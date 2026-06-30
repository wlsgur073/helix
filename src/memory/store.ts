import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, MemoryState, ProvenanceSource, ScopedRecord, ScopedHistoricalRecord } from '../types.js';
import { appendRecord, appendRecordUnlocked, parseLedger, compactLedger, type LedgerPath } from './ledger.js';
import { buildHistory } from './history.js';
import { findSecrets, redactSecrets } from './secret-scan.js';
import { canCommit, isVerifyingSource, resolveTransition, type TransitionResult, type VerifyOutcome } from './firewall.js';
import { runRealityCheck, checkBinding, type RealityCheck } from './reality-check.js';
import { type RecallOptions } from './projection.js';
import { rankRecords, type Expansion } from './retrieval.js';
import { defaultExpansion, SEM_DISCOUNT, SEM_GATE } from './expansion.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce } from './content-frame.js';
import { isOwned, stampOwnership } from './ownership.js';
import { ensureMaster, signVerify, verifyVerify, digestContent } from './ledger-mac.js';
import { buildVerifiedProjection, type VerifiedProjection } from './verified-projection.js';
import { subkeyForScope, verifiedLive, verifiedLiveOf } from './verified-read.js';
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
  /** EH-3: precomputed synonym expansion. Defaults to the committed asset; tests may inject/disable. */
  expansion?: Expansion;
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

  /** Which scope (project root, or undefined for global) a ledger path belongs to. */
  private scopeRootOf(ledger: LedgerPath): string | undefined {
    const p = this.opts.project;
    return (p && ledger === p.ledger) ? p.root : undefined;
  }

  /** Subkey that signs/verifies records for one ledger, or null if no master exists yet OR the
   *  scope nonce is unresolvable (project not owned). Read path tolerates null (key-absent mode);
   *  the write path mints the master first via ensureMaster. Delegates to the shared verified-read
   *  helper so the hook and the store resolve subkeys identically (one source of truth).
   *
   *  INVARIANT: the helper uses a SINGLE home for both the master read AND the project scope nonce,
   *  whereas the pre-refactor code read the project nonce from project.home. These are the same dir —
   *  the server wiring always sets opts.home === project.home (and the default homeDir() is
   *  dirname(global), with project.home === that). They differ only under a hand-built store that
   *  relocates HELIX_LEDGER outside HELIX_HOME with an active project — where reads still clamp Fresh
   *  (fail-safe) and a project writeVerify would throw rather than mis-sign. */
  private subkeyForLedger(ledger: LedgerPath): Buffer | null {
    return subkeyForScope(this.homeDir(), this.scopeRootOf(ledger));
  }

  /** Verifying projection for one ledger (R1 clamp / R2 MAC gate / R3 content binding). When no
   *  subkey is available every state is clamped to Fresh and keyAvailable is false. Delegates to the
   *  shared verified-read helper that the SessionStart hook also uses (provable consistency). */
  private verifiedOf(ledger: LedgerPath): VerifiedProjection {
    return verifiedLive(ledger, this.homeDir(), this.scopeRootOf(ledger));
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
    const expansion = this.opts.expansion ?? defaultExpansion();
    const hits = rankRecords(scoped.map((s) => s.record), query,
      { ...opts, expansion, semDiscount: SEM_DISCOUNT, semGate: SEM_GATE });
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

  /** Live + closed rows across scopes for the bitemporal history view. Live rows come WHOLESALE from
   *  the verified path (graded, total — an unverified live row defaults to Fresh and is never
   *  dropped); closed rows come from buildHistory. The live/closed partition is overlap-free because
   *  buildHistory's liveness (buildProjection) equals the verified path's membership. anomalies/
   *  truncated are aggregated across scopes. (Spec §4.1/§5.)
   *
   *  ATOMIC per scope: each scope's ledger is parsed ONCE and the single record array feeds BOTH the
   *  verified (graded-live) projection and buildHistory (closed rows) — there is no second,
   *  unsynchronized read, so one id can never surface as both live and closed within a render (the
   *  prior two-read structure could, transiently, under a concurrent cross-process write — spec §10.3,
   *  Codex code-review #1). verifiedLiveOf is the SAME source-of-truth verifiedLive/verifiedOf use, so
   *  the graded live rows are byte-identical to the prior scopedVerified()-sourced ones. Atomicity
   *  here is intra-scope (one snapshot, two projections); it needs no lock — global+project remain two
   *  independent reads, and a forged cross-scope id stays distinguished by its scope tag. */
  historyView(): { rows: ScopedHistoricalRecord[]; anomalies: Set<string>; truncated: boolean; integrityAvailable: boolean } {
    const rows: ScopedHistoricalRecord[] = [];
    const anomalies = new Set<string>();
    let truncated = false;
    let integrityAvailable = true; // false if ANY read scope lacked a master key (mirrors scopedVerified)

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const records = parseLedger(ledger); // ONE read per scope — shared by both projections below
      // Live rows (graded) — membership authority + LEFT-join enrichment, identical to verifiedOf.
      const v = verifiedLiveOf(records, this.homeDir(), this.scopeRootOf(ledger));
      if (!v.keyAvailable) integrityAvailable = false; // key-absent => every grade clamped Fresh (fail-safe)
      for (const r of v.live.values()) {
        rows.push({ record: r, scope, txTo: null, closedBy: null, integrity: v.compromised.has(r.id) ? 'compromised' : 'ok' });
      }
      // Closed rows from the SAME record array.
      const h = buildHistory(records);
      for (const id of h.anomalies) anomalies.add(id);
      if (h.truncated) truncated = true;
      for (const row of h.rows) {
        if (row.closedBy === null) continue; // live rows already added (graded) above
        rows.push({ ...row, scope, integrity: 'ok' });
      }
    };
    addScope(this.global, 'global');
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home)) addScope(p.ledger, 'project');

    return { rows, anomalies, truncated, integrityAvailable };
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
      // Resolve the subkey ONCE so the whole compaction makes one atomic keep/drop decision — a
      // per-record re-resolve could see a valid subkey for one verify and a transient null for the
      // next, tearing a single rewrite into an inconsistent partial state.
      //
      // Key-absent => PRESERVE every live-target verify (`() => true`), do NOT drop. Compaction is
      // DESTRUCTIVE (unlike the recoverable read-path clamp): if subkeyForLedger returns null — which
      // a transient registry/master read failure can cause even with the key still on disk — we
      // cannot tell genuine from forged, so dropping would permanently destroy recoverable
      // elevations AND demotions. Keeping them is safe: with no key the read path clamps everything
      // to Fresh regardless, so kept records confer no trust, and the next key-present compaction
      // purges any forgeries. (Must NOT fall through to the legacy bake-and-drop path here.)
      const sk = this.subkeyForLedger(ledger);
      compactLedger(ledger, {
        erasedIds: new Set([id]),
        keepValidVerify: sk ? (r) => verifyVerify(r, sk) : () => true,
      });
    }
  }
}
