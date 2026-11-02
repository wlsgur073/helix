// Third fix batch B1, task B6 (design 4.7, 4.1 item 4): the state of the global ledger's path, its typed refusal and fixed
// texts, and the read of a ledger by the resolved name or, for an unresolvable global ledger, by the path as given.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, realpathSync, rmSync } from 'node:fs';
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

afterEach(() => cleanupLayouts());
const AS_ROOT = process.getuid?.() === 0;
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

const CAUSE = "the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, or a link into a directory that does not exist)";
const TAIL = 'Tell the user that the global memory path needs repair; do not repair it for them.';
const NOTE = "(the global memory file's path cannot be used for writing (it cannot be resolved, or it is a link into a directory that does not exist), so global memory is read-only: records that can be read through that path are shown, and nothing can be stored, erased or re-graded there until the path is repaired)";
const STARTUP = "helix: NOTE - the global memory file's path cannot be used for writing (it cannot be resolved, or it is a link into a directory that does not exist), so global memory is read-only: nothing can be stored, erased or re-graded there until the path is repaired";

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
    const s = globalLedgerWriteState(l.ledger);
    expect(s.kind).toBe(cls === 'writable' ? 'writable' : 'read-only');
    if (s.kind === 'read-only') expect(s.cause).toBe(cls);
    expect(isGlobalLedgerReadOnly(l.ledger)).toBe(cls !== 'writable');
    expect(snapshotTree(l.base)).toEqual(before);        // asking creates nothing and changes no mode
  });

  it.skipIf(AS_ROOT)('a path below a mode-000 folder cannot be inspected: writable here, the write then fails with the fs error', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'gl-')));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'g.jsonl'), '');
    chmodSync(join(d, 'sub'), 0o000);
    try {
      expect(globalLedgerWriteState(join(d, 'sub', 'g.jsonl'))).toEqual({ kind: 'writable' });
      expect((thrownBy(() => readLedgerBytes(join(d, 'sub', 'g.jsonl'))) as NodeJS.ErrnoException).code).toBe('EACCES');
      expect((thrownBy(() => readLedgerBytes(join(d, 'sub', 'g.jsonl'), GLOBAL_LEDGER_READ)) as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally { chmodSync(join(d, 'sub'), 0o700); rmSync(d, { recursive: true, force: true }); }
  });

  it('the walk above the file reads the path as given: `live/../dl` answers what `other/dl` answers (ALIAS-DOTDOT class)', () => {
    const l = buildGlobalLayout('below-dangling-dir-link-dotdot');
    const plain = `${l.base}/other/dl/memory.jsonl`;
    expect(globalLedgerWriteState(l.ledger)).toEqual({ kind: 'read-only', cause: 'target-directory-missing' });
    expect(globalLedgerWriteState(l.ledger)).toEqual(globalLedgerWriteState(plain));
  });

  it('never throws for an odd string', () => {
    for (const odd of ['', '.', '/', 'a//b/../c', 'x'.repeat(5000)]) expect(() => globalLedgerWriteState(odd)).not.toThrow();
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

  it.each(OPS)('%s: the changed-destination text names the global file, not a project (v-global-08: "in progress")', (op) => {
    expect(GLOBAL_DESTINATION_CHANGED[op]).toMatch(new RegExp(`^${op}: the global memory file was replaced while the [a-z]+ was in progress — `));
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
