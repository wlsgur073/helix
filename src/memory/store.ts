import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BlastRadius, Classification, MemoryRecord, MemoryScope, MemoryState, ProvenanceSource, ScopedRecord, ScopedHistoricalRecord, ScopedAsOfFact } from '../types.js';
import { parseLedger, parseLedgerHealth, readLedgerBytes, GLOBAL_LEDGER_READ, compactLedgerUnlocked, planCompaction, serializedBytes, isMarkerShape, isWitnessFence, landedCompactionStats, DESTINATION_CHANGED_REFUSAL, LedgerDestinationChangedError, LedgerProcLostError, isLedgerCreateRefusedError, isLedgerDestinationChangedError, isLedgerProcLostError, ledgerContentKindAt, type CompactOptions, type CompactionStats, type JudgedDestination, type LedgerContentKind, type LedgerPath } from './ledger.js';
import { appendWitnessedUnlocked } from './witness-write.js';
import { scopeKeyOf, readScopeWitness, classifyState, completeTransition, discardTransition, assertWitnessWritable, isRecordStoredError, isWitnessAdvanceError, isWitnessBlockedError, isWitnessUnusableError, WitnessBlockedError } from './witness-store.js';
import { cheapGate, dirtyGate } from './compaction-trigger.js';
import type { CompactionConfig } from '../config.js';
import { buildHistory, ledgerTruncated, isIsoInstant } from './history.js';
import { buildAsOfEvidence } from './asof.js';
import { findSecrets, redactSecrets, selectWriteRedactions } from './secret-scan.js';
import { canCommit, isVerifyingSource, resolveTransition, type TransitionResult, type VerifyOutcome } from './firewall.js';
import { runRealityCheck, checkBinding, type RealityCheck } from './reality-check.js';
import { type RecallOptions } from './projection.js';
import { rankWithArtifacts, buildRankArtifacts, assertQueryWithinBounds, type Expansion } from './retrieval.js';
import { defaultExpansion, SEM_DISCOUNT, SEM_GATE } from './expansion.js';
import { requiresReverifyBeforeUse } from './state-machine.js';
import { frameAsData, newNonce, collectWitnessReadNotes, asOfWitnessNotes, GLOBAL_LEDGER_READ_ONLY_NOTE } from './content-frame.js';
import { stampOwnership, restoreOwnership, openOwnerDir, judgeProjectLayer, canonicalRoot, isReviewableRoot, isHelixDirLinked, trustStateOf, type LayerJudgement, type OwnershipSnapshot, type ProjectDisposition, type ProjectOrigin, type TrustState } from './ownership.js';
import { ensureMaster, signVerify, verifyVerify, digestContent, isFutureMacVersion } from './ledger-mac.js';
import { buildVerifiedProjection, isKnownState, enforceWitnessProjection, clampElevatedState, type VerifiedProjection } from './verified-projection.js';
import { subkeyForScope, verifiedLiveOf, verifiedLiveStats, verifiedLiveWitnessed, verifiedProjectionWithSubkey } from './verified-read.js';
import { readLedgerWitnessed, readLedgerBytesWitnessed } from './witness-read.js';
import { interruptedAtPredecessor, type WitnessFileMark, type WitnessVerdict } from './witness-core.js';
import { ledgerDigest, subkeyFingerprint, keyVectorEqual, type ScopeKeyComponent, type RecallCacheEntry } from './recall-cache.js';
import type { MetricsSink } from '../metrics.js';
import { withFileLock, isLockForeignObjectError, isLockPublishRefusedError, isLockTimeoutError, lockTimeoutCauseOf, type LockContext } from './lock.js';
import { closeHeldDir } from './dir-bound.js';
import { realFsOps } from './fs-ops.js';
import { isUnresolvablePathError, fileIdentityAt, resolvePath } from './path-identity.js';
import { globalLedgerWriteState, GlobalLedgerReadOnlyError, GLOBAL_DESTINATION_CHANGED, type GlobalWriteOp } from './global-ledger.js';
import { ensureHelixDir } from './home-permissions.js';
import { MAX_COMMIT_CONTENT_CHARS, RECALL_RECENCY_APPENDIX_COUNT, RECALL_APPENDIX_FUTURE_TOLERANCE_MS } from '../limits.js';

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
   *  comment claiming they were always equal was false against the shipped wiring. `origin` says
   *  where it was found (src/memory/project-root.ts); absent reads as 'cwd'. */
  project?: { ledger: string; root: string; origin?: ProjectOrigin };
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
   *  them, in the shape the chain test accepts since issues #5 and #12 (Windows paths,
   *  environment-variable references, NAME=value settings, source code: isBenignWordChain).
   *  selectWriteRedactions decides span by span; hex, named/heuristic overlaps and
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
   *  same-millisecond ties), additive beyond `maxItems`; only records whose tx is a canonical instant
   *  no later than RECALL_APPENDIX_FUTURE_TOLERANCE_MS after the call (issue #9). */
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

/** ALIAS-P2P (item 7), revised by third fix batch B1 (design 4.9): the refusal of a project-routed write on an
 *  'aliased' layer, adopted or not. One constant so every site carries the same wording. Ruling R7 with plan
 *  refinement P1: the first sentence names every cause a refused write can have, rows 4, 6, 7 and 8 of design 4.2 (a
 *  memory file that resolves outside this project, one that leads to another Helix memory file, one with more than one
 *  hard link, and a path Helix cannot resolve the kernel's way: a non-UTF-8 name, a path past PATH_MAX, too many links),
 *  so the text never states one cause while another holds. IT-M4: the last sentence leaves the choice of global memory
 *  to the user — the former "Pass scope 'global'" steered the model into choosing it. */
const ALIASED_PROJECT_WRITE_REFUSAL =
  "commit: this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve, so the project layer is disabled here — the write is refused rather than written somewhere else. ' +
  "Ask the user whether to store this fact in global memory, which every project sees, or to replace the link with the project's own file; do not choose for them.";

/** Row 5 of design 4.2 (third fix batch B1): the refusal of a project-routed write on a layer whose memory path
 *  cannot be inspected, adopted or not (design 4.9). */
const UNUSABLE_PROJECT_WRITE_REFUSAL =
  "commit: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot " +
  'be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory ' +
  "records), so the project layer is disabled here — nothing was written. Ask the user whether to store this fact " +
  "in global memory, which every project sees, or to repair the project's memory file; do not choose for them.";

/** The 'aliased' state on an erase with scope 'project' (design 4.9): the same four causes as the commit refusal. */
const ERASE_ALIASED_REFUSAL =
  "erase: this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve — the erase is refused rather than applied somewhere else.';

/** The 'unusable' state on an erase with scope 'project' (design 4.9). */
const ERASE_UNUSABLE_REFUSAL =
  "erase: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot " +
  'be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory ' +
  'records) — nothing was erased.';

/** 13.3 decision 5 (design 4.3 step 2): the ledger lock of a project could not be published because the memory folder
 *  refuses the write (EACCES) or stands on a read-only file system (EROFS). */
const UNWRITABLE_PROJECT_WRITE_REFUSAL =
  "commit: this project's memory folder cannot be written (a read-only folder or file system), so nothing was written. " +
  'Ask the user whether to store this fact in global memory, which every project sees, or to make that folder writable; do not choose for them.';

/** A project memory file Helix did not create (design 4.3 step 4, third case; the EEXIST and ELOOP of the exclusive
 *  creation answer it too). ONE text: the "appeared here" wording is gone. */
const FOREIGN_FILE_REFUSAL =
  'commit: a project memory file exists here that Helix did not create — ask the user whether to adopt it ' +
  '(helix_memory_adopt) or to move it away; do not choose for them.';

/** The first write to a project stored no row and the ownership it had recorded was put back (design 4.3 step 5). */
const FIRST_WRITE_FAILED_UNDONE =
  "commit: the first write to this project's memory file failed, so the project was not adopted and nothing was written. " +
  'Ask the user whether to store this fact in global memory, which every project sees, or to look at the project\'s memory folder first; do not choose for them.';

/** The same failure when the restore itself failed, whatever the first cause (step 5, the item on the texts). */
const FIRST_WRITE_FAILED_NOT_UNDONE =
  "commit: the first write to this project's memory file failed and the adoption recorded for it could not be undone, so the project is adopted with no memory file — nothing was written. " +
  'Tell the user what happened; do not try to repair it for them.';

/** The project writes the critical section of design 4.3 serves. */
type ProjectWriteOp = 'commit' | 'erase' | 'confirm' | 'recheck' | 'compaction' | 'adopt';

/** erase with scope 'project' (or any erase routed to the project) in a layer that is not owned: the project is not
 *  adopted, or stopped being adopted under the lock (FW-R13). It names no cause, because the same refusal answers a layer
 *  with no file and an unadopted parent project. Design 4.9, verbatim. */
const ERASE_NOT_ADOPTED =
  "erase: this project's memory is not adopted — ask the user whether to adopt it (helix_memory_adopt); do " +
  'not choose for them.';

/** The cause clauses of the 4.9 texts, for the cells 4.9 leaves to the implementation. */
const ALIASED_CAUSE =
  "this project's memory file resolves outside this project, to another Helix memory file, to a file with " +
  'more than one hard link, or through a path Helix cannot resolve';
const UNUSABLE_CAUSE =
  "this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be " +
  'read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix ' +
  'memory records)';
const UNWRITABLE_CAUSE = "this project's memory folder cannot be written (a read-only folder or file system)";

/** The `adopt` row of PROJECT_WRITE_REFUSAL. aliased and unusable are 4.9's texts (the first clause of the commit refusal,
 *  then "— nothing was adopted."); unwritable and changed are in the 4.9 form; notAdopted is not reachable (adopt is the
 *  operation that adopts) and carries the unusable text. */
const ADOPT_REFUSAL = {
  aliased: `adopt: ${ALIASED_CAUSE}, so the project layer is disabled here — nothing was adopted.`,
  unusable: `adopt: ${UNUSABLE_CAUSE}, so the project layer is disabled here — nothing was adopted.`,
  unwritable: `adopt: ${UNWRITABLE_CAUSE}, so nothing was adopted. Ask the user whether to make that folder writable; do not choose for them.`,
  changed: "adopt: this project's memory file was replaced while the adoption waited for its lock — nothing was adopted. " +
    'Try the adoption again; if it happens again, tell the user.',
  notAdopted: `adopt: ${UNUSABLE_CAUSE}, so the project layer is disabled here — nothing was adopted.`,
};

/** adopt: the destination exists and holds content that is not ledger rows (design 4.4, second bullet). Design 4.9, verbatim. */
const ADOPT_NOT_LEDGER_CONTENT =
  "adopt: the file this project's memory path leads to holds content that is not Helix memory records — " +
  "nothing was adopted. Ask the user which file this project's memory should be; do not choose for them.";

/** adopt waited the lock's budget (5 s) behind another writer of the same ledger (4.4: "예산(5초)까지 기다리고"). 14 decision
 *  8, t-07: the lock layer's own text names the lock path. It answers the timeout causes 'payload' (a holder that parsed)
 *  and 'vanished' (contention: the lock was free at the last look), and a timeout mark that carries no cause (14 item 19). */
const ADOPT_LOCK_BUSY_REFUSAL =
  "adopt: another write to this project's memory file did not finish while the adoption waited for its lock — nothing was adopted. " +
  'Try the adoption again; if it happens again, tell the user.';

/** adopt waited the lock's budget (5 s) behind a lock whose holder cannot be identified or shown to be gone: the timeout
 *  causes 'unreadable', 'unparseable' and 'legacy-dir', none of which the lock layer reclaims by itself, so a retry would
 *  meet the same lock (14 item 19). The cause 'no-directory' gets the adopt row's `changed` text instead. */
const ADOPT_LOCK_UNIDENTIFIED_REFUSAL =
  "adopt: the lock beside this project's memory file has a holder Helix cannot identify or show to be gone (the lock file " +
  'cannot be read or does not parse as a lock, its holder cannot be checked, or it is a lock folder left by an older ' +
  'version), so Helix does not remove it — nothing was adopted. Ask the user to look at that lock; do not remove it for them.';

/** adopt's own ownership record failed (FW-R4, 4.4 last paragraph: the first commit's hold and restore) and the restore put
 *  both records back / could not put them back. In the form of the commit's two first-write texts. */
const ADOPT_RECORD_FAILED_UNDONE =
  'adopt: recording the adoption failed, so the project was not adopted and nothing was recorded. Tell the user what happened.';
const ADOPT_RECORD_FAILED_NOT_UNDONE =
  'adopt: recording the adoption failed and could not be undone, so the project may be partly adopted. ' +
  'Tell the user what happened; do not try to repair it for them.';

/** The fixed texts of a project write refused by the critical section, by operation. Constants: no path, no id,
 *  nothing of the call. commit and erase (aliased, unusable, notAdopted) are the 4.9 texts or A13's; every other cell is
 *  in the 4.9 form (cause clause, then the operation's own result clause). `changed`: the destination under the lock is
 *  not the one judged before it (step 3), or the check after the open refused (4.1 item 3). `notAdopted`: the layer is not
 *  owned under the lock (FW-R13); a commit never meets it. */
const PROJECT_WRITE_REFUSAL: Record<ProjectWriteOp, { aliased: string; unusable: string; unwritable: string; changed: string; notAdopted: string }> = {
  commit: {
    aliased: ALIASED_PROJECT_WRITE_REFUSAL,
    unusable: UNUSABLE_PROJECT_WRITE_REFUSAL,
    unwritable: UNWRITABLE_PROJECT_WRITE_REFUSAL,
    changed: DESTINATION_CHANGED_REFUSAL,
    notAdopted: FOREIGN_FILE_REFUSAL,
  },
  erase: {
    aliased: ERASE_ALIASED_REFUSAL,
    unusable: ERASE_UNUSABLE_REFUSAL,
    unwritable: `erase: ${UNWRITABLE_CAUSE}, so nothing was erased. Ask the user whether to make that folder writable; do not choose for them.`,
    changed: "erase: this project's memory file was replaced while the erase waited for its lock — nothing was erased. " +
      'Try the erase again; if it happens again, tell the user.',
    notAdopted: ERASE_NOT_ADOPTED,
  },
  confirm: {
    aliased: `confirm: ${ALIASED_CAUSE} — the grade was not changed rather than recorded somewhere else.`,
    unusable: `confirm: ${UNUSABLE_CAUSE} — the grade was not changed.`,
    unwritable: `confirm: ${UNWRITABLE_CAUSE}, so the grade was not changed. Ask the user whether to make that folder writable; do not choose for them.`,
    changed: "confirm: this project's memory file was replaced while the confirmation waited for its lock — the grade was not changed. " +
      'Try the confirmation again; if it happens again, tell the user.',
    notAdopted: "confirm: this project's memory is not adopted — the grade was not changed. " +
      'Ask the user whether to adopt it (helix_memory_adopt); do not choose for them.',
  },
  recheck: {
    aliased: `recheck: ${ALIASED_CAUSE} — the grade was not changed rather than recorded somewhere else.`,
    unusable: `recheck: ${UNUSABLE_CAUSE} — the grade was not changed.`,
    unwritable: `recheck: ${UNWRITABLE_CAUSE}, so the grade was not changed. Ask the user whether to make that folder writable; do not choose for them.`,
    changed: "recheck: this project's memory file was replaced while the recheck waited for its lock — the grade was not changed. " +
      'Try the recheck again; if it happens again, tell the user.',
    notAdopted: "recheck: this project's memory is not adopted — the grade was not changed. " +
      'Ask the user whether to adopt it (helix_memory_adopt); do not choose for them.',
  },
  compaction: {
    aliased: `compaction: ${ALIASED_CAUSE} — nothing was rewritten.`,
    unusable: `compaction: ${UNUSABLE_CAUSE} — nothing was rewritten.`,
    unwritable: `compaction: ${UNWRITABLE_CAUSE}, so nothing was rewritten.`,
    changed: "compaction: this project's memory file was replaced while the rewrite waited for its lock — nothing was rewritten.",
    notAdopted: "compaction: this project's memory is not adopted — nothing was rewritten.",
  },
  adopt: ADOPT_REFUSAL,
};

/** The states in which an explicit 'global' commit bypassed a project layer that is off here (IT-M4). */
export type BypassedProjectDisposition = 'ancestor-unadopted' | 'aliased' | 'unusable' | 'unadopted-present';
/** What `commitScoped` reports: the record, the scope it was written to, and two disclosures.
 *  `redactions` (IT-M3) counts, per marker kind, the spans the secret scan actually replaced (the
 *  write-policy selection, one `[redacted:<kind>]` marker each); absent when nothing was replaced.
 *  `bypassedProject` (IT-M4) is set only for an EXPLICIT 'global' commit made while a project layer
 *  is configured but off here — 'ancestor-unadopted', 'aliased', 'unusable', or (ruling R11) 'unadopted-present',
 *  a cwd project whose memory file Helix did not create and nobody adopted, excluded from every read
 *  the same way; absent otherwise. */
export interface CommitResult {
  record: MemoryRecord;
  scope: MemoryScope;
  redactions?: Record<string, number>;
  bypassedProject?: BypassedProjectDisposition;
}

/** A refusal thrown by `resolveEraseTarget` / `erase` BEFORE any byte moves — the pre-write half of
 *  handlers.ts's three-way erase audit. Read by property (`isEraseRefusedError`), never instanceof,
 *  for the reason witness-store.ts's `isWitnessAdvanceError` sets out. */
export class EraseRefusedError extends Error {
  readonly eraseRefused = true;
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'EraseRefusedError'; }
}
export const isEraseRefusedError = (e: unknown): boolean =>
  e instanceof Error && (e as { eraseRefused?: unknown }).eraseRefused === true;

/** IT-M16: what `MemoryStore.erase` found the id naming (see its docstring). */
export type EraseOutcome = 'erased' | 'not-live' | 'absent';

/** What underProjectLedgerLock hands its body: the held lock, the judgement read under it, and the destination that
 *  judgement passed, for the append. */
interface HeldProjectLedger { ctx: LockContext; judgement: LayerJudgement; judged: JudgedDestination }

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
   *  later). They stay grade-inert (verifyVerify false until a verifier exists) and scan-visible.
   *  "Future" is ledger-mac.ts isFutureMacVersion, the predicate the startup scan's newer-version class
   *  uses too (second fix batch, plan refinement P2), so both read a future version the same way. The
   *  two sets still differ at two edges: a MAC-valid row with an unknown state is newer-version to the
   *  scan and not kept here, and a future-version row with no mac or keyId is kept here and forged/legacy
   *  to the scan. */
  private keepValidVerifyFor(subkey: Buffer | null): (r: MemoryRecord) => boolean {
    return subkey
      ? (r) => (verifyVerify(r, subkey) && isKnownState(r.state)) || isFutureMacVersion(r.macVersion)
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
    return this.commitScoped(input).record;
  }

  /** `commit`, plus what `helix_memory_commit` reports about it (CommitResult): the scope the record was
   *  actually written to and the two disclosures. Issue #1: a result that did not name its scope let a
   *  project fact land in the global ledger with nothing to show for it. */
  commitScoped(input: CommitInput): CommitResult {
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
    // Design 4.7: a commit routed to a read-only global ledger is refused here, before the supersede pre-check reads anything
    // and before any lock or home write. These are exactly the two routes targetLedger sends to the global ledger; an
    // explicit 'project' without a layer keeps its own refusal.
    if (input.scope === 'global' || (input.scope === undefined && !this.opts.project)) this.refuseReadOnlyGlobal('commit');
    // ALIAS-P2P (item 7, fix round 1): refused HERE, before the supersede pre-check below ever calls
    // ledgerOf(input.supersedes) — that call used to read through the alias (pulling the OTHER
    // project's live record into this scope, and its Tier-1/Tier-2 guards could then leak whether
    // that record exists and is human-authored) before commitToProject()'s own refusal fired at the very
    // end of this method. "Project-routed" = a project layer is configured and the caller did not
    // explicitly ask for 'global' (explicit 'project', or an omitted scope — the same set
    // targetLedger() below eventually routes to the project ledger for). An explicit scope:'global'
    // commit is untouched here: its supersede target resolves through the (now alias-excluding)
    // ledgerOf below, never through this check.
    let first: LayerJudgement | null = null;
    if (input.scope !== 'global' && this.opts.project) {
      first = this.judgeLayer({ freshContent: true });
      this.refuseExcludedProjectWrite('commit', this.opts.project, first);
    }
    if (input.supersedes) {
      const targetLedger = this.ledgerOf(input.supersedes);
      const target = this.verifiedOf(targetLedger).live.get(input.supersedes);
      if (!target) throw new Error('commit: supersedes target not found (dead or unknown id)');
      // Cross-scope guard (spec §15): the supersede record is written to the ledger for input.scope,
      // but projection is per-ledger. If the target lives in a different ledger than the write, the
      // supersede would NOT evict it — both stay live (a duplicate, stale fact never removed). Reject
      // the scope mismatch. (Side-effect-free write-ledger resolution: mirrors targetLedger() routing,
      // and commitToProject() claims ownership only after it, so a rejected commit never stamps/creates a ledger.
      // M-3: one cell now diverges on purpose rather than mirrors it — an explicit 'project' scope
      // with no active project layer, which targetLedger() REFUSES outright, this line still routes
      // to global. Harmless: that refusal fires at the real targetLedger() call below, before any
      // write, so this mirror's routing choice for that one cell never reaches disk either way.
      // ALIAS-P2P (item 7, fix round 1): the alias case is NOT part of this mirror at all — a
      // project-routed commit on an aliased layer is refused by the early check above, before this
      // block ever runs, so `writeLedger` here is never resolved against an aliased ledger; ledgerOf
      // above is also alias-excluding on its own (gated on disposition === 'owned'), so an explicit
      // scope:'global' supersede of an aliased-project-only id resolves to global, not the alias.)
      const writeLedger = input.scope === 'global' || !this.opts.project ? this.global : this.opts.project.ledger;
      if (targetLedger !== writeLedger) {
        throw new Error('commit: cannot supersede across scopes (target lives in a different ledger)');
      }
      this.assertSupersedeAllowed(target, input, source);
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
    let redactions: Record<string, number> | undefined;
    if (redactable.length > 0) {
      // Span-level redaction: replace ONLY the secret tokens with a content-free marker, preserving
      // the surrounding text. A high-entropy false positive (e.g. a git SHA) no longer empties the
      // whole record; classification flags that a redaction happened.
      const red = redactSecrets(input.content, redactable);
      content = red.content;
      classification = red.classification;
      // IT-M3: count what was ACTUALLY replaced — `redactable` is exactly the span set redactSecrets
      // replaced, one marker per span — never the unselected `spans`, which include released chains.
      redactions = {};
      for (const s of redactable) redactions[s.kind] = (redactions[s.kind] ?? 0) + 1;
    }
    const record: MemoryRecord = {
      id: this.id(), tx: ts, validFrom: input.validFrom ?? ts, validTo: input.validTo ?? null,
      // supersedes set => 'supersede' (projection drops the old item and keeps this one as the live
      // replacement, so an update replaces rather than duplicates); otherwise a plain 'assert'.
      type: input.supersedes ? 'supersede' : 'assert', state: 'Fresh', content,
      provenance: { source, sessionId: this.session() },
      supersedes: input.supersedes ?? null, blastRadius: input.blastRadius ?? null, reverifyTrigger: null, classification,
    };
    const target = this.targetLedger(input.scope);
    if (target.project) {
      if (first === null) throw new Error('commit: internal error — a project write without its judgement');
      this.commitToProject(target.project, first, record, input, source);
    } else {
      this.underGlobalLedgerLock('commit', ({ judged }) => {
        if (input.supersedes) this.assertSupersedeTargetUnderLock(target.ledger, input, source);   // step 6 for the global scope (D10)
        appendWitnessedUnlocked(target.ledger, record, this.homeDir(), undefined, 'commit', 'commit', judged);
      });
    }
    const out: CommitResult = { record, scope: target.ledger === this.global ? 'global' : 'project' };
    if (redactions) out.redactions = redactions;
    // IT-M4: an explicit 'global' commit skips every project check above (commitToProject never runs),
    // so the result could not say it bypassed a project layer that is off here.
    // The disposition is computed ONLY on this path — explicit 'global' with a layer configured — and
    // after the append, so a refused or failed write never pays for it. Side-effect free.
    if (input.scope === 'global' && this.opts.project) {
      const d = this.projectDisposition();
      if (d === 'ancestor-unadopted' || d === 'aliased' || d === 'unusable' || d === 'unadopted-present') out.bypassedProject = d;
    }
    return out;
  }

  /** The source guard and the digest of a Verified target: two of the three checks a supersede commit makes on its target
   *  (the first, that the target is live, is the caller's lookup). ONE function for the lock-free pre-check in
   *  commitScoped and for the check made again under the ledger lock (design 4.3 step 6, D10), so the two can never carry
   *  different rules or different texts. */
  private assertSupersedeAllowed(target: MemoryRecord, input: CommitInput, source: ProvenanceSource): void {
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

  /** Design 4.3 step 6 (D10, FN-24): the target of a supersede commit, checked AGAIN under the lock of the ledger the
   *  commit is written to, in the place where step 3 judges again. The same three checks as lock-free and the same texts:
   *  the target is live in this ledger, the source guard, the digest of a Verified target. Two supersede commits of one id
   *  used to pass the lock-free look together and both were stored; the late one now finds its target dead here. Holds for
   *  the global scope too. The read is the verified projection the pre-check uses, without the replay metric (one commit,
   *  one metric). */
  private assertSupersedeTargetUnderLock(ledger: LedgerPath, input: CommitInput, source: ProvenanceSource): void {
    const target = verifiedLiveStats(ledger, this.homeDir(), this.scopeRootOf(ledger)).projection.live.get(input.supersedes!);
    if (!target) throw new Error('commit: supersedes target not found (dead or unknown id)');
    this.assertSupersedeAllowed(target, input, source);
  }

  /** A fresh judgement of this store's project layer (ownership.ts judgeProjectLayer, the one rule). No project layer
   *  gives row 1. `freshContent` is for a write: it reads the link target's content and never consults the memory. */
  private judgeLayer(opts: { forAdopt?: boolean; freshContent?: boolean } = {}): LayerJudgement {
    const p = this.opts.project;
    return judgeProjectLayer(p && { root: p.root, ledger: p.ledger, home: this.homeDir(), globalLedger: this.global, origin: p.origin }, opts);
  }

  /** The single condition + message for refusing a project-routed write on a layer the judgement excludes, shared by
   *  commitScoped()'s early check (fired before the supersede block ever calls ledgerOf, which used to read through an
   *  alias) and by commitToProject()'s critical section, so the two call sites can never carry different wording or drift
   *  out of sync. 'aliased' and 'unusable' hold whether or not the project is adopted.
   *
   *  Issue #1: a project layer found in a PARENT directory is used only once adopted, and nothing claims it
   *  automatically, so a project-routed commit (omitted or explicit 'project' scope) below an unadopted one is refused:
   *  never widened to the global ledger, never auto-adopted, so no path reaches stampOwnership for a parent directory.
   *  The root is JSON-quoted so a newline or quote in a directory name cannot reshape the message.
   *
   *  Side-effect free, no ownership stamping: a write about to be refused must never first claim or create a ledger.
   *  Returns for every other state. `op` picks the text: 'aliased' and 'unusable' carry the operation's fixed text;
   *  'ancestor-unadopted' keeps the issue-#1 text for a commit and is the not-adopted text of any other operation. */
  private refuseExcludedProjectWrite(op: ProjectWriteOp, p: { root: string }, j: LayerJudgement): void {
    if (j.state === 'aliased') throw this.projectWriteRefusal(op, 'aliased');
    if (j.state === 'unusable') throw this.projectWriteRefusal(op, 'unusable');
    if (j.state === 'ancestor-unadopted') {
      if (op !== 'commit') throw this.projectWriteRefusal(op, 'notAdopted');
      throw new Error(
        `commit: this session started below a Helix project at ${JSON.stringify(p.root)} that is not adopted, ` +
        'so project memory is off here — the write is refused rather than widened to the global ledger. ' +
        'Ask the user whether to adopt that project (helix_memory_adopt, projectRoot: that absolute path) ' +
        'or to store this fact in global memory, which every project sees; do not choose for them.',
      );
    }
  }

  /** A refusal of a project write, as the operation raises it. An erase refusal is the typed pre-write refusal the erase
   *  handler audits as 'rejected' (nothing was written). A changed destination is the ledger layer's typed error for every
   *  other operation, so the commit's catch in firstProjectWrite keeps recognising it. */
  private projectWriteRefusal(op: ProjectWriteOp, kind: 'aliased' | 'unusable' | 'unwritable' | 'changed' | 'notAdopted', cause?: unknown): Error {
    const text = PROJECT_WRITE_REFUSAL[op][kind];
    const options = cause === undefined ? undefined : { cause };
    if (op === 'erase') return new EraseRefusedError(text, options);
    if (kind === 'changed') return new LedgerDestinationChangedError(text);
    return new Error(text, options);
  }

  /** Resolve the ledger to write to, and the project layer when it is a project's. The routing only: the judgement, the
   *  ownership claim and the foreign-file refusal moved into commitToProject. With no project layer active, an OMITTED
   *  scope falls back to global — the contextual default — while an EXPLICIT 'project' is REFUSED rather than
   *  silently widened; see the argument on that branch below. */
  private targetLedger(scope: MemoryScope | undefined): { ledger: LedgerPath; project?: { root: string; ledger: string } } {
    const p = this.opts.project;
    // An EXPLICIT project scope with no project layer used to fall through to the global ledger with
    // no signal: the caller named the narrower ledger and its record was persisted in the broader
    // one, undetectable except by inspecting the other scope. Refused instead. Deliberately narrow —
    // an OMITTED scope keeps the contextual default (project when a layer is active, global
    // otherwise), which is the overwhelming majority path, and an explicit 'global' is untouched.
    if (scope === 'project' && !p) {
      throw new Error(
        'commit: scope \'project\' was requested but no project memory layer is active here ' +
        '(Helix configures one only when started in or below a directory holding a .helix folder). ' +
        'Omit `scope` to use the contextual default, or create a .helix folder at the project root and start ' +
        'a new session there to turn project memory on — the write is refused rather than silently widened ' +
        'to the global ledger.',
      );
    }
    if (scope === 'global' || !p) return { ledger: this.global };
    return { ledger: p.ledger, project: p };
  }

  /** THE critical section of a write to a project (design 4.3 steps 1 to 3), for every operation of `ProjectWriteOp`, adopt
   *  included (design 4.4). `first` is the caller's lock-free judgement (step 1); it is refused here again, so no
   *  caller can come in with an excluded layer.
   *
   *  What the operation changes: the texts (`projectWriteRefusal`), the name in the witness refusal (`op` is the tool's
   *  name: commit, erase, confirm, recheck, adopt), whether the layer must be owned (every operation but the commit and the
   *  adopt; FW-R13: asked in front of the lock and again under it, so a project that stopped being owned is refused with the
   *  operation's not-adopted text), whether the memory folder is created when it is missing (the commit and the adopt), and
   *  whether the judgement skips row 2 for a project found in a parent directory (the adopt). The compaction asks
   *  no witness question in front of the lock: it is best effort and its own gate refuses an unusable file.
   *
   *  In front of the lock: the witness file must be usable (design 4.8 item 2; asked before the home is validated or
   *  tightened and before a lock file is published in the project: FW-R10); the home is validated; a `.helix` that
   *  became a link is refused (row 3's condition, row 3's fixed text); and a memory folder that is missing is created
   *  when the memory path is no link (design 4.2, line 110: row 10 refuses a link whose folder is missing, so only a plain
   *  `.helix/memory.jsonl` reaches the mkdir). The judgement used for the append is taken after the folder exists:
   *  row 13 with no folder has `dirIdentity === null`, which the held-directory append refuses (A6).
   *
   *  Step 2: the ledger lock of the resolved destination. A lock file that cannot be PUBLISHED because the folder refuses
   *  the write gets the operation's `unwritable` text (13.3 decision 5); an error raised inside the held section (the
   *  registry's or the key's lock, a home that cannot be written) is never converted: `held` tells the two apart.
   *  Step 3: under the lock the layer is judged again with the content read afresh; 'aliased', 'unusable' and
   *  'ancestor-unadopted' get their refusal; a judgement that passes with another destination than step 1's, or than the
   *  one the lock stands beside (ctx.path), is the changed-destination refusal: the path that was locked is not the path
   *  that would be written. A lock timeout, a foreign lock object, a lost `/proc` and an unusable witness file pass through
   *  unconverted: each keeps its own text. One exception: the adopt's wait for this lock that ran out of its budget gets a
   *  fixed text without the lock path, chosen by the timeout's cause (14 decision 8, t-07; 14 item 19): another writer
   *  ('payload', 'vanished', or a mark with no cause) the busy text, a folder that went away ('no-directory') the adopt
   *  row's `changed` text (a retry creates the folder again), a lock Helix cannot identify ('unreadable', 'unparseable',
   *  'legacy-dir') the unidentified-lock text.
   *
   *  A folder this call created is removed again when the call is refused (FW-R6): the lock-free look found none, the
   *  call made it, and a refused call must not leave an empty `.helix` that the next start would find as a project layer.
   *  It stays when something was put in it (a lock file of a release that could not be proved, an `.owner` the restore
   *  could not take away) and when the row is stored.
   *
   *  Lock order: this ledger lock first; the body takes the registry lock, the key lock (a first mint) and the witness lock
   *  under it and never another ledger lock. */
  private underProjectLedgerLock<T>(p: { root: string; ledger: string }, op: ProjectWriteOp, first: LayerJudgement, body: (held: HeldProjectLedger) => T): T {
    const home = this.homeDir();
    this.refuseExcludedProjectWrite(op, p, first);
    if (first.destination === undefined) throw this.projectWriteRefusal(op, 'unusable');   // no state that passes lacks a destination
    if (op !== 'commit' && op !== 'adopt' && first.state !== 'owned') throw this.projectWriteRefusal(op, 'notAdopted');
    if (op !== 'compaction') assertWitnessWritable(home, op, { homeUnchecked: true });
    ensureHelixDir(home);
    if (isHelixDirLinked(p.root)) throw this.projectWriteRefusal(op, 'unusable');
    const folder = dirname(p.ledger);
    let madeFolder = false;
    if (op === 'commit' || op === 'adopt') {   // only the commit and the adopt create the memory folder
      let folderThere = true;
      try { lstatSync(folder); } catch (e) { folderThere = (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
      if (!folderThere) { mkdirSync(folder, { recursive: true }); madeFolder = true; }
    }
    let held = false;   // true once THIS lock is published
    try {
      return withFileLock(p.ledger, (ctx) => {
        held = true;
        const j = this.judgeLayer(op === 'adopt' ? { forAdopt: true, freshContent: true } : { freshContent: true });
        this.refuseExcludedProjectWrite(op, p, j);
        if (j.destination === undefined || j.destination !== first.destination || ctx.path !== j.destination) throw this.projectWriteRefusal(op, 'changed');
        if (op !== 'commit' && op !== 'adopt' && j.state !== 'owned') throw this.projectWriteRefusal(op, 'notAdopted');   // FW-R13
        return body({ ctx, judgement: j, judged: { path: j.destination, identity: j.identity ?? null, dir: j.dirIdentity } });
      });
    } catch (e) {
      if (madeFolder && !isRecordStoredError(e)) { try { rmdirSync(folder); } catch { /* not empty, or gone: leave it */ } }
      if (!held && op === 'adopt' && isLockTimeoutError(e)) {
        const cause = lockTimeoutCauseOf(e);
        if (cause === 'no-directory') throw this.projectWriteRefusal('adopt', 'changed', e);
        if (cause === 'unreadable' || cause === 'unparseable' || cause === 'legacy-dir') throw new Error(ADOPT_LOCK_UNIDENTIFIED_REFUSAL, { cause: e });
        throw new Error(ADOPT_LOCK_BUSY_REFUSAL, { cause: e });
      }
      if (!held && isLockPublishRefusedError(e)) throw this.projectWriteRefusal(op, 'unwritable', e);
      // The check after the open and the rewrite's own look at the path raise the ledger layer's commit text: give the operation's.
      if (op !== 'commit' && isLedgerDestinationChangedError(e) && !isRecordStoredError(e) && (e as Error).message !== PROJECT_WRITE_REFUSAL[op].changed) throw this.projectWriteRefusal(op, 'changed', e);
      throw e;
    }
  }

  /** Is the global ledger read-only (design 4.7: its path cannot be resolved, or it reaches a missing folder through a
   *  link)? Asked afresh on every call: the state is the path's, and a path repaired in the middle of a session is
   *  writable again at the next call. Side-effect free. */
  private globalReadOnly(): boolean {
    return globalLedgerWriteState(this.global).kind === 'read-only';
  }

  /** The typed pre-refusal of a write to a read-only global ledger, or nothing. It stands in front of every lock and of
   *  everything the store writes to the home. */
  private refuseReadOnlyGlobal(op: GlobalWriteOp): void {
    const w = globalLedgerWriteState(this.global);
    if (w.kind === 'read-only') throw new GlobalLedgerReadOnlyError(op, w.cause);
  }

  /** Order item 3 (4.7, second table, "거부의 위치"): a confirm or recheck whose id names a row of the GLOBAL ledger is
   *  refused while that ledger is read-only, before the target is looked up (the lookup reads the verified projection, and
   *  the first read with a key present mints the global scope nonce into projects.json) and before the recheck's check
   *  runs. The test is key-free: any row of the ledger, read through the path as given, that carries the id. An id that
   *  is nowhere, or only in the project, goes on to the ordinary path. */
  private refuseReadOnlyGlobalTarget(id: string, op: 'confirm' | 'recheck'): void {
    if (!this.globalReadOnly()) return;
    let carried = false;
    try { carried = parseLedger(this.global, GLOBAL_LEDGER_READ).some((r) => r.id === id); } catch { /* cannot be shown: the ordinary path decides */ }
    if (carried) this.refuseReadOnlyGlobal(op);
  }

  /** A read's out-of-frame notes with the read-only note in FRONT when it applies (design 4.7: recall, every inspect view,
   *  and the SessionStart block). */
  private withGlobalNote(notes: string[]): string[] {
    return this.globalReadOnly() ? [GLOBAL_LEDGER_READ_ONLY_NOTE, ...notes] : notes;
  }

  /** THE inner function of every write to the GLOBAL ledger (design 4.7, the first table's first two rows and the second
   *  table's row "거부의 위치"): the commit, the erase's tombstone, the two grade changes, the auto-compaction and the
   *  permanent erase's rewrite. Five entry points used to reach the global ledger by four routes, each with its own steps
   *  in front of the lock.
   *    1. A read-only global ledger is refused with the operation's fixed text (GlobalLedgerReadOnlyError): before the
   *       witness check, before ensureHelixDir may create the home or tighten its mode, before the ledger's folder is
   *       created and before a lock is tried.
   *    2. The witness file must be usable (4.8 item 2), asked in front of the home's validation (G-R3). Not for the
   *       auto-compaction, whose gate is the rewrite's own.
   *    3. ensureHelixDir and the folder of a plain path (today's creation, unchanged).
   *    4. The ledger lock at the resolved destination. Under it the path is resolved again: it must be the path the lock
   *       stands beside, and the destination's identity is sampled HERE, where the append's check after the open compares
   *       the descriptor with it (G-R7). A path that became read-only while the call waited is refused with step 1's text;
   *       one that resolves elsewhere gets the global changed-destination text.
   *  Lock order: the global ledger lock first; the body takes the registry lock (the global scope nonce), the key lock (a
   *  first mint) and the witness lock under it and never another ledger lock. */
  private underGlobalLedgerLock<T>(op: GlobalWriteOp, body: (held: { ctx: LockContext; judged: JudgedDestination }) => T): T {
    this.refuseReadOnlyGlobal(op);
    const home = this.homeDir();
    if (op !== 'compaction') assertWitnessWritable(home, op, { homeUnchecked: true });
    ensureHelixDir(home);
    mkdirSync(dirname(this.global), { recursive: true });
    try {
      return withFileLock(this.global, (ctx) => {
        const r = resolvePath(this.global);
        if (r.kind === 'unresolvable') throw new GlobalLedgerReadOnlyError(op, 'unresolvable');
        if (r.kind === 'uninspectable') throw r.error;
        if (r.dirMissing || r.path !== ctx.path) throw this.globalChanged(op);
        return body({ ctx, judged: { path: r.path, identity: fileIdentityAt(r.path) } });
      });
    } catch (e) {
      // The append's own check after the open raises the project commit's text: give the global scope its own.
      if (isLedgerDestinationChangedError(e) && !isRecordStoredError(e) && (e as Error).message !== GLOBAL_DESTINATION_CHANGED[op]) throw this.globalChanged(op, e);
      throw e;
    }
  }

  /** The changed-destination refusal of a global write. An erase's is the typed pre-write refusal the erase handler audits
   *  as 'rejected' (nothing was written), as for a project erase. */
  private globalChanged(op: GlobalWriteOp, cause?: unknown): Error {
    const text = GLOBAL_DESTINATION_CHANGED[op];
    if (op === 'erase') return new EraseRefusedError(text, cause === undefined ? undefined : { cause });
    return new LedgerDestinationChangedError(text);   // the ledger layer's type, as projectWriteRefusal does; it takes no cause
  }

  /** A commit to a project: the body of the critical section (design 4.3 steps 4 and 6). Step 6 first, in the place where
   *  step 3 judged again: a supersede commit checks its target again. A project that is not owned under the lock has no live
   *  target in its scope, so a supersede there is the target-not-found refusal (and never reaches the foreign-file or the
   *  first-write branch below). Then step 4, on the ownership the judgement read under the lock. owned: the row is appended.
   *  Nobody owns it and a file stands at the destination: the foreign-file refusal, made HERE only (FW-R1: a lock-free copy
   *  could refuse a late racer for a file Helix itself had just created; under the lock that commit is finished and the
   *  project reads owned). Nobody owns it and nothing stands there: firstProjectWrite. */
  private commitToProject(p: { root: string; ledger: string }, first: LayerJudgement, record: MemoryRecord, input: CommitInput, source: ProvenanceSource): void {
    this.underProjectLedgerLock(p, 'commit', first, ({ judgement, judged }) => {
      if (input.supersedes) {
        if (judgement.state !== 'owned') throw new Error('commit: supersedes target not found (dead or unknown id)');
        this.assertSupersedeTargetUnderLock(p.ledger, input, source);
      }
      if (judgement.state === 'owned') {
        appendWitnessedUnlocked(p.ledger, record, this.homeDir(), p.root, 'commit', 'commit', judged);
      } else if (judgement.state === 'unadopted-present') {
        throw new Error(FOREIGN_FILE_REFUSAL);
      } else {
        this.firstProjectWrite(p, judgement, record, judged);
      }
    });
  }

  /** The first write to a project nobody adopted, under its ledger lock (design 4.3 step 4, second case, and step 5 with
   *  its seven items). The checks that do not concern the project's file stand in front of the ownership record (item 6).
   *  The held `.helix` descriptor is opened BEFORE anything is recorded (a folder that is not the judged one is the
   *  changed-destination refusal, nothing to restore), and `.owner` is written and removed through it (14 decision 4).
   *
   *  A failure that STORED NO ROW puts the ownership records back, `.owner` first (items 2 and 3; the created file is
   *  taken away by the append itself while it is still this call's, item 4). An error that carries the stored mark
   *  (the row is in the ledger, a later step failed: the witness advance, and, since decision 10, the file's close, the
   *  directory fsync and the held directory's close) keeps the ownership. The answer (item 7): the foreign-file text for
   *  the EEXIST or ELOOP of the creation; the changed-destination text when the check after the open refused; the
   *  cancel-failed text whenever the restore failed, whatever the cause. A refusal with a type and a text of its own that
   *  is not about the project's file (the witness file, a lock object, a path that cannot be resolved, a lost /proc) is
   *  thrown as it is, after the restore (FW-R3; a WitnessAdvanceError here is the heal's, before the row;
   *  the lost /proc has a dedicated text). Everything else is the
   *  first-write-failed text with the fs error as its cause. An error raised before anything was recorded is thrown as it is. */
  private firstProjectWrite(p: { root: string; ledger: string }, judgement: LayerJudgement, record: MemoryRecord, judged: JudgedDestination): void {
    const home = this.homeDir();
    assertWitnessWritable(home, 'commit');
    ensureMaster(home);
    const opened = openOwnerDir(p.root, judgement, realFsOps);
    if (opened.kind === 'changed') throw new LedgerDestinationChangedError();
    if (opened.kind === 'proc-lost') throw new LedgerProcLostError();
    const owner = opened.dir;
    try {
      let snapshot: OwnershipSnapshot | null = null;
      try {
        stampOwnership(p.root, home, { now: this.opts.now, genStamp: this.opts.genStamp, capture: (s) => { snapshot = s; }, ownerDir: owner });
        appendWitnessedUnlocked(p.ledger, record, home, p.root, 'commit', 'commit', { ...judged, createExclusive: true });
      } catch (e) {
        if (isRecordStoredError(e)) throw e;
        const taken = snapshot as OwnershipSnapshot | null;   // assigned in the callback above
        if (taken === null) throw e;
        try { restoreOwnership(p.root, home, taken, owner); }
        catch { throw new Error(FIRST_WRITE_FAILED_NOT_UNDONE, { cause: e }); }
        if (isLedgerCreateRefusedError(e)) throw new Error(FOREIGN_FILE_REFUSAL, { cause: e });
        if (isLedgerDestinationChangedError(e)) throw e;
        if (isWitnessBlockedError(e) || isWitnessUnusableError(e) || isWitnessAdvanceError(e) || isLockForeignObjectError(e) || isUnresolvablePathError(e) || isLedgerProcLostError(e)) throw e;
        throw new Error(FIRST_WRITE_FAILED_UNDONE, { cause: e });
      }
    } finally {
      try { closeHeldDir(owner, realFsOps); } catch { /* a read-only descriptor loses nothing: a failed close must not replace a stored row's success or the refusal in flight */ }
    }
  }

  /** Snapshot the project layer's disposition, for the READ side (recall/inspect/history/asOf — see
   *  each call site below). Computed once per public read call and reused for every project-inclusion
   *  decision that call makes, so a single call can never disagree with itself about whether the
   *  project layer participates (Codex R2 #7). The judgement reads the home registry, the repo-side
   *  .owner file and the path, so this is a SNAPSHOT, not a lock: a concurrent adopt() between two
   *  SEPARATE calls — or mid-read within this one — can still change the answer. That race is accepted,
   *  not solved, here: each NEW call re-invokes this method (nothing is memoized on the instance), so
   *  the next call still sees a fresh, current answer (I4) — only a single call's internal
   *  self-consistency is what this method buys.
   *
   *  The states and their rows are the judgement's (ownership.ts ProjectDisposition, judgeProjectLayer).
   *  This read answers row 9a from the per-process memory; the write side judges again with
   *  `freshContent` (commitToProject, commitScoped, resolveEraseTarget). What stays HERE is the call-site
   *  contract: invoke it ONCE per public read call (recall/currentView/historyView/asOfView each do so,
   *  then thread the snapshot as a parameter into every private helper that needs it, never
   *  re-invoking this within that call). */
  private projectDisposition(): ProjectDisposition {
    return this.judgeLayer().state;
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
  private recallInput(disposition: ProjectDisposition): { scoped: ScopedRecord[]; available: boolean; artifacts: ReturnType<typeof buildRankArtifacts>; verdicts: Array<{ scope: MemoryScope; verdict: WitnessVerdict; witnessFile?: WitnessFileMark }> } {
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
    const verdicts: Array<{ scope: MemoryScope; verdict: WitnessVerdict; witnessFile?: WitnessFileMark }> = [];
    const reads: Array<{ ledger: LedgerPath; scope: MemoryScope; root: string | undefined; bytes: Buffer; subkey: Buffer | null; readMs: number; journalPending: boolean; mismatch: boolean }> = [];
    const globalReadOnly = this.globalReadOnly();
    for (const s of scopes) {
      // W-T7 + §7: witness verdict + identity + journalPending, all off the SAME (final) witness snapshot
      // classified against the SAME (final) bytes — witness-first with a single alarm retry (no self-race,
      // no spurious mismatch from a concurrent append). The identity is a cache-key component; the verdict
      // is applied FRESH by recall() after cache resolution; journalPending forces a bypass.
      const w = readLedgerBytesWitnessed(s.ledger, home, s.root);
      const bytes = w.bytes;                          // I1: owned immutable buffer, read once — NO parse yet
      const subkey = this.subkeyForLedger(s.ledger);  // I3: resolved fresh from disk, never memoized
      key.push({ scopeId: s.ledger, digest: ledgerDigest(bytes), fingerprint: subkeyFingerprint(subkey), witness: w.witnessIdentity });
      verdicts.push({ scope: s.scope, verdict: w.verdict, witnessFile: w.witnessFile });
      // `mismatch` is the STABLE (witness-first + retry-once) rollback verdict — threaded into
      // maybeAutoCompact below so it never advances the witness onto a rolled-back scope (spec §4.2
      // PR-1, belt-and-braces above compactLedger's own authoritative gate). Also set for a read-only global scope
      // (design 4.7): the rewrite would be refused, so the once-per-session guard is kept and no failure metric is written.
      reads.push({ ledger: s.ledger, scope: s.scope, root: s.root, bytes, subkey, readMs: w.readMs, journalPending: w.journalPending, mismatch: w.verdict.kind === 'mismatch' || w.witnessFile !== undefined || (s.scope === 'global' && globalReadOnly) });
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
      // Also set for a scope whose witness file cannot be used or resolved: W-R8, the guard is not spent.
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
        stats = this.rewriteLedger(r.ledger, 'compaction', null, {
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
    for (const { scope, verdict, witnessFile } of verdicts) {
      if (verdict.kind === 'transition-interrupted') excluded.add(scope);
      else if (verdict.kind === 'mismatch' || witnessFile === 'unusable') clamped.add(scope);
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
    // a pure function of the already-read served set (no extra ledger read) and, since issue #9, of
    // the call's clock, which only refuses a slot to a record dated after the call and ranks nothing
    // differently; a cache HIT computes the same appendix as a MISS at the same instant.
    //
    // Issue #9: only a record dated no later than this call, plus RECALL_APPENDIX_FUTURE_TOLERANCE_MS,
    // can take a slot. The order is by tx, so a row carrying a far-future tx (a skewed clock, or a row
    // written by hand into an adopted ledger) otherwise held the first slot on every recall, and a tx
    // that is not a canonical instant cannot be placed in time at all. Such rows are still ranked like
    // any other; only the regardless-of-rank slot is refused. The tolerance keeps a record committed
    // just before a backward clock step (measured: about 0.78 s every ~32 s on WSL2); a step larger than
    // it withholds such a record until the clock comes back within the tolerance of its tx. The call's
    // clock is the one input added here, read after the rank cache, so a HIT and a MISS at the same
    // instant still compute the same appendix. `this.now()` is canonical in production (toISOString);
    // an injected clock must be too, or `<=` stops reading as time order (an unreadable one admits nothing).
    const ranked = new Set(hits);
    const callMs = Date.parse(this.now());
    const latestTx = Number.isFinite(callMs) ? new Date(callMs + RECALL_APPENDIX_FUTURE_TOLERANCE_MS).toISOString() : '';
    const appendixRecords = enforcedScoped
      .map((s, seq) => ({ rec: s.record, seq }))
      .filter(({ rec }) => !ranked.has(rec) && isIsoInstant(rec.tx) && rec.tx <= latestTx)
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
      witnessNotes: this.withGlobalNote(collectWitnessReadNotes(verdicts)),
    };
  }

  /** Which ledger currently holds `id` (project iff the per-call disposition snapshot is 'owned' —
   *  item 7 fix round 1: gating on the shared four-state predicate, not raw isOwned, excludes an
   *  ALIASED layer here too, so neither of this method's callers (commit()'s supersede pre-check,
   *  writeVerify) ever reads through the alias into the other project's real ledger file) and
   *  present; defaults to global. D9: an id live in BOTH scopes at once (only reachable via a
   *  hand-planted/forged ledger row) is ambiguous — silently binding global would ignore the project
   *  duplicate. Throw instead. */
  private ledgerOf(id: string): LedgerPath {
    const p = this.opts.project;
    const inGlobal = this.verifiedOf(this.global).live.has(id);
    const inProject = !!p && this.projectDisposition() === 'owned' && this.verifiedOf(p.ledger).live.has(id);
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
   *  signs, and appends — all under ONE ledger lock so a concurrent writer can't race the gen. A project ledger runs in
   *  the critical section of design 4.3 (the lock at the resolved destination, the layer judged again under it, and a
   *  project that is not owned there refused with the operation's text); the global ledger runs in `underGlobalLedgerLock`. */
  private writeVerify(targetId: string, state: MemoryState, source: ProvenanceSource, op: 'confirm' | 'recheck'): MemoryRecord {
    const ledger = this.ledgerOf(targetId);
    const p = this.opts.project;
    if (p && ledger === p.ledger) {
      return this.underProjectLedgerLock(p, op, this.judgeLayer({ freshContent: true }), ({ judged }) => this.writeVerifyLocked(ledger, targetId, state, source, op, judged));
    }
    return this.underGlobalLedgerLock(op, ({ judged }) => this.writeVerifyLocked(ledger, targetId, state, source, op, judged));
  }

  /** writeVerify's body, for a caller that holds the ledger lock. `op` is the tool's name in a witness refusal; `judged` is
   *  the destination judged under that lock (the project's critical section or `underGlobalLedgerLock`). */
  private writeVerifyLocked(ledger: LedgerPath, targetId: string, state: MemoryState, source: ProvenanceSource, op: 'confirm' | 'recheck', judged: JudgedDestination | undefined): MemoryRecord {
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
    appendWitnessedUnlocked(ledger, signed, this.homeDir(), this.scopeRootOf(ledger), 'verify', op, judged); // we already hold the ledger lock — non-locking, witnessed append
    return signed;
  }

  /** A ledger rewrite (the auto-compaction, the permanent erase) through the same order as every project write: for a
   *  project ledger the critical section, then the rewrite under the lock it holds and through the directory it judged;
   *  for the global ledger `underGlobalLedgerLock`. `first` is the caller's lock-free
   *  judgement, or null to make it here. */
  private rewriteLedger(ledger: LedgerPath, op: 'compaction' | 'erase', first: LayerJudgement | null, opts: CompactOptions): CompactionStats {
    const p = this.opts.project;
    if (p && ledger === p.ledger) {
      return this.underProjectLedgerLock(p, op, first ?? this.judgeLayer({ freshContent: true }), ({ ctx, judged }) => compactLedgerUnlocked(ledger, opts, ctx, judged));
    }
    return this.underGlobalLedgerLock(op, ({ ctx, judged }) => compactLedgerUnlocked(ledger, opts, ctx, judged));
  }

  /** Content-bound mechanical reality-check. Mints at most Corroborated; never Verified. */
  recheck(id: string, check: RealityCheck): RecheckResult {
    this.refuseReadOnlyGlobalTarget(id, 'recheck');
    const target = this.liveTarget(id);
    const binding = checkBinding(target.content, check, target.classification);   // R10: the record's classification decides the redaction sentence
    if (!binding.bound) throw new Error(`recheck: ${binding.reason}`);
    const outcome = runRealityCheck(check);
    const result = resolveTransition({
      targetState: target.state,
      evidenceSource: 'reality-check', outcome,
    });
    const record = result.kind === 'state' ? this.writeVerify(id, result.state, 'reality-check', 'recheck') : null;
    return { outcome, result, record };
  }

  /** Human out-of-band vouch → Verified. Target-gated: only a source=user item is eligible. */
  confirm(id: string): { record: MemoryRecord } {
    this.refuseReadOnlyGlobalTarget(id, 'confirm');
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
    return { record: this.writeVerify(id, state, 'user', 'confirm') };
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
    const verdicts: Array<{ verdict: WitnessVerdict; witnessFile?: WitnessFileMark }> = [];
    const addScope = (ledger: LedgerPath, scope: MemoryScope, root: string | undefined): void => {
      const w = verifiedLiveWitnessed(ledger, home, root);
      this.opts.metricsSink?.emitReplay({
        scope: root ? 'project' : 'global', caller: 'store',
        rows: w.stats.rows, liveRows: w.stats.liveRows, bytes: w.stats.bytes,
        parseMs: w.stats.parseMs, projectMs: w.stats.projectMs, keyAvailable: w.stats.keyAvailable,
      });
      const proj = enforceWitnessProjection(w.projection, w.verdict, w.witnessFile);
      for (const r of proj.live.values()) {
        records.push({
          record: r, scope,
          integrity: proj.compromised.has(r.id) ? 'compromised' : 'ok',
          contentDigest: digestContent(r.content),   // proof-of-read token for a guarded supersede
        });
      }
      verdicts.push({ verdict: w.verdict, witnessFile: w.witnessFile });
    };
    addScope(this.global, 'global', undefined);
    const p = this.opts.project;
    if (p && disposition === 'owned') addScope(p.ledger, 'project', p.root);
    return { records, projectDisposition: disposition, witnessNotes: this.withGlobalNote(collectWitnessReadNotes(verdicts)) };
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
    const verdicts: Array<{ verdict: WitnessVerdict; witnessFile?: WitnessFileMark }> = [];

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const root = this.scopeRootOf(ledger);
      // ONE witnessed read per scope (spec §7): witness-first + retry-once. bytes feed the verdict,
      // records feed both projections — all from the SAME final read pair, so the verdict can never
      // race the projection and an ordinary concurrent append never yields a spurious mismatch.
      const w = readLedgerWitnessed(ledger, home, root);
      verdicts.push({ verdict: w.verdict, witnessFile: w.witnessFile });
      if (w.verdict.kind === 'transition-interrupted') return; // exclude the whole scope (live AND closed rows)
      // Live rows (graded) — membership authority + LEFT-join enrichment, identical to verifiedOf —
      // then the witness clamp (mismatch => elevated LIVE grades drop to Fresh; closed rows below keep
      // their historical state, like asOf).
      const rawV = verifiedLiveOf(w.records, home, root);
      if (!rawV.keyAvailable) integrityAvailable = false; // key-absent => every grade clamped Fresh (fail-safe)
      const v = enforceWitnessProjection(rawV, w.verdict, w.witnessFile);
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

    return { rows, anomalies, truncated, integrityAvailable, projectDisposition: disposition, witnessNotes: this.withGlobalNote(collectWitnessReadNotes(verdicts)) };
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
    const verdicts: Array<{ verdict: WitnessVerdict; witnessFile?: WitnessFileMark }> = [];

    const addScope = (ledger: LedgerPath, scope: MemoryScope) => {
      const root = this.scopeRootOf(ledger);
      // ONE witnessed read per scope (spec §7): witness-first + retry-once, so the verdict and the
      // records come from the SAME final read pair (no spurious mismatch from a concurrent append).
      const w = readLedgerWitnessed(ledger, home, root);
      verdicts.push({ verdict: w.verdict, witnessFile: w.witnessFile });
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
    return { facts, keyAvailable, truncated, projectDisposition: disposition, witnessNotes: this.withGlobalNote(asOfWitnessNotes(collectWitnessReadNotes(verdicts, { asOf: true }))) };
  }

  /** Explicitly adopt the active project ledger (trust its current contents): a pre-existing ledger
   *  Helix did not create, or a parent project. Throws if no project layer is active, or if
   *  `expectedRoot` names a different one.
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
    // The gate (design 4.4; 13.3 decision 3), in the order of a commit: judged lock-free and refused when the judgement excludes
    // the layer, BEFORE anything is recorded; then the ledger lock of the resolved destination, the judgement again under it, the
    // content, the key, and only then the ownership record (lock order ledger, then registry: the first commit's). For a project
    // found in a parent directory the judgement skips row 2 and applies rows 3 to 10 to that project directly (forAdopt). The
    // serialisation is what lets the restore of a failed first commit (4.3 step 5) never undo an adoption made in between: a
    // re-adoption keeps stamp, nonce and time, so the restoring side could not tell it from its own record by value. While
    // another writer holds the ledger lock adopt waits the lock's budget; a foreign object at the lock keeps the lock layer's text.
    this.underProjectLedgerLock(p, 'adopt', this.judgeLayer({ forAdopt: true, freshContent: true }), ({ judgement, judged }) => this.adoptUnderLock(p, judgement, judged));
    return active;
  }

  /** adopt's body, under the project ledger lock (design 4.4). In order: the content check (a destination that exists holds
   *  nothing or parses as ledger rows by the first-1-MiB definition; for a memory path that is a link row 9a of the judgement has
   *  just answered the same question, so this is what answers it for a memory path that is NOT a link); the witness file again
   *  (the wait behind the lock can be 5 s; the first commit's order, 4.3 step 5 item 6); the key (FN-23: a damaged
   *  signing key used to surface AFTER the adoption was recorded; it makes signing possible going forward but signs nothing that
   *  exists: adoption must never launder an unsigned, pre-seeded elevated assert into a Verified one); the held `.helix`
   *  descriptor; then the ownership record with the hold of 4.3 step 5, and its restore when the record fails halfway. */
  private adoptUnderLock(p: { root: string; ledger: string }, judgement: LayerJudgement, judged: JudgedDestination): void {
    if (judged.identity !== null) {
      let kind: LedgerContentKind;
      try { kind = ledgerContentKindAt(judged.path); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOENT' || code === 'EISDIR') throw this.projectWriteRefusal('adopt', 'changed', e);
        throw e;
      }
      if (kind === 'other') throw new Error(ADOPT_NOT_LEDGER_CONTENT);
    }
    const home = this.homeDir();
    assertWitnessWritable(home, 'adopt');
    ensureMaster(home);
    const opened = openOwnerDir(p.root, judgement, realFsOps);
    if (opened.kind === 'changed') throw this.projectWriteRefusal('adopt', 'changed');
    if (opened.kind === 'proc-lost') throw new LedgerProcLostError();
    const owner = opened.dir;
    try {
      let snapshot: OwnershipSnapshot | null = null;
      try {
        stampOwnership(p.root, home, { now: this.opts.now, genStamp: this.opts.genStamp, capture: (s) => { snapshot = s; }, ownerDir: owner });
      } catch (e) {
        const taken = snapshot as OwnershipSnapshot | null;   // assigned in the callback above
        if (taken === null) throw e;                           // failed before anything was recorded (a registry lock refused, for one): as it is
        try { restoreOwnership(p.root, home, taken, owner); }
        catch { throw new Error(ADOPT_RECORD_FAILED_NOT_UNDONE, { cause: e }); }
        throw new Error(ADOPT_RECORD_FAILED_UNDONE, { cause: e });
      }
    } finally {
      try { closeHeldDir(owner, realFsOps); } catch { /* a read-only descriptor loses nothing: a failed close must not replace an adoption made or the refusal in flight */ }
    }
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
   *
   *  A SOFT erase asks a narrower question than a permanent one (IT-M16, rulings R1 and R4): it acts on
   *  MEMORY RECORDS, so only an `assert` or `supersede` row counts as a 'record' — the id of a verify
   *  row or of a tombstone (erase / invalidate) names no memory (R4) — and only a marker row carrying
   *  this EXACT id counts as a 'marker': a name that merely matches a marker family while no row carries
   *  it (`witness_fence_never_written` beside a real fence) names nothing (R1). Content can name any
   *  such id, and answering `unchanged` there read as "already erased or superseded" while nothing was.
   *  The PERMANENT (operator-only) path keeps both wider readings: its family match (C10) is what clears
   *  a planted marker without knowing its nonce, and its exact-id match on any non-marker row is a
   *  physical purge of that row, whatever its type.
   *  Snapshot-relative: computed before the mutation lock, exactly like the presence check it
   *  replaces; a concurrent writer can create the ambiguity after this returns. */
  private findEraseTarget(ledger: LedgerPath, id: string, permanent: boolean): 'record' | 'marker' | 'ambiguous' | 'absent' {
    const records = parseLedger(ledger, ledger === this.global ? GLOBAL_LEDGER_READ : undefined);
    const isRecordRow = (r: MemoryRecord): boolean =>
      !isMarkerShape(r) && (permanent || r.type === 'assert' || r.type === 'supersede');
    const fam = permanent ? this.familyPrefixOf(id) : null;   // R1: the family match serves the permanent path only
    const recordHit = records.some((r) => isRecordRow(r) && r.id === id);
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
  private resolveEraseTarget(id: string, scope: MemoryScope | undefined, permanent: boolean): { ledger: LedgerPath; kind: 'record' | 'marker'; layer: LayerJudgement } | null {
    const p = this.opts.project;
    const judged = this.judgeLayer({ freshContent: true });
    const layer = judged.state;
    const projectActive = layer === 'owned';
    const classify = (ledger: LedgerPath): 'record' | 'marker' | null => {
      const kind = this.findEraseTarget(ledger, id, permanent);
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
      // signal — for a DESTRUCTIVE operation. Refused, mirroring commitToProject's commit-side refusal.
      // A project layer exists only when the server started in or below a directory holding .helix/
      // (src/memory/project-root.ts), so adopting cannot cure this state on its own.
      if (scope === 'project' && !p) {
        throw new EraseRefusedError(
          'erase: scope \'project\' was requested but no project memory layer is active here ' +
          '(Helix configures one only when started in or below a directory holding a .helix folder). ' +
          'Omit `scope`, or start a new session inside the project whose memory holds the record — ' +
          'the erase is refused rather than silently widened to the global ledger.',
        );
      }
      if (scope === 'project' && layer === 'aliased') throw new EraseRefusedError(ERASE_ALIASED_REFUSAL);
      if (scope === 'project' && layer === 'unusable') throw new EraseRefusedError(ERASE_UNUSABLE_REFUSAL);
      const ledger = scope === 'global' || !p ? this.global
        : (projectActive ? p.ledger : (() => { throw new EraseRefusedError(ERASE_NOT_ADOPTED); })());
      const kind = classify(ledger);
      if (kind === null) throw new EraseRefusedError(`erase: id not found in scope ${scope}`);
      return { ledger, kind, layer: judged };
    }
    const candidates: LedgerPath[] = [this.global, ...(projectActive ? [p!.ledger] : [])];
    // Corruption gate — PERMANENT (destructive) erase only. The only production caller (the MCP tool)
    // issues soft, no-scope erases and cannot pass a scope, so gating this on `permanent` keeps
    // right-to-erasure via the tool available even when a candidate has a torn/partial line.
    if (permanent) {
      for (const c of candidates) {
        // IT-H4: the same file-type-checked read as every ledger reader (a FIFO candidate used to block
        // here forever). A missing candidate reads as empty, which has no corrupt lines.
        const text = readLedgerBytes(c, c === this.global ? GLOBAL_LEDGER_READ : undefined).toString('utf8');
        if (parseLedgerHealth(text).skippedNonBlank > 0) {
          throw new EraseRefusedError('erase: a ledger has skipped (corrupt/torn) lines — pass an explicit scope');
        }
      }
    }
    const hits: Array<{ ledger: LedgerPath; kind: 'record' | 'marker'; layer: LayerJudgement }> = [];
    for (const c of candidates) {
      const kind = classify(c);
      if (kind !== null) hits.push({ ledger: c, kind, layer: judged });
    }
    // SOFT erases (the tool's only shape — it cannot pass a scope) prefer the one candidate holding a
    // RECORD with this exact id over candidates whose matches are marker rows: every ledger that has ever
    // been rewritten carries a witness fence, so a marker-only hit is the ordinary state of the OTHER
    // scope, not a second home for the record (final review, I-2), and a soft erase never tombstones a
    // marker row, so preferring the record loses nothing. (Since ruling R1 a soft erase takes no
    // family-only marker match at all — findEraseTarget — so its marker hits here are exact-id ones; the
    // permanent path keeps the family match.) A permanent no-scope erase with more than one hit stays
    // refused — the operator passes an explicit scope.
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
   *  line on ANY candidate throws rather than silently risking a wrong-file compaction.
   *
   *  IT-M16: returns what the id named, so a caller can tell a real erase from a no-op:
   *  - 'erased'   a live record carried the id and its tombstone was appended;
   *  - 'not-live' a memory record (an assert or supersede row) carries the id but is no longer live
   *               (erased or superseded before), or a marker row carries the exact id — no tombstone is
   *               written (T1-g, D8);
   *  - 'absent'   no active scope holds a memory record or a marker row with the id (a no-scope call; an
   *               explicit scope throws). For a SOFT erase that includes a name matching only a marker
   *               FAMILY (R1) and the id of a verify row or a tombstone (R4): none names a memory record
   *               (findEraseTarget).
   *  The PERMANENT path classifies with the wider permanent reading (family match, any non-marker row)
   *  and its behaviour is unchanged: it still compacts every row carrying the id, so 'not-live' there
   *  does not mean nothing was removed. */
  erase(id: string, opts: { permanent?: boolean; scope?: MemoryScope } = {}): EraseOutcome {
    const target = this.resolveEraseTarget(id, opts.scope, opts.permanent ?? false);
    if (target === null) { this.rankCache = null; return 'absent'; }   // clean + absent → no-op, nothing written
    const { ledger, kind, layer } = target;
    const p = this.opts.project;
    const inProject = !!p && ledger === p.ledger;
    if (!inProject) this.refuseReadOnlyGlobal('erase');   // design 4.7: before the advisory read, so a permanent erase never stores a tombstone it cannot purge
    // Anti-laundering (spec §4.2 PR-1): a PERMANENT erase ends in a witnessed compactLedger rewrite,
    // which refuses to advance the witness over a MISMATCH. Gate the WHOLE permanent erase up front on
    // the scope's stable (witness-first + retry-once) verdict, so a rolled-back scope is refused BEFORE
    // the tombstone append — never left tombstone-without-compaction (the plaintext stays on disk while
    // the row already reads as erased). Recovery is the user-only re-baseline ceremony (helix-rebaseline),
    // then re-erase. A SOFT erase is unaffected: its tombstone append is availability-correct (it lands
    // without advancing the witness on a mismatch, witness-write.ts). This up-front read is advisory; the
    // authoritative refusal is compactLedger's own under-lock gate, so a race here can never launder.
    if (opts.permanent && readLedgerBytesWitnessed(ledger, this.homeDir(), this.scopeRootOf(ledger), { rewriterWait: false }).verdict.kind === 'mismatch') {
      throw new WitnessBlockedError(
        'permanent-erase',
        `permanent-erase: scope for id '${id}' is in a MISMATCH (rollback-alarm) state — refusing a permanent erase that would launder the alarm; re-baseline the scope (helix-rebaseline) to adopt the current bytes, then retry (spec §4.2)`,
      );
    }
    let outcome: EraseOutcome;
    try {
      const isMarker = kind === 'marker';                       // by the ROW, not the id (R5(c))
      const alreadyDead = !this.verifiedOf(ledger).live.has(id);
      outcome = isMarker || alreadyDead ? 'not-live' : 'erased';
      if (!isMarker && !alreadyDead) {                          // skip tombstone for markers (T1-g) + already-dead ids (D8)
        const ts = this.now();
        const tombstone: MemoryRecord = {
          id: this.id(), tx: ts, validFrom: ts, validTo: null,
          type: 'erase', content: '', state: 'Suspect',
          provenance: { source: 'user', sessionId: this.session() },
          supersedes: id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        };
        if (inProject) this.underProjectLedgerLock(p!, 'erase', layer, ({ judged }) => appendWitnessedUnlocked(ledger, tombstone, this.homeDir(), p!.root, 'erase', 'erase', judged));
        else this.underGlobalLedgerLock('erase', ({ judged }) => appendWitnessedUnlocked(ledger, tombstone, this.homeDir(), undefined, 'erase', 'erase', judged));
      }
      if (opts.permanent) {
        // HMAC-aware compaction: preserve genuine signed verifies for this ledger, drop forgeries.
        // Resolve the subkey ONCE (see keepValidVerifyFor) so the whole compaction makes one atomic
        // keep/drop decision, and share that predicate with the auto-compaction trigger so the two
        // paths can never diverge. A permanent erase is a ledger REWRITE (prefix change), so it drives
        // the witness transition (kind:'erase') — otherwise the next witnessed read would false-alarm.
        const sk = this.subkeyForLedger(ledger);
        // 'compaction', not 'erase': this rewrite stands behind a stored tombstone, where the erase row's "nothing was
        // erased" is false and the compaction row's "nothing was rewritten" is true. A retried permanent erase re-runs it.
        this.rewriteLedger(ledger, 'compaction', layer, {
          erasedIds: new Set([id]), keepValidVerify: this.keepValidVerifyFor(sk), provesKey: this.provesKeyFor(sk),
          witness: { home: this.homeDir(), scopeKey: scopeKeyOf(this.homeDir(), this.scopeRootOf(ledger)), now: () => this.now(), kind: 'erase' },
        });
      }
    } finally {
      // I8: self-erase gives zero in-memory retention window — cleared even when the append landed
      // and a LATER step threw, so a landed tombstone can never be masked by a stale recall cache.
      this.rankCache = null;
    }
    return outcome;
  }

  /** WRITE-side startup step (spec §4.9): complete any transition whose new bytes already landed
   *  before a crash (crash window B — verdict transition-heal) for every scope this store owns, so a
   *  half-finished rewrite is resolved before the first read rather than lingering as a pending
   *  journal. Global always; project only when its disposition is 'owned' (the same gate every read
   *  path uses, so an excluded layer is left alone).
   *  Each scope's heal runs under that scope's LEDGER lock; completeTransition then nests the witness
   *  lock (a different path — legal). BEST-EFFORT: a scope that is interrupted, stale, or mismatched is
   *  LEFT as-is (it re-surfaces as transition-interrupted / blocked on the next witnessed write, Task
   *  5) — healing must never block server startup, so per-scope failures are swallowed. Wired ONCE in
   *  src/server/index.ts after construction, NEVER from a hook (a read-only surface must not advance
   *  the witness). The lock is taken only after a lock-free look at the scope, one bare read pair
   *  (witness, then ledger) that finds a heal to do (design 4.6, p-8). A holder that dies in a
   *  transition right after that look leaves its scope to be healed by the next start. A start with
   *  nothing to heal is not delayed by a held lock. */
  healWitness(): void {
    const p = this.opts.project;
    // 4.6 and 4.7 (G-R6): the scope of a read-only global ledger (an unresolvable path, or a link into a missing folder) is
    // not healed and its lock is not taken, not even for the lock-free look below. A pending journal there stays pending
    // until the path is repaired and the server is started again (4.7, the residue paragraph).
    const scopes: Array<{ ledger: LedgerPath; root: string | undefined }> = this.globalReadOnly() ? [] : [{ ledger: this.global, root: undefined }];
    if (p && this.projectDisposition() === 'owned') scopes.push({ ledger: p.ledger, root: p.root });
    const home = this.homeDir();
    for (const s of scopes) {
      if (!existsSync(dirname(s.ledger))) continue;   // no scope dir => no witness state => nothing to heal
      const scopeKey = scopeKeyOf(home, s.root);
      try {
        // p-8 (design 4.6): classify WITHOUT the lock first and take the lock only when there is something this step would
        // act on. The look is ONE bare pair, witness first and ledger second (the order witness-read.ts explains), with no
        // retry and no reader wait. It sits inside the same per-scope try, so a read that throws skips the scope, and it
        // decides ONLY whether to take the lock: what the heal does is decided by the classification under the lock.
        const stateBefore = readScopeWitness(home, scopeKey);
        const bytesBefore = readLedgerBytes(s.ledger);
        const verdictBefore = classifyState(stateBefore, bytesBefore);
        const needsHeal = verdictBefore.kind === 'transition-heal'
          || (verdictBefore.kind === 'transition-interrupted' && interruptedAtPredecessor(bytesBefore, verdictBefore.journal));
        if (!needsHeal) continue;
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
