import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, MemoryState, ProvenanceSource, ScopedRecord } from '../types.js';
import { appendRecord, appendRecordUnlocked, parseLedger, compactLedger, type LedgerPath } from './ledger.js';
import { findSecrets, redactSecrets } from './secret-scan.js';
import { canCommit, isVerifyingSource, resolveTransition, type TransitionResult, type VerifyOutcome } from './firewall.js';
import { runRealityCheck, checkBinding, type RealityCheck } from './reality-check.js';
import { type RecallOptions } from './projection.js';
import { rankRecords } from './retrieval.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce } from './content-frame.js';
import { isOwned, stampOwnership, scopeNonce, globalScopeNonce } from './ownership.js';
import { ensureMaster, tryReadMaster, deriveSubkey, signVerify, verifyVerify, digestContent } from './ledger-mac.js';
import { buildVerifiedProjection, type VerifiedProjection } from './verified-projection.js';
import { withFileLock } from './lock.js';

export interface MemoryStoreOptions {
  sessionId?: string;
  now?: () => string;   // ISO timestamp source (injectable for tests)
  genId?: () => string; // id source (injectable for tests)
  genNonce?: () => string; // injectable per-frame nonce source (default crypto)
  /** When set, enables the project scope layer (in-repo ledger + ownership gate). */
  project?: { ledger: string; root: string; home: string };
  /** Injectable ownership stamp source (default crypto). */
  genStamp?: () => string;
  /** Where the ledger-MAC master key + scope-nonce registry live. Defaults to dirname(global). */
  home?: string;
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
  /** 'compromised' iff the verifying replay saw an equal-generation MAC conflict for this target
   *  (R-conflict). 'ok' otherwise — including a forged elevation that was simply ignored (it shows
   *  its honest clamped state, no conflict). */
  integrity: 'ok' | 'compromised';
}

export interface RecallResult {
  items: RecalledItem[];
  framed: string; // DATA-quarantined block for prompt injection
  /** False when no master key is available — every state is conservatively clamped to Fresh and
   *  no elevation can be trusted (the verifying replay ran in key-absent mode). */
  integrityAvailable: boolean;
}

export interface RecheckResult {
  outcome: VerifyOutcome;
  result: TransitionResult;
  record: MemoryRecord | null;
}

/** Orchestrates the deterministic core modules over a real JSONL ledger file. */
export class MemoryStore {
  constructor(private readonly global: LedgerPath, private readonly opts: MemoryStoreOptions = {}) {}

  private now(): string { return (this.opts.now ?? (() => new Date().toISOString()))(); }
  private id(): string { return (this.opts.genId ?? (() => `m_${randomUUID()}`))(); }
  private nonce(): string { return (this.opts.genNonce ?? newNonce)(); }
  private session(): string { return this.opts.sessionId ?? 'unknown'; }

  /** Where the ledger-MAC master key + scope-nonce registry live (defaults next to the global ledger). */
  private homeDir(): string { return this.opts.home ?? dirname(this.global); }

  /** Subkey that signs/verifies records for one ledger, or null if no master exists yet OR the
   *  scope nonce is unresolvable (project not owned). Read path tolerates null (key-absent mode);
   *  the write path mints the master first via ensureMaster. */
  private subkeyForLedger(ledger: LedgerPath): Buffer | null {
    const master = tryReadMaster(this.homeDir());
    if (!master) return null;
    const p = this.opts.project;
    const nonce = (p && ledger === p.ledger) ? scopeNonce(p.root, p.home) : globalScopeNonce(this.homeDir());
    return nonce ? deriveSubkey(master, nonce) : null;
  }

  /** Verifying projection for one ledger (R1 clamp / R2 MAC gate / R3 content binding). When no
   *  subkey is available every state is clamped to Fresh and keyAvailable is false. */
  private verifiedOf(ledger: LedgerPath): VerifiedProjection {
    const subkey = this.subkeyForLedger(ledger);
    return buildVerifiedProjection(parseLedger(ledger), {
      verify: (r) => (subkey ? verifyVerify(r, subkey) : false),
      keyAvailable: subkey !== null,
    });
  }

  commit(input: CommitInput): MemoryRecord {
    if (input.content.trim() === '') throw new Error('commit: content must be non-empty');
    const source: ProvenanceSource = input.source;
    if (!canCommit({ provenance: { source, sessionId: this.session() } })) {
      throw new Error('commit: missing provenance');
    }
    if (input.supersedes) {
      const targetLedger = this.ledgerOf(input.supersedes);
      const target = this.verifiedOf(targetLedger).live.get(input.supersedes);
      if (!target) throw new Error('commit: supersedes target not found (dead or unknown id)');
      // Cross-scope guard (spec §15): the supersede record is written to the ledger for input.scope,
      // but projection is per-ledger. If the target lives in a different ledger than the write, the
      // supersede would NOT evict it — both stay live (a duplicate, stale fact never removed). Reject
      // the scope mismatch. (Side-effect-free write-ledger resolution: mirrors targetLedger() routing
      // WITHOUT its ownership-claim side effect, so a rejected commit never stamps/creates a ledger.)
      const writeLedger = input.scope === 'global' || !this.opts.project ? this.global : this.opts.project.ledger;
      if (targetLedger !== writeLedger) {
        throw new Error('commit: cannot supersede across scopes (target lives in a different ledger)');
      }
      const targetIsAuthoritative = isVerifyingSource(target.provenance.source) || target.state === 'Verified';
      if (targetIsAuthoritative && !isVerifyingSource(source)) {
        throw new Error(
          'commit: cannot supersede an authoritative fact with a non-authoritative source ' +
          '(user-relayed / agent-inference). Commit as source=user if you are authoring this, or reconcile via recall.',
        );
      }
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

  /** Verified live records from global + (project iff owned), each tagged with scope + integrity,
   *  plus whether a master key was available for EVERY scope read (integrityAvailable). */
  private scopedVerified(): { records: ScopedRecord[]; available: boolean } {
    const out: ScopedRecord[] = [];
    let available = true;
    const add = (ledger: LedgerPath, scope: MemoryScope) => {
      const v = this.verifiedOf(ledger);
      if (!v.keyAvailable) available = false;
      for (const r of v.live.values()) {
        out.push({ record: r, scope, integrity: v.compromised.has(r.id) ? 'compromised' : 'ok' });
      }
    };
    add(this.global, 'global');
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home)) add(p.ledger, 'project');
    return { records: out, available };
  }

  /** Live records from global + (project iff owned), each tagged with its scope. */
  private scopedProjection(): ScopedRecord[] {
    return this.scopedVerified().records;
  }

  recall(query: string, opts: RecallOptions = {}): RecallResult {
    const { records: scoped, available } = this.scopedVerified();
    const byId = new Map(scoped.map((s) => [s.record.id, s]));
    const hits = rankRecords(scoped.map((s) => s.record), query, opts);
    const items: RecalledItem[] = hits.map((record) => ({
      record,
      scope: byId.get(record.id)?.scope ?? 'global',
      needsReverify: requiresReverifyBeforeUse({ state: record.state, blastRadius: record.blastRadius, source: record.provenance.source }),
      integrity: byId.get(record.id)?.integrity ?? 'ok',
    }));
    return {
      items,
      framed: frameAsData(items.map(({ record, scope }) => ({ record, scope })), this.nonce()),
      integrityAvailable: available,
    };
  }

  /** Which ledger currently holds `id` (project iff owned and present); defaults to global. */
  private ledgerOf(id: string): LedgerPath {
    if (this.verifiedOf(this.global).live.has(id)) return this.global;
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home) && this.verifiedOf(p.ledger).live.has(id)) return p.ledger;
    return this.global;
  }

  /** Live projected record for `id` across scopes, or throw. */
  private liveTarget(id: string): MemoryRecord {
    const found = this.scopedProjection().find((s) => s.record.id === id);
    if (!found) throw new Error('target not found (dead or unknown id)');
    return found.record;
  }

  /** Append a SIGNED verify event conferring `state` on `targetId` (routed to the target's ledger).
   *  Reads the verified projection, computes the next per-target generation and the content digest,
   *  signs, and appends — all under ONE ledger lock so a concurrent writer can't race the gen. */
  private writeVerify(targetId: string, state: MemoryState, source: ProvenanceSource): MemoryRecord {
    const ledger = this.ledgerOf(targetId);
    return withFileLock(ledger, () => {
      ensureMaster(this.homeDir());                 // mint the master on first sign (different lock)
      const subkey = this.subkeyForLedger(ledger);
      if (!subkey) throw new Error('writeVerify: cannot resolve signing subkey (project not owned?)');
      const records = parseLedger(ledger);
      // Trust only VALID verifies for the live target + the running generation, so a forged record
      // (state or gen) can never raise the floor we sign above.
      const v = buildVerifiedProjection(records, { verify: (r) => verifyVerify(r, subkey), keyAvailable: true });
      const target = v.live.get(targetId);
      if (!target) throw new Error('writeVerify: target not live');
      const maxGen = records.reduce(
        (m, r) => (r.type === 'verify' && r.supersedes === targetId && verifyVerify(r, subkey) ? Math.max(m, r.gen ?? 0) : m),
        0,
      );
      const ts = this.now();
      // gen + targetDigest MUST be set before signVerify (it silently signs gen=0/digest=null otherwise).
      const unsigned: MemoryRecord = {
        id: this.id(), tx: ts, validFrom: ts, validTo: null,
        type: 'verify', state, content: '',
        provenance: { source, sessionId: this.session() },
        supersedes: targetId, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        gen: maxGen + 1, targetDigest: digestContent(target.content),
      };
      const signed = signVerify(unsigned, subkey);
      appendRecordUnlocked(ledger, signed);         // we already hold the ledger lock — non-locking append
      return signed;
    });
  }

  /** Content-bound mechanical reality-check. Mints at most Corroborated; never Verified. */
  recheck(id: string, check: RealityCheck): RecheckResult {
    const target = this.liveTarget(id);
    const binding = checkBinding(target.content, check);
    if (!binding.bound) throw new Error(`recheck: ${binding.reason}`);
    const outcome = runRealityCheck(check);
    const result = resolveTransition({
      targetSource: target.provenance.source, targetState: target.state,
      evidenceSource: 'reality-check', outcome,
    });
    const record = result.kind === 'state' ? this.writeVerify(id, result.state, 'reality-check') : null;
    return { outcome, result, record };
  }

  /** Human out-of-band vouch → Verified. Target-gated: only a source=user item is eligible. */
  confirm(id: string): { record: MemoryRecord } {
    const target = this.liveTarget(id);
    if (target.provenance.source !== 'user') {
      throw new Error('confirm: only a source=user item is eligible (re-commit as source=user to take authorship first)');
    }
    const result = resolveTransition({
      targetSource: 'user', targetState: target.state,
      evidenceSource: 'user', outcome: { ran: true, indeterminate: false, passed: true },
    });
    // resolveTransition guarantees { kind:'state', state:'Verified' } for evidenceSource 'user'
    const state = result.kind === 'state' ? result.state : 'Verified';
    return { record: this.writeVerify(id, state, 'user') };
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
    // Make signing possible going forward (future confirm/recheck can mint signed verifies), but
    // do NOT sign or bless any pre-existing record: adoption must never launder an unsigned,
    // pre-seeded elevated assert into a Verified one. R1's replay clamp already demotes such a
    // record to Fresh — this only ensures the master exists, it signs nothing that already exists.
    ensureMaster(this.homeDir());
  }

  /** Remove an item from the live projection. Soft by default (tombstone only — recoverable until
   *  compaction, so an erroneous/poisoned erase can be undone). `permanent` compacts immediately for
   *  genuine right-to-erasure. */
  erase(id: string, opts: { permanent?: boolean } = {}): void {
    const ts = this.now();
    const ledger = this.ledgerOf(id);
    appendRecord(ledger, {
      id: this.id(), tx: ts, validFrom: ts, validTo: null,
      type: 'erase', content: '', state: 'Suspect',
      provenance: { source: 'user', sessionId: this.session() },
      supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    });
    if (opts.permanent) {
      // HMAC-aware compaction: preserve genuine signed verifies for this ledger, drop forgeries.
      // verifyVerify is gated on the SAME subkey the ledger was signed under (key-absent => keep
      // nothing, i.e. drop every verify — the conservative floor, matching the read path's clamp).
      compactLedger(ledger, {
        erasedIds: new Set([id]),
        keepValidVerify: (r) => {
          const sk = this.subkeyForLedger(ledger);
          return sk ? verifyVerify(r, sk) : false;
        },
      });
    }
  }
}
