/** witness.json + witness-log.jsonl IO, MAC, locking, single-slot journal supersession (spec
 *  2026-07-17-high-water-counter-decision §4.1-§4.3). The ONLY writer of witness state — every
 *  compound operation runs inside ONE `withFileLock(witnessPath(home), ...)` scope (withFileLock
 *  is not re-entrant per path, lock.ts:166-167), so the functions below never call each other; each
 *  re-derives its own view of the current disk state under its own lock acquisition. */
import { randomBytes, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { lstatSync, openSync, fstatSync, readFileSync, closeSync, constants, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './lock.js';
import { canonicalRoot, resolvePath, resolvedPathOrThrow } from './path-identity.js';
import { ensureMaster, tryReadMaster } from './ledger-mac.js';
import { realFsOps, writeAll, type DurableFsOps } from './fs-ops.js';
import { sweepOrphanTmps } from './ledger-sweep.js';
import { ensureHelixDir } from './home-permissions.js';
import {
  classifyWitness, advanceAllowed, cleanupClearAllowed, sha256Hex,
  type WitnessEntry, type JournalEntry, type WitnessVerdict, type WitnessFileMark,
} from './witness-core.js';
import type { MemoryState } from '../types.js';

export function witnessPath(home: string): string { return join(home, 'witness.json'); }
export function witnessLogPath(home: string): string { return join(home, 'witness-log.jsonl'); }

/** Home-side scope identity — registry-key convention (ownership.canonicalRoot): '@global' or the
 *  CANONICAL (symlink-resolved) absolute project root, so an aliased path can't split one physical
 *  project into two witness scopes (must match ownership's nonce key exactly). NEVER the repo-side
 *  `.owner` stamp (adversary-writable). */
export function scopeKeyOf(home: string, projectRoot?: string): string {
  return projectRoot === undefined ? '@global' : canonicalRoot(projectRoot);
}

/** A refused (or race-invalidated) witness advance, thrown by `openTransition`, `completeTransition`,
 *  `discardTransition` and `advanceWitness`. `landedState` is set by exactly ONE caller —
 *  witness-write.ts's post-append `advanceWitness` call — and is undefined on every other throw,
 *  which reads as "nothing is known to have landed", never as "nothing landed". */
export class WitnessAdvanceError extends Error {
  /** The marker `isWitnessAdvanceError` reads. See there for why it is a property and not the class. */
  readonly witnessAdvance = true;
  /** The state of the record that ALREADY LANDED when this throw happened. Set by the ONE caller that
   *  knows it — witness-write.ts's post-append `advanceWitness` call. Undefined for every
   *  rewrite-path throw, which refuses before the ledger moves, so `undefined` reads as "nothing is
   *  known to have landed", never as "nothing landed". */
  landedState?: MemoryState;
  constructor(message: string) { super(message); this.name = 'WitnessAdvanceError'; }
}

/** Read as a PROPERTY rather than through `instanceof`, for the reason
 *  scripts/pilot/artifact-io.ts's `isInvocationError` sets out: a class is identified by the module
 *  instance that evaluated its declaration, so any arrangement that loads this module twice mints two
 *  unrelated classes and `instanceof` answers "no" for a genuine one — silently restoring the exact
 *  mislabel this marker exists to fix. Returns `boolean`, matching the precedent, rather than a type
 *  predicate a merely structural object could satisfy. */
export const isWitnessAdvanceError = (e: unknown): boolean =>
  e instanceof Error && (e as { witnessAdvance?: unknown }).witnessAdvance === true;
/** The operation a blocked witnessed write was performing. Append ops ('commit' | 'erase' |
 *  'verify') come from the three witness-write callers; rewrite ops ('compaction' |
 *  'permanent-erase') are DERIVED from the flowing witness kind at the authoritative gate, so
 *  the label stays truthful even when a permanent erase loses the advisory-precheck race and
 *  is refused inside compactLedger (Codex round 3). */
export type WitnessBlockedOp = 'commit' | 'erase' | 'verify' | 'compaction' | 'permanent-erase';
export class WitnessBlockedError extends Error {
  /** Marker `isWitnessBlockedError` reads — a property, never the class (see isWitnessAdvanceError). */
  readonly witnessBlocked = true;
  constructor(readonly op: WitnessBlockedOp, message: string) { super(message); this.name = 'WitnessBlockedError'; }
}
/** Every WitnessBlockedError is thrown BEFORE the ledger moves (witness-write.ts steps 3/3b, the
 *  compaction gate), so a handler may audit it as a pre-write refusal. Property read, not instanceof. */
export const isWitnessBlockedError = (e: unknown): boolean =>
  e instanceof Error && (e as { witnessBlocked?: unknown }).witnessBlocked === true;

export interface ScopeWitnessState {
  entry: WitnessEntry | null;
  journal: JournalEntry | null;
  macInvalid: boolean;
  /** Set only by a read with `WITNESS_READ_AS_GIVEN`; see WitnessFileMark. */
  file?: WitnessFileMark;
}

interface ScopeFile { entry: WitnessEntry | null; journal: JournalEntry | null }
interface WitnessStoreFile { v: 1; scopes: Record<string, ScopeFile> }

// ---- MAC: HMAC-SHA256, key = HKDF(master, salt=scopeKey, info='helix-witness-mac-v1'), payload
// = JSON.stringify({...record, mac: undefined}) — JSON.stringify drops an undefined-valued key
// entirely, so the payload is the record's OTHER fields in their fixed construction order (the
// 'mac' key's position never moves: signedEntry/signedJournal always add it last). ----

function macKeyFor(scopeKey: string, master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(scopeKey), 'helix-witness-mac-v1', 32));
}
function macOf(scopeKey: string, master: Buffer, record: object): string {
  const payload = JSON.stringify({ ...record, mac: undefined });
  return createHmac('sha256', macKeyFor(scopeKey, master)).update(payload).digest('hex');
}
function verifyMac(scopeKey: string, master: Buffer, record: { mac: string }): boolean {
  let got: Buffer;
  try { got = Buffer.from(record.mac, 'hex'); } catch { return false; }
  const want = Buffer.from(macOf(scopeKey, master, record), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
function signedEntry(scopeKey: string, master: Buffer, unsigned: Omit<WitnessEntry, 'mac'>): WitnessEntry {
  const base = { ...unsigned, mac: '' };
  return { ...base, mac: macOf(scopeKey, master, base) };
}
function signedJournal(scopeKey: string, master: Buffer, unsigned: Omit<JournalEntry, 'mac'>): JournalEntry {
  const base = { ...unsigned, mac: '' };
  return { ...base, mac: macOf(scopeKey, master, base) };
}

// ---- witness.json read/write (pure helpers — no locking of their own; callers that mutate hold
// the witness lock and resolve the witness path through path-identity.ts ONCE, matching the
// resolve-once-under-the-lock discipline ledger.ts's compactLedger uses). ----

export type WitnessUnusableReason = 'unresolvable' | 'link' | 'not-regular' | 'unreadable' | 'unparseable' | 'transient';

const WITNESS_UNUSABLE_REFUSAL_BODY =                                                           // 4.9 row "witness", verbatim after `<op>: `
  'the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is ' +
  'not a regular file, or it cannot be read or parsed) — the write is refused rather than replacing that ' +
  'file, which would drop the baseline of every scope. Ask the user whether to restore it from a backup or ' +
  'to remove it, which starts every scope again from first contact; do not choose for them.';
const WITNESS_TRANSIENT_FAILURE_BODY =                                                          // no 4.9 row: no advice to remove the file
  'the rollback-witness file could not be read at this moment (the system is out of file descriptors, or ' +
  'the read was interrupted), so this call failed. The file itself was not found to be damaged; try the ' +
  'call again.';
export function witnessUnusableRefusal(op: string): string { return `${op}: ${WITNESS_UNUSABLE_REFUSAL_BODY}`; }

/** witness.json cannot be used, or could not be read this once (`reason: 'transient'`). A read failure is this error and
 *  never "no pending journal" (D9, second item). */
export class WitnessUnusableError extends Error {
  readonly witnessUnusable = true;                                                              // the marker; never `instanceof`
  constructor(readonly op: string, readonly reason: WitnessUnusableReason) {
    super(reason === 'transient' ? `${op}: ${WITNESS_TRANSIENT_FAILURE_BODY}` : witnessUnusableRefusal(op));
    this.name = 'WitnessUnusableError';
  }
}
export const isWitnessUnusableError = (e: unknown): boolean =>
  e instanceof Error && (e as { witnessUnusable?: unknown }).witnessUnusable === true;

const TRANSIENT_READ_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EINTR']);
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
/** O_NOFOLLOW: a link that takes the name after the look is not followed (ELOOP). O_NONBLOCK: a FIFO that takes it
 *  opens instead of blocking, and the descriptor is then asked what it is. */
const WITNESS_READ_OPEN = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

type WitnessFileRead =
  | { kind: 'absent'; path: string | null; asGiven: boolean }          // path null: no folder to create it in
  | { kind: 'store'; path: string; store: WitnessStoreFile; asGiven: boolean }
  | { kind: 'unusable'; reason: Exclude<WitnessUnusableReason, 'transient'> }
  | { kind: 'transient' }
  | { kind: 'uninspectable'; error: NodeJS.ErrnoException };           // the way to the file cannot be examined (EACCES, ENOTDIR on the home's path): raised as that fs error, as before (W-R7)

const isEnvelope = (parsed: unknown): parsed is WitnessStoreFile => {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const o = parsed as { v?: unknown; scopes?: unknown };
  return o.v === 1 && o.scopes !== null && typeof o.scopes === 'object' && !Array.isArray(o.scopes);   // what the scopes hold is NOT looked at (D9 fourth item)
};

/** THE one look at witness.json (design 4.8): used lock-free by readScopeWitness and by A16's pre-append check, and under the witness
 *  lock by the five mutating functions, so the rule is one rule. Never throws; nothing is remembered between calls (D9 fifth item). */
function readWitnessFile(rawPath: string, asGiven: boolean): WitnessFileRead {
  // 1. The resolver FIRST, because it follows a link and the look below does not. A link that took the name before the
  // look is seen by the look, whatever the resolver said; a link that takes it after the look stands at r.path itself,
  // where O_NOFOLLOW and the replace check guard the right name. In the other order a link that lands between the two
  // passes the look and turns r.path into its destination, which is then read and replaced.
  const r = resolvePath(rawPath);
  try {                                                                 // 2. the NAME, without following a link (decision 6)
    const st = lstatSync(rawPath);
    if (st.isSymbolicLink()) return { kind: 'unusable', reason: 'link' };
    if (!st.isFile()) return { kind: 'unusable', reason: 'not-regular' };
  } catch (e) {
    if (TRANSIENT_READ_CODES.has(codeOf(e) ?? '')) return { kind: 'transient' };
    // absent, or not examinable from here: the resolver answers for the path
  }
  let path: string; let given = false;
  if (r.kind === 'unresolvable') {
    if (!asGiven) return { kind: 'unusable', reason: 'unresolvable' };
    path = rawPath; given = true;                                       // D3: a read opens the path as written; no link stands at its last name (examined above)
  } else if (r.kind === 'uninspectable') {
    const code = r.error.code ?? '';
    if (code === 'ENOENT') return { kind: 'absent', path: null, asGiven: false };   // a spelling the kernel refuses to open: for the kernel no file is there
    return TRANSIENT_READ_CODES.has(code) ? { kind: 'transient' } : { kind: 'uninspectable', error: r.error };
  } else if (r.dirMissing) {
    return { kind: 'absent', path: null, asGiven: false };              // a virgin home has no witness state (IT-H1)
  } else path = r.path;
  let fd: number;                                                       // 3. only a regular file is opened; the DESCRIPTOR is asked again what it is
  try { fd = openSync(path, WITNESS_READ_OPEN); }
  catch (e) {
    const code = codeOf(e) ?? '';
    if (code === 'ENOENT') return { kind: 'absent', path, asGiven: given };
    if (code === 'ELOOP') return { kind: 'unusable', reason: 'link' };           // a link took the name between the look and the open
    return TRANSIENT_READ_CODES.has(code) ? { kind: 'transient' } : { kind: 'unusable', reason: 'unreadable' };
  }
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'unusable', reason: 'not-regular' };
    text = readFileSync(fd, 'utf8');
  } catch (e) {
    return TRANSIENT_READ_CODES.has(codeOf(e) ?? '') ? { kind: 'transient' } : { kind: 'unusable', reason: 'unreadable' };
  } finally { try { closeSync(fd); } catch { /* a failed close of a read-only descriptor */ } }
  let parsed: unknown;                                                  // 4. only a missing file is an empty store
  try { parsed = JSON.parse(text); } catch { return { kind: 'unusable', reason: 'unparseable' }; }
  if (!isEnvelope(parsed)) return { kind: 'unusable', reason: 'unparseable' };
  return { kind: 'store', path, store: { v: 1, scopes: parsed.scopes }, asGiven: given };
}

/** Before the witness LOCK is asked for: the lock file's place comes from the resolver, which follows a link, so a link
 *  at witness.json would move the lock to the destination's side. An absent or non-examinable name falls through. */
function assertWitnessPathLockable(rawPath: string, op: string): void {
  let link = false;
  try { link = lstatSync(rawPath).isSymbolicLink(); } catch { /* absent, or not examinable from here */ }
  if (link) throw new WitnessUnusableError(op, 'link');
  if (resolvePath(rawPath).kind === 'unresolvable') throw new WitnessUnusableError(op, 'unresolvable');
}

/** The store as a caller holding the witness lock sees it, and the path it replaces. Only a missing file is an empty
 *  store; a missing folder raises the kernel's own ENOENT, as before. */
function loadStoreLocked(rawPath: string, op: string): { path: string; store: WitnessStoreFile } {
  const f = readWitnessFile(rawPath, false);
  if (f.kind === 'uninspectable') throw f.error;
  if (f.kind === 'unusable') throw new WitnessUnusableError(op, f.reason);
  if (f.kind === 'transient') throw new WitnessUnusableError(op, 'transient');
  if (f.kind === 'store') return { path: f.path, store: f.store };
  return { path: f.path ?? resolvedPathOrThrow(rawPath), store: { v: 1, scopes: {} } };
}

/** The look at the name right before the rename (W-R3): a link or any non-regular object that took the name after the
 *  locked read is refused, never replaced. */
function assertReplaceTarget(path: string, op: string): void {
  let st: Stats;
  try { st = lstatSync(path); }
  catch (e) {
    const code = codeOf(e) ?? '';
    if (code === 'ENOENT') return;
    if (TRANSIENT_READ_CODES.has(code)) throw new WitnessUnusableError(op, 'transient');
    throw e;
  }
  if (st.isSymbolicLink()) throw new WitnessUnusableError(op, 'link');
  if (!st.isFile()) throw new WitnessUnusableError(op, 'not-regular');
}

/** Atomic replace: sweep orphans, write `.w-<hex32>.tmp` ('wx' + fchmod 0600), writeAll, fsync,
 *  close, rename over witness.json, fsync the parent dir. `fsOps` is the SAME injectable
 *  fs-ops.ts:DurableFsOps seam compactLedger/appendRecordUnlocked already use — defaults to
 *  realFsOps, so production behavior is unchanged; tests can inject a faulty fsOps to exercise the
 *  disk-full/short-write/fsync failpoints on this specific file (Task 8). The name is looked at once
 *  more before the rename (assertReplaceTarget); `op` names the refusal, and a refusal leaves no tmp. */
function writeStoreFileAt(path: string, store: WitnessStoreFile, fsOps: DurableFsOps = realFsOps, op = 'witness'): void {
  const dir = dirname(path);
  const tmp = `${path}.w-${randomBytes(16).toString('hex')}.tmp`;
  sweepOrphanTmps(path, { fsOps, keep: tmp });
  const fd = fsOps.openSync(tmp, 'wx');
  try {
    fsOps.fchmodSync(fd, 0o600);
    writeAll(fsOps, fd, JSON.stringify(store));
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
  } catch (e) {
    try { fsOps.closeSync(fd); } catch { /* already closed by a throwing close */ }
    try { fsOps.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
  try { assertReplaceTarget(path, op); }
  catch (e) {
    try { fsOps.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
  fsOps.renameSync(tmp, path);
  fsOps.fsyncDir(dir);
}

/** Verify entry/journal independently against `raw`; `macInvalid` is set if EITHER fails —
 *  classifyScope degrades the WHOLE scope wholesale on any tamper (semantics row 4), never
 *  salvages a still-valid half. */
function deriveState(scopeKey: string, master: Buffer | null, raw: ScopeFile | undefined): ScopeWitnessState {
  if (!raw) return { entry: null, journal: null, macInvalid: false };
  let macInvalid = false;
  let entry: WitnessEntry | null = null;
  let journal: JournalEntry | null = null;
  if (raw.entry) { if (master && verifyMac(scopeKey, master, raw.entry)) entry = raw.entry; else macInvalid = true; }
  if (raw.journal) { if (master && verifyMac(scopeKey, master, raw.journal)) journal = raw.journal; else macInvalid = true; }
  return { entry, journal, macInvalid };
}

/** How a caller wants witness.json answered. The default, for a writer or a planner: refuse an unresolvable path and an
 *  unusable file. `unresolvable: 'as-given'` opens an unresolvable path as written (D3); `unusable: 'mark'` answers an
 *  unusable file as an empty state carrying `file: 'unusable'`. `op` names the refusal. */
export interface WitnessReadOptions { unresolvable?: 'refuse' | 'as-given'; unusable?: 'refuse' | 'mark'; op?: string }
/** What a read surface passes: it never throws for an unusable file, and a transient error still fails the call. */
export const WITNESS_READ_AS_GIVEN: WitnessReadOptions = { unresolvable: 'as-given', unusable: 'mark' };

/** Lock-free read; MAC-invalid entry/journal reported via `macInvalid`, returned as null. Only a missing
 *  file is an empty store (D9). A home that does not exist yet (a fresh install) has no witness state
 *  (IT-H1): witness-read.ts promises a valid verdict on a virgin home. A way to the file that cannot be
 *  examined (ENOTDIR from a file standing in the path, EACCES) still propagates as that fs error (W-R7). */
export function readScopeWitness(home: string, scopeKey: string, opts: WitnessReadOptions = {}): ScopeWitnessState {
  const f = readWitnessFile(witnessPath(home), opts.unresolvable === 'as-given');
  const op = opts.op ?? 'witness';
  if (f.kind === 'uninspectable') throw f.error;
  if (f.kind === 'transient') throw new WitnessUnusableError(op, 'transient');                    // fails this call for every caller (D9 sixth item)
  if (f.kind === 'unusable' && opts.unusable !== 'mark') throw new WitnessUnusableError(op, f.reason);
  if (f.kind === 'absent' && f.path === null) return { entry: null, journal: null, macInvalid: false };   // no home folder: nothing to read, not even a key (IT-H1)
  const master = tryReadMaster(home);   // read in EVERY other case, an absent or unusable store included: a corrupt HOME key must still make this throw (prototype finding F-2; trust-store-home.e2e case C)
  if (f.kind === 'unusable') return { entry: null, journal: null, macInvalid: false, file: 'unusable' };
  const state = deriveState(scopeKey, master, f.kind === 'store' ? f.store.scopes[scopeKey] : undefined);
  return f.asGiven ? { ...state, file: 'as-given' } : state;
}

/** Classify `bytes` against an ALREADY-DERIVED scope state (readScopeWitness) — the core mapping
 *  classifyScope composes from readScopeWitness + this function (DRY: extracted, Fix loop 1, so a
 *  caller that already holds one ScopeWitnessState snapshot — e.g. witness-read.ts's
 *  readLedgerWitnessed, which also needs witnessIdentity/journalPending off the SAME state — can
 *  derive its verdict directly, without classifyScope's own internal second witness.json read).
 *  `macInvalid` short-circuits to first-contact/mac-invalid WITHOUT consulting classifyWitness at
 *  all — a corrupt journal degrades the whole scope even if the entry alone would still verify
 *  (semantics row 4). */
export function classifyState(state: ScopeWitnessState, bytes: Buffer): WitnessVerdict {
  if (state.macInvalid) return { kind: 'first-contact', reason: 'mac-invalid' };
  return classifyWitness(bytes, state.entry, state.journal);
}

/** readScopeWitness + classifyState; macInvalid short-circuits to first-contact/mac-invalid
 *  WITHOUT consulting classifyWitness at all — a corrupt journal degrades the whole scope even if
 *  the entry alone would still verify (semantics row 4). Thin composition, unchanged behavior — a
 *  caller that needs the intermediate ScopeWitnessState too calls readScopeWitness + classifyState
 *  directly instead, to avoid this function's own internal second witness.json read. */
export function classifyScope(home: string, scopeKey: string, bytes: Buffer): WitnessVerdict {
  return classifyState(readScopeWitness(home, scopeKey), bytes);
}

function appendWitnessLogLine(home: string, line: { v: 1; scope: string; epoch: number; kind: JournalEntry['kind']; tx: string; nonce: string; op?: 'discard' }, fsOps: DurableFsOps): void {
  const fd = fsOps.openSync(witnessLogPath(home), 'a', 0o600);
  try {
    writeAll(fsOps, fd, JSON.stringify(line) + '\n');
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
}

/** Under the witness lock, RE-classifies from current disk state (never a pre-lock snapshot) and
 *  throws WitnessAdvanceError unless advanceAllowed — the anti-laundering invariant enforced a
 *  second time at the store layer (spec §4.2). A macInvalid scope degrades wholesale to a fresh
 *  TOFU adoption: the new entry's epoch resets to 1, matching a genuine first-contact. `fsOps`
 *  (Task 8): injectable seam for the witness.json replace itself — defaults to realFsOps. */
export function advanceWitness(home: string, scopeKey: string, bytes: Buffer, headTx: string | null, fsOps: DurableFsOps = realFsOps): void {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, 'advanceWitness');
  ensureHelixDir(home);
  const master = ensureMaster(home);
  withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, 'advanceWitness');
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const verdict = classifyState(state, bytes);
    if (!advanceAllowed(verdict)) {
      throw new WitnessAdvanceError(`advanceWitness: blocked for scope — verdict '${verdict.kind}' does not permit advance`);
    }
    // Wholesale degrade (semantics row 4): when macInvalid, treat BOTH pieces as absent — even a
    // still-verifying journal is discarded, since preserving it would bind a fresh TOFU entry
    // (epoch reset to 1) to a predecessor/epoch lineage from the discarded entry.
    const effectiveEntry = state.macInvalid ? null : state.entry;
    const effectiveJournal = state.macInvalid ? null : state.journal;
    const unsigned = { epoch: effectiveEntry?.epoch ?? 1, byteLength: bytes.length, prefixHash: sha256Hex(bytes), headTx };
    const entry = signedEntry(scopeKey, master, unsigned);
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal: effectiveJournal } } };
    writeStoreFileAt(path, nextStore, fsOps, 'advanceWitness');
  });
}

/** The minted-but-not-yet-written plan for the next transition (spec §4.9 "Ordering resolution"):
 *  epoch + nonce + predecessor + supersedes, computed from the CURRENT scope state WITHOUT any witness
 *  write. Split out of openTransition so the caller (compactLedger) can mint the fence — which needs
 *  the epoch+nonce — and thereby the `expected` digest BEFORE journaling, breaking the fence<->journal
 *  cycle. A pure read: never mints a master (tryReadMaster via readScopeWitness), never writes.
 *  macInvalid degrades entry/journal to null, exactly as openTransition/advanceWitness do. `kind` is
 *  part of the plan the caller carries to openTransition (it does not affect epoch/nonce here). The
 *  plan is only ADVISORY — openTransition re-reads under the lock and re-asserts consistency, so a
 *  concurrent writer moving the witness between plan and open is caught (WitnessAdvanceError), never
 *  silently applied over a moved state. */
export function planTransition(
  home: string, scopeKey: string, kind: JournalEntry['kind'],
): { epoch: number; nonce: string; predecessor: { byteLength: number; prefixHash: string } | null; supersedes: string | null } {
  void kind; // carried by the caller into openTransition; epoch/nonce do not depend on it
  const state = readScopeWitness(home, scopeKey);
  const entry = state.macInvalid ? null : state.entry;
  const pending = state.macInvalid ? null : state.journal;
  const epoch = Math.max((entry?.epoch ?? 0) + 1, pending ? pending.epoch + 1 : 0);
  const nonce = randomBytes(16).toString('hex');
  const predecessor = entry ? { byteLength: entry.byteLength, prefixHash: entry.prefixHash } : null;
  const supersedes = pending?.nonce ?? null;
  return { epoch, nonce, predecessor, supersedes };
}

/** Under the witness lock; single-slot atomic supersession — a pending journal is REPLACED by the
 *  new one, its nonce recorded in `supersedes`, so there is never a cleared gap and never two
 *  stacked entries (spec §4.3, Codex round 4). Takes the fully-formed `plan` (from planTransition)
 *  PLUS the `expected` digest the caller computed over the fenced rewrite bytes — it no longer mints
 *  epoch/nonce itself (the fence<->journal ordering resolution). RE-READS the scope state under the
 *  lock and ASSERTS the plan is still consistent — the current entry's epoch is strictly below the
 *  plan's, AND the pending journal's nonce is exactly what the plan expects to supersede — else the
 *  witness moved after the plan was taken and this throws WitnessAdvanceError (the caller must
 *  re-plan). Appends the witness-log line BEFORE the journal write lands, so incident response sees
 *  the intent even if the journal write itself never completes. `fsOps` (Task 8): injectable seam
 *  for the witness.json replace itself — defaults to realFsOps. */
export function openTransition(
  home: string, scopeKey: string,
  plan: {
    kind: JournalEntry['kind'];
    epoch: number;
    nonce: string;
    predecessor: { byteLength: number; prefixHash: string } | null;
    supersedes: string | null;
    expected: { byteLength: number; prefixHash: string };
    tx: string;
  },
  fsOps: DurableFsOps = realFsOps,
): JournalEntry {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, 'openTransition');
  ensureHelixDir(home);
  const master = ensureMaster(home);
  return withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, 'openTransition');
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const entry = state.macInvalid ? null : state.entry;
    const pending = state.macInvalid ? null : state.journal;
    const pendingNonce = pending ? pending.nonce : null;
    if (!((entry?.epoch ?? 0) < plan.epoch && pendingNonce === plan.supersedes)) {
      throw new WitnessAdvanceError(
        'openTransition: plan is inconsistent with the current witness state (entry epoch not below ' +
        'plan epoch, or the pending journal to supersede changed) — the witness moved, re-plan',
      );
    }
    // Field ORDER is load-bearing (the MAC payload is JSON.stringify of these keys in this order —
    // macOf, above): keep it byte-identical to the plan/JournalEntry field order.
    const unsigned = {
      kind: plan.kind, epoch: plan.epoch, predecessor: plan.predecessor, expected: plan.expected,
      nonce: plan.nonce, tx: plan.tx, supersedes: plan.supersedes,
    };
    const journal = signedJournal(scopeKey, master, unsigned);
    appendWitnessLogLine(home, { v: 1, scope: scopeKey, epoch: plan.epoch, kind: plan.kind, tx: plan.tx, nonce: plan.nonce }, fsOps);
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal } } };
    writeStoreFileAt(path, nextStore, fsOps, 'openTransition');
    return journal;
  });
}

/** Under the witness lock; requires a pending journal AND bytes that exactly match
 *  journal.expected (classifyWitness's transition-heal, entry is provably irrelevant to that
 *  check once a journal is present — journal-first, witness-core.ts). Also enforces "the journal
 *  can never lower the witness" (spec §4.3, R1-F2): a journal whose epoch the witness has already
 *  reached or passed is stale and MUST NOT be applied — only maybeCleanupClear may retire it. On
 *  success this is the ONLY path that moves the witness across a rewrite: entry becomes the
 *  expected head at the journal's epoch, and the slot clears. `fsOps` (Task 8): injectable seam for
 *  the witness.json replace itself — defaults to realFsOps. */
export function completeTransition(home: string, scopeKey: string, bytes: Buffer, headTx: string | null, fsOps: DurableFsOps = realFsOps): void {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, 'completeTransition');
  ensureHelixDir(home);
  const master = ensureMaster(home);
  withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, 'completeTransition');
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) throw new WitnessAdvanceError('completeTransition: no pending journal for scope');
    const entry = state.macInvalid ? null : state.entry;
    if (entry !== null && entry.epoch >= journal.epoch) {
      throw new WitnessAdvanceError('completeTransition: stale journal — the witness already reached or passed its target epoch (a journal can never lower the witness)');
    }
    const verdict = classifyWitness(bytes, null, journal); // entry is irrelevant once a journal is present
    if (verdict.kind !== 'transition-heal') {
      throw new WitnessAdvanceError('completeTransition: bytes do not exactly match the journaled expected head');
    }
    const unsigned = { epoch: journal.epoch, byteLength: journal.expected.byteLength, prefixHash: journal.expected.prefixHash, headTx };
    const nextEntry = signedEntry(scopeKey, master, unsigned);
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry: nextEntry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps, 'completeTransition');
  });
}

/** Under the witness lock; the RETRACT half of the open/complete pair — journal := null, entry
 *  untouched — for a transition whose rewrite provably never touched the ledger (the append/rename
 *  refused before its first byte). Logs the retraction to witness-log BEFORE clearing the slot
 *  (mirror of openTransition's intent-first ordering: if the clear itself never lands, the scope
 *  stays pending — the conservative side).
 *
 *  Identified by `nonce`, not by tx: the fence's tx is a wall-clock stamp (millisecond resolution,
 *  and a constant under an injected fixed clock), so it cannot prove ownership of a transition. The
 *  journal's nonce is 16 random bytes minted per plan, so equality IS the ownership proof — and the
 *  caller gets it from the JournalEntry openTransition returned, which means a retraction key can
 *  only exist for a journal that actually landed.
 *
 *  TWO refusals, both structural:
 *
 *  1. A journal this caller did not open (nonce mismatch, or none pending) — the ordinary
 *     someone-moved-the-witness case.
 *  2. A journal that SUPERSEDED a still-unresolved one (`supersedes !== null`). openTransition is
 *     single-slot: the predecessor is absorbed and only its nonce survives, so clearing the slot
 *     would not restore the pre-open state — it would DELETE the predecessor's evidence. The
 *     caller's proof covers only its own rewrite; it says nothing about the earlier writer's
 *     window. Retracting there either launders a rollback alarm (predecessor interrupted) or
 *     discards the binding between already-landed bytes and their epoch, leaving a 'mismatch' the
 *     entry can no longer explain (predecessor healing). Leaving the slot pending is the only
 *     honest option, and it is exactly what a re-drive expects to supersede.
 *
 *  SAFETY CONTRACT, deliberately split: the bytes-unchanged proof belongs to the CALLER, because
 *  only the failing writer has it — it held the LEDGER lock continuously from before
 *  openTransition and re-read the bytes under that lock after the failure. From disk state alone,
 *  "bytes match the pre-transition state" cannot distinguish a rewrite that never started from one
 *  that landed and was rolled back (the journal-first rationale in witness-core.ts), which is why
 *  classifyWitness keeps calling that state 'transition-interrupted' and no read path may relax
 *  it. A CRASHED writer's journal therefore stays pending until the next server start retracts it
 *  (store.ts healWitness, and only when the bytes still sit at the journal's recorded predecessor;
 *  this function still refuses one that superseded another) or an operator re-drives the rewrite or
 *  re-baselines the scope. A reader that meets the state while a LIVE process holds the ledger lock
 *  waits for that holder and reads again (witness-read.ts, IT-M6); that changes when it reads, never
 *  how it classifies. */
export function discardTransition(home: string, scopeKey: string, nonce: string, fsOps: DurableFsOps = realFsOps): void {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, 'discardTransition');
  ensureHelixDir(home);
  const master = ensureMaster(home);
  withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, 'discardTransition');
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) throw new WitnessAdvanceError('discardTransition: no pending journal for scope');
    if (journal.nonce !== nonce) {
      throw new WitnessAdvanceError('discardTransition: the pending journal belongs to a different transition (superseded meanwhile?) — refusing to retract it');
    }
    if (journal.supersedes !== null) {
      throw new WitnessAdvanceError(
        'discardTransition: this transition superseded a still-unresolved one, whose evidence the ' +
        'single journal slot no longer holds — retracting would clear an alarm this writer cannot ' +
        'vouch for; leaving it pending for a re-drive instead',
      );
    }
    const entry = state.macInvalid ? null : state.entry;
    appendWitnessLogLine(home, { v: 1, scope: scopeKey, epoch: journal.epoch, kind: journal.kind, tx: journal.tx, nonce: journal.nonce, op: 'discard' }, fsOps);
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps, 'discardTransition');
  });
}

/** Under the witness lock; applies cleanupClearAllowed's two-part predicate (witness at/beyond
 *  the journal's target epoch AND the current file validates against the CURRENT witness entry —
 *  monotonicity alone is not read containment, spec §4.3 R4-F1). Clears the slot and returns true
 *  only when it holds; otherwise the journal REMAINS pending (never a plain no-journal decay).
 *  `fsOps` (Task 8): injectable seam for the witness.json replace itself — defaults to realFsOps.
 *
 *  DEFENSIVE / not on a live path (final whole-branch review, 2026-07-18): `completeTransition`
 *  advances the entry AND clears the journal in ONE atomic write, so the "witness at/beyond target
 *  with the journal still pending" state this cleans up cannot arise from our own write paths. It
 *  is retained, tested, as defense-in-depth against a partial-write adversary the model otherwise
 *  excludes; no production caller invokes it today. */
export function maybeCleanupClear(home: string, scopeKey: string, bytes: Buffer, fsOps: DurableFsOps = realFsOps): boolean {
  const rawPath = witnessPath(home);
  assertWitnessPathLockable(rawPath, 'maybeCleanupClear');
  ensureHelixDir(home);
  return withFileLock(rawPath, () => {
    const { path, store } = loadStoreLocked(rawPath, 'maybeCleanupClear');
    const master = tryReadMaster(home); // never mints: clearing produces no new signed content
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) return false;
    const entry = state.macInvalid ? null : state.entry;
    if (!cleanupClearAllowed(bytes, entry, journal)) return false;
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps, 'maybeCleanupClear');
    return true;
  });
}
