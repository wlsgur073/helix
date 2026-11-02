// Third fix batch B1, task A16 (design 4.8 items 2 and 3): the witness file is looked at before anything of the append is done,
// and every error after the append says the record is stored.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, chmodSync, symlinkSync, linkSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { appendWitnessed, appendWitnessedUnlocked } from '../../src/memory/witness-write.js';
import { isLockForeignObjectError } from '../../src/memory/lock.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import {
  witnessPath, witnessUnusableRefusal, isWitnessUnusableError, isWitnessAdvanceError, WitnessAdvanceError, assertWitnessWritable,
  markRecordStored, isRecordStoredError,
} from '../../src/memory/witness-store.js';
import type { MemoryRecord } from '../../src/types.js';

const home = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'wp-')));
const store = (h: string, ledger: string = join(h, 'memory.jsonl'), project?: { ledger: string; root: string }): MemoryStore => {
  let n = 0;
  return new MemoryStore(ledger, { home: h, sessionId: 's', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}`, ...(project ? { project: { ...project, origin: 'cwd' as const } } : {}) });
};
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});
const rows = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0);
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

describe('the first step of an append: an unusable witness file refuses BEFORE anything is done (4.8 item 2; G-R3, W-R9)', () => {
  it('FN-03: a directory at witness.json: the commit is refused with the commit text, nothing is stored, a retry stores nothing, no key is minted', () => {
    const h = home(); mkdirSync(witnessPath(h));
    const s = store(h);
    for (let i = 0; i < 2; i++) {
      const e = thrown(() => s.commit({ content: 'the build uses node 24', source: 'user', scope: 'global' })) as Error;
      expect(isWitnessUnusableError(e)).toBe(true);
      expect(e.message).toBe(witnessUnusableRefusal('commit'));
      expect(isRecordStoredError(e)).toBe(false);                          // refused BEFORE the append: no mark
    }
    expect(rows(join(h, 'memory.jsonl'))).toBe(0);
    expect(existsSync(join(h, 'ledger-mac-master.key'))).toBe(false);
    expect(readdirSync(h).filter((n) => n.includes('.w-'))).toEqual([]);   // BASE left a witness.json.w-*.tmp per attempt
  });

  it('G-R3 and W-R9: the refusal comes before ensureHelixDir: a home that is too open keeps its mode, and a ledger folder outside the home is not created', () => {
    const h = home(); writeFileSync(witnessPath(h), 'not json {{{'); chmodSync(h, 0o755);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wp-')));
    const s = store(h, join(base, 'lg', 'memory.jsonl'));
    const e = thrown(() => s.commit({ content: 'a fact', source: 'user', scope: 'global' })) as Error;
    expect(e.message).toBe(witnessUnusableRefusal('commit'));
    expect(statSync(h).mode & 0o777).toBe(0o755);                          // ensureHelixDir would have tightened it to 0700
    expect(existsSync(join(base, 'lg'))).toBe(false);                      // appendWitnessed's mkdir of the ledger folder stands behind the check
  });

  it('control: with a usable witness file the same open home IS tightened (the check does not skip ensureHelixDir)', () => {
    const h = home(); const s = store(h);
    s.commit({ content: 'first', source: 'user', scope: 'global' });
    chmodSync(h, 0o755);
    s.commit({ content: 'second', source: 'user', scope: 'global' });
    expect(statSync(h).mode & 0o777).toBe(0o700);
  });

  it('a link at witness.json refuses a PROJECT commit too: the project ledger is unchanged and the link\'s destination is not touched', () => {
    const h = home(); const base = realpathSync(mkdtempSync(join(tmpdir(), 'wp-')));
    const root = join(base, 'proj'); mkdirSync(join(root, '.helix'), { recursive: true });
    const pl = join(root, '.helix', 'memory.jsonl');
    const s = store(h, join(h, 'memory.jsonl'), { ledger: pl, root });
    s.commit({ content: 'first project fact', source: 'user', scope: 'project' });     // adopts and witnesses
    const before = readFileSync(pl);
    const victim = join(h, 'elsewhere.json'); writeFileSync(victim, '{"note":1}');
    unlinkSync(witnessPath(h)); symlinkSync(victim, witnessPath(h));
    const e = thrown(() => s.commit({ content: 'second project fact', source: 'user', scope: 'project' })) as Error;
    expect(e.message).toBe(witnessUnusableRefusal('commit'));
    expect(readFileSync(pl).equals(before)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('{"note":1}');
  });

  it('the operation names its own text: a tombstone append says erase, confirm and recheck say the tool, never the store\'s verify (W-R5)', () => {
    const h = home(); const s = store(h);
    const id = s.commit({ content: 'a fact', source: 'user', scope: 'global' }).id;
    writeFileSync(join(h, 'app.json'), 'base /v2/users');
    const rid = s.commit({ content: 'api base /v2/users in app.json', source: 'user-relayed', scope: 'global' }).id;
    writeFileSync(witnessPath(h), 'not json {{{');
    expect((thrown(() => s.erase(id)) as Error).message).toBe(witnessUnusableRefusal('erase'));
    expect((thrown(() => s.confirm(id)) as Error).message).toBe(witnessUnusableRefusal('confirm'));
    const cwd = process.cwd(); process.chdir(h);
    try { expect((thrown(() => s.recheck(rid, { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' })) as Error).message).toBe(witnessUnusableRefusal('recheck')); }
    finally { process.chdir(cwd); }
  });

  it('the unlocked entry (the one confirm and recheck use) refuses first too: nothing is appended', () => {
    const h = home(); const ledger = join(h, 'memory.jsonl'); writeFileSync(ledger, '');
    mkdirSync(witnessPath(h));
    const e = thrown(() => appendWitnessedUnlocked(ledger, rec('m_x'), h, undefined, 'verify')) as Error;
    expect(e.message).toBe(witnessUnusableRefusal('verify'));
    expect(rows(ledger)).toBe(0);
  });

  it('assertWitnessWritable: absent file and absent home pass; transient is its own reason; homeUnchecked lets an unexaminable way fall through', () => {
    const h = home();
    expect(() => assertWitnessWritable(h, 'commit')).not.toThrow();                          // no witness.json yet
    expect(() => assertWitnessWritable(join(h, 'nohome'), 'commit')).not.toThrow();          // no home yet
    writeFileSync(join(h, 'afile'), 'x');                                                    // a FILE stands in the way: ENOTDIR on the path
    const badHome = join(h, 'afile', 'sub');
    expect((thrown(() => assertWitnessWritable(badHome, 'commit')) as NodeJS.ErrnoException).code).toBe('ENOTDIR');
    expect(() => assertWitnessWritable(badHome, 'commit', { homeUnchecked: true })).not.toThrow();
  });
});

describe('markRecordStored / isRecordStoredError (4.8 item 3)', () => {
  it('marks an Error in place: same object, same class and message, the stored state carried', () => {
    const e = new WitnessAdvanceError('raced');
    const out = markRecordStored(e, 'Verified');
    expect(out).toBe(e);
    expect(isRecordStoredError(out)).toBe(true);
    expect((out as unknown as { storedState: string }).storedState).toBe('Verified');
    expect(isWitnessAdvanceError(out)).toBe(true);
  });
  it('wraps what cannot take a property (a frozen error, a thrown string): the mark is never lost, the cause is kept', () => {
    const frozen = Object.freeze(new Error('frozen'));
    const a = markRecordStored(frozen, 'Fresh') as Error;
    expect(isRecordStoredError(a)).toBe(true); expect(a).not.toBe(frozen); expect(a.cause).toBe(frozen);
    const b = markRecordStored('a string', 'Fresh') as Error;
    expect(isRecordStoredError(b)).toBe(true); expect(b.cause).toBe('a string'); expect(b.message).toBe('a step after the write failed');
  });
  it('is read as a property, not by class, and an unmarked error is not marked', () => {
    expect(isRecordStoredError(Object.assign(new Error('x'), { recordStored: true }))).toBe(true);
    expect(isRecordStoredError(new Error('x'))).toBe(false);
    expect(isRecordStoredError('recordStored')).toBe(false);
  });
});

describe('every error after the append carries the mark; none before it does (4.8 item 3; the W4 causes)', () => {
  function seeded() { const h = home(); const ledger = join(h, 'memory.jsonl'); return { h, ledger, s: store(h) }; }

  it('an fs error from the witness replace (EIO): marked, the original error survives, the row is in the ledger once', () => {
    const { h, ledger } = seeded();
    const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw Object.assign(new Error('EIO: fake'), { code: 'EIO' }); });
    try {
      const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit')) as NodeJS.ErrnoException;
      expect(e.code).toBe('EIO'); expect(isRecordStoredError(e)).toBe(true);
      expect((e as unknown as { storedState: string }).storedState).toBe('Fresh');
    } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(1);
  });

  it('a WitnessAdvanceError from a racing writer: marked AND landedState kept (the audit rows are built from it)', () => {
    const { h, ledger } = seeded();
    const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw new WitnessAdvanceError('raced'); });
    try {
      const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit')) as WitnessAdvanceError;
      expect(isWitnessAdvanceError(e)).toBe(true); expect(isRecordStoredError(e)).toBe(true); expect(e.landedState).toBe('Fresh');
    } finally { spy.mockRestore(); }
  });

  it('the witness file became unusable BETWEEN the first step and the advance: the error is the witness refusal, marked (its "refused rather than replacing" is true of the file, not of the row)', () => {
    const { h, ledger } = seeded();
    const real = witnessStoreMod.advanceWitness;
    const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce((...a: Parameters<typeof real>) => { mkdirSync(witnessPath(h)); return real(...a); });
    try {
      const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit')) as Error;
      expect(isWitnessUnusableError(e)).toBe(true); expect(isRecordStoredError(e)).toBe(true);
    } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(1);
  });

  it('the re-read of the ledger after the append fails: marked', () => {
    const { h, ledger } = seeded();
    const real = ledgerMod.readLedgerBytes; let calls = 0;
    const spy = vi.spyOn(ledgerMod, 'readLedgerBytes').mockImplementation((...a: Parameters<typeof real>) => { if (++calls === 2) throw Object.assign(new Error('EIO: fake read'), { code: 'EIO' }); return real(...a); });
    try {
      const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit'));
      expect(isRecordStoredError(e)).toBe(true);
    } finally { spy.mockRestore(); }
    expect(rows(ledger)).toBe(1);
  });

  it('a thrown frozen error is wrapped, not lost', () => {
    const { h, ledger } = seeded();
    const spy = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw Object.freeze(new Error('frozen')); });
    try {
      const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit')) as Error;
      expect(isRecordStoredError(e)).toBe(true); expect((e.cause as Error).message).toBe('frozen');
    } finally { spy.mockRestore(); }
  });

  it('W-R4: a foreign object at the place of the witness lock is met after the append: the lock\'s refusal, marked, the row stored once (the first step does not look there)', () => {
    const { h, ledger } = seeded();
    symlinkSync(join(h, 'nowhere'), `${witnessPath(h)}.lock`);
    const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit'));
    expect(isLockForeignObjectError(e)).toBe(true); expect(isRecordStoredError(e)).toBe(true);
    expect(rows(ledger)).toBe(1);
  });

  it('a refusal before the append never carries the mark (the witness check)', () => {
    const { h, ledger } = seeded();
    writeFileSync(witnessPath(h), 'not json {{{');
    const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit'));
    expect(isWitnessUnusableError(e)).toBe(true); expect(isRecordStoredError(e)).toBe(false);
    expect(rows(ledger)).toBe(0);
  });
});

describe('a failure inside the append after the row\'s fsync returned is marked too; the fsync of the row itself is not (4.8 item 3, 4.3 step 5)', () => {
  const hasProc = existsSync('/proc/self/fd');
  const eioFrom = (what: string): NodeJS.ErrnoException => Object.assign(new Error(`EIO: fake ${what}`), { code: 'EIO' });
  /** A second witnessed append on an existing ledger, whose own append runs on `ops`. */
  function appendOn(ops: Partial<DurableFsOps>): { e: unknown; ledger: string } {
    const h = home(); const ledger = join(h, 'memory.jsonl');
    appendWitnessed(ledger, rec('m_0'), h, undefined, 'commit');
    const real = ledgerMod.appendRecordUnlocked;
    const spy = vi.spyOn(ledgerMod, 'appendRecordUnlocked').mockImplementationOnce((p, r) => real(p, r, { ...realFsOps, ...ops }));
    try { return { e: thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit')), ledger }; } finally { spy.mockRestore(); }
  }

  it('the directory fsync fails on an existing ledger: the original error, marked, the row is there once', () => {
    const { e, ledger } = appendOn({ fsyncDir: () => { throw eioFrom('directory fsync'); } });
    expect((e as NodeJS.ErrnoException).code).toBe('EIO');
    expect(isRecordStoredError(e)).toBe(true);
    expect((e as unknown as { storedState: string }).storedState).toBe('Fresh');
    expect(rows(ledger)).toBe(2);
  });

  it('the close of the ledger file fails: marked, the row is there once', () => {
    let closes = 0;
    const { e, ledger } = appendOn({ closeSync: (fd) => { realFsOps.closeSync(fd); if (++closes === 1) throw eioFrom('close'); } });
    expect(isRecordStoredError(e)).toBe(true);
    expect(rows(ledger)).toBe(2);
  });

  it.skipIf(!hasProc)('the close of the held directory fails: marked, the row is there once', () => {
    let closes = 0;
    const { e, ledger } = appendOn({ closeSync: (fd) => { realFsOps.closeSync(fd); if (++closes === 2) throw eioFrom('close'); } });
    expect(closes).toBe(2);
    expect(isRecordStoredError(e)).toBe(true);
    expect(rows(ledger)).toBe(2);
  });

  it('a frozen error from the directory fsync is wrapped, not lost', () => {
    const { e } = appendOn({ fsyncDir: () => { throw Object.freeze(new Error('frozen')); } });
    expect(isRecordStoredError(e)).toBe(true);
    expect(((e as Error).cause as Error).message).toBe('frozen');
  });

  it('the fsync of the row itself fails: the original error and no mark', () => {
    const { e } = appendOn({ fsyncSync: () => { throw eioFrom('fsync'); } });
    expect((e as NodeJS.ErrnoException).code).toBe('EIO');
    expect(isRecordStoredError(e)).toBe(false);
  });

  it('a refusal before the first byte (a second hard link) carries no mark', () => {
    const h = home(); const ledger = join(h, 'memory.jsonl');
    appendWitnessed(ledger, rec('m_0'), h, undefined, 'commit');
    linkSync(ledger, join(h, 'second.jsonl'));
    const e = thrown(() => appendWitnessed(ledger, rec('m_1'), h, undefined, 'commit'));
    expect(isRecordStoredError(e)).toBe(false);
    expect(rows(ledger)).toBe(1);
  });
});
