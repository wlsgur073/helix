// Spec 4.5: ONE reader for every read of a lock path; five classes (payload, legacy directory, foreign,
// unreadable, absent). Every row runs in a child with a hard deadline (test/helpers/lock-object-child.ts):
// before B1 several of these objects stopped the whole thread (a FIFO read) or spun it (LOCK-UNREADABLE).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync, rmSync, lstatSync, existsSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { bundleCli } from '../helpers/bundle-cli.js';
import * as lock from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';

const BUDGET = 300;
const posixOnly = describe.skipIf(process.platform === 'win32');
let child: string;
beforeAll(async () => { child = await bundleCli('test/helpers/lock-object-child.ts'); }, 60_000);

interface Run { outcome: string; ms: number; message: string; foreign: boolean }
function run(mode: string, ledger: string): Run {
  const r = spawnSync(process.execPath, [child, mode, ledger, String(BUDGET)], { encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL' });
  expect(r.signal, `the child did not finish (it was killed at the deadline); stdout=${r.stdout} stderr=${r.stderr.slice(0, 200)}`).toBeNull();
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as Run;
}
const deadPid = (): number => spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
// The parent is alive for the whole test, so a payload with its identity classifies ALIVE in the child.
const livePayload = (): string => JSON.stringify({ ...selfIdentity('c'.repeat(32)), threadId: 99 });
const deadPayload = (): string => JSON.stringify({ ...selfIdentity('d'.repeat(32)), pid: deadPid(), threadId: 5 });
const mkfifo = (p: string): void => { execFileSync('mkfifo', [p]); };

interface Fx { dir: string; ledger: string; lockPath: string }
function fx(): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'helix-lockobj-'));
  const ledger = join(dir, 'ledger.jsonl');
  writeFileSync(ledger, '');
  return { dir, ledger, lockPath: lock.lockPathOf(ledger) };
}
const kindAt = (p: string): string => { const st = lstatSync(p); return st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : st.isDirectory() ? 'dir' : st.isSocket() ? 'socket' : 'file'; };

type Acquire = 'acquired' | 'foreign' | 'budget';
type Wait = 'none' | 'timeout';
const rows: Array<{ name: string; plant: (f: Fx) => void; acquire: Acquire; wait: Wait; kind?: string; message?: RegExp; notMessage?: RegExp }> = [
  { name: 'control: no lock', plant: () => {}, acquire: 'acquired', wait: 'none' },
  { name: 'control: payload of a live process', plant: (f) => writeFileSync(f.lockPath, livePayload()), acquire: 'budget', wait: 'timeout', message: /held by pid/ },
  { name: 'control: payload of a dead process', plant: (f) => writeFileSync(f.lockPath, deadPayload()), acquire: 'acquired', wait: 'none' },
  { name: 'a dangling symlink', plant: (f) => symlinkSync(join(f.dir, 'nowhere'), f.lockPath), acquire: 'foreign', wait: 'none', kind: 'symlink' },
  { name: 'a symlink to a file that holds a dead holder\'s payload (not followed, not reclaimed)', plant: (f) => { writeFileSync(join(f.dir, 'elsewhere'), deadPayload()); symlinkSync(join(f.dir, 'elsewhere'), f.lockPath); }, acquire: 'foreign', wait: 'none', kind: 'symlink' },
  { name: 'a FIFO', plant: (f) => mkfifo(f.lockPath), acquire: 'foreign', wait: 'none', kind: 'fifo' },
  { name: 'a live payload padded past the 64 KiB cap reads like a payload that does not parse', plant: (f) => writeFileSync(f.lockPath, livePayload() + ' '.repeat(64 * 1024)), acquire: 'budget', wait: 'timeout', notMessage: /held by pid/ },
  { name: 'a payload past the cap that predates this boot is litter, like any payload that does not parse', plant: (f) => { writeFileSync(f.lockPath, livePayload() + ' '.repeat(64 * 1024)); utimesSync(f.lockPath, new Date(0), new Date(0)); }, acquire: 'acquired', wait: 'none' },
  { name: 'a legacy lock directory whose owner entry is a FIFO (read as no owner: alive-unknown)', plant: (f) => { mkdirSync(f.lockPath); mkfifo(join(f.lockPath, 'owner')); }, acquire: 'budget', wait: 'timeout', kind: 'dir' },
  { name: 'a legacy lock directory whose owner entry is a link to a file naming a dead pid (not followed, not reclaimed)', plant: (f) => { mkdirSync(f.lockPath); writeFileSync(join(f.dir, 'own'), `${deadPid()}-cafe`); symlinkSync(join(f.dir, 'own'), join(f.lockPath, 'owner')); }, acquire: 'budget', wait: 'timeout', kind: 'dir' },
  { name: 'a legacy lock directory whose owner entry is past the cap (read as no owner, not reclaimed)', plant: (f) => { mkdirSync(f.lockPath); writeFileSync(join(f.lockPath, 'owner'), `${deadPid()}-cafe` + ' '.repeat(64 * 1024)); }, acquire: 'budget', wait: 'timeout', kind: 'dir' },
];

posixOnly('one reader for every lock path (spec 4.5, D8)', () => {
  for (const row of rows) {
    it(`${row.name}: the acquirer ${row.acquire}, the reader wait answers ${row.wait}`, () => {
      const a = fx(), w = fx();
      try {
        row.plant(a);
        const got = run('acquire', a.ledger);
        if (row.acquire === 'acquired') {
          expect(got.outcome).toBe('ACQUIRED');
        } else if (row.acquire === 'foreign') {
          expect(got.outcome).toBe('THREW');
          expect(got.foreign).toBe(true);
          expect(got.message).toBe(lock.LOCK_FOREIGN_OBJECT_REFUSAL);
          expect(got.ms, 'refused at once, not after the budget').toBeLessThan(BUDGET);
          expect(kindAt(a.lockPath), 'the object is left where it stood').toBe(row.kind);
        } else {
          expect(got.outcome).toBe('THREW');
          expect(got.foreign).toBe(false);
          expect(got.message).toMatch(/timed out after \d+ms acquiring/);
          expect(got.ms).toBeGreaterThanOrEqual(BUDGET - 20);
          if (row.message) expect(got.message).toMatch(row.message);
          if (row.notMessage) expect(got.message).not.toMatch(row.notMessage);
          expect(existsSync(a.lockPath), 'never reclaimed in this boot').toBe(true);
          if (row.kind) expect(kindAt(a.lockPath)).toBe(row.kind);
        }
        row.plant(w);
        const waited = run('wait', w.ledger);
        expect(waited.outcome).toBe(row.wait);
        if (row.wait === 'none') expect(waited.ms).toBeLessThan(BUDGET);
        else expect(waited.ms).toBeGreaterThanOrEqual(BUDGET - 20);
      } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(w.dir, { recursive: true, force: true }); }
    }, 30_000);
  }

  it('a unix socket: refused at once, never opened; the reader wait answers none', async () => {
    const dir = mkdtempSync('/tmp/hl-');   // short on purpose: a socket path must fit sun_path (precedent test/memory/ledger-file-type.test.ts)
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, '');
    const srv = createServer();
    await new Promise<void>((res) => srv.listen(lock.lockPathOf(ledger), res));
    try {
      const got = run('acquire', ledger);
      expect(got.foreign).toBe(true);
      expect(got.ms).toBeLessThan(BUDGET);
      expect(run('wait', ledger).outcome).toBe('none');
    } finally { await new Promise((res) => srv.close(res)); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)('an unreadable regular file (mode 000): the acquirer waits the budget as for a live holder, the reader wait answers none', () => {
    const a = fx(), w = fx();
    try {
      for (const f of [a, w]) { writeFileSync(f.lockPath, livePayload()); chmodSync(f.lockPath, 0o000); }
      const got = run('acquire', a.ledger);
      expect(got.outcome).toBe('THREW');
      expect(got.foreign).toBe(false);
      expect(got.ms).toBeGreaterThanOrEqual(BUDGET - 20);
      expect(got.message).not.toMatch(/held by pid/);
      const waited = run('wait', w.ledger);
      expect(waited.outcome).toBe('none');
      expect(waited.ms).toBeLessThan(BUDGET);
    } finally { for (const f of [a, w]) { try { chmodSync(f.lockPath, 0o600); } catch { /* gone */ } rmSync(f.dir, { recursive: true, force: true }); } }
  }, 30_000);

  it('a liveness probe that throws while classifying reads as unreadable (locks-R10): the acquirer waits the budget instead of spinning, the reader wait answers none', () => {
    const a = fx(), w = fx();
    try {
      writeFileSync(a.lockPath, livePayload());   // another pid in the child, so classifyHolder reaches probe.kill0
      writeFileSync(w.lockPath, livePayload());
      const got = run('acquire-probe-throws', a.ledger);
      expect(got.outcome).toBe('THREW');
      expect(got.foreign).toBe(false);
      expect(got.message).toMatch(/timed out after \d+ms acquiring/);
      expect(got.ms).toBeGreaterThanOrEqual(BUDGET - 20);
      const waited = run('wait-probe-throws', w.ledger);
      expect(waited.outcome).toBe('none');
      expect(waited.ms).toBeLessThan(BUDGET);
    } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(w.dir, { recursive: true, force: true }); }
  }, 30_000);

  it('stillOwned and the release do not follow a link: a link to this lock\'s own payload is not ours and stays where it stands', () => {
    const f = fx();
    try {
      let owned: boolean | null = null;
      lock.withFileLock(f.ledger, (ctx) => {
        const elsewhere = join(f.dir, 'elsewhere');
        writeFileSync(elsewhere, readFileSync(f.lockPath));
        unlinkSync(f.lockPath);
        symlinkSync(elsewhere, f.lockPath);
        owned = ctx.stillOwned();
      });
      expect(owned).toBe(false);
      expect(kindAt(f.lockPath), 'the release left the link alone').toBe('symlink');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('lock.ts has no second way to read a lock path', () => {
  it('no readFileSync call is left in src/memory/lock.ts: every read goes through readLockObject', () => {
    expect(readFileSync('src/memory/lock.ts', 'utf8')).not.toMatch(/\breadFileSync\s*\(/);
  });
});
