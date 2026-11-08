// Third fix batch B1, task B6 (design 4.7, 4.1 item 4): the state of the global ledger's path, its typed refusal and fixed
// texts, and the read of a ledger by the resolved name or, for an unresolvable global ledger, by the path as given.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, realpathSync, rmSync, lstatSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalLedgerWriteState, isGlobalLedgerReadOnly, GlobalLedgerReadOnlyError, isGlobalLedgerReadOnlyError,
  GLOBAL_WRITE_REFUSAL, GLOBAL_READ_ONLY_STARTUP_LINE, GLOBAL_DESTINATION_CHANGED, type GlobalWriteOp,
} from '../../src/memory/global-ledger.js';
import { GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { parseLedger, readLedgerBytes, readLedgerRaw, GLOBAL_LEDGER_READ } from '../../src/memory/ledger.js';
import * as pathIdentityMod from '../../src/memory/path-identity.js';
import { isUnresolvablePathError } from '../../src/memory/path-identity.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import { verifiedLiveStats } from '../../src/memory/verified-read.js';
import { buildGlobalLayout, cleanupLayouts, snapshotTree, type GlobalLayoutName } from '../helpers/global-layouts.js';
import { isHomeRefusalError } from '../../src/memory/home-env.js';
import { buildControlHome, linkOwnerLedgerTo, relocatedLedger, homeDigest, cleanupControlLayouts, CONTROL_FILES, CONTROL_LOCKS } from '../helpers/home-control-layouts.js';

afterEach(() => { vi.restoreAllMocks(); cleanupLayouts(); cleanupControlLayouts(); });
const AS_ROOT = process.getuid?.() === 0;
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

const CAUSE = "the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist) or leads to another file of the Helix home";
const TAIL = 'Tell the user that the global memory path needs repair; do not repair it for them.';
const NOTE = "(the global memory file's path cannot be used for writing (it cannot be resolved, it is a link into a directory that does not exist, or it leads to another file of the Helix home), so global memory is read-only: records that can be read through that path are shown, and nothing can be stored, erased or re-graded there until the path is repaired; while the path is broken, a rollback witness mismatch note for global memory can come from the broken path and not from a rollback)";
const STARTUP = "helix: NOTE - the global memory file's path cannot be used for writing (it cannot be resolved, it is a link into a directory that does not exist, or it leads to another file of the Helix home), so global memory is read-only: nothing can be stored, erased or re-graded there until the path is repaired";

const STATE: Array<[GlobalLayoutName, 'writable' | 'unresolvable' | 'target-directory-missing']> = [
  ['plain', 'writable'], ['link-to-file', 'writable'], ['dangling-target-dir-present', 'writable'],
  ['plain-missing-dir', 'writable'], ['symlinked-ancestor-first-run', 'writable'],
  ['nonutf8-link-body', 'unresolvable'], ['nonutf8-dir-link', 'unresolvable'], ['chain-41', 'unresolvable'], ['loop', 'unresolvable'],
  ['dangling-target-dir-missing', 'target-directory-missing'], ['below-dangling-dir-link', 'target-directory-missing'],
  ['below-dangling-dir-link-dotdot', 'target-directory-missing'],
];

describe('globalLedgerWriteState (design 4.7, first table; G-R1: a directory link above the file counts)', () => {
  it.each(STATE)('%s -> %s', (name, cls) => {
    const l = buildGlobalLayout(name);
    expect(l.cls).toBe(cls);
    const before = snapshotTree(l.base);
    const s = globalLedgerWriteState(l.ledger, l.home);
    expect(s.kind).toBe(cls === 'writable' ? 'writable' : 'read-only');
    if (s.kind === 'read-only') expect(s.cause).toBe(cls);
    expect(isGlobalLedgerReadOnly(l.ledger, l.home)).toBe(cls !== 'writable');
    expect(snapshotTree(l.base)).toEqual(before);        // asking creates nothing and changes no mode
  });

  it.skipIf(AS_ROOT)('a path below a mode-000 folder cannot be inspected: writable here, the write then fails with the fs error', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'gl-')));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'g.jsonl'), '');
    chmodSync(join(d, 'sub'), 0o000);
    try {
      expect(globalLedgerWriteState(join(d, 'sub', 'g.jsonl'), d)).toEqual({ kind: 'writable' });
      expect((thrownBy(() => readLedgerBytes(join(d, 'sub', 'g.jsonl'))) as NodeJS.ErrnoException).code).toBe('EACCES');
      expect((thrownBy(() => readLedgerBytes(join(d, 'sub', 'g.jsonl'), GLOBAL_LEDGER_READ)) as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally { chmodSync(join(d, 'sub'), 0o700); rmSync(d, { recursive: true, force: true }); }
  });

  it('the walk above the file reads the path as given: `live/../dl` answers what `other/dl` answers (ALIAS-DOTDOT class)', () => {
    const l = buildGlobalLayout('below-dangling-dir-link-dotdot');
    const plain = `${l.base}/other/dl/memory.jsonl`;
    expect(globalLedgerWriteState(l.ledger, l.home)).toEqual({ kind: 'read-only', cause: 'target-directory-missing' });
    expect(globalLedgerWriteState(l.ledger, l.home)).toEqual(globalLedgerWriteState(plain, l.home));
  });

  it('never throws for an odd string', () => {
    for (const odd of ['', '.', '/', 'a//b/../c', 'x'.repeat(5000)]) {
      expect(() => globalLedgerWriteState(odd, join(tmpdir(), 'no-such-home'))).not.toThrow();
      expect(() => globalLedgerWriteState(join(tmpdir(), 'g.jsonl'), odd)).not.toThrow();
    }
  });
});

describe('globalLedgerWriteState: a destination that is a file the home keeps for itself (B2a ruling E, design 4.3)', () => {
  const HOME_FILE = { kind: 'read-only', cause: 'home-control-file' } as const;

  it.each([...CONTROL_FILES])('%s as the ledger path, the file existing: read-only with the cause home-control-file, and asking changes nothing', (name) => {
    const l = buildControlHome();
    const ledger = join(l.home, name);
    expect(lstatSync(ledger).isFile()).toBe(true);                 // the file is there: both conditions are in play
    const before = homeDigest(l.home);
    expect(globalLedgerWriteState(ledger, l.home)).toEqual(HOME_FILE);
    expect(isGlobalLedgerReadOnly(ledger, l.home)).toBe(true);
    expect(homeDigest(l.home)).toEqual(before);
  });

  it.each([...CONTROL_LOCKS])('%s as the ledger path, nothing standing there: read-only by the path', (name) => {
    const l = buildControlHome();
    const ledger = join(l.home, name);
    expect(() => lstatSync(ledger)).toThrow();
    expect(globalLedgerWriteState(ledger, l.home)).toEqual(HOME_FILE);
  });

  it.each(['witness.json', 'projects.json', 'ledger-mac-master.key', 'config.json', 'witness.json.lock'])('G17/G18: the owner ledger is a link to %s (the last one dangling): read-only', (name) => {
    const l = buildControlHome();
    const ledger = linkOwnerLedgerTo(l, name);
    expect(lstatSync(ledger).isSymbolicLink()).toBe(true);
    expect(globalLedgerWriteState(ledger, l.home)).toEqual(HOME_FILE);
  });

  it('a hard link to a control file, outside the home, is read-only by identity', () => {
    const l = buildControlHome();
    const alias = join(l.base, 'alias.jsonl');
    linkSync(join(l.home, 'witness.json'), alias);
    expect(globalLedgerWriteState(alias, l.home)).toEqual(HOME_FILE);
  });

  it('controls (Review Focus 3): the owner ledger, a ledger outside the home, another regular file in the home and a link to a file outside stay writable', () => {
    const l = buildControlHome();
    const outside = relocatedLedger(l);
    const inside = join(l.home, 'ledger-2.jsonl');
    writeFileSync(inside, '');
    const linked = join(l.home, 'linked.jsonl');
    symlinkSync(outside, linked);
    for (const p of [join(l.home, 'memory.jsonl'), outside, inside, linked]) expect(globalLedgerWriteState(p, l.home), p).toEqual({ kind: 'writable' });
  });

  it('a home that does not exist yet: a control name under it is read-only by its path, the owner ledger is writable, nothing is created', () => {
    const l = buildControlHome();
    const fresh = join(l.base, 'fresh', 'home');
    expect(globalLedgerWriteState(join(fresh, 'projects.json'), fresh)).toEqual(HOME_FILE);
    expect(globalLedgerWriteState(join(fresh, 'memory.jsonl'), fresh)).toEqual({ kind: 'writable' });
    expect(() => lstatSync(join(l.base, 'fresh'))).toThrow();
  });

  it('Review Focus 4: on a file system that reports inode 0 the path decides: a ledger outside the home is writable, a control name is not', () => {
    const l = buildControlHome();
    const outside = relocatedLedger(l);
    const real = pathIdentityMod.fileIdentityAt;
    vi.spyOn(pathIdentityMod, 'fileIdentityAt').mockImplementation((p, o) => {
      const id = real(p, o);
      return id === null ? null : { dev: id.dev, ino: 0n };
    });
    expect(globalLedgerWriteState(outside, l.home)).toEqual({ kind: 'writable' });
    expect(globalLedgerWriteState(join(l.home, 'witness.json'), l.home)).toEqual(HOME_FILE);
  });
});

describe('GlobalLedgerReadOnlyError and the fixed texts (4.9; final wording of this task)', () => {
  const OPS: GlobalWriteOp[] = ['commit', 'erase', 'confirm', 'recheck', 'compaction'];
  it.each(OPS)('%s: the refusal is "<op>: <cause> — nothing was written." plus one sentence, with no path', (op) => {
    const e = new GlobalLedgerReadOnlyError(op, 'unresolvable');
    expect(e.message).toBe(`${op}: ${CAUSE} — nothing was written. ${TAIL}`);
    expect(GLOBAL_WRITE_REFUSAL[op]).toBe(e.message);
    expect(e.op).toBe(op);
    expect(e.readOnlyCause).toBe('unresolvable');
    expect(e.message).not.toMatch(/[\\/]/);
    expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
  });

  it('the predicate reads a property and needs an Error: a look-alike, a plain Error and a string are not it', () => {
    expect(isGlobalLedgerReadOnlyError(new Error(GLOBAL_WRITE_REFUSAL.commit))).toBe(false);
    expect(isGlobalLedgerReadOnlyError({ globalLedgerReadOnly: true })).toBe(false);
    expect(isGlobalLedgerReadOnlyError('commit')).toBe(false);
    expect(isGlobalLedgerReadOnlyError(Object.assign(new Error('x'), { globalLedgerReadOnly: true }))).toBe(true);   // a class loaded twice is still recognised
  });

  it('the note and the startup line are fixed strings: the note has no path and no "session", the line is ASCII', () => {
    expect(GLOBAL_LEDGER_READ_ONLY_NOTE).toBe(NOTE);
    expect(NOTE).not.toMatch(/session|[\\/]/);
    expect(GLOBAL_READ_ONLY_STARTUP_LINE).toBe(STARTUP);
    expect(GLOBAL_READ_ONLY_STARTUP_LINE).toMatch(/^[\x20-\x7e]+$/);
  });

  it('home-control-file: the same refusal text for every op, typed as a global read-only refusal and as a home refusal', () => {
    for (const op of OPS) {
      const e = new GlobalLedgerReadOnlyError(op, 'home-control-file');
      expect(e.message).toBe(`${op}: ${CAUSE} — nothing was written. ${TAIL}`);
      expect(e.message).toBe(GLOBAL_WRITE_REFUSAL[op]);
      expect(e.readOnlyCause).toBe('home-control-file');
      expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
      expect(isHomeRefusalError(e)).toBe(true);
      expect(e.homeRefusalCause).toBe('home-control-file');
    }
  });

  it('the other two causes are not home refusals', () => {
    for (const cause of ['unresolvable', 'target-directory-missing'] as const) {
      const e = new GlobalLedgerReadOnlyError('commit', cause);
      expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
      expect(isHomeRefusalError(e)).toBe(false);
      expect(e.homeRefusalCause).toBeUndefined();
    }
  });

  it.each(OPS)('%s: the changed-destination text names the global file, not a project (v-global-08: "in progress")', (op) => {
    expect(GLOBAL_DESTINATION_CHANGED[op]).toMatch(new RegExp(`^${op}: the global memory file changed while the [a-z]+ was in progress — `));
    expect(GLOBAL_DESTINATION_CHANGED[op]).not.toMatch(/project|waited/);
  });
});

describe('the read of a ledger (design 4.1 item 4)', () => {
  it('a resolvable path reads the file the kernel reaches', () => {
    const l = buildGlobalLayout('link-to-file');
    expect(parseLedger(l.ledger).map((r) => r.id)).toEqual([...l.ids]);
  });

  it('opens the RESOLVED name with O_NOFOLLOW: a link that stands at that name is ELOOP, never content', () => {
    const l = buildGlobalLayout('link-to-file');
    const swapped = join(l.base, 'swapped');
    symlinkSync(l.kernelFile as string, swapped);
    const spy = vi.spyOn(pathIdentityMod, 'resolvePath').mockReturnValue({ kind: 'resolved', path: swapped, dirMissing: false });
    try {
      expect((thrownBy(() => readLedgerBytes(l.ledger)) as NodeJS.ErrnoException).code).toBe('ELOOP');
    } finally { spy.mockRestore(); }
  });

  it('a link to something that is not a regular file: the error names the path the caller gave, not its target', () => {
    const l = buildGlobalLayout('plain');
    const link = join(l.base, 'dev-link');
    symlinkSync('/dev/null', link);
    expect((thrownBy(() => readLedgerBytes(link)) as Error).message).toBe(`ledger ${link} is not a regular file`);
  });

  it('an unresolvable path is refused by default and opened as given for the global ledger', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    expect(isUnresolvablePathError(thrownBy(() => parseLedger(l.ledger)))).toBe(true);
    expect(isUnresolvablePathError(thrownBy(() => readLedgerBytes(l.ledger)))).toBe(true);
    expect(isUnresolvablePathError(thrownBy(() => readLedgerRaw(l.ledger)))).toBe(true);
    expect(parseLedger(l.ledger, GLOBAL_LEDGER_READ).map((r) => r.id)).toEqual([...l.ids]);
    expect(readLedgerBytes(l.ledger, GLOBAL_LEDGER_READ).length).toBeGreaterThan(0);
    expect(readLedgerRaw(l.ledger, GLOBAL_LEDGER_READ).records).toHaveLength(2);
  });

  it.each(['chain-41', 'loop'] as const)('%s: the kernel cannot open it either (ELOOP): read as given, it is an empty ledger (G-R5)', (name) => {
    const l = buildGlobalLayout(name);
    expect(parseLedger(l.ledger, GLOBAL_LEDGER_READ)).toEqual([]);
    expect(readLedgerBytes(l.ledger, GLOBAL_LEDGER_READ).length).toBe(0);
    expect(isUnresolvablePathError(thrownBy(() => parseLedger(l.ledger)))).toBe(true);   // the default still refuses
  });

  it.each(['dangling-target-dir-missing', 'below-dangling-dir-link', 'plain-missing-dir'] as const)('%s: the folder is missing, so the ledger reads as empty and nothing is created', (name) => {
    const l = buildGlobalLayout(name);
    const before = snapshotTree(l.base);
    expect(parseLedger(l.ledger)).toEqual([]);
    expect(readLedgerBytes(l.ledger, GLOBAL_LEDGER_READ).length).toBe(0);
    expect(snapshotTree(l.base)).toEqual(before);
  });

  it('the witnessed reads and the verified replay pass the option for the global scope only', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const w = readLedgerWitnessed(l.ledger, l.home);
    expect(w.records.map((r) => r.id).sort()).toEqual([...l.ids].sort());
    expect(w.verdict.kind).toBe('in-sync');
    expect(verifiedLiveStats(l.ledger, l.home).projection.live.size).toBe(2);
    expect(isUnresolvablePathError(thrownBy(() => readLedgerWitnessed(l.ledger, l.home, join(l.base, 'proj'))))).toBe(true);   // a project scope is not opened as given
  });
});
