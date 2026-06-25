import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, ProvenanceSource, ScopedRecord } from '../types.js';
import { appendRecord, parseLedger, compactLedger, type LedgerPath } from './ledger.js';
import { findSecrets, redactSecrets } from './secret-scan.js';
import { canCommit, promotionFor, type VerifyOutcome } from './firewall.js';
import { buildProjection, type RecallOptions } from './projection.js';
import { rankRecords } from './retrieval.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce } from './content-frame.js';
import { isOwned, stampOwnership } from './ownership.js';

export interface MemoryStoreOptions {
  sessionId?: string;
  now?: () => string;   // ISO timestamp source (injectable for tests)
  genId?: () => string; // id source (injectable for tests)
  genNonce?: () => string; // injectable per-frame nonce source (default crypto)
  /** When set, enables the project scope layer (in-repo ledger + ownership gate). */
  project?: { ledger: string; root: string; home: string };
  /** Injectable ownership stamp source (default crypto). */
  genStamp?: () => string;
}

export interface CommitInput {
  content: string;
  source: ProvenanceSource;        // required: the caller MUST declare provenance
  blastRadius?: BlastRadius | null;
  classification?: Classification; // default 'normal'
  validFrom?: string;
  validTo?: string | null;
  /** Id of an existing item this commit replaces. Set => emit a 'supersede' (update-in-place)
   *  instead of an 'assert', so a changed fact replaces the old one rather than duplicating it. */
  supersedes?: string | null;
  /** Where to store the fact. Default 'project' when a project layer is active, else 'global'. */
  scope?: MemoryScope;
}

export interface RecalledItem {
  record: MemoryRecord;
  scope: MemoryScope;
  needsReverify: boolean;
}

export interface RecallResult {
  items: RecalledItem[];
  framed: string; // DATA-quarantined block for prompt injection
}

/** Orchestrates the deterministic core modules over a real JSONL ledger file. */
export class MemoryStore {
  constructor(private readonly global: LedgerPath, private readonly opts: MemoryStoreOptions = {}) {}

  private now(): string { return (this.opts.now ?? (() => new Date().toISOString()))(); }
  private id(): string { return (this.opts.genId ?? (() => `m_${randomUUID()}`))(); }
  private nonce(): string { return (this.opts.genNonce ?? newNonce)(); }
  private session(): string { return this.opts.sessionId ?? 'unknown'; }

  commit(input: CommitInput): MemoryRecord {
    if (input.content.trim() === '') throw new Error('commit: content must be non-empty');
    const source: ProvenanceSource = input.source;
    if (!canCommit({ provenance: { source, sessionId: this.session() } })) {
      throw new Error('commit: missing provenance');
    }
    const ts = this.now();
    let content = input.content;
    let classification: Classification = input.classification ?? 'normal';
    const spans = findSecrets(input.content);
    if (spans.length > 0) {
      // Span-level redaction: replace ONLY the secret tokens with a content-free marker, preserving
      // the surrounding text. A high-entropy false positive (e.g. a git SHA) no longer empties the
      // whole record; classification flags that a redaction happened.
      const red = redactSecrets(input.content, spans);
      content = red.content;
      classification = red.classification;
    }
    const record: MemoryRecord = {
      id: this.id(), tx: ts, validFrom: input.validFrom ?? ts, validTo: input.validTo ?? null,
      // supersedes set => 'supersede' (projection drops the old item and keeps this one as the live
      // replacement, so an update replaces rather than duplicates); otherwise a plain 'assert'.
      type: input.supersedes ? 'supersede' : 'assert', state: 'Fresh', content,
      provenance: { source, sessionId: this.session() },
      supersedes: input.supersedes ?? null, blastRadius: input.blastRadius ?? null, reverifyTrigger: null, classification,
    };
    appendRecord(this.targetLedger(input.scope), record);
    return record;
  }

  /** Resolve the ledger to write to. Project scope claims ownership on first use and refuses a
   *  pre-existing unowned (foreign) ledger. Falls back to global when no project layer is active. */
  private targetLedger(scope: MemoryScope | undefined): LedgerPath {
    const p = this.opts.project;
    if (scope === 'global' || !p) return this.global;
    if (!isOwned(p.root, p.home)) {
      if (existsSync(p.ledger)) {
        throw new Error(
          'commit: a project memory file exists here that Helix did not create — ' +
          'adopt it explicitly (helix_memory_adopt) or remove it',
        );
      }
      stampOwnership(p.root, p.home, { now: this.opts.now, genStamp: this.opts.genStamp });
    }
    return p.ledger;
  }

  /** Live records from global + (project iff owned), each tagged with its scope. */
  private scopedProjection(): ScopedRecord[] {
    const out: ScopedRecord[] = [];
    for (const r of buildProjection(parseLedger(this.global)).values()) out.push({ record: r, scope: 'global' });
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home)) {
      for (const r of buildProjection(parseLedger(p.ledger)).values()) out.push({ record: r, scope: 'project' });
    }
    return out;
  }

  recall(query: string, opts: RecallOptions = {}): RecallResult {
    const scoped = this.scopedProjection();
    const scopeById = new Map(scoped.map((s) => [s.record.id, s.scope]));
    const hits = rankRecords(scoped.map((s) => s.record), query, opts);
    const items: RecalledItem[] = hits.map((record) => ({
      record,
      scope: scopeById.get(record.id) ?? 'global',
      needsReverify: requiresReverifyBeforeUse({ state: record.state, blastRadius: record.blastRadius }),
    }));
    return { items, framed: frameAsData(items.map(({ record, scope }) => ({ record, scope })), this.nonce()) };
  }

  /** Which ledger currently holds `id` (project iff owned and present); defaults to global. */
  private ledgerOf(id: string): LedgerPath {
    if (buildProjection(parseLedger(this.global)).has(id)) return this.global;
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home) && buildProjection(parseLedger(p.ledger)).has(id)) return p.ledger;
    return this.global;
  }

  verify(targetId: string, outcome: VerifyOutcome, source: ProvenanceSource = 'reality-check', verifier?: string): MemoryRecord {
    const ts = this.now();
    const state = promotionFor({ source, sessionId: this.session(), verifier }, outcome);
    const record: MemoryRecord = {
      id: this.id(), tx: ts, validFrom: ts, validTo: null,
      type: 'verify', state, content: '',
      provenance: { source, sessionId: this.session(), verifier },
      supersedes: targetId, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    };
    appendRecord(this.ledgerOf(targetId), record);
    return record;
  }

  inspect(): ScopedRecord[] {
    return this.scopedProjection();
  }

  /** Explicitly adopt the active project ledger (trust its current contents). For team-shared
   *  ledgers. Throws if no project layer is active. */
  adopt(): void {
    const p = this.opts.project;
    if (!p) throw new Error('adopt: no project scope is active');
    stampOwnership(p.root, p.home, { now: this.opts.now, genStamp: this.opts.genStamp });
  }

  erase(id: string): void {
    const ts = this.now();
    const ledger = this.ledgerOf(id);
    appendRecord(ledger, {
      id: this.id(), tx: ts, validFrom: ts, validTo: null,
      type: 'erase', content: '', state: 'Suspect',
      provenance: { source: 'user', sessionId: this.session() },
      supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    });
    compactLedger(ledger, { erasedIds: new Set([id]) });
  }
}
