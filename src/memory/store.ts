import { randomUUID } from 'node:crypto';
import type { BlastRadius, Classification, MemoryRecord, ProvenanceSource } from '../types.js';
import { appendRecord, parseLedger, compactLedger, type LedgerPath } from './ledger.js';
import { detectSecret, redactSecret } from './secret-scan.js';
import { canCommit, promotionFor, type VerifyOutcome } from './firewall.js';
import { buildProjection, recall, type RecallOptions } from './projection.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce } from './content-frame.js';

export interface MemoryStoreOptions {
  sessionId?: string;
  now?: () => string;   // ISO timestamp source (injectable for tests)
  genId?: () => string; // id source (injectable for tests)
  genNonce?: () => string; // injectable per-frame nonce source (default crypto)
}

export interface CommitInput {
  content: string;
  source?: ProvenanceSource;       // default 'user'
  blastRadius?: BlastRadius | null;
  classification?: Classification; // default 'normal'
  validFrom?: string;
  validTo?: string | null;
}

export interface RecalledItem {
  record: MemoryRecord;
  needsReverify: boolean;
}

export interface RecallResult {
  items: RecalledItem[];
  framed: string; // DATA-quarantined block for prompt injection
}

/** Orchestrates the deterministic core modules over a real JSONL ledger file. */
export class MemoryStore {
  constructor(private readonly ledger: LedgerPath, private readonly opts: MemoryStoreOptions = {}) {}

  private now(): string { return (this.opts.now ?? (() => new Date().toISOString()))(); }
  private id(): string { return (this.opts.genId ?? (() => `m_${randomUUID()}`))(); }
  private nonce(): string { return (this.opts.genNonce ?? newNonce)(); }
  private session(): string { return this.opts.sessionId ?? 'unknown'; }

  commit(input: CommitInput): MemoryRecord {
    if (input.content.trim() === '') throw new Error('commit: content must be non-empty');
    const source: ProvenanceSource = input.source ?? 'user';
    if (!canCommit({ provenance: { source, sessionId: this.session() } })) {
      throw new Error('commit: missing provenance');
    }
    const ts = this.now();
    let content = input.content;
    let classification: Classification = input.classification ?? 'normal';
    const scan = detectSecret(input.content);
    if (scan.hit) {
      // v1 stores only the redacted content + classification. redactSecret also returns
      // {kind, hash}; persisting the hash (for dedupe/recognition per spec §7.4) is deferred
      // until there is a consumer and a schema slot for it.
      const red = redactSecret(input.content, scan.kind ?? 'secret');
      content = red.content;
      classification = red.classification;
    }
    const record: MemoryRecord = {
      id: this.id(), tx: ts, validFrom: input.validFrom ?? ts, validTo: input.validTo ?? null,
      type: 'assert', state: 'Fresh', content,
      provenance: { source, sessionId: this.session() },
      supersedes: null, blastRadius: input.blastRadius ?? null, reverifyTrigger: null, classification,
    };
    appendRecord(this.ledger, record);
    return record;
  }

  recall(query: string, opts: RecallOptions = {}): RecallResult {
    const projection = buildProjection(parseLedger(this.ledger));
    const hits = recall(projection, query, opts);
    const items: RecalledItem[] = hits.map((record) => ({
      record,
      needsReverify: requiresReverifyBeforeUse({ state: record.state, blastRadius: record.blastRadius }),
    }));
    return { items, framed: frameAsData(hits, this.nonce()) };
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
    appendRecord(this.ledger, record);
    return record;
  }

  inspect(): MemoryRecord[] {
    return [...buildProjection(parseLedger(this.ledger)).values()];
  }

  erase(id: string): void {
    const ts = this.now();
    appendRecord(this.ledger, {
      id: this.id(), tx: ts, validFrom: ts, validTo: null,
      type: 'erase', content: '', state: 'Suspect',
      provenance: { source: 'user', sessionId: this.session() },
      supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    });
    compactLedger(this.ledger, { erasedIds: new Set([id]) });
  }
}
