import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, MemoryState, ProvenanceSource, ScopedRecord, ScopedHistoricalRecord, ScopedAsOfFact } from '../types.js';
import { appendRecord, appendRecordUnlocked, parseLedger, parseLedgerText, parseLedgerHealth, compactLedger, planCompaction, serializedBytes, type CompactionStats, type LedgerPath } from './ledger.js';
import { cheapGate, dirtyGate } from './compaction-trigger.js';
import type { CompactionConfig } from '../config.js';
import { buildHistory, ledgerTruncated } from './history.js';
import { buildAsOfEvidence } from './asof.js';
import { findSecrets, redactSecrets } from './secret-scan.js';
import { canCommit, isVerifyingSource, resolveTransition, type TransitionResult, type VerifyOutcome } from './firewall.js';
import { runRealityCheck, checkBinding, type RealityCheck } from './reality-check.js';
import { type RecallOptions } from './projection.js';
import { rankWithArtifacts, buildRankArtifacts, type Expansion } from './retrieval.js';
import { defaultExpansion, SEM_DISCOUNT, SEM_GATE } from './expansion.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce } from './content-frame.js';
import { isOwned, stampOwnership } from './ownership.js';
import { ensureMaster, signVerify, verifyVerify, digestContent, MAC_VERSION } from './ledger-mac.js';
import { buildVerifiedProjection, isKnownState, type VerifiedProjection } from './verified-projection.js';
import { subkeyForScope, verifiedLiveOf, verifiedLiveStats, verifiedProjectionWithSubkey } from './verified-read.js';
import { ledgerDigest, subkeyFingerprint, keyVectorEqual, type ScopeKeyComponent, type RecallCacheEntry } from './recall-cache.js';
import type { MetricsSink } from '../metrics.js';
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
  /** Metrics sink (spec 2026-07-05). Absent => zero emission (tests/bench/library use stay clean). */
  metricsSink?: MetricsSink;
  /** Resolved auto-compaction config (spec 2026-07-09). Injected by the server from the GLOBAL config
   *  only; absent => disabled. */
  compaction?: CompactionConfig;
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

  /** A4 single-slot recall cache (I5). Reused only on an exact content-identity key match; replaced on
   *  any miss; cleared on self-erase (I8). Per-instance — dies with the store (I6). */
  private rankCache: RecallCacheEntry | null = null;

  /** Once-per-session auto-compaction guard, set on ATTEMPT (spec §4.5) so a failed compaction does
   *  not retry within the session. */
  private compactedThisSession = false;

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

  /** The verify-keep predicate a compaction must use: key-present => genuine-signed OR a future MAC
   *  version (never destroy what a newer binary signed); key-absent => keep every live-target verify
   *  (cannot tell genuine from forged, so dropping would be destructive). SHARED by the manual erase
   *  path and the auto-compaction trigger so the two never diverge.
   *
   *  Takes an ALREADY-RESOLVED subkey (never re-resolves per record): the caller resolves once so the
   *  whole compaction makes one atomic keep/drop decision — a per-record re-resolve could see a valid
   *  subkey for one verify and a transient null for the next, tearing a single rewrite into an
   *  inconsistent partial state.
   *
   *  Key-absent => PRESERVE every live-target verify (`() => true`), do NOT drop. Compaction is
   *  DESTRUCTIVE (unlike the recoverable read-path clamp): if subkeyForLedger returns null — which
   *  a transient registry/master read failure can cause even with the key still on disk — we cannot
   *  tell genuine from forged, so dropping would permanently destroy recoverable elevations AND
   *  demotions. Keeping them is safe: with no key the read path clamps everything to Fresh
   *  regardless, so kept records confer no trust, and the next key-present compaction purges any
   *  forgeries. (Must NOT fall through to the legacy bake-and-drop path.)
   *
   *  spec §4.6: preserve records from a FUTURE MAC version too — an A-era compactor must never
   *  destroy what a newer binary signed (the pre-A -> v2 destructive-compaction class, one bump
   *  later). They stay grade-inert (verifyVerify false until a verifier exists) and scan-visible. */
  private keepValidVerifyFor(subkey: Buffer | null): (r: MemoryRecord) => boolean {
    return subkey
      ? (r) => (verifyVerify(r, subkey) && isKnownState(r.state)) || (typeof r.macVersion === 'number' && Number.isSafeInteger(r.macVersion) && r.macVersion > MAC_VERSION)
      : () => true;
  }

  /** Verifying projection for one ledger (R1 clamp / R2 MAC gate / R3 content binding). When no
   *  subkey is available every state is clamped to Fresh and keyAvailable is false. Delegates to the
   *  shared verified-read helper that the SessionStart hook also uses (provable consistency).
   *  Emits one replay record per read when a metrics sink is injected. */
  private verifiedOf(ledger: LedgerPath): VerifiedProjection {
    const root = this.scopeRootOf(ledger);
    const { projection, stats } = verifiedLiveStats(ledger, this.homeDir(), root);
    this.opts.metricsSink?.emitReplay({
      scope: root ? 'project' : 'global', caller: 'store',
      rows: stats.rows, liveRows: stats.liveRows, bytes: stats.bytes,
      parseMs: stats.parseMs, projectMs: stats.projectMs, keyAvailable: stats.keyAvailable,
    });
    return projection;
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

  /** Read-once, content-identity-keyed recall input (spec §5). Reads each participating ledger's bytes
   *  ONCE (I1), keys a single slot on (digest, fresh subkey fingerprint, scopeId) per scope (I2/I3),
   *  and reuses the cached scoped projection + rank artifacts on an exact match; else rebuilds from the
   *  SAME bytes. Ownership is checked fresh here, upstream of the key (I4). */
  private recallInput(): { scoped: ScopedRecord[]; available: boolean; artifacts: ReturnType<typeof buildRankArtifacts> } {
    const scopes: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined }> = [
      { ledger: this.global, scope: 'global', root: undefined },
    ];
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home)) scopes.push({ ledger: p.ledger, scope: 'project', root: p.root });

    const key: ScopeKeyComponent[] = [];
    const reads: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; text: string; bytes: number; subkey: Buffer | null; readMs: number }> = [];
    for (const s of scopes) {
      let buf: Buffer;
      const rt0 = performance.now();
      try {
        buf = readFileSync(s.ledger);                 // I1: owned immutable buffer, read once
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') buf = Buffer.alloc(0);
        else throw e;
      }
      const text = buf.toString('utf8');              // decode timed WITH the read (parseLedger's parseMs is read+decode-inclusive)
      const readMs = performance.now() - rt0;
      const subkey = this.subkeyForLedger(s.ledger);  // I3: resolved fresh from disk, never memoized
      key.push({ scopeId: s.ledger, digest: ledgerDigest(buf), fingerprint: subkeyFingerprint(subkey) });
      reads.push({ ledger: s.ledger, scope: s.scope, root: s.root, text, bytes: buf.length, subkey, readMs });
    }

    if (this.rankCache && keyVectorEqual(this.rankCache.key, key)) {
      return { scoped: this.rankCache.scoped, available: this.rankCache.available, artifacts: this.rankCache.artifacts };
    }

    // MISS: rebuild from the SAME bytes already read above. parseMs = per-scope read+decode (captured
    // with the read) + line-split + JSON.parse, matching verifiedLiveStats' read-inclusive parseMs so
    // the A3 replay curve stays comparable across the store/hook emitters; projectMs is the verifying
    // replay, exactly as verifiedOf emits.
    const scoped: ScopedRecord[] = [];
    let available = true;
    for (const r of reads) {
      const t0 = performance.now();
      const records = parseLedgerText(r.text);
      const t1 = performance.now();
      const proj = verifiedProjectionWithSubkey(records, r.subkey);
      const t2 = performance.now();
      if (!proj.keyAvailable) available = false;
      for (const rec of proj.live.values()) {
        scoped.push({ record: rec, scope: r.scope, integrity: proj.compromised.has(rec.id) ? 'compromised' : 'ok' });
      }
      this.opts.metricsSink?.emitReplay({
        scope: r.root ? 'project' : 'global', caller: 'store',
        rows: records.length, liveRows: proj.live.size, bytes: r.bytes,
        parseMs: r.readMs + (t1 - t0), projectMs: t2 - t1, keyAvailable: proj.keyAvailable,
      });
    }
    const artifacts = buildRankArtifacts(scoped.map((s) => s.record));
    this.rankCache = { key, scoped, available, artifacts };   // I5: single slot, atomic replace
    // Fire the once-per-session auto-compaction on the MISS path only. It returns the projection
    // computed ABOVE (locals, not the cache), so compaction cannot change what this recall answers:
    // compactLedger preserves the live projection by construction.
    this.maybeAutoCompact(reads);
    return { scoped, available, artifacts };
  }

  /** Auto-compaction (spec 2026-07-09): once per session, on the first ELIGIBLE recall MISS. Evaluates
   *  cheap gates from free signals first; only then runs planCompaction (the shared classifier) for the
   *  reclaim branch, so post-compaction reclaimable is exactly zero (self-limiting, no persisted state).
   *  All errors are swallowed — compaction must never break a recall.
   *
   *  The guard is checked ONCE at entry, so every participating scope (global + an owned project) that
   *  is independently eligible compacts within this one attempt; the guard suppresses a SECOND attempt
   *  on later recalls, not a second scope in this one.
   *
   *  METRIC SEMANTICS (planned vs actual). The GATES legitimately reason about a PROJECTION: they ask
   *  "would a compaction reclaim enough?" of a lock-free snapshot, and `reclaimable`/`reclaimableBytes`
   *  below are exactly that. The emitted METRIC may not: its fields are past tense, and a consumer will
   *  sum them as work done. So it reports the counts compactLedger MEASURED INSIDE ITS OWN LOCK, never
   *  the numbers planned out here — a concurrent cross-process append landing between this lock-free
   *  plan and that lock would otherwise be attributed to this compaction. Both fields are ZERO on
   *  failure: compactLedger writes a tmp and renames, so a throw leaves the ledger byte-identical and
   *  nothing was dropped or reclaimed. */
  private maybeAutoCompact(reads: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; text: string; subkey: Buffer | null }>): void {
    const cfg = this.opts.compaction;
    if (!cfg || this.compactedThisSession) return;
    const nowMs = Date.parse(this.now());
    for (const r of reads) {
      // D6: a hostile row can slip a future parse-guard change and still throw inside
      // serialize/plan (e.g. JSON.stringify RangeError on pathological nesting). This outer
      // try/catch wraps the ENTIRE per-scope eligibility body so such a throw is swallowed
      // like the compaction call already is — a bad row must never brick a recall. `continue`
      // just skips this scope; other scopes in `reads` still get evaluated.
      try {
        let mtimeMs = 0; let totalBytes = 0;
        try { const st = statSync(r.ledger); mtimeMs = st.mtimeMs; totalBytes = st.size; } catch { continue; }
        const records = parseLedgerText(r.text);
        // `rows` is the TOTAL PHYSICAL row count for BOTH gates (never liveRows), and `reclaimable` /
        // `reclaimableBytes` come from ONE planCompaction pass over that SAME array — dirtyGate's
        // `0 <= reclaimable <= rows` precondition is the caller's to keep.
        const gate = cheapGate({ rows: records.length, totalBytes, mtimeMs, nowMs, cfg });
        if (!gate.proceed) continue;
        // Resolve-once: `r.subkey` was resolved by the read loop and is shared by the eligibility plan
        // AND the compaction below, so the counted keep-set is the written keep-set. A second resolution
        // could transiently return null (registry/master read failure), flipping the predicate to the
        // key-absent `() => true` and preserving forgeries the plan counted as dropped.
        const keepValidVerify = this.keepValidVerifyFor(r.subkey);
        const { kept } = planCompaction(records, { erasedIds: new Set(), keepValidVerify });
        const reclaimable = records.length - kept.length;
        const reclaimableBytes = serializedBytes(records) - serializedBytes(kept);
        if (!dirtyGate({ rows: records.length, reclaimable, reclaimableBytes, cfg })) continue;
        // Eligible: guard on ATTEMPT (before the call), fire, emit a metric, swallow errors.
        this.compactedThisSession = true;
        const started = performance.now();
        let stats: CompactionStats | null = null;   // null <=> the compaction threw <=> nothing happened
        try {
          stats = compactLedger(r.ledger, { erasedIds: new Set(), keepValidVerify });
        } catch { /* swallowed: compaction must never break a recall */ }
        const durationMs = performance.now() - started;   // capture BEFORE any metrics I/O
        // Drop the entry this recall just installed. On SUCCESS the ledger bytes changed, so the
        // content-identity key would miss anyway (belt and braces). On FAILURE the bytes did NOT change,
        // and clearing is what forces the next recall to MISS and re-enter this method — where the
        // once-per-session guard, not a cache hit, then suppresses the retry. Defensive on both paths.
        this.rankCache = null;
        this.opts.metricsSink?.emitCompaction({
          scope: r.root ? 'project' : 'global', durationMs,
          droppedRows: stats?.droppedRows ?? 0, reclaimedBytes: stats?.reclaimedBytes ?? 0,
          droppedForgedVerifies: stats?.droppedForgedVerifies ?? 0, ok: stats !== null,
        });
      } catch { continue; /* D6: a serialization/plan throw on a hostile row must never break a recall */ }
    }
  }

  recall(query: string, opts: RecallOptions = {}): RecallResult {
    const { scoped, available, artifacts } = this.recallInput();
    const byId = new Map(scoped.map((s) => [s.record.id, s]));
    const expansion = this.opts.expansion ?? defaultExpansion();
    const hits = rankWithArtifacts(scoped.map((s) => s.record), artifacts, query,
      { ...opts, expansion, semDiscount: SEM_DISCOUNT, semGate: SEM_GATE });
    const items: RecalledItem[] = hits.map((record) => ({
      record,
      scope: byId.get(record.id)?.scope ?? 'global',
      needsReverify: requiresReverifyBeforeUse({ state: record.state, blastRadius: record.blastRadius, source: record.provenance.source }),  // I7: recomputed per call
      integrity: byId.get(record.id)?.integrity ?? 'ok',
    }));
    return {
      items,
      framed: frameAsData(items.map(({ record, scope }) => ({ record, scope })), this.nonce()),  // I7: fresh nonce per call
      integrityAvailable: available,
    };
  }

  /** Which ledger currently holds `id` (project iff owned and present); defaults to global.
   *  D9: an id live in BOTH scopes at once (only reachable via a hand-planted/forged ledger row)
   *  is ambiguous — silently binding global would ignore the project duplicate. Throw instead. */
  private ledgerOf(id: string): LedgerPath {
    const p = this.opts.project;
    const inGlobal = this.verifiedOf(this.global).live.has(id);
    const inProject = !!p && isOwned(p.root, p.home) && this.verifiedOf(p.ledger).live.has(id);
    if (inGlobal && inProject) throw new Error('ledgerOf: id live in more than one scope — ambiguous');
    if (inProject) return p!.ledger;
    return this.global; // global, or fall through for a non-live id (callers re-gate liveness and throw)
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

  /** Point-in-time forensic snapshot at system-time `t` (spec C §5). Mirrors historyView's ATOMIC
   *  single-parse-per-scope: each scope's ledger is parsed ONCE and the single array feeds
   *  buildAsOfEvidence + ledgerTruncated. `t` is assumed canonical (the surface validates). Membership
   *  and v1 verify timing are DECLARED; only v2 verify tx is authenticated (per-evidence flag). */
  asOfView(t: string): { facts: ScopedAsOfFact[]; keyAvailable: boolean; truncated: boolean } {
    const facts: ScopedAsOfFact[] = [];
    let keyAvailable = true;
    let truncated = false;

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const records = parseLedger(ledger);                 // ONE read per scope
      const subkey = this.subkeyForLedger(ledger);
      const out = buildAsOfEvidence(records, t, {
        verify: (r) => (subkey ? verifyVerify(r, subkey) : false),
        keyAvailable: subkey !== null,
      });
      if (!out.keyAvailable) keyAvailable = false;
      if (ledgerTruncated(records)) truncated = true;      // over the FULL records, not the t-window
      for (const f of out.facts) facts.push({ ...f, scope });
    };
    addScope(this.global, 'global');                       // exact project block copied from historyView
    const p = this.opts.project;
    if (p && isOwned(p.root, p.home)) addScope(p.ledger, 'project');
    return { facts, keyAvailable, truncated };
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

  /** Which marker family a canonical marker id belongs to, or null for a normal id. */
  private markerFamilyOf(id: string): 'integrity_' | 'horizon_' | null {
    return id === 'integrity_marker' ? 'integrity_' : id === 'horizon_marker' ? 'horizon_' : null;
  }

  /** Is `id` present in `ledger` — family-prefix for a marker (C10), else live-or-raw. */
  private presentIn(ledger: LedgerPath, id: string): boolean {
    const fam = this.markerFamilyOf(id);
    const records = parseLedger(ledger);
    if (fam) return records.some((r) => typeof r.id === 'string' && r.id.startsWith(fam));
    if (this.verifiedOf(ledger).live.has(id)) return true;
    return records.some((r) => r.id === id);
  }

  /** Resolve the single ledger an erase acts on, or null for a clean-and-absent no-scope no-op. Throws
   *  on: unowned project scope; explicit scope where the id is absent (C4/D7); no-scope over a ledger
   *  with any skipped line (C5/C6); or a no-scope id live/present in more than one scope (D9). */
  private resolveEraseTarget(id: string, scope: MemoryScope | undefined): LedgerPath | null {
    const p = this.opts.project;
    const projectActive = !!p && isOwned(p.root, p.home);
    if (scope) {
      const ledger = scope === 'global' || !p ? this.global
        : (projectActive ? p.ledger : (() => { throw new Error('erase: project ledger not owned — adopt it (helix_memory_adopt) then erase, or remove it'); })());
      if (!this.presentIn(ledger, id)) throw new Error(`erase: id not found in scope ${scope}`);
      return ledger;
    }
    const candidates: LedgerPath[] = [this.global, ...(projectActive ? [p!.ledger] : [])];
    for (const c of candidates) {
      let text: string;
      try { text = readFileSync(c, 'utf8'); }
      catch (err) {
        // ENOENT (never existed, or vanished between existsSync and this read) => no ledger, no
        // corruption — same tolerance as parseLedger's own ENOENT handling. Any other error still throws.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (parseLedgerHealth(text).skippedNonBlank > 0) {
        throw new Error('erase: a ledger has skipped (corrupt/torn) lines — pass an explicit scope');
      }
    }
    const hits = candidates.filter((c) => this.presentIn(c, id));
    if (hits.length > 1) throw new Error('erase: id present in more than one scope — pass an explicit scope');
    return hits[0] ?? null;
  }

  /** Remove an item from the live projection. Soft by default (tombstone only — recoverable until
   *  compaction, so an erroneous/poisoned erase can be undone). `permanent` compacts immediately for
   *  genuine right-to-erasure. Scope-aware routing (D5/D7/C4/C10): never falls back to a ledger the id
   *  does not live in — an explicit scope must contain the id or this throws; with no scope, exactly
   *  one candidate ledger may hold the id (else throws ambiguity), and a corrupt/torn line on ANY
   *  candidate throws rather than silently risking a wrong-file compaction. */
  erase(id: string, opts: { permanent?: boolean; scope?: MemoryScope } = {}): void {
    const ledger = this.resolveEraseTarget(id, opts.scope);
    if (ledger === null) { this.rankCache = null; return; }   // clean + absent → idempotent no-op success
    const isMarker = this.markerFamilyOf(id) !== null;
    const alreadyDead = !this.verifiedOf(ledger).live.has(id);
    if (!isMarker && !alreadyDead) {                          // skip tombstone for markers (T1-g) + already-dead ids (D8)
      const ts = this.now();
      appendRecord(ledger, {
        id: this.id(), tx: ts, validFrom: ts, validTo: null,
        type: 'erase', content: '', state: 'Suspect',
        provenance: { source: 'user', sessionId: this.session() },
        supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      });
    }
    if (opts.permanent) {
      // HMAC-aware compaction: preserve genuine signed verifies for this ledger, drop forgeries.
      // Resolve the subkey ONCE (see keepValidVerifyFor) so the whole compaction makes one atomic
      // keep/drop decision, and share that predicate with the auto-compaction trigger so the two
      // paths can never diverge.
      const sk = this.subkeyForLedger(ledger);
      // D6: a hostile/malformed row must surface a clean, catchable Error here rather than a raw
      // RangeError from JSON.stringify inside compactLedger's serialize step — permanent erase is
      // user-invoked and callers should get a diagnosable failure, not an uncaught crash.
      try {
        compactLedger(ledger, { erasedIds: new Set([id]), keepValidVerify: this.keepValidVerifyFor(sk) });
      } catch (e) {
        throw new Error(`erase: permanent compaction failed (ledger may contain a malformed row): ${(e as Error).message}`);
      }
    }
    this.rankCache = null;   // I8: self-erase gives zero in-memory retention window
  }
}
