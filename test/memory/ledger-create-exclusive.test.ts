// Third fix batch B1, task B1 (design 4.3 step 4, second case; step 5, the item on the texts): the first write to
// a project nobody adopted creates the memory file with O_CREAT | O_EXCL | O_NOFOLLOW and writes through that
// descriptor. Anything at the name is LedgerCreateRefusedError; there is no fallback to a plain open.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, realpathSync, statSync, rmSync, unlinkSync, existsSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appendRecordUnlocked, isLedgerCreateRefusedError, type LedgerCreateRefusedError } from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import { isRecordStoredError } from '../../src/memory/witness-store.js';
import { fileIdentityAt } from '../../src/memory/path-identity.js';
import type { MemoryRecord } from '../../src/types.js';

const NOW = '2026-11-01T00:00:00.000Z';
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'lce-'))); made.push(d); return d; };
const rec = (id: string): MemoryRecord => ({
  id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`,
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const caught = (fn: () => void): unknown => { try { fn(); } catch (e) { return e; } return undefined; };
const isCreateOpen = (p: string, flags: string | number): boolean =>
  basename(p) === 'm.jsonl' && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0;

describe('createExclusive', () => {
  it('control: an absent file is created with mode 0600 and the row is appended through that descriptor', () => {
    const f = join(dir(), 'm.jsonl');
    appendRecordUnlocked(f, rec('m_1'), undefined, { path: f, identity: null, createExclusive: true });
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('a file that stands at the name is refused with EEXIST and is not written', () => {
    const f = join(dir(), 'm.jsonl');
    writeFileSync(f, 'X\n');
    const err = caught(() => appendRecordUnlocked(f, rec('m_1'), undefined, { path: f, identity: null, createExclusive: true }));
    expect(isLedgerCreateRefusedError(err)).toBe(true);
    expect((err as LedgerCreateRefusedError).code).toBe('EEXIST');
    expect(readFileSync(f, 'utf8')).toBe('X\n');
  });

  it('there is no fallback to a plain open: the ledger name is opened exactly once, with O_CREAT', () => {
    const f = join(dir(), 'm.jsonl');
    writeFileSync(f, 'X\n');
    const opens: Array<string | number> = [];
    const ops: DurableFsOps = { ...realFsOps, openSync: (p, flags, mode) => { if (basename(p) === 'm.jsonl') opens.push(flags); return realFsOps.openSync(p, flags, mode); } };
    caught(() => appendRecordUnlocked(f, rec('m_1'), ops, { path: f, identity: null, createExclusive: true }));
    expect(opens).toHaveLength(1);
    expect(typeof opens[0] === 'number' && (opens[0] & constants.O_CREAT) !== 0).toBe(true);
  });

  it('a link that appears at the name before the exclusive creation is refused and the file it leads to is not written', () => {
    const d = dir();
    const f = join(d, 'm.jsonl');
    const victim = join(d, 'victim.jsonl');
    writeFileSync(victim, 'V\n');
    let planted = false;
    const ops: DurableFsOps = { ...realFsOps, openSync: (p, flags, mode) => {
      if (!planted && isCreateOpen(p, flags)) { planted = true; symlinkSync(victim, f); }
      return realFsOps.openSync(p, flags, mode);
    } };
    const err = caught(() => appendRecordUnlocked(f, rec('m_1'), ops, { path: f, identity: null, createExclusive: true }));
    expect(isLedgerCreateRefusedError(err)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('V\n');
  });

  it('an ELOOP at the exclusive creation is the same refusal and keeps its code', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, openSync: (p, flags, mode) => {
      if (isCreateOpen(p, flags)) throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' });
      return realFsOps.openSync(p, flags, mode);
    } };
    const err = caught(() => appendRecordUnlocked(f, rec('m_1'), ops, { path: f, identity: null, createExclusive: true }));
    expect(isLedgerCreateRefusedError(err)).toBe(true);
    expect((err as LedgerCreateRefusedError).code).toBe('ELOOP');
  });

  it('control: without createExclusive, a file that appeared since the judgement is appended to (R-5)', () => {
    const f = join(dir(), 'm.jsonl');
    writeFileSync(f, 'X\n');
    appendRecordUnlocked(f, rec('m_1'), undefined, { path: f, identity: null });
    expect(readFileSync(f, 'utf8')).toMatch(/^X\n\{.*"id":"m_1"/);
  });
});

describe('the file an exclusive creation made is taken away again when no row was stored (design 4.3 step 5, item 4)', () => {
  const J = (f: string) => ({ path: f, identity: null, createExclusive: true } as const);
  const boom = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });

  it('a write that fails leaves no file', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, writeSync: () => { throw boom('ENOSPC'); } };
    expect(caught(() => appendRecordUnlocked(f, rec('m_1'), ops, J(f)))).toBeInstanceOf(Error);
    expect(existsSync(f)).toBe(false);
  });

  it('an orphan-tmp sweep that fails leaves no file', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, readdirSync: () => { throw boom('EIO'); } };
    expect(caught(() => appendRecordUnlocked(f, rec('m_1'), ops, J(f)))).toBeInstanceOf(Error);
    expect(existsSync(f)).toBe(false);
  });

  it('a row fsync that fails leaves no file', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, fsyncSync: () => { throw boom('EIO'); } };
    const err = caught(() => appendRecordUnlocked(f, rec('m_1'), ops, J(f)));
    expect(isRecordStoredError(err)).toBe(false);
    expect(existsSync(f)).toBe(false);
  });

  it('a file that another party put in its place before the failure is left alone', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, writeSync: () => { unlinkSync(f); writeFileSync(f, 'OTHER\n'); throw boom('ENOSPC'); } };
    caught(() => appendRecordUnlocked(f, rec('m_1'), ops, J(f)));
    expect(readFileSync(f, 'utf8')).toBe('OTHER\n');
  });

  it('a file that existed (a plain open) is never removed, whatever fails', () => {
    const f = join(dir(), 'm.jsonl');
    writeFileSync(f, 'X\n');
    const ops: DurableFsOps = { ...realFsOps, writeSync: () => { throw boom('ENOSPC'); } };
    caught(() => appendRecordUnlocked(f, rec('m_1'), ops, { path: f, identity: fileIdentityAt(f) }));
    expect(readFileSync(f, 'utf8')).toBe('X\n');
  });

  it('the row is durable and the directory fsync fails: the file and the row stay, and the error carries the stored mark (14 decision 10)', () => {
    const f = join(dir(), 'm.jsonl');
    const ops: DurableFsOps = { ...realFsOps, fsyncDir: () => { throw boom('EIO'); } };
    const err = caught(() => appendRecordUnlocked(f, rec('m_1'), ops, J(f)));
    expect(isRecordStoredError(err)).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('"id":"m_1"');
  });
});
