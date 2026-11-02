// Third fix batch B1, task B3 (design 4.3, the paragraph on the other writers; 14 decision 8 FW-R13): the erase tombstone,
// confirm, recheck and the rewrites judge the project layer again under its ledger lock, and a project that is no longer
// owned there is refused with the operation's own text. The plant runs just before the lock is acquired.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, renameSync, unlinkSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import * as ownershipMod from '../../src/memory/ownership.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { MemoryStore, isEraseRefusedError } from '../../src/memory/store.js';
import { handleErase } from '../../src/server/handlers.js';
import { realFsOps } from '../../src/memory/fs-ops.js';
import { noopMetricsSink, type CompactionInput } from '../../src/metrics.js';
import { fixture, cleanupFixtures, rowsIn, keepWritable, type FirstWriteFixture } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const AS_ROOT = process.getuid?.() === 0;

const TEXT = {
  eraseNotAdopted: /^erase: this project's memory is not adopted — ask the user whether to adopt it \(helix_memory_adopt\); do not choose for them\.$/,
  eraseChanged: /^erase: this project's memory file was replaced while the erase waited for its lock — nothing was erased\./,
  eraseUnwritable: /^erase: this project's memory folder cannot be written \(a read-only folder or file system\), so nothing was erased\./,
  eraseAliased: /^erase: this project's memory file resolves outside this project/,
  eraseUnusable: /^erase: this project's memory file cannot be used as it is/,
  confirmNotAdopted: /^confirm: this project's memory is not adopted — the grade was not changed\. Ask the user whether to adopt it \(helix_memory_adopt\)/,
  recheckNotAdopted: /^recheck: this project's memory is not adopted — the grade was not changed\. Ask the user whether to adopt it \(helix_memory_adopt\)/,
  confirmChanged: /^confirm: .* the grade was not changed\. Try the confirmation again/,
  confirmUnwritable: /^confirm: this project's memory folder cannot be written \(a read-only folder or file system\), so the grade was not changed\./,
  witnessConfirm: /^confirm: the rollback-witness file cannot be used/,
  foreignLock: /not a lock Helix wrote/,
  compactionNotAdopted: /^compaction: this project's memory is not adopted — nothing was rewritten\.$/,
  compactionChanged: /^compaction: this project's memory file was replaced while the rewrite waited for its lock — nothing was rewritten\.$/,
  rewriteLanded: /^compactLedger: the rewrite landed, but the memory file changed before the rollback witness was updated$/,
} as const;

type WithLock = typeof lockMod.withFileLock;
/** Records every lock target in call order; `hook` runs just before the real acquisition. */
function spyOnLock(hook: (target: string) => void = () => undefined): string[] {
  const real: WithLock = lockMod.withFileLock;
  const seen: string[] = [];
  vi.spyOn(lockMod, 'withFileLock').mockImplementation(((target: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
    seen.push(target);
    hook(target);
    return real(target, fn, opts);
  }) as unknown as WithLock);
  return seen;
}
/** Runs `action` once, just before the first acquisition of the lock of `target`. */
function armOnce(target: string, action: () => void): void {
  let fired = false;
  spyOnLock((t) => { if (t === target && !fired) { fired = true; action(); } });
}
/** The project stops being owned: its `.owner` goes. The memory file stays, so the layer reads 'unadopted-present'. */
const dropOwner = (fx: FirstWriteFixture) => (): void => unlinkSync(join(fx.helix, '.owner'));
/** An owned project holding one fact; returns that fact's id. */
function owned(fx: FirstWriteFixture, content = 'fact one'): string {
  return fx.store('seed').commit({ content, source: 'user' }).id;
}
function messageOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as Error).message; }
  return '';
}
const auditRows = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const rowCount = (path: string): number => readFileSync(path, 'utf8').trim().split('\n').length;
/** Once, right behind the first directory fsync through a held directory after `landed()` holds, the memory file moves to
 *  `other` and a link takes its name: the rewrite has landed, and its read for the rollback witness meets the link. The
 *  witness file's own fsyncs name the home, so only the held directory's fsync matches. Answers whether it fired. */
function plantLinkBehindBoundFsync(fx: FirstWriteFixture, other: string, landed: () => boolean): () => boolean {
  const real = realFsOps.fsyncDir;
  let fired = false;
  vi.spyOn(realFsOps, 'fsyncDir').mockImplementation((d: string) => {
    real(d);
    if (!fired && d.startsWith('/proc/self/fd/') && landed()) { fired = true; renameSync(fx.ledger, other); symlinkSync('other.jsonl', fx.ledger); }
  });
  return () => fired;
}

describe('the erase tombstone is judged again under the project ledger lock (design 4.3, FW-R13)', () => {
  it('a project that is not owned under the lock is refused with the 4.9 not-adopted text, as a typed pre-write refusal; nothing is appended', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    armOnce(fx.ledger, dropOwner(fx));
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(TEXT.eraseNotAdopted);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
  });

  it('the handler audits that refusal as rejected, never as indeterminate', () => {
    const fx = fixture(); const id = owned(fx);
    armOnce(fx.ledger, dropOwner(fx));
    const auditPath = join(fx.base, 'audit.jsonl');
    expect(() => handleErase(fx.store('b'), { id }, { auditPath })).toThrow(/not adopted/);
    const rows = auditRows(auditPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'erase', id, outcome: 'rejected' });
  });

  it('the handler audits a foreign object at the ledger lock as rejected (13.4, the audit row of 4.7): nothing was written', () => {
    const fx = fixture(); const id = owned(fx);
    symlinkSync(join(fx.base, 'nowhere'), `${fx.ledger}.lock`);
    const auditPath = join(fx.base, 'audit.jsonl');
    expect(() => handleErase(fx.store('b'), { id }, { auditPath })).toThrow(TEXT.foreignLock);
    expect(auditRows(auditPath)[0]).toMatchObject({ kind: 'erase', id, outcome: 'rejected' });
  });

  it('the handler audits a lost /proc as rejected: the refusal stands before the first byte', () => {
    const fx = fixture(); const id = owned(fx);
    vi.spyOn(dirBoundMod, 'openJudgedDir').mockReturnValue({ kind: 'proc-lost' });
    const auditPath = join(fx.base, 'audit.jsonl');
    expect(() => handleErase(fx.store('b'), { id }, { auditPath })).toThrow();
    expect(auditRows(auditPath)[0]).toMatchObject({ kind: 'erase', id, outcome: 'rejected' });
  });

  it('a memory file replaced by a link after the lock-free look is refused with the erase changed-destination text; the file the link leads to is untouched', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    const other = join(fx.helix, 'other.jsonl');
    armOnce(fx.ledger, () => { renameSync(fx.ledger, other); symlinkSync('other.jsonl', fx.ledger); });
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(TEXT.eraseChanged);
    expect(readFileSync(other, 'utf8')).toBe(before);
  });

  it('a memory file replaced by a link out of the project under the lock gets the erase alias text, with the operation\'s name', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    const moved = join(fx.outside, 'moved.jsonl');
    armOnce(fx.ledger, () => { renameSync(fx.ledger, moved); symlinkSync(moved, fx.ledger); });
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(TEXT.eraseAliased);
    expect(readFileSync(moved, 'utf8')).toBe(before);
  });

  it('a directory that took the memory file\'s name under the lock gets the erase unusable text', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    const other = join(fx.helix, 'other.jsonl');
    armOnce(fx.ledger, () => { renameSync(fx.ledger, other); mkdirSync(fx.ledger); });
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(TEXT.eraseUnusable);
    expect(readFileSync(other, 'utf8')).toBe(before);
  });

  it('the check inside the append refuses with the erase text too: the ledger layer raises the commit text, the inner function gives the operation its own', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    const other = join(fx.helix, 'other.jsonl');
    const real = witnessStoreMod.classifyState;
    let fired = false;
    vi.spyOn(witnessStoreMod, 'classifyState').mockImplementation(((...a: Parameters<typeof real>) => {
      if (!fired) { fired = true; renameSync(fx.ledger, other); symlinkSync('other.jsonl', fx.ledger); }   // after the judgement under the lock, before the append
      return real(...a);
    }) as typeof real);
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(fired).toBe(true);
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/^erase: .* nothing was erased\. Try the erase again/);
    expect(readFileSync(other, 'utf8')).toBe(before);
  });

  it.skipIf(AS_ROOT)('a read-only memory folder gets the erase unwritable text instead of the raw errno, and its adopted ledger stays readable (design 4.3 step 5; 13.3 decision 5)', () => {
    const fx = fixture(); const id = owned(fx);
    keepWritable(fx.helix);
    chmodSync(fx.helix, 0o555);
    const before = readFileSync(fx.ledger, 'utf8');
    let caught: unknown;
    try { fx.store('b').erase(id); } catch (e) { caught = e; }
    expect(isEraseRefusedError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(TEXT.eraseUnwritable);
    expect(messageOf(() => fx.store('c').confirm(id))).toMatch(TEXT.confirmUnwritable);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
    const seen = fx.store('r').recall('fact one');           // the judgement does not probe writability: the layer stays owned and is read
    expect(seen.items.map((i) => i.record.content)).toEqual(['fact one']);
    expect(fx.store('r').currentView().projectDisposition).toBe('owned');
  });

  it('control: a foreign object at the ledger lock keeps the lock layer\'s own refusal; the erase does not convert it', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    symlinkSync(join(fx.base, 'nowhere'), `${fx.ledger}.lock`);
    expect(messageOf(() => fx.store('b').erase(id))).toMatch(TEXT.foreignLock);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
  });
});

describe('confirm and recheck are judged again under the project ledger lock', () => {
  it('confirm: a project that is not owned under the lock is refused with the confirm text; no verify row is written', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    armOnce(fx.ledger, dropOwner(fx));
    expect(messageOf(() => fx.store('b').confirm(id))).toMatch(TEXT.confirmNotAdopted);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
  });

  it('confirm: a memory file replaced by a link under the lock gets the confirm changed-destination text', () => {
    const fx = fixture(); const id = owned(fx);
    const before = readFileSync(fx.ledger, 'utf8');
    const other = join(fx.helix, 'other.jsonl');
    armOnce(fx.ledger, () => { renameSync(fx.ledger, other); symlinkSync('other.jsonl', fx.ledger); });
    expect(messageOf(() => fx.store('b').confirm(id))).toMatch(TEXT.confirmChanged);
    expect(readFileSync(other, 'utf8')).toBe(before);
  });

  it('a project that the lock-free look already reads as not owned is refused there: no lock is taken (step 1)', () => {
    const fx = fixture(); const id = owned(fx);
    fx.store('r').inspect();   // the read ahead of the confirm mints the global nonce under the registry lock (14 item 17): done here, so `seen` is the write's alone
    type Judge = typeof ownershipMod.judgeProjectLayer;
    const real: Judge = ownershipMod.judgeProjectLayer;
    vi.spyOn(ownershipMod, 'judgeProjectLayer').mockImplementation(((p: Parameters<Judge>[0], o: Parameters<Judge>[1]) => {
      const j = real(p, o);
      return o?.freshContent === true ? { ...j, state: 'unadopted-present' as const, row: '12' as const } : j;   // only the write side's judgement: the routing still reads owned
    }) as Judge);
    const seen = spyOnLock();
    expect(messageOf(() => fx.store('b').confirm(id))).toMatch(TEXT.confirmNotAdopted);
    expect(seen).toEqual([]);
  });

  it('recheck: the same, with the recheck text', () => {
    const fx = fixture();
    const cwd = process.cwd();
    process.chdir(fx.base);   // the check names a short relative path (store.test.ts:103-108: an absolute temp path trips the entropy scanner)
    try {
      writeFileSync(join(fx.base, 'app.json'), 'base /v2/users');
      const id = fx.store('seed').commit({ content: 'api base /v2/users in app.json', source: 'user-relayed' }).id;
      const before = readFileSync(fx.ledger, 'utf8');
      armOnce(fx.ledger, dropOwner(fx));
      expect(messageOf(() => fx.store('b').recheck(id, { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' }))).toMatch(TEXT.recheckNotAdopted);
      expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
    } finally { process.chdir(cwd); }
  });

  it('control: an unusable witness file still refuses a confirm with the tool\'s own name (W-R5), now from the inner function\'s first look', () => {
    const fx = fixture(); const id = owned(fx);
    rmSync(join(fx.home, 'witness.json'));
    mkdirSync(join(fx.home, 'witness.json'));
    const before = readFileSync(fx.ledger, 'utf8');
    expect(messageOf(() => fx.store('b').confirm(id))).toMatch(TEXT.witnessConfirm);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
    expect(existsSync(`${fx.ledger}.lock`)).toBe(false);
  });
});

describe('the rewrites are judged again under the project ledger lock', () => {
  const FUTURE = '2100-01-01T00:00:00.000Z';
  const COMPACT = { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 };

  it('an auto-compaction of a project ledger is refused when the project is not owned under the lock; the file is not rewritten and no tmp is left', () => {
    const fx = fixture();
    const emitted: CompactionInput[] = [];
    const s = new MemoryStore(fx.globalLedger, {
      home: fx.home, sessionId: 's-c', now: () => FUTURE, project: { root: fx.root, ledger: fx.ledger },
      compaction: { ...COMPACT }, metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(s.commit({ content: `fact ${i} deploy timeout`, source: 'user' }).id);
    for (let i = 0; i < 5; i++) s.commit({ content: `fact ${i} updated deploy timeout`, source: 'user', supersedes: ids[i]! });
    const before = readFileSync(fx.ledger, 'utf8');
    armOnce(fx.ledger, dropOwner(fx));
    s.recall('deploy');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ scope: 'project', ok: false, landed: false });
    expect(readFileSync(fx.ledger, 'utf8')).toBe(before);
    expect(readdirSync(fx.helix).filter((n) => n.includes('.c-'))).toEqual([]);
  });

  it('control: a permanent erase of a project record still removes the plaintext from the file', () => {
    const fx = fixture(); const id = owned(fx, 'secret fact to erase');
    expect(fx.store('b').erase(id, { permanent: true })).toBe('erased');
    expect(readFileSync(fx.ledger, 'utf8')).not.toContain('secret fact to erase');
    expect(rowsIn(fx.ledger)).not.toContain('secret fact to erase');
  });

  it('a project rewrite goes through the destination judged under the lock (the path and the held directory\'s identity reach it)', () => {
    const fx = fixture(); const id = owned(fx);
    const spy = vi.spyOn(ledgerMod, 'compactLedgerUnlocked');
    expect(fx.store('b').erase(id, { permanent: true })).toBe('erased');
    expect(spy).toHaveBeenCalledTimes(1);
    const dir = statSync(fx.helix, { bigint: true });
    expect(spy.mock.calls[0]![3]).toMatchObject({ path: fx.ledger, dir: { dev: dir.dev, ino: dir.ino } });
  });

  it('a project that stops being owned between the tombstone and the rewrite of a permanent erase: the tombstone stands, and the rewrite is refused with the compaction row, where \'nothing was erased\' would be false', () => {
    const fx = fixture(); const id = owned(fx, 'secret fact to erase');
    let acquired = 0;
    spyOnLock((t) => { if (t === fx.ledger && ++acquired === 2) dropOwner(fx)(); });
    let caught: unknown;
    try { fx.store('b').erase(id, { permanent: true }); } catch (e) { caught = e; }
    expect(acquired).toBe(2);
    expect(isEraseRefusedError(caught)).toBe(false);   // a tombstone is stored: this is no pre-write refusal
    expect((caught as Error).message).toMatch(TEXT.compactionNotAdopted);
    const text = readFileSync(fx.ledger, 'utf8');
    expect(text).toContain('secret fact to erase');   // nothing was rewritten
    expect(text).toContain('"type":"erase"');         // the tombstone of the first critical section stands
  });

  it('a memory file replaced between the tombstone and the rewrite of a permanent erase: the tombstone stands, and the refusal says nothing was rewritten, never nothing was erased', () => {
    const fx = fixture(); const id = owned(fx, 'secret fact to erase');
    const other = join(fx.helix, 'other.jsonl');
    let acquired = 0;
    spyOnLock((t) => { if (t === fx.ledger && ++acquired === 2) { renameSync(fx.ledger, other); symlinkSync('other.jsonl', fx.ledger); } });
    let caught: unknown;
    try { fx.store('b').erase(id, { permanent: true }); } catch (e) { caught = e; }
    expect(acquired).toBe(2);
    expect((caught as Error).message).toMatch(TEXT.compactionChanged);
    expect((caught as Error).message).not.toMatch(/nothing was erased/);
    const text = readFileSync(other, 'utf8');
    expect(text).toContain('secret fact to erase');   // nothing was rewritten
    expect(text).toContain('"type":"erase"');         // the tombstone of the first critical section stands
  });

  it('a link that takes the memory file\'s name behind the rename of an auto-compaction: the metric says the rewrite landed, with the real dropped rows and bytes', () => {
    const fx = fixture();
    const emitted: CompactionInput[] = [];
    const s = new MemoryStore(fx.globalLedger, {
      home: fx.home, sessionId: 's-c', now: () => FUTURE, project: { root: fx.root, ledger: fx.ledger },
      compaction: { ...COMPACT }, metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(s.commit({ content: `fact ${i} deploy timeout`, source: 'user' }).id);
    for (let i = 0; i < 5; i++) s.commit({ content: `fact ${i} updated deploy timeout`, source: 'user', supersedes: ids[i]! });
    const before = readFileSync(fx.ledger, 'utf8');
    const rowsBefore = rowCount(fx.ledger);
    const other = join(fx.helix, 'other.jsonl');
    const fired = plantLinkBehindBoundFsync(fx, other, () => readFileSync(fx.ledger, 'utf8') !== before);
    s.recall('deploy');
    expect(fired()).toBe(true);
    const rowsAfter = rowCount(other);
    expect(rowsAfter).toBeLessThan(rowsBefore);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      scope: 'project', ok: false, landed: true,
      droppedRows: rowsBefore - rowsAfter, reclaimedBytes: Buffer.byteLength(before) - statSync(other).size,
    });
  });

  it('a link that takes the memory file\'s name behind the rename of a permanent erase: the plaintext is gone from the bytes the rewrite published, the error carries landed stats, and it says neither nothing was erased nor nothing was rewritten', () => {
    const fx = fixture(); const id = owned(fx, 'secret fact to erase');
    const other = join(fx.helix, 'other.jsonl');
    const fired = plantLinkBehindBoundFsync(fx, other, () => !readFileSync(fx.ledger, 'utf8').includes('secret fact to erase'));
    let caught: unknown;
    try { fx.store('b').erase(id, { permanent: true }); } catch (e) { caught = e; }
    expect(fired()).toBe(true);
    expect(readFileSync(other, 'utf8')).not.toContain('secret fact to erase');
    expect(ledgerMod.isLedgerDestinationChangedError(caught)).toBe(false);
    expect(isEraseRefusedError(caught)).toBe(false);
    const message = (caught as Error).message;
    expect(message).toMatch(TEXT.rewriteLanded);
    expect(message).not.toMatch(/nothing was erased|nothing was rewritten/);
    expect(ledgerMod.landedCompactionStats(caught)).toBeDefined();
  });
});

describe('the other writers on a host without /proc (Review Focus 2: every write works, nothing is refused because /proc is missing)', () => {
  /** The seam the store and the append share (first-write-restore.test.ts): a fresh stub has no memory, so its first
   *  verification fails and every bind goes by path. Whatever runs in `body` must reach the unbound route, or the case says
   *  nothing about such a host, so the fixture asserts it. */
  function onHostWithoutProc(body: () => void): void {
    const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
    realFsOps.procFd = { statSync: enoent, readlinkSync: enoent };
    const opened = vi.spyOn(dirBoundMod, 'openJudgedDir');
    try {
      body();
      expect(opened).toHaveBeenCalled();
      expect(new Set(opened.mock.results.map((r) => (r.value as dirBoundMod.JudgedDirOutcome).kind))).toEqual(new Set(['unbound']));
      expect(dirBoundMod.procFdAvailable(realFsOps)).toBe(false);
    } finally { delete realFsOps.procFd; vi.restoreAllMocks(); }
  }

  it('a soft erase stores its tombstone', () => {
    const fx = fixture(); const id = owned(fx);
    onHostWithoutProc(() => { expect(fx.store('b').erase(id)).toBe('erased'); });
    expect(readFileSync(fx.ledger, 'utf8')).toContain('"type":"erase"');
  });

  it('a confirm stores its verify row', () => {
    const fx = fixture(); const id = owned(fx);
    onHostWithoutProc(() => { fx.store('b').confirm(id); });
    expect(readFileSync(fx.ledger, 'utf8')).toContain('"type":"verify"');
  });

  it('a permanent erase removes the plaintext from the file, by path', () => {
    const fx = fixture(); const id = owned(fx, 'secret fact to erase');
    onHostWithoutProc(() => { expect(fx.store('b').erase(id, { permanent: true })).toBe('erased'); });
    expect(readFileSync(fx.ledger, 'utf8')).not.toContain('secret fact to erase');
    expect(readdirSync(fx.helix).filter((n) => n.includes('.c-'))).toEqual([]);
  });

  it('an auto-compaction of a project ledger lands, by path', () => {
    const fx = fixture();
    const emitted: CompactionInput[] = [];
    const s = new MemoryStore(fx.globalLedger, {
      home: fx.home, sessionId: 's-c', now: () => '2100-01-01T00:00:00.000Z', project: { root: fx.root, ledger: fx.ledger },
      compaction: { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 },
      metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(s.commit({ content: `fact ${i} deploy timeout`, source: 'user' }).id);
    for (let i = 0; i < 5; i++) s.commit({ content: `fact ${i} updated deploy timeout`, source: 'user', supersedes: ids[i]! });
    onHostWithoutProc(() => { s.recall('deploy'); });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ scope: 'project', ok: true, landed: true });
  });
});
