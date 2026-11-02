// Third fix batch B1, task B4 (design 4.3 step 6, D10, FN-24): a supersede commit checks its target AGAIN under the lock
// of the ledger it is written to, in a project scope and in the global scope, with the same three checks and the same
// texts as the lock-free look. The late commit is stopped by a seam after its lock-free checks and before it asks for
// the ledger lock; inside that window another store changes the target; then the late commit goes on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import { realFsOps } from '../../src/memory/fs-ops.js';
import { fixture, cleanupFixtures, rowsIn, type FirstWriteFixture } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const LATE = 'foxtrot replacement by the LATE writer';
type Scope = 'project' | 'global';
const ledgerOf = (fx: FirstWriteFixture, scope: Scope): string => (scope === 'project' ? fx.ledger : fx.globalLedger);

type WithLock = typeof lockMod.withFileLock;
/** Runs `action` once, just before the first acquisition of the lock of `target`. */
function armOnce(target: string, action: () => void): void {
  const real: WithLock = lockMod.withFileLock;
  let fired = false;
  vi.spyOn(lockMod, 'withFileLock').mockImplementation(((t: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
    if (t === target && !fired) { fired = true; action(); }
    return real(t, fn, opts);
  }) as unknown as WithLock);
}

const supersedeRows = (path: string, target: string): number =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; supersedes: string | null })
    .filter((r) => r.type === 'supersede' && r.supersedes === target).length;

interface Case {
  id: string;
  targetSource: 'user' | 'agent-inference';
  lateSource: 'user' | 'agent-inference';
  expect: RegExp;
  inWindow(fx: FirstWriteFixture, scope: Scope, target: string): void;
}
const CASES: Case[] = [
  { id: 'live: another supersede of the same id is stored first (FN-24)', targetSource: 'user', lateSource: 'user',
    expect: /commit: supersedes target not found \(dead or unknown id\)/,
    inWindow: (fx, scope, t) => { fx.store('other').commitScoped({ content: 'echo replacement by the other writer', source: 'user', scope, supersedes: t }); } },
  { id: 'erased: the target is erased first', targetSource: 'user', lateSource: 'user',
    expect: /commit: supersedes target not found \(dead or unknown id\)/,
    inWindow: (fx, _scope, t) => { fx.store('other').erase(t); } },
  { id: 'digest: the target is confirmed (Verified) first and the late commit carries no digest', targetSource: 'user', lateSource: 'user',
    expect: /commit: supersedesDigest missing or stale/,
    inWindow: (fx, _scope, t) => { fx.store('other').confirm(t); } },
  { id: 'guard: the target row is edited on disk to claim a human author and the late commit claims none', targetSource: 'agent-inference', lateSource: 'agent-inference',
    expect: /commit: refusing to supersede a human-authored or verified fact/,
    inWindow: (fx, scope, t) => {
      const p = ledgerOf(fx, scope);
      const text = readFileSync(p, 'utf8');
      const out = text.split('\n').map((l) => (l.includes(`"id":"${t}"`) ? l.replace('"source":"agent-inference"', '"source":"user"') : l)).join('\n');
      if (out === text) throw new Error('precondition: the target row was not edited');
      writeFileSync(p, out);
    } },
];

function seeded(fx: FirstWriteFixture, scope: Scope, targetSource: string): string {
  const seed = fx.store('seed');
  seed.commitScoped({ content: 'alpha global fact', source: 'user', scope: 'global' });   // a used home: witness.json exists
  return seed.commitScoped({ content: 'delta target fact', source: targetSource as 'user', scope }).record.id;
}
function lateCommit(fx: FirstWriteFixture, scope: Scope, source: string, target: string): string {
  try { fx.store('late').commitScoped({ content: LATE, source: source as 'user', scope, supersedes: target }); return 'no error'; }
  catch (e) { return (e as Error).message; }
}

describe('the target of a supersede commit is checked again under the ledger lock (step 6)', () => {
  for (const scope of ['project', 'global'] as Scope[]) {
    for (const k of CASES) {
      it(`${scope} scope, ${k.id}`, () => {
        const fx = fixture();
        const t = seeded(fx, scope, k.targetSource);
        armOnce(ledgerOf(fx, scope), () => k.inWindow(fx, scope, t));
        expect(lateCommit(fx, scope, k.lateSource, t)).toMatch(k.expect);
        expect(rowsIn(ledgerOf(fx, scope))).not.toContain(LATE);
        if (k.id.startsWith('live')) expect(supersedeRows(ledgerOf(fx, scope), t)).toBe(1);
      });
    }

    it(`control: ${scope} scope, a supersede commit that nothing changes in the window is stored once`, () => {
      const fx = fixture();
      const t = seeded(fx, scope, 'user');
      armOnce(ledgerOf(fx, scope), () => undefined);
      expect(lateCommit(fx, scope, 'user', t)).toBe('no error');
      expect(rowsIn(ledgerOf(fx, scope))).toContain(LATE);
      expect(supersedeRows(ledgerOf(fx, scope), t)).toBe(1);
    });

    it(`control: ${scope} scope, a supersede of an id that is not live is refused before the lock with the same text`, () => {
      const fx = fixture();
      seeded(fx, scope, 'user');
      expect(lateCommit(fx, scope, 'user', 'm_nope')).toMatch(/commit: supersedes target not found \(dead or unknown id\)/);
      expect(rowsIn(ledgerOf(fx, scope))).not.toContain(LATE);
    });
  }

  it('a supersede commit to a project that stops being owned under the lock is refused as target-not-found, not as a foreign file', () => {
    const fx = fixture();
    const t = seeded(fx, 'project', 'user');
    armOnce(fx.ledger, () => unlinkSync(join(fx.helix, '.owner')));
    expect(lateCommit(fx, 'project', 'user', t)).toMatch(/commit: supersedes target not found \(dead or unknown id\)/);
    expect(rowsIn(fx.ledger)).not.toContain(LATE);
  });
});

describe('a supersede commit on a host without /proc (Review Focus 2: every write works, nothing is refused because /proc is missing)', () => {
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

  for (const scope of ['project', 'global'] as Scope[]) {
    it(`${scope} scope, a supersede commit that nothing changes in the window is stored once`, () => {
      const fx = fixture();
      const t = seeded(fx, scope, 'user');
      onHostWithoutProc(() => { expect(lateCommit(fx, scope, 'user', t)).toBe('no error'); });
      expect(rowsIn(ledgerOf(fx, scope))).toContain(LATE);
      expect(supersedeRows(ledgerOf(fx, scope), t)).toBe(1);
    });

    it(`${scope} scope, the late one of two supersede commits of one id is refused with the same text`, () => {
      const fx = fixture();
      const t = seeded(fx, scope, 'user');
      onHostWithoutProc(() => {
        armOnce(ledgerOf(fx, scope), () => { fx.store('other').commitScoped({ content: 'echo replacement by the other writer', source: 'user', scope, supersedes: t }); });
        expect(lateCommit(fx, scope, 'user', t)).toMatch(/commit: supersedes target not found \(dead or unknown id\)/);
      });
      expect(rowsIn(ledgerOf(fx, scope))).not.toContain(LATE);
      expect(supersedeRows(ledgerOf(fx, scope), t)).toBe(1);
    });
  }
});
