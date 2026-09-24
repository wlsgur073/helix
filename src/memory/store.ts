import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, MemoryState, ProvenanceSource, ScopedRecord, ScopedHistoricalRecord, ScopedAsOfFact } from '../types.js';
import { parseLedger, parseLedgerHealth, readLedgerBytes, compactLedger, planCompaction, serializedBytes, isMarkerShape, isWitnessFence, landedCompactionStats, type CompactionStats, type LedgerPath } from './ledger.js';
import { appendWitnessed, appendWitnessedUnlocked } from './witness-write.js';
import { scopeKeyOf, readScopeWitness, classifyState, completeTransition, discardTransition, WitnessBlockedError } from './witness-store.js';
import { cheapGate, dirtyGate } from './compaction-trigger.js';
import type { CompactionConfig } from '../config.js';
import { buildHistory, ledgerTruncated } from './history.js';
import { buildAsOfEvidence } from './asof.js';
import { findSecrets, redactSecrets, selectWriteRedactions } from './secret-scan.js';
import { canCommit, isVerifyingSource, resolveTransition, type TransitionResult, type VerifyOutcome } from './firewall.js';
import { runRealityCheck, checkBinding, type RealityCheck } from './reality-check.js';
import { type RecallOptions } from './projection.js';
import { rankWithArtifacts, buildRankArtifacts, assertQueryWithinBounds, type Expansion } from './retrieval.js';
import { defaultExpansion, SEM_DISCOUNT, SEM_GATE } from './expansion.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce, collectWitnessNotes, asOfWitnessNotes } from './content-frame.js';
import { isOwned, stampOwnership, projectDispositionOf, canonicalRoot, isReviewableRoot, trustStateOf, aliasesAdoptedLedger, type ProjectDisposition, type TrustState } from './ownership.js';
import { ensureMaster, signVerify, verifyVerify, digestContent, MAC_VERSION } from './ledger-mac.js';
import { buildVerifiedProjection, isKnownState, enforceWitnessProjection, clampElevatedState, type VerifiedProjection } from './verified-projection.js';
import { subkeyForScope, verifiedLiveOf, verifiedLiveStats, verifiedLiveWitnessed, verifiedProjectionWithSubkey } from './verified-read.js';
import { readLedgerWitnessed, readLedgerBytesWitnessed } from './witness-read.js';
import { interruptedAtPredecessor, type WitnessVerdict } from './witness-core.js';
import { ledgerDigest, subkeyFingerprint, keyVectorEqual, type ScopeKeyComponent, type RecallCacheEntry } from './recall-cache.js';
import type { MetricsSink } from '../metrics.js';
import { withFileLock } from './lock.js';
import { MAX_COMMIT_CONTENT_CHARS, RECALL_RECENCY_APPENDIX_COUNT } from '../limits.js';

export interface MemoryStoreOptions {
  sessionId?: string;
  now?: () => string;   // ISO timestamp source (injectable for tests)
  genId?: () => string; // id source (injectable for tests)
  genNonce?: () => string; // injectable per-frame nonce source (default crypto)
  /** When set, enables the project scope layer (in-repo ledger + ownership gate).
   *
   *  The project scope layer. It deliberately does NOT carry a `home`: the trust store's location is
   *  `opts.home`, which is required, so a second field naming the same directory would be a second
   *  place for it to be wrong. That is not hypothetical — the two used to be separate, and the
   *  comment claiming they were always equal was false against the shipped wiring. */
  project?: { ledger: string; root: string };
  /** Injectable ownership stamp source (default crypto). */
  genStamp?: () => string;
  /** Where the ledger-MAC master key, the scope-nonce registry and the rollback witness live.
   *  REQUIRED, and deliberately so: this used to default to `dirname(global)`, which made the
   *  location of the entire trust store a function of wherever the LEDGER happened to be. Repointing
   *  the ledger then moved the signing key with it — including into a git-tracked tree — while
   *  SECURITY.md promised the key never leaves the user's home. The trust store's address is not a
   *  derivable convenience; a caller that cannot say where it lives has no business opening one. */
  home: string;
  /** EH-3: precomputed synonym expansion. Defaults to the committed asset; tests may inject/disable. */
  expansion?: Expansion;
  /** Metrics sink (spec 2026-07-05). Absent => zero emission (tests/bench/library use stay clean). */
  metricsSink?: MetricsSink;
  /** Resolved auto-compaction config (spec 2026-07-09). Injected by the server from the GLOBAL config
   *  only; absent => disabled. */
  compaction?: CompactionConfig;
  /** W-CITE write policy: persist entropy-only benign word chains verbatim instead of redacting
   *  them (selectWriteRedactions decides span by span; hex, named/heuristic overlaps and
   *  credential-adjacent spans keep redacting regardless). Injected by the server from the GLOBAL
   *  config (`persistence.releaseWordChains`); ABSENT => true, the shipped default. */
  releaseWordChains?: boolean;
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
  /** The target's `contentDigest`, as a read (recall / inspect) handed it back. REQUIRED when the
   *  target is guarded — verified, or claiming a human author — and ignored otherwise. It is proof
   *  the caller retrieved what it is replacing; a blind or prompt-injected supersede cannot produce
   *  it. It is NOT a credential: see the gate in `commit` for why nothing here can be. */
  supersedesDigest?: string;
  /** Where to store the fact. Default 'project' when a project layer is active, else 'global'. */
  scope?: MemoryScope;
}

export interface RecalledItem {
  record: MemoryRecord;
  scope: MemoryScope;
  needsReverify: boolean;
  /** 'compromised' iff the verifying replay had a key AND this target carries at least one VALID
   *  SIGNED verify AND that replay saw either tampering signal: an equal-generation MAC conflict
   *  (R-conflict — two valid verifies at one gen disagreeing on state), OR a duplicate fact id (two
   *  DIFFERING records claiming this id, so which is genuine is not knowable; byte-identical repeats
   *  are exempt as at-least-once append replays). The second cause needs no verify CONFLICT — one
   *  genuine verify plus a forged twin reaches it — but it does need that verify: both signals are
   *  raised only inside the per-target grading loop, which iterates targets that have one. So a
   *  duplicate id on a fact NOTHING has verified reads 'ok' here even though forgedFactIds sees it
   *  (measured) — there is no grade to withhold, and none is conferred, but no alarm is raised
   *  either. 'ok' also covers key-absent, where nothing is graded at all (see
   *  RecallResult.integrityAvailable), and a forged elevation that was simply ignored (it shows its
   *  honest clamped state, no conflict). */
  integrity: 'ok' | 'compromised';
  /** SHA-256 of this record's content, carried through from the verified projection so the RECALL
   *  surface can publish it. Optional for the same reason ScopedRecord.contentDigest is: a pairing
   *  built outside the store's verified projection may omit it. */
  contentDigest?: string;
}

export interface RecallResult {
  items: RecalledItem[];
  /** H1 recency appendix: the newest served records NOT in `items`, included regardless of rank —
   *  the lexical(+semantic-neighbor) ranker cannot reach a record sharing no literal term with the
   *  query, however new it is (mechanism confirmed by experiment, dogfood channel 07-12). Kept
   *  SEPARATE from `items` so rank consumers (the pilot Hit@K scripts) keep measuring the ranker
   *  alone; the tool surface renders both and discloses these ids in a trusted out-of-frame note.
   *  At most RECALL_RECENCY_APPENDIX_COUNT entries, newest first (tx desc, append order breaking
   *  same-millisecond ties), additive beyond `maxItems`. */
  appendix: RecalledItem[];
  framed: string; // DATA-quarantined block for prompt injection
  /** False when no master key is available — every state is conservatively clamped to Fresh and
   *  no elevation can be trusted (the verifying replay ran in key-absent mode). */
  integrityAvailable: boolean;
  /** B2: this call's single project-disposition snapshot (B1), for the caller's unadopted-ledger
   *  disclosure note. Computed ONCE per call, outside the A4 rank cache (recallInput's key vector
   *  only covers PARTICIPATING scopes, so a foreign file's appearance never changes the key — this
   *  field is what lets the note still flip under a cache HIT). */
  projectDisposition: ProjectDisposition;
  /** W-T7: ordered, deduped rollback-witness disclosure notes for the participating scopes (mismatch/
   *  interrupted/first-contact). Recomputed FRESH every call from the per-scope verdict — never cached
   *  — so a cache HIT still surfaces a witness that flipped since the slot was built. */
  witnessNotes: string[];
}

export interface RecheckResult {
  outcome: VerifyOutcome;
  result: TransitionResult;
  record: MemoryRecord | null;
}

/** A refusal thrown by `resolveEraseTarget` / `erase` BEFORE any byte moves — the pre-write half of
 *  handlers.ts's three-way erase audit. Read by property (`isEraseRefusedError`), never instanceof,
 *  for the reason witness-store.ts's `isWitnessAdvanceError` sets out. */
export class EraseRefusedError extends Error {
  readonly eraseRefused = true;
  constructor(message: string) { super(message); this.name = 'EraseRefusedError'; }
}
export const isEraseRefusedError = (e: unknown): boolean =>
  e instanceof Error && (e as { eraseRefused?: unknown }).eraseRefused === true;

/** Orchestrates the deterministic core modules over a real JSONL ledger file. */
export class MemoryStore {
  constructor(private readonly global: LedgerPath, private readonly opts: MemoryStoreOptions) {
    // Belt and braces for callers that reach this from JavaScript, where the required-ness of
    // `home` is only a compile-time claim: without it every trust-store path would silently become
    // `join(undefined, …)` and throw somewhere far from the mistake.
    if (!this.opts?.home) throw new Error('MemoryStore: `home` is required — the trust store location must be stated, never derived from the ledger path');
  }

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

  /** Where the ledger-MAC master key, the scope-nonce registry and the rollback witness live. */
  private homeDir(): string { return this.opts.home; }

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
   *  INVARIANT: the helper uses a SINGLE home for both the master read AND the project scope nonce.
   *  `opts.home` is required, so that home is whatever the caller declared — it is no longer derived
   *  from the ledger's directory, and there is no second candidate to disagree with it. (The comment
   *  that used to sit here asserted "the server wiring always sets opts.home === project.home"; the
   *  wiring set no top-level `home` at all, so the invariant it claimed was false exactly when it
   *  mattered.) */
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

  /** Chokepoint gate for compaction: does `subkey` GENUINELY validate this verify under the CURRENT
   *  MAC version (no future-version clause)? If nothing in a ledger proves the key, the key is wrong
   *  and compaction must preserve every verify rather than delete genuine ones as "forged". */
  private provesKeyFor(subkey: Buffer | null): (r: MemoryRecord) => boolean {
    return subkey ? (r) => verifyVerify(r, subkey) && isKnownState(r.state) : () => false;
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
    // H3 (2026-08-18 review): the FIRST statement of validation, before the secret scan and before
    // any append -- an oversized commit must cost O(1), not pay for a scan of content that is about
    // to be rejected anyway. Schema-enforced too (helix-server.ts), so an MCP caller never reaches
    // this method with oversized content in the first place; this is the authoritative check for
    // callers that do not come through MCP (hooks, CLI, tests). See src/limits.ts's header.
    if (input.content.length > MAX_COMMIT_CONTENT_CHARS) {
      throw new Error(`helix: content exceeds the ${MAX_COMMIT_CONTENT_CHARS}-char commit cap (got ${input.content.length}); split the fact or store a pointer`);
    }
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
      // WITHOUT its ownership-claim side effect, so a rejected commit never stamps/creates a ledger.
      // M-3: one cell now diverges on purpose rather than mirrors it — an explicit 'project' scope
      // with no active project layer, which targetLedger() REFUSES outright, this line still routes
      // to global. Harmless: that refusal fires at the real targetLedger() call below, before any
      // write, so this mirror's routing choice for that one cell never reaches disk either way.)
      const writeLedger = input.scope === 'global' || !this.opts.project ? this.global : this.opts.project.ledger;
      if (targetLedger !== writeLedger) {
        throw new Error('commit: cannot supersede across scopes (target lives in a different ledger)');
      }
      // NOT an authorization boundary, and it never was: nothing a commit carries is authenticated.
      // Three things used to be collapsed into one word here — `state` is cryptographically protected
      // assurance, `provenance.source` is an untrusted attribution hint, and "may this be replaced"
      // is an operation policy. The old test read BOTH sides' provenance, so the credential it
      // checked was the caller's own claim: declaring source='user' walked past a Verified target,
      // and stripping a target's claimed source (boundary write) stripped its protection.
      //
      // What is enforceable is PROOF OF READ. A caller that retrieved the target can echo the
      // digest the read path handed it; one acting blind — the prompt-injected case this guard is
      // really for — cannot. `source` no longer participates in either direction.
      //
      // The provenance disjunct stays, reframed: it selects WHICH records are guarded, and dropping
      // it would leave a Fresh human-authored record with no protection at all. Residual, stated
      // rather than hidden: an adversary who can guess the target's content byte-exactly can compute
      // the digest without reading it — narrower than declaring an enum value, and short predictable
      // facts are the weak case. Superseding a Verified record still costs the grade regardless: the
      // signed verify binds (id, contentDigest), so replacement content replays as Fresh.
      // TWO TIERS, because one word was doing two jobs. `state` is cryptographically protected
      // assurance; `provenance.source` is an untrusted attribution hint; "may this be replaced" is an
      // operation policy. Collapsing them made the caller's own claim the credential.
      //
      // Tier 1 — accident guard, behaviour unchanged and separately tested ("refuses a
      // non-authoritative supersede of a user fact"). A commit that does not claim a human author may
      // not displace one that does. Both sides are self-asserted, so this restrains honest callers
      // only; that is all it was ever doing, and the error now says so.
      const claimsHumanAuthor = isVerifyingSource(target.provenance.source);
      const isVerified = target.state === 'Verified';
      if ((claimsHumanAuthor || isVerified) && !isVerifyingSource(source)) {
        throw new Error(
          'commit: refusing to supersede a human-authored or verified fact from a source that claims ' +
          'neither (user-relayed / agent-inference). This is an accident guard, not an authorization ' +
          'check — no field a commit carries is authenticated. Commit as source=user if you are ' +
          'authoring this, or reconcile via recall.',
        );
      }
      // Tier 2 — the actual fix. Tier 1's credential is a model-supplied enum, so declaring
      // source='user' walked straight past a Verified target: the highest tier was protected by the
      // cheapest possible claim. What IS enforceable is proof of read — a caller that retrieved the
      // target can echo the digest the read path handed it; one acting blind, which is the
      // prompt-injected case this exists for, cannot. Applied only to Verified targets: that is where
      // `state` is MAC-covered, so the guard sits exactly on the authenticated boundary and does not
      // tax the ordinary Fresh update path.
      //
      // Residual, stated rather than hidden: an adversary who can guess the content byte-exactly can
      // compute the digest without reading it — far narrower than declaring an enum value, with short
      // predictable facts the weak case. Superseding a Verified record still costs the grade either
      // way: the signed verify binds (id, contentDigest), so replacement content replays as Fresh.
      if (isVerified && input.supersedesDigest !== digestContent(target.content)) {
        throw new Error(
          'commit: supersedesDigest missing or stale. A verified fact may only be superseded by a ' +
          'caller that has read it — recall or inspect the target and echo its `contentDigest` back ' +
          'as `supersedesDigest`. Proof of read, not authorization: no field a commit carries is ' +
          'authenticated.',
        );
      }
    }
    const ts = this.now();
    let content = input.content;
    let classification: Classification = input.classification ?? 'normal';
    // W-CITE: findSecrets -> write-policy SELECTION -> redactSecrets(selected) -> persist. The
    // selection must be APPLIED here at the commit boundary, not inside redactSecrets: gating on
    // the UNSELECTED spans.length would re-enter the branch for an all-exempt record and either
    // falsely claim `secret-redacted` or erase a caller's `personal` (the design's round-1 Codex
    // counter). `secret-redacted` is set only when a span was actually replaced.
    const spans = findSecrets(input.content);
    const redactable = (this.opts.releaseWordChains ?? true) ? selectWriteRedactions(input.content, spans) : spans;
    if (redactable.length > 0) {
      // Span-level redaction: replace ONLY the secret tokens with a content-free marker, preserving
      // the surrounding text. A high-entropy false positive (e.g. a git SHA) no longer empties the
      // whole record; classification flags that a redaction happened.
      const red = redactSecrets(input.content, redactable);
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
    const ledger = this.targetLedger(input.scope);
    appendWitnessed(ledger, record, this.homeDir(), this.scopeRootOf(ledger), 'commit');
    return record;
  }

  /** Resolve the ledger to write to. Project scope claims ownership on first use and refuses a
   *  pre-existing unowned (foreign) ledger. With no project layer active, an OMITTED scope falls
   *  back to global — the contextual default — while an EXPLICIT 'project' is REFUSED rather than
   *  silently widened; see the argument on that branch below. */
  private targetLedger(scope: MemoryScope | undefined): LedgerPath {
    const p = this.opts.project;
    // An EXPLICIT project scope with no project layer used to fall through to the global ledger with
    // no signal: the caller named the narrower ledger and its record was persisted in the broader
    // one, undetectable except by inspecting the other scope. Refused instead. Deliberately narrow —
    // an OMITTED scope keeps the contextual default (project when a layer is active, global
    // otherwise), which is the overwhelming majority path, and an explicit 'global' is untouched.
    if (scope === 'project' && !p) {
      throw new Error(
        'commit: scope \'project\' was requested but no project memory layer is active here ' +
        '(Helix configures one only when started inside a directory holding a .helix folder). ' +
        'Omit `scope` to use the contextual default, or start Helix inside the project and adopt it ' +
        '(helix_memory_adopt) — the write is refused rather than silently widened to the global ledger.',
      );
    }
    if (scope === 'global' || !p) return this.global;
    // ALIAS-P2P (item 7): an owned layer whose ledger leads to ANOTHER adopted project's file is
    // refused, never written through — and never silently widened to the global ledger either.
    if (isOwned(p.root, this.homeDir()) && aliasesAdoptedLedger({ root: p.root, home: this.homeDir(), ledger: p.ledger })) {
      throw new Error(
        "commit: this project's memory file resolves to another adopted project's memory file, so the " +
        "project layer is disabled here — the write is refused rather than written into the other " +
        "project's memory. Pass scope 'global', or replace the link with the project's own file.",
      );
    }
    if (!isOwned(p.root, this.homeDir())) {
      if (existsSync(p.ledger)) {
        throw new Error(
          'commit: a project memory file exists here that Helix did not create — ' +
          'adopt it explicitly (helix_memory_adopt) or remove it',
        );
      }
      // autoAdoptLedger: re-check under the registry lock that no foreign ledger appeared between the
      // existsSync above and the stamp — closing the check-then-adopt TOCTOU on the auto-adopt path.
      stampOwnership(p.root, this.homeDir(), { now: this.opts.now, genStamp: this.opts.genStamp, autoAdoptLedger: p.ledger });
    }
    return p.ledger;
  }

  /** Snapshot the project layer's disposition, for the READ side (recall/inspect/history/asOf — see
   *  each call site below). Computed once per public read call and reused for every project-inclusion
   *  decision that call makes, so a single call can never disagree with itself about whether the
   *  project layer participates (Codex R2 #7). isOwned reads two files (the home registry + the
   *  repo-side .owner file), so this is a SNAPSHOT, not a lock: a concurrent adopt() between two
   *  SEPARATE calls — or mid-read within this one — can still change the answer. That race is accepted,
   *  not solved, here: each NEW call re-invokes this method (nothing is memoized on the instance), so
   *  the next call still sees a fresh, current answer (I4) — only a single call's internal
   *  self-consistency is what this method buys.
   *
   *  - 'owned': isOwned(p.root, home) — true regardless of whether the ledger FILE exists yet (an
   *    owned project with no ledger file still participates, matching pre-existing behavior).
   *  - 'aliased' (item 7): owned, but its ledger leads to another adopted project's ledger file
   *    (ownership.ts's aliasesAdoptedLedger). Excluded from every read like 'unadopted-present', with
   *    its own constant note; targetLedger() (commit) and resolveEraseTarget() (erase) both refuse to
   *    write through it.
   *  - 'unadopted-present': project configured, NOT owned, and a ledger file exists at p.ledger — the
   *    exact condition targetLedger() (above) already throws on for commit. The write side keeps its
   *    OWN independent, fresh isOwned/existsSync check — targetLedger's auto-stamp claim-on-first-use
   *    and fail-loud-on-foreign-ledger behavior is unaffected by this method or its caller.
   *  - 'inactive': no project layer configured, OR configured but neither owned nor a ledger file
   *    present — nothing to read, nothing to disclose.
   *
   *  B2: the four-state RULES above now live in the shared, pure projectDispositionOf (ownership.ts) —
   *  this method is a one-line delegate. What stays HERE is the call-site contract: invoke it ONCE per
   *  public read call (recall/currentView/historyView/asOfView each do so, then thread the snapshot as
   *  a parameter into every private helper that needs it, never re-invoking this within that call). */
  private projectDisposition(): ProjectDisposition {
    const p = this.opts.project;
    return projectDispositionOf(p && { root: p.root, ledger: p.ledger, home: this.homeDir() });
  }

  /** Verified live records from global + (project iff `disposition === 'owned'`), each tagged with
   *  scope + integrity, plus whether a master key was available for EVERY scope read
   *  (integrityAvailable). `disposition` is the caller's ALREADY-computed snapshot (B2) — this method
   *  never calls projectDisposition() itself, so one public call can never disagree with itself. */
  private scopedVerified(disposition: ProjectDisposition): { records: ScopedRecord[]; available: boolean } {
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
    if (p && disposition === 'owned') add(p.ledger, 'project');
    return { records: out, available };
  }

  /** Live records from global + (project iff `disposition === 'owned'`), each tagged with its scope. */
  private scopedProjection(disposition: ProjectDisposition): ScopedRecord[] {
    return this.scopedVerified(disposition).records;
  }

  /** Read-once, content-identity-keyed recall input (spec §5). Reads each participating ledger's bytes
   *  ONCE (I1), keys a single slot on (digest, fresh subkey fingerprint, scopeId) per scope (I2/I3),
   *  and reuses the cached scoped projection + rank artifacts on an exact match; else rebuilds from the
   *  SAME bytes. `disposition` is the caller's (recall's) single per-call snapshot (B2), threaded in
   *  rather than re-read here — it gates project participation (I4) exactly as before, but a stale
   *  disposition can never disagree with scopedVerified's because there is only one evaluation per
   *  call. NOTE: `disposition` participates ONLY in the `scopes` decision below, never in `key` — the
   *  cache stays keyed on participating-scope content identity alone, so an unadopted-present foreign
   *  file (not a participating scope) can appear/disappear across calls without forcing a rebuild; the
   *  caller (recall) re-computes `disposition` fresh every call regardless of cache hit/miss, which is
   *  what lets the disclosure note still flip under a cache HIT. */
  private recallInput(disposition: ProjectDisposition): { scoped: ScopedRecord[]; available: boolean; artifacts: ReturnType<typeof buildRankArtifacts>; verdicts: Array<{ scope: MemoryScope; verdict: WitnessVerdict }> } {
    const scopes: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined }> = [
      { ledger: this.global, scope: 'global', root: undefined },
    ];
    const p = this.opts.project;
    if (p && disposition === 'owned') scopes.push({ ledger: p.ledger, scope: 'project', root: p.root });

    // Bytes-only pass (Fix loop 1): digest + subkey fingerprint need nothing but the raw bytes, so the
    // cache-key check below runs BEFORE any parse — a HIT pays a read cost but ZERO parse cost, the A4
    // cache's original invariant. readLedgerBytesWitnessed reads witness-FIRST then the ledger bytes
    // with NO parse (readLedgerBytes), classifies, and retries once on an alarm (spec §7) — so a HIT
    // still never reaches a parse. readLedgerRaw (which parses eagerly) is deliberately NOT used here;
    // it stays reserved for non-cache-gated sites (historyView/asOfView/verifiedLiveStats).
    const home = this.homeDir();
    const key: ScopeKeyComponent[] = [];
    const verdicts: Array<{ scope: MemoryScope; verdict: WitnessVerdict }> = [];
    const reads: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; bytes: Buffer; subkey: Buffer | null; readMs: number; journalPending: boolean; mismatch: boolean }> = [];
    for (const s of scopes) {
      // W-T7 + §7: witness verdict + identity + journalPending, all off the SAME (final) witness snapshot
      // classified against the SAME (final) bytes — witness-first with a single alarm retry (no self-race,
      // no spurious mismatch from a concurrent append). The identity is a cache-key component; the verdict
      // is applied FRESH by recall() after cache resolution; journalPending forces a bypass.
      const w = readLedgerBytesWitnessed(s.ledger, home, s.root);
      const bytes = w.bytes;                          // I1: owned immutable buffer, read once — NO parse yet
      const subkey = this.subkeyForLedger(s.ledger);  // I3: resolved fresh from disk, never memoized
      key.push({ scopeId: s.ledger, digest: ledgerDigest(bytes), fingerprint: subkeyFingerprint(subkey), witness: w.witnessIdentity });
      verdicts.push({ scope: s.scope, verdict: w.verdict });
      // `mismatch` is the STABLE (witness-first + retry-once) rollback verdict — threaded into
      // maybeAutoCompact below so it never advances the witness onto a rolled-back scope (spec §4.2
      // PR-1, belt-and-braces above compactLedger's own authoritative gate).
      reads.push({ ledger: s.ledger, scope: s.scope, root: s.root, bytes, subkey, readMs: w.readMs, journalPending: w.journalPending, mismatch: w.verdict.kind === 'mismatch' });
    }

    // A pending journal means an in-flight rewrite: the cache is bypassed BOTH directions (no read,
    // no store) for this call, so a transition that resolves between calls can never be served from a
    // slot built under the pre-transition state. Verdicts are still returned (fresh) so recall() can
    // exclude the interrupted scope and render its note.
    const anyPending = reads.some((r) => r.journalPending);
    if (!anyPending && this.rankCache && keyVectorEqual(this.rankCache.key, key)) {
      return { scoped: this.rankCache.scoped, available: this.rankCache.available, artifacts: this.rankCache.artifacts, verdicts };
    }

    // MISS: parse the SAME bytes already read above (readLedgerBytes, in the per-scope loop) — ONE
    // parse per scope, reached only on a MISS. parseMs = read (r.readMs, captured above) + parse
    // (captured here), matching verifiedLiveStats' read-inclusive parseMs so the A3 replay curve stays
    // comparable across the store/hook emitters; projectMs is just the verifying replay. `parsed`
    // carries the records this loop just parsed, threaded into maybeAutoCompact below so IT never
    // re-parses either (the Task-4 double-parse-on-MISS-with-compaction-enabled fix, preserved).
    const parsed: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; records: MemoryRecord[]; subkey: Buffer | null; mismatch: boolean }> = [];
    const scoped: ScopedRecord[] = [];
    let available = true;
    for (const r of reads) {
      const t0 = performance.now();
      const { records } = parseLedgerHealth(r.bytes.toString('utf8'));
      const t1 = performance.now();
      const proj = verifiedProjectionWithSubkey(records, r.subkey);
      const t2 = performance.now();
      if (!proj.keyAvailable) available = false;
      for (const rec of proj.live.values()) {
        scoped.push({
          record: rec, scope: r.scope,
          integrity: proj.compromised.has(rec.id) ? 'compromised' : 'ok',
          contentDigest: digestContent(rec.content),   // proof-of-read token for a guarded supersede
        });
      }
      this.opts.metricsSink?.emitReplay({
        scope: r.root ? 'project' : 'global', caller: 'store',
        rows: records.length, liveRows: proj.live.size, bytes: r.bytes.length,
        parseMs: r.readMs + (t1 - t0), projectMs: t2 - t1, keyAvailable: proj.keyAvailable,
      });
      parsed.push({ ledger: r.ledger, scope: r.scope, root: r.root, records, subkey: r.subkey, mismatch: r.mismatch });
    }
    const artifacts = buildRankArtifacts(scoped.map((s) => s.record));
    // Store + auto-compact ONLY when no scope has a pending journal. A pending journal is bypassed both
    // directions (no store), and auto-compaction is itself a witnessed rewrite that must not race an
    // already-open transition — so it is skipped until the transition resolves.
    if (!anyPending) {
      this.rankCache = { key, scoped, available, artifacts };   // I5: single slot, atomic replace
      // Fire the once-per-session auto-compaction on the MISS path only. It returns the projection
      // computed ABOVE (locals, not the cache), so compaction cannot change what this recall answers:
      // compactLedger preserves the live projection by construction.
      this.maybeAutoCompact(parsed);
    }
    return { scoped, available, artifacts, verdicts };
  }

  /** D1 clamp on a single scoped record (the recall/P2 counterpart of clampElevated over a whole
   *  projection): an elevated live grade drops to Fresh, Fresh/Suspect are untouched, scope +
   *  integrity carried. */
  private clampScopedRecord(r: MemoryRecord): MemoryRecord {
    const state = clampElevatedState(r.state);
    return state === r.state ? r : { ...r, state };
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
  private maybeAutoCompact(reads: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; records: MemoryRecord[]; subkey: Buffer | null; mismatch: boolean }>): void {
    const cfg = this.opts.compaction;
    if (!cfg || this.compactedThisSession) return;
    const nowMs = Date.parse(this.now());
    for (const r of reads) {
      // Anti-laundering (spec §4.2 PR-1): NEVER auto-compact a scope whose pre-recall witness verdict
      // is a stable MISMATCH. compactLedger's own gate would throw here anyway, and the catch below
      // swallows it (functionally safe — a rolled-back scope is never silently re-blessed), but skipping
      // explicitly keeps the common path off a swallowed-exception crutch and does not consume the
      // once-per-session guard on a doomed attempt (the guard is only set when a scope actually fires).
      if (r.mismatch) continue;
      let mtimeMs = 0; let totalBytes = 0;
      try { const st = statSync(r.ledger); mtimeMs = st.mtimeMs; totalBytes = st.size; } catch { continue; }
      // records already read+parsed once by recallInput's own MISS-branch parse loop — reused here
      // instead of re-parsed, so a MISS with auto-compaction enabled still parses each scope's bytes
      // only once (Task 4's double-parse fix, preserved across Fix loop 1's readLedgerBytes rework).
      // Serialization is still total: every parsed record passed isWellFormedRecord's
      // depth cap (MAX_PARSE_DEPTH), which is far below JSON.stringify's overflow depth, so a deep row
      // is dropped at parse and never reaches serializedBytes/planCompaction — the depth cap (not a
      // wrap) is the load-bearing D6 protection for this path.
      const records = r.records;
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
      const provesKey = this.provesKeyFor(r.subkey);
      const { kept } = planCompaction(records, { erasedIds: new Set(), keepValidVerify, provesKey });
      // Fence-net the reclaim estimate: a witnessed compaction ALWAYS re-plants exactly one epoch
      // fence, and planCompaction ALWAYS drops any existing fence from `kept`. So a lone stale fence is
      // NOT net-reclaimable — it is dropped and immediately re-added. Counting it would make a
      // witnessed compaction non-idempotent, re-firing the trigger every session on the fence alone and
      // breaking the self-limiting invariant (spec §4.5). Measuring reclaim against the NON-fence input
      // rows nets it out (on a fence-free ledger this is identical to `records`, so a genuinely dirty
      // ledger is unaffected). `rows` for the gate stays the total PHYSICAL count (dirtyGate contract).
      // Same predicate planCompaction drops by — imported, not restated, so the estimate can never
      // drift from the keep-set it is estimating (see isWitnessFence).
      const inputNonFence = records.filter((rec) => !isWitnessFence(rec));
      const reclaimable = inputNonFence.length - kept.length;
      const reclaimableBytes = serializedBytes(inputNonFence) - serializedBytes(kept);
      if (!dirtyGate({ rows: records.length, reclaimable, reclaimableBytes, cfg })) continue;
      // Eligible: guard on ATTEMPT (before the call), fire, emit a metric, swallow errors.
      this.compactedThisSession = true;
      const started = performance.now();
      let stats: CompactionStats | null = null;        // null <=> the compaction threw <=> did not complete cleanly
      let landedStats: CompactionStats | null = null;   // set only when a THROWN compaction's rewrite had already landed (post-rename failure) — see ledger.ts's landedCompactionStats
      try {
        stats = compactLedger(r.ledger, {
          erasedIds: new Set(), keepValidVerify, provesKey,
          // Witnessed rewrite (spec §4.9): the auto-compaction is a prefix-changing rewrite, so it
          // advances the witness (plants a fence) — otherwise the next witnessed read would false-alarm.
          witness: { home: this.homeDir(), scopeKey: scopeKeyOf(this.homeDir(), r.root), now: () => this.now(), kind: 'compaction' },
        });
      } catch (e) {
        // swallowed: compaction must never break a recall. But a throw AFTER the rename landed still
        // dropped real rows on disk — recover them so the metric never claims "nothing happened" for a
        // rewrite that, in fact, already did.
        landedStats = landedCompactionStats(e) ?? null;
      }
      const durationMs = performance.now() - started;   // capture BEFORE any metrics I/O
      // Drop the entry this recall just installed. On a clean SUCCESS the ledger bytes changed, so the
      // content-identity key would miss anyway (belt and braces). On a FAILURE the bytes usually did NOT
      // change (a pre-rename throw is a pure no-op) — but a post-rename throw (landedStats set) DID
      // change them. Either way clearing here is correct: it forces the next recall to MISS and
      // re-enter this method, where the once-per-session guard, not a cache hit, then suppresses the
      // retry. Defensive on every path.
      this.rankCache = null;
      const real = stats ?? landedStats;   // whichever is non-null carries the REAL on-disk deltas
      this.opts.metricsSink?.emitCompaction({
        scope: r.root ? 'project' : 'global', durationMs,
        droppedRows: real?.droppedRows ?? 0, reclaimedBytes: real?.reclaimedBytes ?? 0,
        droppedForgedVerifies: real?.droppedForgedVerifies ?? 0, ok: stats !== null, landed: real !== null,
      });
    }
  }

  recall(query: string, opts: RecallOptions = {}): RecallResult {
    // Bound the query BEFORE any ledger read: this is the one always-available tool surface, so the
    // cheap check has to come before the expensive work it is protecting (parse + projection +
    // rank), not beside it.
    assertQueryWithinBounds(query);
    // B2: ONE disposition snapshot for this whole call, computed BEFORE consulting the rank cache and
    // never memoized in it — recallInput's key vector covers only PARTICIPATING scopes, so a foreign
    // unadopted ledger appearing/disappearing never changes the key and can serve a cache HIT; this
    // fresh-every-call read is what still lets the disclosure note flip under that HIT.
    const disposition = this.projectDisposition();
    const { scoped, available, artifacts, verdicts } = this.recallInput(disposition);
    // W-T7: apply the FRESH per-scope verdict to the (cache-resolved) scoped records — exclude a
    // transition-interrupted scope entirely, clamp a mismatched scope's elevated grades to Fresh (D1;
    // D1b — the rows are still served). Order is preserved, so when nothing is excluded the cached
    // rank artifacts still pair positionally; a genuine exclusion rebuilds them over the served set.
    const excluded = new Set<MemoryScope>();
    const clamped = new Set<MemoryScope>();
    for (const { scope, verdict } of verdicts) {
      if (verdict.kind === 'transition-interrupted') excluded.add(scope);
      else if (verdict.kind === 'mismatch') clamped.add(scope);
    }
    const enforcedScoped = (excluded.size === 0 && clamped.size === 0)
      ? scoped
      : scoped.reduce<ScopedRecord[]>((acc, s) => {
          if (excluded.has(s.scope)) return acc;
          acc.push(clamped.has(s.scope) ? { ...s, record: this.clampScopedRecord(s.record) } : s);
          return acc;
        }, []);
    const effectiveArtifacts = enforcedScoped.length === scoped.length ? artifacts : buildRankArtifacts(enforcedScoped.map((s) => s.record));
    // Keyed by the record OBJECT, not its id: ranking returns the very references it was handed
    // (retrieval.ts rankWithArtifacts maps records -> scored -> back to `s.rec`), so this pairing is
    // exact. An id-keyed map collapses last-wins under a cross-scope id collision and would report
    // ONE scope and ONE integrity verdict for both copies — the same hazard retrieval.ts:411-414
    // already fixed for the scoring path, on the tagging path it had been left on.
    const byRecord = new Map(enforcedScoped.map((s) => [s.record, s]));
    const expansion = this.opts.expansion ?? defaultExpansion();
    const hits = rankWithArtifacts(enforcedScoped.map((s) => s.record), effectiveArtifacts, query,
      { ...opts, expansion, semDiscount: SEM_DISCOUNT, semGate: SEM_GATE });
    // H1 (recency crowding): a record sharing no literal term with the query is unreachable by the
    // ranker no matter how new it is, so a session's newest decisions lose to older, longer
    // entries. The repair is this APPENDIX, not a score term: a wall-clock decay component would
    // make the same bytes rank differently across calls — the exact determinism class the
    // inspect-asof cursor fix retired — and would poison the A4 cache's HIT path. The appendix is
    // a pure function of the already-read served set (no extra ledger read), so a cache HIT
    // computes the same appendix as the MISS that built the slot.
    const ranked = new Set(hits);
    const appendixRecords = enforcedScoped
      .map((s, seq) => ({ rec: s.record, seq }))
      .filter(({ rec }) => !ranked.has(rec))
      .sort((a, b) => (a.rec.tx === b.rec.tx ? b.seq - a.seq : a.rec.tx < b.rec.tx ? 1 : -1))
      .slice(0, RECALL_RECENCY_APPENDIX_COUNT)
      .map(({ rec }) => rec);
    const toItem = (record: MemoryRecord): RecalledItem => ({
      record,
      scope: byRecord.get(record)?.scope ?? 'global',
      needsReverify: requiresReverifyBeforeUse({ state: record.state, blastRadius: record.blastRadius, source: record.provenance.source }),  // I7: recomputed per call
      integrity: byRecord.get(record)?.integrity ?? 'ok',
      contentDigest: byRecord.get(record)?.contentDigest,
    });
    const items: RecalledItem[] = hits.map(toItem);
    const appendix: RecalledItem[] = appendixRecords.map(toItem);
    return {
      items,
      appendix,
      framed: frameAsData([...items, ...appendix].map(({ record, scope, contentDigest }) => ({ record, scope, contentDigest })), this.nonce()),  // I7: fresh nonce per call
      integrityAvailable: available,
      projectDisposition: disposition,
      witnessNotes: collectWitnessNotes(verdicts.map((v) => v.verdict)),
    };
  }

  /** Which ledger currently holds `id` (project iff owned and present); defaults to global.
   *  D9: an id live in BOTH scopes at once (only reachable via a hand-planted/forged ledger row)
   *  is ambiguous — silently binding global would ignore the project duplicate. Throw instead. */
  private ledgerOf(id: string): LedgerPath {
    const p = this.opts.project;
    const inGlobal = this.verifiedOf(this.global).live.has(id);
    const inProject = !!p && isOwned(p.root, this.homeDir()) && this.verifiedOf(p.ledger).live.has(id);
    if (inGlobal && inProject) throw new Error('ledgerOf: id live in more than one scope — ambiguous');
    if (inProject) return p!.ledger;
    return this.global; // global, or fall through for a non-live id (callers re-gate liveness and throw)
  }

  /** Live projected record for `id` across scopes, or throw. Its own single disposition snapshot
   *  (this call is not a note-rendering surface, so nothing needs it threaded further). */
  private liveTarget(id: string): MemoryRecord {
    const found = this.scopedProjection(this.projectDisposition()).find((s) => s.record.id === id);
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
      // C1.4-③: a pending scope withholds its subkey (subkeyForScope returns null), which would
      // otherwise surface below as the misleading "not owned?" message. Name the real cause first:
      // trust is suspended by an unresolved ambiguous re-adoption, and a new verify must not be
      // minted until a human resolves it (repair or fresh) — minting now would confer trust the
      // pending state exists to withhold.
      const root = this.scopeRootOf(ledger);
      if (root && trustStateOf(root, this.homeDir()) === 'pending')
        throw new Error('writeVerify: scope is trust-pending (an ambiguous re-adoption) — resolve it (repair or fresh) before minting a verify');
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
      appendWitnessedUnlocked(ledger, signed, this.homeDir(), this.scopeRootOf(ledger), 'verify'); // we already hold the ledger lock — non-locking, witnessed append
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
      targetState: target.state,
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
      targetState: target.state,
      evidenceSource: 'user', outcome: { ran: true, indeterminate: false, passed: true },
    });
    // resolveTransition guarantees { kind:'state', state:'Verified' } for evidenceSource 'user'
    const state = result.kind === 'state' ? result.state : 'Verified';
    return { record: this.writeVerify(id, state, 'user') };
  }

  inspect(): ScopedRecord[] {
    return this.currentView().records;
  }

  /** Current live projection PLUS the single disposition snapshot (B2) used to gate it — the
   *  disposition-threaded counterpart of `inspect()`, for the current-view MCP surface's
   *  unadopted-ledger + rollback-witness disclosure notes. `inspect()` itself stays array-shaped
   *  (unchanged, many call sites); this is the one entry a caller uses when it also needs the notes.
   *
   *  W-T7: routes each scope through verifiedLiveWitnessed (single raw read → projection + verdict,
   *  no self-race), applies read-side witness enforcement (clamp on mismatch / exclude on
   *  transition-interrupted), and emits the replay metric verifiedOf used to. It deliberately does NOT
   *  reuse scopedProjection()/verifiedOf(): those stay UNENFORCED for the write/routing paths
   *  (commit/ledgerOf/erase/liveTarget), where a witness clamp must not change authority checks. */
  currentView(): { records: ScopedRecord[]; projectDisposition: ProjectDisposition; witnessNotes: string[] } {
    const disposition = this.projectDisposition();
    const home = this.homeDir();
    const records: ScopedRecord[] = [];
    const verdicts: WitnessVerdict[] = [];
    const addScope = (ledger: LedgerPath, scope: MemoryScope, root: string | undefined): void => {
      const w = verifiedLiveWitnessed(ledger, home, root);
      this.opts.metricsSink?.emitReplay({
        scope: root ? 'project' : 'global', caller: 'store',
        rows: w.stats.rows, liveRows: w.stats.liveRows, bytes: w.stats.bytes,
        parseMs: w.stats.parseMs, projectMs: w.stats.projectMs, keyAvailable: w.stats.keyAvailable,
      });
      const proj = enforceWitnessProjection(w.projection, w.verdict);
      for (const r of proj.live.values()) {
        records.push({
          record: r, scope,
          integrity: proj.compromised.has(r.id) ? 'compromised' : 'ok',
          contentDigest: digestContent(r.content),   // proof-of-read token for a guarded supersede
        });
      }
      verdicts.push(w.verdict);
    };
    addScope(this.global, 'global', undefined);
    const p = this.opts.project;
    if (p && disposition === 'owned') addScope(p.ledger, 'project', p.root);
    return { records, projectDisposition: disposition, witnessNotes: collectWitnessNotes(verdicts) };
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
  historyView(): { rows: ScopedHistoricalRecord[]; anomalies: Set<string>; truncated: boolean; integrityAvailable: boolean; projectDisposition: ProjectDisposition; witnessNotes: string[] } {
    // B2: ONE disposition snapshot for this call, computed up front and reused below — never a second
    // this.projectDisposition() call within this method.
    const disposition = this.projectDisposition();
    const home = this.homeDir();
    const rows: ScopedHistoricalRecord[] = [];
    const anomalies = new Set<string>();
    let truncated = false;
    // false if ANY read scope lacked a master key (mirrors scopedVerified). Intended semantic:
    // availability over the scopes whose rows are actually SERVED; today it also spans
    // witness-EXCLUDED scopes' key availability — indistinguishable while every scope shares the
    // one master key. If per-scope keys ever ship, compute over included scopes only.
    let integrityAvailable = true;
    const verdicts: WitnessVerdict[] = [];

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const root = this.scopeRootOf(ledger);
      // ONE witnessed read per scope (spec §7): witness-first + retry-once. bytes feed the verdict,
      // records feed both projections — all from the SAME final read pair, so the verdict can never
      // race the projection and an ordinary concurrent append never yields a spurious mismatch.
      const w = readLedgerWitnessed(ledger, home, root);
      verdicts.push(w.verdict);
      if (w.verdict.kind === 'transition-interrupted') return; // exclude the whole scope (live AND closed rows)
      // Live rows (graded) — membership authority + LEFT-join enrichment, identical to verifiedOf —
      // then the witness clamp (mismatch => elevated LIVE grades drop to Fresh; closed rows below keep
      // their historical state, like asOf).
      const rawV = verifiedLiveOf(w.records, home, root);
      if (!rawV.keyAvailable) integrityAvailable = false; // key-absent => every grade clamped Fresh (fail-safe)
      const v = enforceWitnessProjection(rawV, w.verdict);
      for (const r of v.live.values()) {
        rows.push({
          record: r, scope, txTo: null, closedBy: null,
          integrity: v.compromised.has(r.id) ? 'compromised' : 'ok',
          contentDigest: digestContent(r.content),   // LIVE rows only — see ScopedHistoricalRecord
        });
      }
      // Closed rows from the SAME record array.
      const h = buildHistory(w.records);
      for (const id of h.anomalies) anomalies.add(id);
      if (h.truncated) truncated = true;
      for (const row of h.rows) {
        if (row.closedBy === null) continue; // live rows already added (graded) above
        rows.push({ ...row, scope, integrity: 'ok' });
      }
    };
    addScope(this.global, 'global');
    const p = this.opts.project;
    if (p && disposition === 'owned') addScope(p.ledger, 'project');

    return { rows, anomalies, truncated, integrityAvailable, projectDisposition: disposition, witnessNotes: collectWitnessNotes(verdicts) };
  }

  /** Point-in-time forensic snapshot at system-time `t` (spec C §5). Mirrors historyView's ATOMIC
   *  single-parse-per-scope: each scope's ledger is parsed ONCE and the single array feeds
   *  buildAsOfEvidence + ledgerTruncated. `t` is assumed canonical (the surface validates). Membership
   *  and v1 verify timing are DECLARED; only v2 verify tx is authenticated (per-evidence flag). */
  asOfView(t: string): { facts: ScopedAsOfFact[]; keyAvailable: boolean; truncated: boolean; projectDisposition: ProjectDisposition; witnessNotes: string[] } {
    // B2: ONE disposition snapshot for this call (see historyView's identical comment).
    const disposition = this.projectDisposition();
    const home = this.homeDir();
    const facts: ScopedAsOfFact[] = [];
    let keyAvailable = true;
    let truncated = false;
    const verdicts: WitnessVerdict[] = [];

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const root = this.scopeRootOf(ledger);
      // ONE witnessed read per scope (spec §7): witness-first + retry-once, so the verdict and the
      // records come from the SAME final read pair (no spurious mismatch from a concurrent append).
      const w = readLedgerWitnessed(ledger, home, root);
      verdicts.push(w.verdict);
      if (w.verdict.kind === 'transition-interrupted') return; // exclude the scope entirely; the note still renders below
      const subkey = this.subkeyForLedger(ledger);
      const out = buildAsOfEvidence(w.records, t, {
        verify: (r) => (subkey ? verifyVerify(r, subkey) : false),
        keyAvailable: subkey !== null,
      });
      if (!out.keyAvailable) keyAvailable = false;
      if (ledgerTruncated(w.records)) truncated = true;      // over the FULL records, not the t-window
      // asOf facts are HISTORICAL — a mismatch renders the note (below) but does NOT clamp the grades
      // (a point-in-time reconstruction keeps what the ledger attested then).
      // The digest is computed HERE, not at render time: `capRendered` calls its `render(n)` closure
      // O(log n) times while binary-searching the item count that fits, so a digest taken in the
      // renderer would be re-hashed on every probe. It is also the value the verify binds — asof.ts
      // computes the identical `digestContent(rec.content)` to test a promotion's targetDigest — so a
      // reader can quote it against the same ledger the echo guard consults.
      for (const f of out.facts) facts.push({ ...f, scope, contentDigest: digestContent(f.record.content) });
    };
    addScope(this.global, 'global');                       // exact project block copied from historyView
    const p = this.opts.project;
    if (p && disposition === 'owned') addScope(p.ledger, 'project');
    // The as-of surface never clamps, so the LIVE mismatch note (which promises a clamp) is false here.
    // Mapped at the SOURCE so a library caller gets the surface-true wording, not only the tool.
    return { facts, keyAvailable, truncated, projectDisposition: disposition, witnessNotes: asOfWitnessNotes(collectWitnessNotes(verdicts)) };
  }

  /** Explicitly adopt the active project ledger (trust its current contents). For team-shared
   *  ledgers. Throws if no project layer is active, or if `expectedRoot` names a different one.
   *
   *  The caller must NAME the root it means. Adoption moves a trust boundary — it is the only other
   *  tool besides confirm that changes what Helix trusts — and a zero-argument call gives the
   *  approval prompt nothing to show, so a user could only ever approve the ACT, never the target.
   *  Requiring the root means the prompt names the ledger, and an agent that guessed wrong adopts
   *  nothing instead of silently adopting whatever scope happened to be active. The check lives
   *  here rather than in the handler because this is where the authority is: a caller reaching the
   *  store directly must clear the same gate. Returns the canonical scope for the audit row. */
  adopt(expectedRoot: string): string {
    const p = this.opts.project;
    // BEFORE the scope lookup, so a root that names nothing fails as ONE clean rejection naming the
    // real problem, instead of being resolved against cwd and then passing the equality check below.
    if (!isReviewableRoot(expectedRoot))
      throw new Error('adopt: projectRoot must be an absolute path — a relative or empty root resolves to wherever the server is running, so the approval prompt has no target to show');
    if (!p) throw new Error('adopt: no project scope is active');
    const active = canonicalRoot(p.root);
    if (canonicalRoot(expectedRoot) !== active)
      throw new Error(`adopt: the named project root is not the active project scope (${active})`);
    stampOwnership(p.root, this.homeDir(), { now: this.opts.now, genStamp: this.opts.genStamp });
    // Make signing possible going forward (future confirm/recheck can mint signed verifies), but
    // do NOT sign or bless any pre-existing record: adoption must never launder an unsigned,
    // pre-seeded elevated assert into a Verified one. R1's replay clamp already demotes such a
    // record to Fresh — this only ensures the master exists, it signs nothing that already exists.
    ensureMaster(this.homeDir());
    return active;
  }

  /** C1.4-③: the active project scope's trust disposition (`active`/`pending`), or 'active' when no
   *  project layer is configured. Lets the adopt handler DISCLOSE a trust-pending re-adoption rather
   *  than claim the ledger is trusted while trust is suspended. */
  projectTrustState(): TrustState {
    const p = this.opts.project;
    return p ? trustStateOf(p.root, this.homeDir()) : 'active';
  }

  /** The marker family a canonical id ADDRESSES, or null. `integrity_marker` / `horizon_marker` are
   *  single canonical ids; a witness fence has one id per epoch+nonce, so ANY id wearing that prefix
   *  addresses the family (C10 — a caller erasing "the fence" need not know the nonce). This is the
   *  id-side half; `markerFamilyOf` below is the row-side half. */
  private familyPrefixOf(id: string): 'integrity_' | 'horizon_' | 'witness_fence_' | null {
    if (id === 'integrity_marker') return 'integrity_';
    if (id === 'horizon_marker') return 'horizon_';
    if (id.startsWith('witness_fence_')) return 'witness_fence_';
    return null;
  }

  /** The family of a marker-SHAPED row, or null for any row that is not a marker — whatever its id.
   *  Takes the RECORD, not the id (R5(c)): a live assert wearing a marker prefix is a record.
   *  Membership is by family PREFIX, mirroring ledger.ts's isIntegrityMarker / isHorizonMarker /
   *  isWitnessFence (marker SHAPE + prefix): a marker row of a fixpoint family need NOT carry the
   *  canonical id — anyone who can append an `integrity_`-prefixed marker row mints one (ledger.ts's
   *  F5 residual), and clearing it is exactly what the C10 family match is for. Deliberately wider
   *  than familyPrefixOf, which answers the narrower id-side question of what an id ADDRESSES. */
  private markerFamilyOf(r: MemoryRecord): 'integrity_' | 'horizon_' | 'witness_fence_' | null {
    if (!isMarkerShape(r)) return null;
    if (r.id.startsWith('integrity_')) return 'integrity_';
    if (r.id.startsWith('horizon_')) return 'horizon_';
    if (r.id.startsWith('witness_fence_')) return 'witness_fence_';
    return null;
  }

  /** What `id` names in `ledger`, classified by the parsed ROWS (R5(c)):
   *  - 'record'    a non-marker row with exactly this id (live or raw) — an exact id always wins
   *                over a family-only marker match, so a live row wearing a marker prefix is erasable;
   *  - 'marker'    only marker-shaped rows match: this exact id, or this id's family (C10);
   *  - 'ambiguous' a record AND a marker row carry the SAME exact id — a SOFT erase tombstones the
   *                record (marker rows are inert to a tombstone); a PERMANENT erase purges every row
   *                carrying the id;
   *  - 'absent'    nothing matches.
   *  Snapshot-relative: computed before the mutation lock, exactly like the presence check it
   *  replaces; a concurrent writer can create the ambiguity after this returns. */
  private findEraseTarget(ledger: LedgerPath, id: string): 'record' | 'marker' | 'ambiguous' | 'absent' {
    const records = parseLedger(ledger);
    const fam = this.familyPrefixOf(id);
    const recordHit = records.some((r) => !isMarkerShape(r) && r.id === id);
    const markerExact = records.some((r) => isMarkerShape(r) && r.id === id);
    const markerFamily = fam !== null && records.some((r) => this.markerFamilyOf(r) === fam);
    if (recordHit) return markerExact ? 'ambiguous' : 'record';
    if (markerExact || markerFamily) return 'marker';
    return 'absent';
  }

  /** Resolve the single ledger an erase acts on — and what the id names there — or null for a
   *  clean-and-absent no-scope no-op. Throws on: unowned project scope; explicit scope where the id
   *  is absent (C4/D7); a no-scope PERMANENT erase over a ledger with any skipped line (C5/C6); or a
   *  no-scope id present in more than one scope (D9) — which a SOFT erase reaches only when no single
   *  candidate holds a record with this exact id (I-2). `permanent` gates the corruption check: a
   *  physical purge must not silently miss a secret hiding in a skipped line, but a SOFT erase only
   *  tombstones (parseLedger tolerates a torn line as §10 specifies), so an unrelated corrupt line
   *  must never brick it (finding 2). */
  private resolveEraseTarget(id: string, scope: MemoryScope | undefined, permanent: boolean): { ledger: LedgerPath; kind: 'record' | 'marker' } | null {
    const p = this.opts.project;
    const owned = !!p && isOwned(p.root, this.homeDir());
    const aliased = owned && aliasesAdoptedLedger({ root: p!.root, home: this.homeDir(), ledger: p!.ledger });
    const projectActive = owned && !aliased;
    const classify = (ledger: LedgerPath): 'record' | 'marker' | null => {
      const kind = this.findEraseTarget(ledger, id);
      if (kind === 'ambiguous') {
        // A marker-shaped row and a record carry the same exact id. A SOFT erase tombstones the RECORD:
        // the tombstone acts on the id in the projection, and marker-shaped rows never enter the live
        // projection (null target), so no marker row is touched either way — refusing here protected
        // nothing and let anyone who can append a row deny the record's erasure (final review, I-1).
        // A PERMANENT erase is a physical purge of every row carrying the id, marker and record alike
        // (compactLedger drops by id — "erasure still wins"), so it routes as a marker: no tombstone,
        // straight to compaction — the documented out-of-band escape for a planted marker.
        return permanent ? 'marker' : 'record';
      }
      return kind === 'absent' ? null : kind;
    };
    if (scope) {
      // An EXPLICIT project scope with no project layer used to route to the GLOBAL ledger with no
      // signal — for a DESTRUCTIVE operation. Refused, mirroring targetLedger's commit-side refusal.
      // A project layer exists only when the server started inside a directory holding .helix/
      // (src/server/index.ts), so adopting cannot cure this state on its own.
      if (scope === 'project' && !p) {
        throw new EraseRefusedError(
          'erase: scope \'project\' was requested but no project memory layer is active here ' +
          '(Helix configures one only when started inside a directory holding a .helix folder). ' +
          'Omit `scope`, or start Helix inside the project and adopt it (helix_memory_adopt) — ' +
          'the erase is refused rather than silently widened to the global ledger.',
        );
      }
      if (scope === 'project' && aliased) {
        throw new EraseRefusedError(
          "erase: this project's memory file resolves to another adopted project's memory file — the " +
          "erase is refused rather than applied to the other project's memory.",
        );
      }
      const ledger = scope === 'global' || !p ? this.global
        : (projectActive ? p.ledger : (() => { throw new EraseRefusedError('erase: project ledger not owned — adopt it (helix_memory_adopt) then erase, or remove it'); })());
      const kind = classify(ledger);
      if (kind === null) throw new EraseRefusedError(`erase: id not found in scope ${scope}`);
      return { ledger, kind };
    }
    const candidates: LedgerPath[] = [this.global, ...(projectActive ? [p!.ledger] : [])];
    // Corruption gate — PERMANENT (destructive) erase only. The only production caller (the MCP tool)
    // issues soft, no-scope erases and cannot pass a scope, so gating this on `permanent` keeps
    // right-to-erasure via the tool available even when a candidate has a torn/partial line.
    if (permanent) {
      for (const c of candidates) {
        let text: string;
        try { text = readFileSync(c, 'utf8'); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // no ledger => no corruption
          throw err;
        }
        if (parseLedgerHealth(text).skippedNonBlank > 0) {
          throw new EraseRefusedError('erase: a ledger has skipped (corrupt/torn) lines — pass an explicit scope');
        }
      }
    }
    const hits: Array<{ ledger: LedgerPath; kind: 'record' | 'marker' }> = [];
    for (const c of candidates) {
      const kind = classify(c);
      if (kind !== null) hits.push({ ledger: c, kind });
    }
    // SOFT erases (the tool's only shape — it cannot pass a scope) prefer the one candidate holding a
    // RECORD with this exact id over candidates whose matches are marker rows, family or exact-id: every
    // ledger that has ever been rewritten carries a witness fence, so a marker-only hit is the ordinary
    // state of the OTHER scope, not a second home for the record (final review, I-2), and a soft erase
    // never tombstones a marker row, so preferring the record loses nothing. A permanent no-scope erase
    // with more than one hit stays refused — the operator passes an explicit scope.
    if (!permanent) {
      const recs = hits.filter((h) => h.kind === 'record');
      if (recs.length === 1) return recs[0]!;
    }
    if (hits.length > 1) throw new EraseRefusedError('erase: id present in more than one scope — pass an explicit scope');
    return hits[0] ?? null;
  }

  /** Remove an item from the live projection. Soft by default (tombstone only — recoverable until
   *  compaction, so an erroneous/poisoned erase can be undone). `permanent` compacts immediately for
   *  genuine right-to-erasure. Scope-aware routing (D5/D7/C4/C10): never falls back to a ledger the id
   *  does not live in — an explicit scope must contain the id or this throws; with no scope, exactly
   *  one candidate ledger may hold the id (else throws the multi-scope refusal), and a corrupt/torn
   *  line on ANY candidate throws rather than silently risking a wrong-file compaction. */
  erase(id: string, opts: { permanent?: boolean; scope?: MemoryScope } = {}): void {
    const target = this.resolveEraseTarget(id, opts.scope, opts.permanent ?? false);
    if (target === null) { this.rankCache = null; return; }   // clean + absent → idempotent no-op success
    const { ledger, kind } = target;
    // Anti-laundering (spec §4.2 PR-1): a PERMANENT erase ends in a witnessed compactLedger rewrite,
    // which refuses to advance the witness over a MISMATCH. Gate the WHOLE permanent erase up front on
    // the scope's stable (witness-first + retry-once) verdict, so a rolled-back scope is refused BEFORE
    // the tombstone append — never left tombstone-without-compaction (the plaintext stays on disk while
    // the row already reads as erased). Recovery is the user-only re-baseline ceremony (helix-rebaseline),
    // then re-erase. A SOFT erase is unaffected: its tombstone append is availability-correct (it lands
    // without advancing the witness on a mismatch, witness-write.ts). This up-front read is advisory; the
    // authoritative refusal is compactLedger's own under-lock gate, so a race here can never launder.
    if (opts.permanent && readLedgerBytesWitnessed(ledger, this.homeDir(), this.scopeRootOf(ledger)).verdict.kind === 'mismatch') {
      throw new WitnessBlockedError(
        'permanent-erase',
        `permanent-erase: scope for id '${id}' is in a MISMATCH (rollback-alarm) state — refusing a permanent erase that would launder the alarm; re-baseline the scope (helix-rebaseline) to adopt the current bytes, then retry (spec §4.2)`,
      );
    }
    try {
      const isMarker = kind === 'marker';                       // by the ROW, not the id (R5(c))
      const alreadyDead = !this.verifiedOf(ledger).live.has(id);
      if (!isMarker && !alreadyDead) {                          // skip tombstone for markers (T1-g) + already-dead ids (D8)
        const ts = this.now();
        appendWitnessed(ledger, {
          id: this.id(), tx: ts, validFrom: ts, validTo: null,
          type: 'erase', content: '', state: 'Suspect',
          provenance: { source: 'user', sessionId: this.session() },
          supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        }, this.homeDir(), this.scopeRootOf(ledger), 'erase');
      }
      if (opts.permanent) {
        // HMAC-aware compaction: preserve genuine signed verifies for this ledger, drop forgeries.
        // Resolve the subkey ONCE (see keepValidVerifyFor) so the whole compaction makes one atomic
        // keep/drop decision, and share that predicate with the auto-compaction trigger so the two
        // paths can never diverge. A permanent erase is a ledger REWRITE (prefix change), so it drives
        // the witness transition (kind:'erase') — otherwise the next witnessed read would false-alarm.
        const sk = this.subkeyForLedger(ledger);
        compactLedger(ledger, {
          erasedIds: new Set([id]), keepValidVerify: this.keepValidVerifyFor(sk), provesKey: this.provesKeyFor(sk),
          witness: { home: this.homeDir(), scopeKey: scopeKeyOf(this.homeDir(), this.scopeRootOf(ledger)), now: () => this.now(), kind: 'erase' },
        });
      }
    } finally {
      // I8: self-erase gives zero in-memory retention window — cleared even when the append landed
      // and a LATER step threw, so a landed tombstone can never be masked by a stale recall cache.
      this.rankCache = null;
    }
  }

  /** WRITE-side startup step (spec §4.9): complete any transition whose new bytes already landed
   *  before a crash (crash window B — verdict transition-heal) for every scope this store owns, so a
   *  half-finished rewrite is resolved before the first read rather than lingering as a pending
   *  journal. Global always; project only when owned (the same disposition gate every read path uses).
   *  Each scope's heal runs under that scope's LEDGER lock; completeTransition then nests the witness
   *  lock (a different path — legal). BEST-EFFORT: a scope that is interrupted, stale, or mismatched is
   *  LEFT as-is (it re-surfaces as transition-interrupted / blocked on the next witnessed write, Task
   *  5) — healing must never block server startup, so per-scope failures are swallowed. Wired ONCE in
   *  src/server/index.ts after construction, NEVER from a hook (a read-only surface must not advance
   *  the witness). */
  healWitness(): void {
    const p = this.opts.project;
    const scopes: Array<{ ledger: LedgerPath; root: string | undefined }> = [{ ledger: this.global, root: undefined }];
    if (p && isOwned(p.root, this.homeDir())) scopes.push({ ledger: p.ledger, root: p.root });
    const home = this.homeDir();
    for (const s of scopes) {
      if (!existsSync(dirname(s.ledger))) continue;   // no scope dir => no witness state => nothing to heal
      const scopeKey = scopeKeyOf(home, s.root);
      try {
        withFileLock(s.ledger, () => {
          const bytes = readLedgerBytes(s.ledger);
          const verdict = classifyState(readScopeWitness(home, scopeKey), bytes);
          if (verdict.kind === 'transition-heal') {
            completeTransition(home, scopeKey, bytes, verdict.journal.tx);
          } else if (verdict.kind === 'transition-interrupted' && interruptedAtPredecessor(bytes, verdict.journal)) {
            // A crash between openTransition and the rename used to leave the scope dark forever:
            // reads excluded it, writes threw, and only a TTY ceremony could clear it. On the global
            // scope that darkened all memory until a human ran it.
            //
            // The argument for leaving it was that predecessor bytes under a pending journal cannot
            // be told apart from a rewrite that landed and was then rolled back. That is true and it
            // does not decide anything, because the correct action is the SAME either way. This
            // RETRACTS; it never re-drives. The scope is left holding exactly the bytes on disk — the
            // pre-rewrite state if the rename never landed, and precisely what was asked for if a
            // rollback restored them. Nothing a rollback removed can return through this path.
            //
            // Only the predecessor lineage qualifies: interruptedAtPredecessor refuses the expected
            // lineage (that rewrite completed), the both-match case and the no-predecessor case, and
            // classifyWitness has already sent a fork to `mismatch`. Everything it refuses stays
            // pending for the ceremony — the same fail-closed direction, now reached by measuring the
            // bytes rather than by declining to look.
            discardTransition(home, scopeKey, verdict.journal.nonce);
          }
        });
      } catch { /* best-effort: a stale/rejected/broken heal stays pending; never block startup */ }
    }
  }
}
