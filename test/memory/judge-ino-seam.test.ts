import { describe, it, expect, vi, afterEach } from 'vitest';

const overrides = vi.hoisted(() => new Map<string, { dev: bigint; ino: bigint }>());
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: (p: unknown, o?: { bigint?: boolean }) => {
      const st = (real.lstatSync as (...a: unknown[]) => any)(p, o);
      const hit = o?.bigint === true && typeof p === 'string' ? overrides.get(p) : undefined;
      if (hit === undefined) return st;
      return new Proxy(st, { get: (t, k) => (k === 'dev' ? hit.dev : k === 'ino' ? hit.ino : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    },
  };
});

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeProjectLayer } from '../../src/memory/ownership.js';

afterEach(() => overrides.clear());

/** A project whose memory path links to data/mine.jsonl (inside the root) and a DIFFERENT file data/g.jsonl as the global ledger. */
function world() {
  const b = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'jis-')));
  const root = join(b, 'proj'); const home = join(b, 'home');
  fs.mkdirSync(join(root, '.helix'), { recursive: true }); fs.mkdirSync(join(root, 'data')); fs.mkdirSync(home);
  fs.writeFileSync(join(root, 'data', 'mine.jsonl'), ''); fs.writeFileSync(join(root, 'data', 'g.jsonl'), '');
  fs.symlinkSync(join(root, 'data', 'mine.jsonl'), join(root, '.helix', 'memory.jsonl'));
  const judge = () => judgeProjectLayer({ root, ledger: join(root, '.helix', 'memory.jsonl'), home, globalLedger: join(root, 'data', 'g.jsonl'), origin: 'cwd' });
  return { mine: join(root, 'data', 'mine.jsonl'), g: join(root, 'data', 'g.jsonl'), judge };
}

describe('row 7 compares device and inode as bigints and never calls inode 0 the same', () => {
  it('two different files that both report inode 0 are NOT the same file (drvfs, FUSE)', () => {
    const w = world();
    overrides.set(w.mine, { dev: 1n, ino: 0n }); overrides.set(w.g, { dev: 1n, ino: 0n });
    expect(w.judge()).toMatchObject({ state: 'unadopted-present', row: '12' });
  });
  it('one device and one non-zero inode IS the same file even though the strings differ (decision 15: a second path to one file)', () => {
    const w = world();
    overrides.set(w.mine, { dev: 7n, ino: 42n }); overrides.set(w.g, { dev: 7n, ino: 42n });
    expect(w.judge()).toMatchObject({ state: 'aliased', row: '7', cause: 'global-ledger' });
  });
  it('inodes that differ only above 2^53 are different files (a number-typed stat would round them to one)', () => {
    const w = world();
    overrides.set(w.mine, { dev: 7n, ino: 2n ** 60n + 1n }); overrides.set(w.g, { dev: 7n, ino: 2n ** 60n + 2n });
    expect(w.judge()).toMatchObject({ state: 'unadopted-present', row: '12' });
  });
  it('one inode on two different devices is not the same file', () => {
    const w = world();
    overrides.set(w.mine, { dev: 7n, ino: 42n }); overrides.set(w.g, { dev: 8n, ino: 42n });
    expect(w.judge()).toMatchObject({ state: 'unadopted-present', row: '12' });
  });
});
