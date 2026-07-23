/** witness.json + witness-log.jsonl IO, MAC, locking, single-slot journal supersession (spec
 *  2026-07-17-high-water-counter-decision §4.1-§4.3). The ONLY writer of witness state — every
 *  compound operation runs inside ONE `withFileLock(witnessPath(home), ...)` scope (withFileLock
 *  is not re-entrant per path, lock.ts:107), so the functions below never call each other; each
 *  re-derives its own view of the current disk state under its own lock acquisition. */
import { randomBytes, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalRoot } from './ownership.js';
import { withFileLock, canonical } from './lock.js';
import { ensureMaster, tryReadMaster } from './ledger-mac.js';
import { realFsOps, writeAll, type DurableFsOps } from './fs-ops.js';
import { sweepOrphanTmps } from './ledger-sweep.js';
import {
  classifyWitness, advanceAllowed, cleanupClearAllowed, sha256Hex,
  type WitnessEntry, type JournalEntry, type WitnessVerdict,
} from './witness-core.js';

export function witnessPath(home: string): string { return join(home, 'witness.json'); }
export function witnessLogPath(home: string): string { return join(home, 'witness-log.jsonl'); }

/** Home-side scope identity — registry-key convention (ownership.canonicalRoot): '@global' or the
 *  CANONICAL (symlink-resolved) absolute project root, so an aliased path can't split one physical
 *  project into two witness scopes (must match ownership's nonce key exactly). NEVER the repo-side
 *  `.owner` stamp (adversary-writable). */
export function scopeKeyOf(home: string, projectRoot?: string): string {
  return projectRoot === undefined ? '@global' : canonicalRoot(projectRoot);
}

export class WitnessAdvanceError extends Error {}
/** The operation a blocked witnessed write was performing. Append ops ('commit' | 'erase' |
 *  'verify') come from the three witness-write callers; rewrite ops ('compaction' |
 *  'permanent-erase') are DERIVED from the flowing witness kind at the authoritative gate, so
 *  the label stays truthful even when a permanent erase loses the advisory-precheck race and
 *  is refused inside compactLedger (Codex round 3). */
export type WitnessBlockedOp = 'commit' | 'erase' | 'verify' | 'compaction' | 'permanent-erase';
export class WitnessBlockedError extends Error {
  constructor(readonly op: WitnessBlockedOp, message: string) { super(message); }
}

export interface ScopeWitnessState { entry: WitnessEntry | null; journal: JournalEntry | null; macInvalid: boolean }

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
// the witness lock and resolve `path = canonical(witnessPath(home))` ONCE, matching the
// resolve-once-under-the-lock discipline ledger.ts's compactLedger uses). ----

function readStoreFileAt(path: string): WitnessStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WitnessStoreFile>;
    return { v: 1, scopes: parsed.scopes ?? {} };
  } catch { return { v: 1, scopes: {} }; }
}

/** Atomic replace: sweep orphans, write `.w-<hex32>.tmp` ('wx' + fchmod 0600), writeAll, fsync,
 *  close, rename over witness.json, fsync the parent dir. `fsOps` is the SAME injectable
 *  fs-ops.ts:DurableFsOps seam compactLedger/appendRecordUnlocked already use — defaults to
 *  realFsOps, so production behavior is unchanged; tests can inject a faulty fsOps to exercise the
 *  disk-full/short-write/fsync failpoints on this specific file (Task 8). */
function writeStoreFileAt(path: string, store: WitnessStoreFile, fsOps: DurableFsOps = realFsOps): void {
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

/** Lock-free read; MAC-invalid entry/journal reported via `macInvalid`, returned as null. */
export function readScopeWitness(home: string, scopeKey: string): ScopeWitnessState {
  const path = canonical(witnessPath(home));
  const store = readStoreFileAt(path);
  return deriveState(scopeKey, tryReadMaster(home), store.scopes[scopeKey]);
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

function appendWitnessLogLine(home: string, line: { v: 1; scope: string; epoch: number; kind: JournalEntry['kind']; tx: string; nonce: string }, fsOps: DurableFsOps): void {
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
  mkdirSync(home, { recursive: true });
  const master = ensureMaster(home);
  const rawPath = witnessPath(home);
  withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
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
    writeStoreFileAt(path, nextStore, fsOps);
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
  mkdirSync(home, { recursive: true });
  const master = ensureMaster(home);
  const rawPath = witnessPath(home);
  return withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
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
    writeStoreFileAt(path, nextStore, fsOps);
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
  mkdirSync(home, { recursive: true });
  const master = ensureMaster(home);
  const rawPath = witnessPath(home);
  withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
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
    writeStoreFileAt(path, nextStore, fsOps);
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
  mkdirSync(home, { recursive: true });
  const rawPath = witnessPath(home);
  return withFileLock(rawPath, () => {
    const path = canonical(rawPath);
    const store = readStoreFileAt(path);
    const master = tryReadMaster(home); // never mints: clearing produces no new signed content
    const state = deriveState(scopeKey, master, store.scopes[scopeKey]);
    const journal = state.macInvalid ? null : state.journal;
    if (!journal) return false;
    const entry = state.macInvalid ? null : state.entry;
    if (!cleanupClearAllowed(bytes, entry, journal)) return false;
    const nextStore: WitnessStoreFile = { v: 1, scopes: { ...store.scopes, [scopeKey]: { entry, journal: null } } };
    writeStoreFileAt(path, nextStore, fsOps);
    return true;
  });
}
