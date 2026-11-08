// B2a, task B3 (design 4.5, ruling J3): two looks stand in front of a global append. (1) The witness LOCK's name is looked at
// with the lock reader's own verdict, next to the witness file. (2) The master key is read or minted inside the ledger lock in
// front of the row of a global commit and a global erase. Every case that plants a FIFO runs in a child with a hard deadline.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, copyFileSync, readFileSync, existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import { fixture, cleanupFixtures, registryKeys, rowsIn } from '../helpers/first-write-fixture.js';
import { MemoryStore } from '../../src/memory/store.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { LOCK_FOREIGN_OBJECT_REFUSAL, isLockForeignObjectError } from '../../src/memory/lock.js';
import { isRecordStoredError } from '../../src/memory/witness-store.js';

const posixOnly = describe.skipIf(process.platform === 'win32');
const AS_ROOT = process.getuid?.() === 0;
const DEADLINE_MS = 20_000;
const NOW = '2026-11-08T00:00:00.000Z';
const KEY = 'ledger-mac-master.key';
const KEY_LOCK = `${KEY}.lock`;
const WITNESS_LOCK = 'witness.json.lock';

let child: string;
beforeAll(async () => { child = await bundleCli('test/helpers/pre-append-child.ts'); }, 60_000);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupFixtures();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sandbox = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'pa-'))); dirs.push(d); return d; };
const mkfifo = (p: string): void => { execFileSync('mkfifo', [p]); expect(lstatSync(p).isFIFO(), `fixture: ${p} is a FIFO`).toBe(true); };
const digest = (p: string): string => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent');
const rowsOf = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0);
const auditRows = (home: string): Array<Record<string, unknown>> =>
  (existsSync(join(home, 'audit.jsonl')) ? readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as Record<string, unknown>);
/** An in-process store over a home's `memory.jsonl`: used only to seed a home before any FIFO is planted in it. */
const seedStore = (home: string): MemoryStore => { let n = 0; return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 'seed', now: () => NOW, genId: () => `m_${++n}` }); };

interface Out { outcome: 'RETURNED' | 'THREW'; holds?: boolean; name?: string; message?: string; foreign?: boolean; stored?: boolean; unusable?: boolean }
function run(...args: string[]): Out {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HELIX_')));
  const r = spawnSync(process.execPath, [child, ...args], { encoding: 'utf8', timeout: DEADLINE_MS, killSignal: 'SIGKILL', cwd: tmpdir(), env });
  expect(r.signal, `the child did not finish, it was killed at the deadline; stdout=${r.stdout} stderr=${r.stderr.slice(0, 300)}`).toBeNull();
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as Out;
}

/** A fresh home that holds ONE live global row (its id returned) and nothing else: no key, no witness file, no lock. The row is
 *  carried over from a scratch home whose store minted the key and the witness there. */
function seededHome(): { home: string; id: string; ledger: string } {
  const scratch = sandbox();
  const id = seedStore(scratch).commit({ content: 'a seeded fact', source: 'user', scope: 'global' }).id;
  const home = sandbox();
  copyFileSync(join(scratch, 'memory.jsonl'), join(home, 'memory.jsonl'));
  expect(existsSync(join(home, KEY)), 'fixture: the fresh home has no key').toBe(false);
  expect(existsSync(join(home, 'witness.json')), 'fixture: the fresh home has no witness file').toBe(false);
  expect(rowsOf(join(home, 'memory.jsonl')), 'fixture: one seeded row').toBe(1);
  return { home, id, ledger: join(home, 'memory.jsonl') };
}

interface LockObjectRow { name: string; plant: (lockPath: string, dir: string) => void; foreign: boolean; skip?: boolean }
const OBJECTS: LockObjectRow[] = [
  { name: 'a FIFO', plant: (p) => mkfifo(p), foreign: true },
  { name: 'a dangling symlink', plant: (p, d) => symlinkSync(join(d, 'nowhere'), p), foreign: true },
  { name: 'a symlink to a regular file', plant: (p, d) => { writeFileSync(join(d, 'elsewhere'), 'not a lock payload'); symlinkSync(join(d, 'elsewhere'), p); }, foreign: true },
  { name: 'control: a regular file that holds no lock payload', plant: (p) => writeFileSync(p, 'not a lock payload'), foreign: false },
  { name: 'control: a legacy lock directory', plant: (p) => mkdirSync(p), foreign: false },
  { name: 'control: a regular file nobody can read', plant: (p) => { writeFileSync(p, 'x'); chmodSync(p, 0o000); }, foreign: false, skip: AS_ROOT },
  { name: 'control: nothing at the name', plant: () => {}, foreign: false },
];

function expectAssert(out: Out, refused: boolean): void {
  if (!refused) { expect(out.outcome).toBe('RETURNED'); return; }
  // the lock's own refusal and its own text, unmarked: nothing was stored
  expect(out).toMatchObject({ outcome: 'THREW', foreign: true, stored: false, unusable: false, message: LOCK_FOREIGN_OBJECT_REFUSAL });
}

posixOnly('the look at the object beside the witness file (design 4.5, ruling J3)', () => {
  for (const row of OBJECTS) {
    describe(row.name, () => {
      const t = row.skip ? it.skip : it;
      t(`lockPathHoldsForeignObject answers ${row.foreign}`, () => {
        const dir = sandbox();
        row.plant(join(dir, WITNESS_LOCK), dir);
        expect(run('look', join(dir, WITNESS_LOCK))).toMatchObject({ outcome: 'RETURNED', holds: row.foreign });
      });
      t(`assertWitnessWritable with no witness file yet ${row.foreign ? 'refuses with the lock refusal' : 'passes'}`, () => {
        const home = sandbox();
        row.plant(join(home, WITNESS_LOCK), home);
        expect(existsSync(join(home, 'witness.json')), 'precondition: no witness file').toBe(false);
        expectAssert(run('assert', home), row.foreign);
      });
      t(`assertWitnessWritable with a usable witness file ${row.foreign ? 'refuses with the lock refusal' : 'passes'}`, () => {
        const home = sandbox();
        seedStore(home).commit({ content: 'a fact', source: 'user', scope: 'global' });
        expect(existsSync(join(home, 'witness.json')), 'precondition: the commit wrote the witness file').toBe(true);
        row.plant(join(home, WITNESS_LOCK), home);
        expectAssert(run('assert', home), row.foreign);
      });
    });
  }
});

posixOnly('a global write is refused before its row, with the ledger as it was (ruling J3)', () => {
  const REFUSED = { outcome: 'THREW', foreign: true, stored: false, message: LOCK_FOREIGN_OBJECT_REFUSAL } as const;

  it('a FIFO at the key lock of a fresh home: the first global commit is refused before its row, and no key is minted (WBR-locks L-3)', () => {
    const home = sandbox();
    mkfifo(join(home, KEY_LOCK));
    expect(run('commit', home)).toMatchObject(REFUSED);
    expect(rowsOf(join(home, 'memory.jsonl'))).toBe(0);
    expect(existsSync(join(home, KEY))).toBe(false);
    expect(existsSync(join(home, 'witness.json'))).toBe(false);
    expect(existsSync(join(home, 'memory.jsonl.lock')), 'the ledger lock the call took was released').toBe(false);
  });

  it('the refusal leaves nothing behind: with the FIFO taken away the same commit stores exactly one row and mints the key', () => {
    const home = sandbox();
    const fifo = join(home, KEY_LOCK);
    mkfifo(fifo);
    expect(run('commit', home)).toMatchObject(REFUSED);
    unlinkSync(fifo);
    expect(run('commit', home)).toMatchObject({ outcome: 'RETURNED' });
    expect(rowsOf(join(home, 'memory.jsonl'))).toBe(1);
    expect(existsSync(join(home, KEY))).toBe(true);
  });

  it('a FIFO at the key lock of a seeded home: the global erase is refused before its tombstone, the ledger bytes are unchanged, the audit row is rejected', () => {
    const { home, id, ledger } = seededHome();
    const before = digest(ledger);
    mkfifo(join(home, KEY_LOCK));
    expect(run('erase', home, id)).toMatchObject(REFUSED);
    expect(digest(ledger)).toBe(before);
    expect(existsSync(join(home, KEY))).toBe(false);
    expect(auditRows(home)).toEqual([expect.objectContaining({ kind: 'erase', soft: true, outcome: 'rejected' })]);
  });

  it('a FIFO at the witness lock of a fresh home: each global commit is refused before its row, however often it is retried (WBR-bundle F3)', () => {
    const home = sandbox();
    mkfifo(join(home, WITNESS_LOCK));
    for (let i = 0; i < 2; i++) {
      expect(run('commit', home)).toMatchObject(REFUSED);
      expect(rowsOf(join(home, 'memory.jsonl'))).toBe(0);
    }
    expect(existsSync(join(home, KEY))).toBe(false);
    expect(existsSync(join(home, 'witness.json'))).toBe(false);
  });

  it('a FIFO at the witness lock of a seeded home: the global erase is refused before its tombstone and audited rejected, not indeterminate', () => {
    const { home, id, ledger } = seededHome();
    const before = digest(ledger);
    mkfifo(join(home, WITNESS_LOCK));
    expect(run('erase', home, id)).toMatchObject(REFUSED);
    expect(digest(ledger)).toBe(before);
    expect(existsSync(join(home, KEY))).toBe(false);
    expect(auditRows(home)).toEqual([expect.objectContaining({ kind: 'erase', soft: true, outcome: 'rejected' })]);
  });

  it('a FIFO at the witness lock of a seeded home: the global confirm is refused before its verify row, the ledger bytes are unchanged', () => {
    const { home, id, ledger } = seededHome();
    const before = digest(ledger);
    mkfifo(join(home, WITNESS_LOCK));
    expect(run('confirm', home, id)).toMatchObject(REFUSED);
    expect(digest(ledger)).toBe(before);
    expect(existsSync(join(home, KEY))).toBe(false);
    expect(auditRows(home)).toEqual([expect.objectContaining({ kind: 'verify', source: 'user', resultState: 'rejected' })]);
  });

  it('control: a home that already has its key is not asked for the key lock, so a FIFO there changes nothing', () => {
    const home = sandbox();
    seedStore(home).commit({ content: 'a fact', source: 'user', scope: 'global' });   // mints the key and the witness file
    expect(existsSync(join(home, KEY)), 'precondition: the key exists').toBe(true);
    mkfifo(join(home, KEY_LOCK));
    expect(run('commit', home)).toMatchObject({ outcome: 'RETURNED' });
    expect(rowsOf(join(home, 'memory.jsonl'))).toBe(2);
  });

  it('the key exists when the append starts: the mint stands inside the ledger lock, in front of the row', () => {
    const home = sandbox();
    const keyAtAppend: boolean[] = [];
    const real = ledgerMod.appendRecordUnlocked;
    vi.spyOn(ledgerMod, 'appendRecordUnlocked').mockImplementation((...a: Parameters<typeof real>) => { keyAtAppend.push(existsSync(join(home, KEY))); return real(...a); });
    seedStore(home).commit({ content: 'a fact', source: 'user', scope: 'global' });
    expect(keyAtAppend).toEqual([true]);
  });
});

posixOnly('adopt and a project\'s writes stand behind the same look (plan decision B3-2, owner 2026-11-08: every append)', () => {
  it('a foreign object at the witness lock refuses an adopt before the registry entry and the ownership record', () => {
    const fx = fixture();
    symlinkSync(join(fx.base, 'nowhere'), join(fx.home, WITNESS_LOCK));   // a link, not a FIFO: this case runs in process
    let error: unknown;
    try { fx.store().adopt(fx.root); } catch (e) { error = e; }
    expect(isLockForeignObjectError(error)).toBe(true);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
  });

  it('a foreign object at the witness lock refuses a project\'s later commit before its row, unmarked', () => {
    const fx = fixture();
    fx.store('a').commit({ content: 'a first fact', source: 'user' });   // the project becomes owned, the witness file exists
    expect(rowsIn(fx.ledger), 'precondition: one project row').toEqual(['a first fact']);
    symlinkSync(join(fx.base, 'nowhere'), join(fx.home, WITNESS_LOCK));
    let error: unknown;
    try { fx.store('b').commit({ content: 'a second fact', source: 'user' }); } catch (e) { error = e; }
    expect(isLockForeignObjectError(error)).toBe(true);
    expect(isRecordStoredError(error)).toBe(false);
    expect(rowsIn(fx.ledger)).toEqual(['a first fact']);
  });
});
