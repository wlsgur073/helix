// B2a task B1 (ruling E, design 4.3): the homes the control-file cases share. Not a suite by itself.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

export const NOW = '2026-11-01T00:00:00.000Z';

/** The ten control files, spelled out here and not read from src/: a name added to or dropped from the product's list must
 *  fail a test, not be followed by it. */
export const CONTROL_FILES = [
  'audit.jsonl', 'sessions.jsonl', 'metrics.jsonl', 'trigger.jsonl', 'codex-log.jsonl',
  'witness.json', 'witness-log.jsonl', 'projects.json', 'ledger-mac-master.key', 'config.json',
] as const;
export const CONTROL_LOCKS: readonly string[] = ['memory.jsonl', ...CONTROL_FILES].map((n) => `${n}.lock`);

const made: string[] = [];
export function cleanupControlLayouts(): void { for (const b of made.splice(0)) rmSync(b, { recursive: true, force: true }); }

export const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export interface ControlHome {
  readonly base: string;
  readonly home: string;
  /** The ids of the two rows in <home>/memory.jsonl before a case plants anything. */
  readonly ids: readonly string[];
  /** A store over `ledger` with this home; ids n_101 ... so they never collide with the seed's g_1 ... */
  store(ledger: string, sessionId?: string): MemoryStore;
}

/** A `0700` home as a few sessions leave it: the owner's ledger with two rows, and the key, the witness file and the registry
 *  made by the store itself (one commit and one recall: the recall mints the global scope nonce into projects.json); every
 *  other control file is a small regular file with known bytes. The preconditions are asserted here, so no case passes
 *  vacuously over a home that lacks a file. */
export function buildControlHome(): ControlHome {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hc-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  let n = 0;
  const seed = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'seed', now: () => NOW, genId: () => `g_${++n}` });
  const ids = [seed.commit({ content: 'alpha deploy fact', source: 'user' }).id, seed.commit({ content: 'beta deploy fact', source: 'user' }).id];
  seed.recall('deploy');
  for (const name of CONTROL_FILES) {
    let present = true;
    try { lstatSync(join(home, name)); } catch { present = false; }
    if (!present) writeFileSync(join(home, name), `{"kept":"${name}"}\n`, { mode: 0o600 });
  }
  for (const name of CONTROL_FILES) {
    if (!lstatSync(join(home, name)).isFile()) throw new Error(`fixture: ${name} is not a regular file`);
  }
  return {
    base, home, ids,
    store: (ledger, sessionId = 's') => {
      let k = 100;
      return new MemoryStore(ledger, { home, sessionId, now: () => NOW, genId: () => `n_${++k}` });
    },
  };
}

/** Every entry of the home: name, kind, mode and sha256 of a file, the body of a link. Two equal digests mean nothing in the
 *  home was created, removed, re-moded, rewritten or re-linked in between. */
export function homeDigest(home: string): string[] {
  return readdirSync(home).sort().map((name) => {
    const p = join(home, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `${name}|link|${readlinkSync(p)}`;
    if (st.isFile()) return `${name}|file|${(st.mode & 0o777).toString(8)}|${sha256Of(p)}`;
    return `${name}|${st.isDirectory() ? 'dir' : 'other'}`;
  });
}

/** WBR-bundle F1, G17 and G18: the owner's ledger moved out of the home (to <base>/owner-ledger.jsonl) and a link left at its
 *  name that leads to `<home>/<name>`. Returns the link's path. `name` may be a file that does not exist (a dangling link). */
export function linkOwnerLedgerTo(l: ControlHome, name: string): string {
  const ledger = join(l.home, 'memory.jsonl');
  renameSync(ledger, join(l.base, 'owner-ledger.jsonl'));
  symlinkSync(join(l.home, name), ledger);
  return ledger;
}

/** The supported relocation (HELIX_LEDGER): an empty regular file outside the home. */
export function relocatedLedger(l: ControlHome): string {
  const dir = join(l.base, 'elsewhere');
  mkdirSync(dir);
  const path = join(dir, 'g.jsonl');
  writeFileSync(path, '');
  return path;
}
