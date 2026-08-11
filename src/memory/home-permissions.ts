import { lstatSync, chmodSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Files Helix persists under HELIX_HOME. Enumerated rather than globbed so the pass can never
 *  reach a name Helix does not own, and so adding a persisted file is a deliberate edit here.
 *  `config.json` is included even though Helix never creates it: it is authority-bearing — it can
 *  enable the outbound path and release every egress leg — so a group-writable config is a
 *  privilege-escalation surface even when every ledger byte is sound. */
const OWNED_FILES: readonly string[] = [
  'memory.jsonl',
  'audit.jsonl',
  'sessions.jsonl',
  'metrics.jsonl',
  'trigger.jsonl',
  'codex-log.jsonl',
  'witness.json',
  'witness-log.jsonl',
  'projects.json',
  'ledger-mac-master.key',
  'config.json',
];

export interface HardenDeps {
  /** Called once per repaired or refused path. Never throws. */
  warn: (message: string) => void;
}

/**
 * Bring an existing HELIX_HOME back to owner-only. Creation-time modes cover new files; this covers
 * everything a shipped version already wrote, which on any pre-existing install is all of them.
 *
 * THE DIRECTORY IS THE POINT. POSIX puts unlink permission on the parent, not the file, so a `0600`
 * master key inside a `0775` directory can still be unlinked and replaced by any group member — a
 * file-mode-only pass does not close the finding. `mkdirSync(..., { mode })` does nothing to a
 * directory that already exists, so the mode has to be repaired explicitly.
 *
 * WARN-AND-FIX, NOT FAIL-CLOSED. An over-broad mode is a state shipped versions created; it is not
 * by itself evidence of tampering, and the integrity guarantee does not rest on the mode (a forged
 * or edited record replays as `Fresh` regardless). Failing closed would brick anyone whose backup
 * tool reset modes on restore. What is NOT ordinary legacy state — a symlink, or anything that is
 * not a regular file — is refused rather than repaired: following a link here would hand an
 * arbitrary-chmod primitive to anyone who can create a name inside HELIX_HOME.
 *
 * SCOPE. Project `.helix` trees are deliberately excluded. SECURITY.md models an adversary who CAN
 * write `<project>/.helix/memory.jsonl` but cannot read `~/.helix`; normalizing a project ledger
 * would contradict the threat model, and a shared project ledger is a supported team layout.
 *
 * Never throws: a startup hardening pass that can break startup is worse than the exposure it fixes.
 */
export function hardenHomePermissions(home: string, deps: HardenDeps): void {
  if (process.platform === 'win32') return; // mode bits are not enforced there
  try {
    const dir = lstatSync(home);
    if (dir.isDirectory() && (dir.mode & 0o077) !== 0) {
      chmodSync(home, 0o700);
      deps.warn(`helix: tightened HELIX_HOME ${home} from 0${(dir.mode & 0o777).toString(8)} to 0700 `
        + '(a group- or world-writable directory lets another local user replace files inside it, whatever their own mode)');
    }
  } catch { /* absent or unreadable home — nothing to harden, and never a startup error */ }

  // Only names Helix owns, and only ones that exist. readdirSync is used purely to skip absent files
  // cheaply; the repair set itself is the fixed list above.
  let present: Set<string>;
  try { present = new Set(readdirSync(home)); } catch { return; }

  for (const name of OWNED_FILES) {
    if (!present.has(name)) continue;
    const path = join(home, name);
    try {
      const st = lstatSync(path); // lstat, NOT stat: never follow a link before deciding to chmod
      if (st.isSymbolicLink()) {
        deps.warn(`helix: ${path} is a symlink — refusing to change permissions through it (repair or remove it by hand)`);
        continue;
      }
      if (!st.isFile()) {
        deps.warn(`helix: ${path} is not a regular file — refusing to change its permissions`);
        continue;
      }
      if ((st.mode & 0o077) === 0) continue; // already owner-only
      chmodSync(path, 0o600);
      deps.warn(`helix: tightened ${path} from 0${(st.mode & 0o777).toString(8)} to 0600`);
    } catch {
      deps.warn(`helix: could not repair permissions on ${path} — leaving it as it is`);
    }
  }
}

/**
 * The ONE way a Helix-owned directory comes into existence. Every site that used to reach for
 * `mkdirSync(dir, { recursive: true })` calls this instead.
 *
 * S3: seven separate sites created HELIX_HOME, none passing a mode, so a brand-new install ran its
 * whole first session at the umask's mode — 0755, or 0775 under umask 002 — and was tightened only
 * at the next start. POSIX puts unlink permission on the PARENT, so a 0600 master key inside a 0775
 * directory can still be replaced by any group member. Adding a mode argument seven times would fix
 * today and leave the eighth site as the next exposure; the invariant needs one owner.
 *
 * NON-RECURSIVE, deliberately. `recursive: true` walks and creates missing ancestors, and against an
 * attacker-writable ancestor that walk can be raced: pre-create a component, or substitute a symlink,
 * and the recursive call succeeds against the planted path. Requiring the parent to exist means the
 * only directory this creates is the leaf, under a parent the caller already trusts.
 *
 * THROWS on a hostile name rather than repairing it. `hardenHomePermissions` never throws because an
 * over-broad mode is ordinary legacy state; a SYMLINK or a plain file standing where the directory
 * belongs is not, and following one would hand an arbitrary-write primitive to whoever planted it.
 * The same reasoning `ensureScratchRoot` applies to the scratch root, which refuses rather than
 * adopts. A wrong owner is refused for that reason too: another user's directory is not our state.
 *
 * SCOPED TO CREATION. A home that already ran group-writable may have had its key or registry
 * replaced while it was exposed, and tightening the mode afterwards locks those objects in rather
 * than restoring trust. That is legacy remediation and is deliberately NOT what this closes.
 *
 * Windows has no POSIX mode bits — `mkdir`'s mode is ignored there and `hardenHomePermissions`
 * returns early for the same reason — so the owner-only guarantee is POSIX-only and this says so by
 * taking the plain path rather than pretending to enforce something.
 */
export function ensureHelixDir(dir: string): void {
  if (process.platform === 'win32') { mkdirSync(dir, { recursive: true }); return; }

  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(dir); } catch { st = null; }   // ENOENT is the create path below

  if (st !== null) {
    // lstat, never stat: the question is what the NAME is, never what it points at.
    if (st.isSymbolicLink()) throw new Error(`refusing to use ${dir}: it is a symlink, not a directory Helix owns`);
    if (!st.isDirectory()) throw new Error(`refusing to use ${dir}: it exists and is not a directory`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(`refusing to use ${dir}: it is owned by uid ${st.uid}, not by this user (${uid})`);
    }
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return;
  }

  const parent = dirname(dir);
  if (!existsSync(parent)) {
    throw new Error(`refusing to create ${dir}: its parent ${parent} does not exist (Helix creates one directory, never a chain)`);
  }
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    // Lost a creation race with a concurrent Helix process: validate what landed rather than assume.
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    ensureHelixDir(dir);
  }
}
