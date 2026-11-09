import { mkdirSync, fsyncSync, closeSync, accessSync, statSync, lstatSync, readlinkSync, constants, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { writeAll, realFsOps, fsyncDir } from './memory/fs-ops.js';
import { openHomeFileForAppend } from './memory/home-files.js';
import type { EgressLeg } from './config.js';
import type { GateName } from './verify/dual-verify.js';
import { ensureHelixDir } from './memory/home-permissions.js';
import { HomeRefusalError } from './memory/home-env.js';

/** Schema note (append-only history): `decidedLeg` replaces the mis-named `blockedLeg` (an
 *  `allowed_override` used to write its DECIDER into a field literally called `blockedLeg`,
 *  claiming a released leg was blocked). Rows written before this change carry `blockedLeg`
 *  instead of `decidedLeg` with the same coarse-`Leg` values; audit.jsonl is append-only, so
 *  those old rows are NEVER migrated — a reader must accept EITHER key as the decider field. */
export interface DualVerifyAudit {
  kind: 'dual-verify';
  ts: string;
  enabled: boolean;
  /** True when a real (metered) Codex call was attempted. */
  spawned: boolean;
  mode?: 'compare' | 'critique';
  verdict?: 'agree' | 'diverge' | 'indeterminate';
  reason?: string;
  // --- egress guard fields (2b): enum / ID / policy-key only — NEVER a matched span, secret, PII value,
  // or memory snippet. Both blocked AND allowed-override events are logged. ---
  egressDecision?: 'pass' | 'blocked' | 'allowed_override';
  decidedLeg?: 'secret' | 'pii' | 'memory_echo';                       // the coarse leg that DECIDED (renamed from blockedLeg)
  // Was a hand-copied union of the same five keys, which silently went stale the moment a sixth leg
  // existed. Sourced from EgressLeg so the audit schema cannot drift from the policy it records.
  releasedLegs?: EgressLeg[];                                          // policy keys a policy released
  piiKinds?: Array<'email' | 'phone' | 'credit_card' | 'national_id'>; // labels, never values
  echoMemoryIds?: string[];                                            // ledger IDs, never text
  /** H7: the guard that ended the call (`enabled` / `stakesFloor` / `egress` / `available` /
   *  `runner`), sourced from GateName so this schema cannot drift from the chain it records. Absent
   *  on a call that ran. It exists so a reader of this ledger reconstructs the gate ORDER from data
   *  rather than from refusal wording -- the inference that took the dogfood channel three weeks and
   *  landed on the reverse of the truth. */
  stoppedGate?: GateName;
}

/** Erase audit (F1): every helix_memory_erase is recorded — best-effort (the fsync'd row is appended
 *  after the fsync'd erase, so a crash in the narrow gap can miss it; see appendAudit) — so a
 *  poisoned/erroneous erase that suppresses an authoritative fact is detectable in audit.jsonl. The MCP tool is soft-only
 *  (`soft: true`); `soft: false` marks the out-of-band permanent/compaction path. Content-free
 *  by design — only the id is recorded, never the erased text. LEAD-AUDIT-ID-UNCONSTRAINED: `id` used
 *  to be an unbounded string written here VERBATIM even when it matched no record (erase() is a
 *  no-op, not a throw, for an absent id) — an attacker-chosen id of unbounded length/bytes could ride
 *  this "content-free" field. `id` is now bounded (length + charset) before this event is ever
 *  constructed: handlers.ts's `assertValidId` guards every caller of this interface, mirrored at the
 *  MCP boundary by helix-server.ts's `ID_SCHEMA`. */
export interface EraseAudit {
  kind: 'erase';
  ts: string;
  id: string;
  soft: boolean; // true = tombstone-only (recoverable); false = physical compaction (right-to-erasure)
  /** ADDITIVE (same evolution rule as VerifyAudit.witnessAdvance): present ONLY when the tombstone
   *  append LANDED and the post-append witness advance then threw. Absent on every success row. */
  witnessAdvance?: 'failed';
  /** ADDITIVE: how a FAILED erase failed. 'rejected' — the store refused BEFORE any write: a typed
   *  EraseRefusedError (since IT-M16 also handleErase's refusal of an id no active scope holds — the
   *  store's no-op 'absent' result), a WitnessBlockedError, or — for the soft erase handleErase issues — a
   *  WitnessAdvanceError carrying no landedState (its only pre-write source there is the pre-append
   *  completeTransition; the post-append advance always stamps landedState). 'indeterminate' — an
   *  UNCLASSIFIED error escaped after the write may have begun (post-append re-read, fsync), so the
   *  tombstone MAY be on disk; an untyped PRE-write failure (a read error, a lock failure) lands here
   *  too, over-reporting in the safe direction. For an unclassified error an undefined landedState never
   *  means "nothing landed" (witness-store.ts), hence the third value. */
  outcome?: 'rejected' | 'indeterminate';
}

/** Verify audit (two-tier trust ladder): every trust transition attempt (recheck / confirm) is
 *  recorded — including rejected and contested outcomes — best-effort (the fsync'd row is written
 *  after the fsync'd transition; see appendAudit) — so a poisoned/erroneous promotion or a
 *  silently-dropped corroboration is detectable in audit.jsonl. Content-free by design: ids /
 *  enums / booleans ONLY, NEVER a matched span, file path, or check pattern. `outcome` is an INLINE
 *  shape (not firewall's VerifyOutcome) to keep audit decoupled from the check engine.
 *  LEAD-AUDIT-ID-UNCONSTRAINED: the REJECTED branch (recheck/confirm target-not-found or unbound)
 *  is the sharp case — it audits BEFORE re-throwing, so a garbage id would otherwise be logged on
 *  every single failed lookup. `id` is bounded (length + charset) before either handler's try block
 *  runs: see handlers.ts's `assertValidId` / helix-server.ts's `ID_SCHEMA`. */
export interface VerifyAudit {
  kind: 'verify';
  ts: string;
  id: string;
  source: 'reality-check' | 'user';
  resultState: 'Corroborated' | 'Verified' | 'Suspect' | 'no-change' | 'contested' | 'rejected';
  checkKind?: 'file-contains' | 'file-exists';
  bound?: boolean;
  outcome?: { ran: boolean; indeterminate: boolean; passed: boolean };
  /** ADDITIVE, and additive is the point (same evolution rule as `decidedLeg` above: audit.jsonl is
   *  append-only, so old rows are never migrated and `resultState` can never gain a value). Present
   *  ONLY when the ledger append LANDED and the post-append witness advance then threw — the one
   *  ordering `witness-write.ts` guarantees, since the append is unconditional and precedes
   *  `advanceWitness`. `resultState` on such a row names the grade the landed record confers, NOT
   *  'rejected': the row is on disk and no code path unwinds it. What did NOT happen is the witness
   *  advance, so the scope's alarm still stands and a reader may see that grade clamped on the read
   *  side — this key is how a reader tells that case from an honest promotion. Absent on every other
   *  outcome, including a genuine rejection, so a reader that does not know the key reads exactly the
   *  rows it always did. */
  witnessAdvance?: 'failed';
}

/** Adopt audit: every helix_memory_adopt is recorded — best-effort, like the others. Adoption is one
 *  of only two operations that move what Helix trusts (confirm is the other), and it was previously
 *  the only one that left no trace at all: a foreign project ledger became trusted with nothing in
 *  audit.jsonl to show for it. `scope` is the canonical project root — an IDENTITY, not content. It
 *  discloses nothing that `projects.json` beside it does not already hold, and the content-free rule
 *  this file keeps is about memory text, which never appears here. */
export interface AdoptAudit {
  kind: 'adopt';
  ts: string;
  scope: string;
}

export type AuditEvent = DualVerifyAudit | EraseAudit | VerifyAudit | AdoptAudit;

/** Append one audit event as a JSONL line, fsync'd so a written row survives power loss. Creates
 *  parent dirs as needed. Completeness is best-effort, NOT transactional: the row is appended AFTER
 *  the action it records (the erase/verify, itself fsynced), so a crash in the narrow window between
 *  the two can leave the action durable with its audit row absent. Durable-once-written: the row bytes
 *  are fsync'd, and on EVERY append the parent directory is fsync'd too, so the file's directory
 *  entry is durable — not just its inode (a crash could otherwise lose the whole freshly-created file).
 *
 *  The directory fsync is swallowed UNCONDITIONALLY here — narrower than fs-ops.ts's own fsyncDir
 *  contract (task 7), which now propagates a genuinely failed attempt. No caller (handlers.ts) wraps
 *  this call, and by the time it runs every caller has already COMPLETED its primary operation — not
 *  always successfully. Four of eight call sites — handlers.ts `handleErase`, `handleAdopt`, and the
 *  post-success appends in `handleRecheck` and `handleConfirm` — run it after a SUCCEEDED operation;
 *  three — the appends in `handleRecheck`'s, `handleConfirm`'s and `handleErase`'s catch blocks — run
 *  it INSIDE a catch, after the primary operation already FAILED, immediately before re-throwing that
 *  real error; one — `handleDualVerify` — follows an operation that commits nothing to disk at all:
 *  audit.jsonl IS the durable record there. Sites are named by FUNCTION rather than by line because
 *  the line form of this same enumeration was corrected twice for its reasoning and then invalidated
 *  a third time by unrelated edits above it, silently and without any check noticing. `grep -n appendAudit
 *  src/server/handlers.ts` re-derives it. Fix round 1 (review Important 3): an earlier version of this
 *  comment claimed every caller's primary operation had "already durably committed", which is false
 *  for the reject paths and the dual-verify path. Fix round 2: that same earlier version also
 *  undercounted the success sites (three, not four — `handleConfirm`'s was missing). The
 *  exemption is correct regardless of the count — it is *more* clearly correct once stated right: at
 *  the reject sites, letting a directory-fsync failure escape would not just misreport a success as a
 *  failure, it would REPLACE the real rejection error the caller is about to re-throw with an
 *  unrelated fsync error, masking the actual diagnosis. Both outcomes are worse than the audit row
 *  silently missing — a gap this docstring already accepts. The row's own bytes stay unconditional:
 *  writeAll + fsyncSync(fd) above are untouched and still propagate.
 *
 *  EVERY append fsyncs the directory, not just the first (2026-08-11): an exists-then-decide probe
 *  raced concurrent first creation, so a non-creator's acknowledged row depended on the CREATOR
 *  surviving to its own fsyncDir. Each appender now owns the directory-entry durability of the row
 *  it acknowledges. Audit appends are low-frequency; the extra directory fsync is noise.
 *
 *  B2a (ruling J4, plan decision P5): the paragraph above that says no caller wraps this call is true of one of the eight call
 *  sites now, handleDualVerify's. The three inside a catch in handlers.ts go through `appendAuditAfterFailure`, which drops this
 *  function's failure, so the error the caller is about to receive is never replaced by it. The four after a success go through
 *  `appendAuditAfterSuccess`, which answers this function's failure with the fixed stored-then-failed text when the call stored a
 *  row. `assertAuditWritable` (below) is the look that confirm, erase, recheck and adopt take before they write their ledger row,
 *  so an audit file the process cannot append to is refused ahead of the row, not after it. */
export function appendAudit(path: string, event: AuditEvent, io: { fsyncDir: typeof fsyncDir } = { fsyncDir }): void {
  ensureHelixDir(dirname(path));
  const fd = openHomeFileForAppend(path, 0o600);   // owner-only ON CREATE (the audit trail is unauthenticated; a group writer could rewrite it)
  try {
    // writeAll loops short writes (a truncated row is never fsynced) and guards a zero-progress write.
    writeAll(realFsOps, fd, JSON.stringify(event) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Unconditional call, unconditionally swallowed here — narrower than fs-ops.ts's own fsyncDir
  // contract, which now propagates a genuinely failed attempt. See the docstring above: at the
  // three reject sites — handleRecheck, handleConfirm and handleErase — this runs inside a catch,
  // immediately before re-throwing the caller's real error, so an escaping fsync error would REPLACE
  // that diagnosis rather than add to it.
  try { io.fsyncDir(dirname(path)); } catch { /* best-effort by design — see docstring above */ }
}

/** The two refusals of `assertAuditWritable`. Constant, ASCII, no path and no interpolation (CLAUDE.md, Code style); both are
 *  said BEFORE anything was changed, because the look runs ahead of the operation. Fixed at the B2a text review. */
export const HOME_UNWRITABLE_TEXT = 'the Helix home directory cannot be written, so the operation was refused before anything was changed';
export const AUDIT_UNWRITABLE_TEXT = 'the Helix audit file cannot be written, so the operation was refused before anything was changed';

const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Is `path` a symbolic link whose target's folder cannot be stat'ed as a directory? The target is the link body as written,
 *  joined to the link's folder by concatenation (path.resolve would fold a `..` as text), and its folder is everything before its
 *  last `/`, so the kernel resolves it. Only the first link is read: a chain of links is the append's own failure. */
function danglingIntoMissingFolder(path: string): boolean {
  let body: string;
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    body = readlinkSync(path);
  } catch { return false; }
  const target = body.startsWith('/') ? body : `${dirname(path)}/${body}`;
  const folder = target.slice(0, target.lastIndexOf('/')) || '/';
  try { return !statSync(folder).isDirectory(); } catch { return true; }
}

/** B2a ruling J4 (design 4.6): confirm, erase, recheck and adopt append their audit row AFTER the ledger row, so an audit file the
 *  process cannot append to used to surface after the row had landed (a confirm then read Verified with no audit row). This is the
 *  look they take first. It reads permissions and kinds only: it opens nothing (an open of a FIFO would block) and creates nothing
 *  (a refused adopt must leave no audit file behind). A home whose own name is a symbolic link is refused first, with the
 *  refusal `ensureHelixDir` gives it (every write through a symlinked home is refused, and a link that does not resolve left
 *  the store with no refusal of its own: final review G10, revising plan decision B4-2). Otherwise it decides only what a
 *  permission or a kind shows; a directory that is missing, is not a directory or cannot be reached returns without a refusal, so
 *  the operation meets it first and the refusal the caller sees is the store's own (WBR-global F1). A directory without write and
 *  search permission is refused as the home's even when `audit.jsonl` itself could be appended: the witness advance after the row
 *  needs the home too. A missing `audit.jsonl` passes unless its name is a link whose target's folder is not a directory, where
 *  the append could not create the file (final review G12; a link into an existing folder keeps the followed append, ruling L).
 *  The look is advisory (access(2) answers for this process at this instant; root passes it), so a state that changes after it
 *  is the append's own failure. */
export function assertAuditWritable(path: string): void {
  const dir = dirname(path);
  let dirLink = false;
  try { dirLink = lstatSync(dir).isSymbolicLink(); } catch { /* a missing name: the operation meets it first */ }
  if (dirLink) ensureHelixDir(dir);   // throws its symlinked-home refusal
  let dirStat: Stats;
  try { dirStat = statSync(dir); } catch { return; }
  if (!dirStat.isDirectory()) return;
  try { accessSync(dir, constants.W_OK | constants.X_OK); }
  catch (e) {
    if (DENIED.has((e as NodeJS.ErrnoException).code ?? '')) throw new HomeRefusalError('home-unwritable', HOME_UNWRITABLE_TEXT);
    return;
  }
  let st: Stats;
  try { st = statSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HomeRefusalError('audit-unwritable', AUDIT_UNWRITABLE_TEXT);
    if (!danglingIntoMissingFolder(path)) return;   // a new file in a directory that can be written
    throw new HomeRefusalError('audit-unwritable', AUDIT_UNWRITABLE_TEXT);
  }
  if (!st.isFile()) throw new HomeRefusalError('audit-unwritable', AUDIT_UNWRITABLE_TEXT);
  try { accessSync(path, constants.W_OK); }
  catch { throw new HomeRefusalError('audit-unwritable', AUDIT_UNWRITABLE_TEXT); }
}
