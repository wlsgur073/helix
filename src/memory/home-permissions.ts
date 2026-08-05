import { lstatSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
