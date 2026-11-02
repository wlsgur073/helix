// Third fix batch B1, task B5 (design 4.4; 13.3 decisions 3 and 13; 14 decisions 1 and 3; FW-R4, FW-R5, t-07): adopt is
// judged lock-free and refused, then takes the ledger lock of the resolved destination (lock order ledger, then registry),
// judges again, checks the content by the 1 MiB definition, makes the key, and only then records ownership, with the first
// commit's hold and restore if its own record fails.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, linkSync, rmSync, renameSync, chmodSync, constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as fsOpsMod from '../../src/memory/fs-ops.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import { realFsOps } from '../../src/memory/fs-ops.js';
import { selfIdentity, realProbe } from '../../src/memory/lock-liveness.js';
import { bundleCli } from '../helpers/bundle-cli.js';
import { LEDGER_CONTENT_READ_BOUND_BYTES, isLedgerProcLostError } from '../../src/memory/ledger.js';
import * as ownershipMod from '../../src/memory/ownership.js';
import { isOwned } from '../../src/memory/ownership.js';
import { MemoryStore } from '../../src/memory/store.js';
import { fixture, cleanupFixtures, registryKeys, keepWritable, NOW, type FirstWriteFixture } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const AS_ROOT = process.getuid?.() === 0;
const PROC = process.platform === 'linux' && existsSync('/proc/self/fd');

const TEXT = {
  notLedger: /^adopt: the file this project's memory path leads to holds content that is not Helix memory records — nothing was adopted\. Ask the user which file this project's memory should be; do not choose for them\.$/,
  aliased: /^adopt: this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, or through a path Helix cannot resolve, so the project layer is disabled here — nothing was adopted\.$/,
  unusable: /^adopt: this project's memory file cannot be used as it is \(.*\), so the project layer is disabled here — nothing was adopted\.$/,
  witness: /^adopt: the rollback-witness file cannot be used/,
  foreignLock: /not a lock Helix wrote/,
  busy: /^adopt: another write to this project's memory file did not finish while the adoption waited for its lock — nothing was adopted\./,
  unidentified: /^adopt: the lock beside this project's memory file has a holder Helix cannot identify or show to be gone \(the lock file cannot be read or does not parse as a lock, its holder cannot be checked, or it is a lock folder left by an older version\), so Helix does not remove it — nothing was adopted\. Ask the user to look at that lock; do not remove it for them\.$/,
  unwritable: /^adopt: this project's memory folder cannot be written \(a read-only folder or file system\), so nothing was adopted\./,
  changed: /^adopt: this project's memory file .* nothing was adopted\. Try the adoption again/,
  undone: /^adopt: recording the adoption failed, so the project was not adopted/,
  notUndone: /^adopt: recording the adoption failed and could not be undone/,
} as const;

const RECORD_LINE = JSON.stringify({
  id: 'm_foreign', tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: 'a team fact',
  provenance: { source: 'user', sessionId: 'x' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
}) + '\n';

function adoptMessage(fx: FirstWriteFixture, store: MemoryStore = fx.store()): string {
  try { store.adopt(fx.root); return 'adopted'; } catch (e) { return (e as Error).message; }
}
function expectNothingRecorded(fx: FirstWriteFixture): void {
  expect(registryKeys(fx.home)).toEqual([]);
  expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
}
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
type FsyncDir = typeof fsOpsMod.fsyncDir;
function failFsyncDirOf(when: (dir: string) => boolean): void {
  const real: FsyncDir = fsOpsMod.fsyncDir;
  vi.spyOn(fsOpsMod, 'fsyncDir').mockImplementation(((dir: string, ...rest: unknown[]) => {
    if (when(dir)) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    return (real as (...a: unknown[]) => void)(dir, ...rest);
  }) as unknown as FsyncDir);
}

describe('the content check (4.4, second bullet; the first 1 MiB decides)', () => {
  const CONTENTS: Array<{ id: string; bytes: () => string; adopted: boolean }> = [
    { id: 'a file that holds {} only', bytes: () => '{}\n', adopted: false },
    { id: 'plain text with no record line', bytes: () => '# notes\nplain text\n', adopted: false },
    { id: 'JSON lines that are not records', bytes: () => '{"a":1}\n{"b":2}\n', adopted: false },
    { id: 'a first MiB of blank lines followed by a record line (a blank-only first MiB of a longer file is not empty)', bytes: () => '\n'.repeat(LEDGER_CONTENT_READ_BOUND_BYTES) + RECORD_LINE, adopted: false },
    { id: 'a record line among other content', bytes: () => 'not json at all\n' + RECORD_LINE + '{"other":true}\n', adopted: true },
    { id: 'an empty file', bytes: () => '', adopted: true },
    { id: 'blank lines only', bytes: () => '\n  \n\t\n', adopted: true },
  ];
  for (const c of CONTENTS) {
    it(`${c.id} is ${c.adopted ? 'adopted' : 'refused with the not-ledger-content text; nothing is recorded and the file is untouched'}`, () => {
      const fx = fixture();
      const bytes = c.bytes();
      writeFileSync(fx.ledger, bytes);
      const message = adoptMessage(fx);
      if (c.adopted) {
        expect(message).toBe('adopted');
        expect(isOwned(fx.root, fx.home)).toBe(true);
      } else {
        expect(message).toMatch(TEXT.notLedger);
        expectNothingRecorded(fx);
      }
      expect(readFileSync(fx.ledger, 'utf8')).toBe(bytes);
    });
  }

  it('a memory path that is a link to a file of non-records is refused by the judgement (row 9a) with the unusable-layer text', () => {
    const fx = fixture();
    mkdirSync(join(fx.root, 'data'));
    writeFileSync(join(fx.root, 'data', 'mem.jsonl'), '{}\n');
    symlinkSync(join(fx.root, 'data', 'mem.jsonl'), fx.ledger);
    expect(adoptMessage(fx)).toMatch(TEXT.unusable);
    expectNothingRecorded(fx);
  });
});

describe('the judgement (4.4, first bullet): adopt on a layer that is aliased or unusable records nothing', () => {
  it('a memory path linked to the global ledger is refused with the aliased adopt text', () => {
    const fx = fixture();
    writeFileSync(fx.globalLedger, '');
    symlinkSync(fx.globalLedger, fx.ledger);
    expect(adoptMessage(fx)).toMatch(TEXT.aliased);
    expectNothingRecorded(fx);
  });

  it('a .helix that is not a directory is refused with the unusable adopt text', () => {
    const fx = fixture();
    rmSync(fx.helix, { recursive: true });
    writeFileSync(fx.helix, 'a file where the folder should be');
    expect(adoptMessage(fx)).toMatch(TEXT.unusable);
    expect(registryKeys(fx.home)).toEqual([]);
  });

  function ancestorStore(fx: FirstWriteFixture): MemoryStore {
    return new MemoryStore(fx.globalLedger, {
      home: fx.home, sessionId: 's-anc', now: () => NOW, genId: () => 'm_anc1',
      project: { root: fx.root, ledger: fx.ledger, origin: 'ancestor' },
    });
  }
  it('control: a parent project with an empty memory file is adopted (row 2 does not apply to adopt)', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, '');
    expect(adoptMessage(fx, ancestorStore(fx))).toBe('adopted');
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });
  it('control: adopting a parent project passes forAdopt to both judgements (row 2 is skipped by the option, not by a text)', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, '');
    const spy = vi.spyOn(ownershipMod, 'judgeProjectLayer');
    expect(adoptMessage(fx, ancestorStore(fx))).toBe('adopted');
    expect(spy.mock.calls.map((c) => c[1])).toEqual([{ forAdopt: true, freshContent: true }, { forAdopt: true, freshContent: true }]);
  });
  const PARENT_SHAPES: Array<{ id: string; shape: (fx: FirstWriteFixture) => void; text: RegExp }> = [
    { id: 'a link to the global ledger (row 6)', text: TEXT.aliased, shape: (fx) => { writeFileSync(fx.globalLedger, ''); symlinkSync(fx.globalLedger, fx.ledger); } },
    { id: 'a file of non-records (the content check)', text: TEXT.notLedger, shape: (fx) => { writeFileSync(fx.ledger, '{}\n'); } },
    { id: 'a .helix that is a regular file (row 3)', text: TEXT.unusable, shape: (fx) => { rmSync(fx.helix, { recursive: true }); writeFileSync(fx.helix, 'a file where the folder should be'); } },
    { id: 'a memory file with a second hard link (row 8)', text: TEXT.aliased, shape: (fx) => { writeFileSync(fx.ledger, RECORD_LINE); linkSync(fx.ledger, join(fx.root, 'second-name.jsonl')); } },
    { id: 'a dangling in-tree link whose folder is missing (row 10)', text: TEXT.unusable, shape: (fx) => { symlinkSync(join(fx.root, 'nodir', 'new.jsonl'), fx.ledger); } },
  ];
  for (const s of PARENT_SHAPES) {
    it(`a parent project is judged by rows 3 to 10 directly: ${s.id} is refused`, () => {
      const fx = fixture();
      s.shape(fx);
      expect(adoptMessage(fx, ancestorStore(fx))).toMatch(s.text);
      expectNothingRecorded(fx);
    });
  }
});

describe('the checks in front of the ownership record (4.4 last paragraph; FW-R5; FN-23)', () => {
  it('an unusable witness file refuses adopt before the lock, the key and the record (FW-R5)', () => {
    const fx = fixture();
    mkdirSync(join(fx.home, 'witness.json'));
    expect(adoptMessage(fx)).toMatch(TEXT.witness);
    expectNothingRecorded(fx);
    expect(existsSync(`${fx.ledger}.lock`)).toBe(false);
    expect(existsSync(join(fx.home, 'ledger-mac-master.key'))).toBe(false);
  });

  it('a damaged signing key refuses adopt with nothing recorded (FN-23: the key is made in front of the record)', () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'ledger-mac-master.key'), 'short', { mode: 0o600 });
    const message = adoptMessage(fx);
    expect(message).not.toBe('adopted');
    expect(message).toMatch(/corrupt master key/);   // the key layer's own error, not the undone or not-undone text of a record that failed
    expectNothingRecorded(fx);
  });

  it('a .helix folder that did not exist and whose adopt is refused is removed again', () => {
    const fx = fixture({ helix: false });
    writeFileSync(join(fx.home, 'ledger-mac-master.key'), 'short', { mode: 0o600 });
    const message = adoptMessage(fx);
    expect(message).not.toBe('adopted');
    expect(message).toMatch(/corrupt master key/);
    expect(existsSync(fx.helix)).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
  });

  it('control: adopt on a project with no .helix folder creates it and adopts', () => {
    const fx = fixture({ helix: false });
    expect(adoptMessage(fx)).toBe('adopted');
    expect(existsSync(join(fx.helix, '.owner'))).toBe(true);
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });
});

describe('the lock (4.4 third paragraph, 13.3 decision 3): ledger lock first, registry second; waiting; the foreign object', () => {
  it('adopt takes the project ledger lock before the registry lock', () => {
    const fx = fixture();
    const seen = spyOnLock();
    expect(adoptMessage(fx)).toBe('adopted');
    const reg = join(fx.home, 'projects.json');
    expect(seen.indexOf(fx.ledger)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(reg)).toBeGreaterThan(seen.indexOf(fx.ledger));
  });

  it('a foreign object at the ledger lock is refused with the lock layer\'s own text and records nothing', () => {
    const fx = fixture();
    symlinkSync(join(fx.base, 'nowhere'), `${fx.ledger}.lock`);
    expect(adoptMessage(fx)).toMatch(TEXT.foreignLock);
    expectNothingRecorded(fx);
  });

  let holdWorker = '';
  beforeAll(async () => { holdWorker = await bundleCli('scripts/lock-hold-worker.ts'); }, 30_000);
  const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
    const until = performance.now() + ms;
    while (!pred()) { if (performance.now() > until) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 25)); }
  };
  const hold = (fx: FirstWriteFixture, holdMs: number): ChildProcess =>
    spawn(process.execPath, [holdWorker, fx.ledger, fx.base, String(holdMs)], { stdio: 'ignore' });

  it.skipIf(process.platform === 'win32')('adopt behind a holder that releases inside the budget waits and then adopts', async () => {
    const fx = fixture();
    const w = hold(fx, 1500);
    try {
      await waitFor(() => existsSync(join(fx.base, 'acquired')), 5_000);
      const t0 = performance.now();
      expect(adoptMessage(fx)).toBe('adopted');
      expect(performance.now() - t0).toBeGreaterThanOrEqual(800);
      expect(isOwned(fx.root, fx.home)).toBe(true);
    } finally { try { w.kill('SIGKILL'); } catch { /* gone */ } }
  }, 20_000);

  it.skipIf(process.platform === 'win32')('adopt behind a holder that stays is refused after the 5 s budget with the fixed busy text, no path, nothing recorded (t-07)', async () => {
    const fx = fixture();
    const w = hold(fx, 20_000);
    try {
      await waitFor(() => existsSync(join(fx.base, 'acquired')), 5_000);
      const t0 = performance.now();
      const message = adoptMessage(fx);
      const elapsed = performance.now() - t0;
      expect(message).toMatch(TEXT.busy);
      expect(message).not.toContain(fx.ledger);
      expect(message).not.toMatch(/timed out/);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(9_000);
      expectNothingRecorded(fx);
    } finally { try { w.kill('SIGKILL'); } catch { /* gone */ } }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('an adopt that overlaps the restore of a failing first commit waits for the commit\'s lock and is not undone by the restore (13.3 decision 3)', async () => {
    const fx = fixture();
    const worker = await bundleCli('scripts/adopt-store-worker.ts');
    const go = join(fx.base, 'go'); const ready = join(fx.base, 'ready'); const result = join(fx.base, 'result');
    const child = spawn(process.execPath, [worker, fx.home, fx.root, go, ready, result], { stdio: 'ignore' });
    try {
      await waitFor(() => existsSync(ready), 10_000);
      let created = false; let fired = false;
      const realOpen = realFsOps.openSync; const realWrite = realFsOps.writeSync;
      vi.spyOn(realFsOps, 'openSync').mockImplementation((p, f, m) => {
        if (basename(p) === 'memory.jsonl' && typeof f === 'number' && (f & constants.O_CREAT) !== 0) created = true;
        return realOpen(p, f, m);
      });
      vi.spyOn(realFsOps, 'writeSync').mockImplementation((fd, buf, off, len) => {
        if (created && !fired) {
          fired = true;
          writeFileSync(go, '1');                                               // the child's adopt starts now, inside the failing commit's critical section
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);   // long enough for it to reach the lock (or, without the lock, to finish)
          throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' });
        }
        return realWrite(fd, buf, off, len);
      });
      let message = 'committed';
      try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/the first write to this project's memory file failed, so the project was not adopted/);
      await waitFor(() => existsSync(result), 15_000);
      expect(readFileSync(result, 'utf8')).toBe('adopted');
      expect(isOwned(fx.root, fx.home)).toBe(true);
    } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 40_000);
});

describe('under the lock (4.4 third paragraph): what changed during the wait counts', () => {
  it('a link that appears while adopt waits is judged again under the lock: nothing is adopted', () => {
    const fx = fixture();
    writeFileSync(fx.globalLedger, '');
    spyOnLock((t) => { if (t === fx.ledger) symlinkSync(fx.globalLedger, fx.ledger); });
    expect(adoptMessage(fx)).toMatch(TEXT.aliased);
    expectNothingRecorded(fx);
  });

  it('a memory file replaced while adopt waits gets the changed-destination text', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, RECORD_LINE);
    spyOnLock((t) => { if (t === fx.ledger) { renameSync(fx.ledger, join(fx.helix, 'other.jsonl')); symlinkSync('other.jsonl', fx.ledger); } });
    expect(adoptMessage(fx)).toMatch(TEXT.changed);
    expectNothingRecorded(fx);
  });

  it('the content is read under the lock: a file that stopped holding records while adopt waited is refused', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, RECORD_LINE);
    spyOnLock((t) => { if (t === fx.ledger) writeFileSync(fx.ledger, '{}\n'); });
    expect(adoptMessage(fx)).toMatch(TEXT.notLedger);
    expectNothingRecorded(fx);
  });

  it('a witness file that becomes unusable while adopt waits refuses it in front of the key and the record', () => {
    const fx = fixture();
    spyOnLock((t) => { if (t === fx.ledger) mkdirSync(join(fx.home, 'witness.json')); });
    expect(adoptMessage(fx)).toMatch(TEXT.witness);
    expectNothingRecorded(fx);
    expect(existsSync(join(fx.home, 'ledger-mac-master.key'))).toBe(false);
  });

  it.skipIf(AS_ROOT)('a read-only memory folder gets the adopt text instead of the raw errno (13.3 decision 5; 4.3: "project scope의 쓰기와 adopt에 적용한다")', () => {
    const fx = fixture();
    keepWritable(fx.helix);
    chmodSync(fx.helix, 0o555);
    expect(adoptMessage(fx)).toMatch(TEXT.unwritable);
    expect(registryKeys(fx.home)).toEqual([]);
  });

  it('a .helix that is not the judged directory any more is refused with nothing recorded', () => {
    const fx = fixture();
    vi.spyOn(dirBoundMod, 'openJudgedDir').mockReturnValue({ kind: 'changed' });
    expect(adoptMessage(fx)).toMatch(TEXT.changed);
    expectNothingRecorded(fx);
  });

  it('a /proc lost before the .helix directory is opened refuses with the dedicated error, nothing recorded', () => {
    const fx = fixture();
    vi.spyOn(dirBoundMod, 'openJudgedDir').mockReturnValue({ kind: 'proc-lost' });
    let caught: unknown;
    try { fx.store().adopt(fx.root); } catch (e) { caught = e; }
    expect(isLedgerProcLostError(caught)).toBe(true);
    expectNothingRecorded(fx);
  });

  it.skipIf(!PROC)('the close of the held .helix directory fails after the record: the adoption stands', () => {
    const fx = fixture();
    const realOpen = realFsOps.openSync;
    let heldFd = -1;
    vi.spyOn(realFsOps, 'openSync').mockImplementation((p, f, m) => {
      const fd = realOpen(p, f, m);
      if (heldFd === -1 && typeof f === 'number' && (f & constants.O_DIRECTORY) !== 0) heldFd = fd;
      return fd;
    });
    const realClose = realFsOps.closeSync;
    vi.spyOn(realFsOps, 'closeSync').mockImplementation((fd) => { realClose(fd); if (fd === heldFd) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); });
    expect(adoptMessage(fx)).toBe('adopted');
    vi.restoreAllMocks();
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });
});

describe('adopt\'s own record fails (FW-R4): the first commit\'s hold and restore', () => {
  it('a failure of the .owner write puts the registry back and answers the undone text', () => {
    const fx = fixture();
    let failed = false;
    failFsyncDirOf((d) => { if (d !== fx.home && !failed) { failed = true; return true; } return false; });
    expect(adoptMessage(fx)).toMatch(TEXT.undone);
    expect(failed).toBe(true);
    expectNothingRecorded(fx);
    expect(isOwned(fx.root, fx.home)).toBe(false);
  });

  it('a restore that fails too answers the not-undone text and leaves the registry entry', () => {
    const fx = fixture();
    failFsyncDirOf((d) => d !== fx.home);
    expect(adoptMessage(fx)).toMatch(TEXT.notUndone);
    expect(registryKeys(fx.home)).toHaveLength(1);
  });
});

describe('the adopt\'s wait that ran out of its budget answers by its cause (section 14 item 19)', () => {
  /** A REAL marked error of the lock layer, from a short wait on a scratch target in the fixture's base. */
  function realTimeout(fx: FirstWriteFixture, cause: lockMod.LockTimeoutCause): Error {
    const dir = join(fx.base, `scratch-${cause}`);
    mkdirSync(dir);
    const target = join(dir, 'ledger.jsonl');
    writeFileSync(target, '');
    const lockPath = lockMod.lockPathOf(target);
    let opts: lockMod.LockOptions = { maxWaitMs: 60 };
    if (cause === 'payload') {
      lockMod.writeLockFileForTest(lockPath, { ...selfIdentity('c'.repeat(32)), pid: 999_999, startTicks: '4242' });
      opts = { maxWaitMs: 60, probe: { ...realProbe, kill0: () => 'alive' as const, startTicksOf: () => null, stateOf: () => null } };
    } else if (cause === 'unparseable') {
      writeFileSync(lockPath, '{not json');
    } else if (cause === 'unreadable') {
      lockMod.writeLockFileForTest(lockPath, { ...selfIdentity('d'.repeat(32)), pid: 999_999, startTicks: '4242', threadId: 5 });
      opts = { maxWaitMs: 60, probe: { ...realProbe, kill0() { throw new Error('injected'); } } };
    } else if (cause === 'legacy-dir') {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'owner'), `${process.pid}-cafe`);
    } else if (cause === 'no-directory') {
      let removed = false;   // after the resolver: it refuses a target whose folder is absent before the lock layer runs
      opts = { maxWaitMs: 60, probe: { ...realProbe, uptimeSec: () => { if (!removed) { removed = true; rmSync(dirname(target), { recursive: true }); } return realProbe.uptimeSec(); } } };
    }
    let caught: unknown;
    try { lockMod.withFileLock(target, () => 1, opts); } catch (e) { caught = e; }
    expect(lockMod.lockTimeoutCauseOf(caught)).toBe(cause);
    return caught as Error;
  }
  /** The fixture's ledger lock throws `e`; every other target goes to the real function. */
  function failLedgerLockWith(fx: FirstWriteFixture, e: Error): void {
    const real: WithLock = lockMod.withFileLock;
    vi.spyOn(lockMod, 'withFileLock').mockImplementation(((target: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
      if (target === fx.ledger) throw e;
      return real(target, fn, opts);
    }) as unknown as WithLock);
  }
  const CAUSES: Array<{ cause: lockMod.LockTimeoutCause; text: RegExp; name: string }> = [
    { cause: 'unparseable', text: TEXT.unidentified, name: 'the unidentified-lock text' },
    { cause: 'unreadable', text: TEXT.unidentified, name: 'the unidentified-lock text' },
    { cause: 'legacy-dir', text: TEXT.unidentified, name: 'the unidentified-lock text' },
    { cause: 'no-directory', text: TEXT.changed, name: 'the changed-destination text' },
    { cause: 'payload', text: TEXT.busy, name: 'the busy text' },
  ];
  for (const c of CAUSES) {
    it(`a timeout with the cause ${c.cause} answers ${c.name}, without the lock path, nothing recorded`, () => {
      const fx = fixture();
      const e = realTimeout(fx, c.cause);
      failLedgerLockWith(fx, e);
      const message = adoptMessage(fx);
      expect(message).toMatch(c.text);
      expectNothingRecorded(fx);
      expect(message).not.toContain(fx.base);
      expect(message).not.toContain('.lock');
    });
  }
});

describe('adopt on a host without /proc (Review Focus 2: every write works, nothing is refused because /proc is missing)', () => {
  /** The seam the store and the append share (supersede-under-lock.test.ts): a fresh stub has no memory, so its first
   *  verification fails and every bind goes by path. The adopt must reach the unbound route, or the case says nothing about
   *  such a host, so the fixture asserts it. */
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

  it('a project with a memory file of record lines is adopted', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, RECORD_LINE);
    onHostWithoutProc(() => { expect(adoptMessage(fx)).toBe('adopted'); });
    expect(isOwned(fx.root, fx.home)).toBe(true);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(RECORD_LINE);
  });

  it('a project with no .helix folder gets the folder and is adopted', () => {
    const fx = fixture({ helix: false });
    onHostWithoutProc(() => { expect(adoptMessage(fx)).toBe('adopted'); });
    expect(existsSync(join(fx.helix, '.owner'))).toBe(true);
    expect(isOwned(fx.root, fx.home)).toBe(true);
  });
});
