// Third fix batch B1, task B1 (design 4.3 steps 1 to 4; 13.3 decision 5; 14 decision 3; D7): the first commit of a
// project runs inside ONE critical section. The ledger lock comes first; under it the layer is judged again, a file
// that stands there is refused (and only there), the key and the witness file are asked before ownership is
// recorded, and a memory folder that refuses the lock file gets its fixed text.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync, statSync, symlinkSync, renameSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as homeMod from '../../src/memory/home-permissions.js';
import * as ownershipMod from '../../src/memory/ownership.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { appendWitnessedUnlocked } from '../../src/memory/witness-write.js';
import { isLedgerDestinationChangedError, DESTINATION_CHANGED_REFUSAL } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';
import { fixture, cleanupFixtures, rowsIn, registryKeys, keepWritable, NOW } from '../helpers/first-write-fixture.js';

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures(); });

const AS_ROOT = process.getuid?.() === 0;
const HAS_PROC = existsSync('/proc/self/fd');
const FOREIGN = '{"foreign":"not written by Helix"}\n';
const FOREIGN_TEXT = /a project memory file exists here that Helix did not create — ask the user whether to adopt it \(helix_memory_adopt\) or to move it away; do not choose for them\./;
const eio = (): Error => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });

type WithLock = typeof lockMod.withFileLock;
/** Records every lock target in call order; `hook` runs just before the real acquisition, `inside` just after it. */
function spyOnLock(hook: (target: string) => void = () => undefined, inside: (target: string) => void = () => undefined): string[] {
  const real: WithLock = lockMod.withFileLock;
  const seen: string[] = [];
  vi.spyOn(lockMod, 'withFileLock').mockImplementation(((target: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
    seen.push(target);
    hook(target);
    return real(target, (ctx) => { inside(target); return fn(ctx); }, opts);
  }) as unknown as WithLock);
  return seen;
}

const record = (id: string): MemoryRecord => ({
  id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`,
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

describe('step 2: the ledger lock comes first (lock order ledger, then registry, key and witness)', () => {
  it('a first commit takes the project ledger lock before the registry lock and the key lock, and stores the row', () => {
    const fx = fixture();
    const seen = spyOnLock();
    const out = fx.store().commitScoped({ content: 'first fact', source: 'user' });
    expect(out.scope).toBe('project');
    const reg = join(fx.home, 'projects.json');
    const key = join(fx.home, 'ledger-mac-master.key');
    expect(seen.indexOf(fx.ledger)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(reg)).toBeGreaterThan(seen.indexOf(fx.ledger));
    expect(seen.indexOf(key)).toBeGreaterThan(seen.indexOf(fx.ledger));
    expect(rowsIn(fx.ledger)).toEqual(['first fact']);
    expect(ownershipMod.isOwned(fx.root, fx.home)).toBe(true);
  });

  it('control: an aliased layer is refused at step 1, before any lock file is published and before the registry is touched', () => {
    const fx = fixture();
    writeFileSync(fx.globalLedger, '');
    symlinkSync(fx.globalLedger, fx.ledger);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(/the project layer is disabled here/);
    expect(existsSync(`${fx.globalLedger}.lock`)).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(readdirSync(fx.helix)).toEqual(['memory.jsonl']);
  });

  it('control: a project whose .helix folder is gone is committed to; the call creates the folder (design 4.2, line 110)', () => {
    const fx = fixture({ helix: false });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).not.toThrow();
    expect(rowsIn(fx.ledger)).toEqual(['a fact']);
    expect(ownershipMod.isOwned(fx.root, fx.home)).toBe(true);
  });

  it('IT-M5, the interleaving by hand: a commit that judged the project unadopted, and then finds another first commit finished, reads it as owned and is stored', () => {
    const fx = fixture();
    let raced = false;
    spyOnLock(() => { if (!raced) { raced = true; fx.store('b').commit({ content: 'the other fact', source: 'user' }); } });
    fx.store('a').commit({ content: 'a fact', source: 'user' });
    expect(rowsIn(fx.ledger).sort()).toEqual(['a fact', 'the other fact']);
    expect(registryKeys(fx.home)).toHaveLength(1);
    expect(ownershipMod.isOwned(fx.root, fx.home)).toBe(true);
  });
});

describe('step 3: under the lock the layer is judged again, with the content read afresh', () => {
  it('M35: a link that appears at the memory path after the lock-free judgement gets the alias refusal; the file it leads to is untouched and nothing is recorded', () => {
    const fx = fixture();
    const victim = join(fx.outside, 'victim.jsonl');
    writeFileSync(victim, 'V\n');
    spyOnLock((target) => { if (target === fx.ledger) symlinkSync(victim, fx.ledger); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(/the project layer is disabled here/);
    expect(readFileSync(victim, 'utf8')).toBe('V\n');
    expect(readdirSync(fx.outside)).toEqual(['victim.jsonl']);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
  });

  it('a judgement that passes with another destination than the lock-free one gets the changed-destination text; nothing is recorded', () => {
    const fx = fixture();
    const a = join(fx.root, 'a.jsonl');
    const b = join(fx.root, 'b.jsonl');
    symlinkSync(a, fx.ledger);
    spyOnLock((target) => { if (target === fx.ledger) { unlinkSync(fx.ledger); symlinkSync(b, fx.ledger); } });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(DESTINATION_CHANGED_REFUSAL);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
  });

  it('a judgement that passes with the first destination while the lock stands beside another one gets the same text', () => {
    const fx = fixture();
    const a = join(fx.root, 'a.jsonl');
    const b = join(fx.root, 'b.jsonl');
    symlinkSync(a, fx.ledger);
    const relink = (to: string): void => { unlinkSync(fx.ledger); symlinkSync(to, fx.ledger); };
    spyOnLock((target) => { if (target === fx.ledger) relink(b); }, (target) => { if (target === fx.ledger) relink(a); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(DESTINATION_CHANGED_REFUSAL);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
  });

  it('control: both judgements of a commit read row 9a afresh (design 4.2, 9a: the write side reads under the lock)', () => {
    const fx = fixture();
    const spy = vi.spyOn(ownershipMod, 'judgeProjectLayer');
    fx.store().commit({ content: 'a fact', source: 'user' });
    expect(spy.mock.calls.map((c) => c[1])).toEqual([{ freshContent: true }, { freshContent: true }]);
  });

  it.skipIf(!HAS_PROC)('the judged directory reaches the append: a memory folder replaced by another real folder after the judgement is refused and no row lands in it', () => {
    const fx = fixture();
    const real = ownershipMod.stampOwnership;
    vi.spyOn(ownershipMod, 'stampOwnership').mockImplementation(((root: string, home: string, opts?: Parameters<typeof real>[2]) => {
      renameSync(fx.helix, join(fx.root, 'helix-real'));
      mkdirSync(fx.helix);
      return real(root, home, opts);
    }) as typeof real);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(DESTINATION_CHANGED_REFUSAL);
    expect(rowsIn(fx.ledger)).toEqual([]);
  });

  it('the judged identity reaches the append: an owned memory file replaced after the judgement is refused and the new file gets no row', () => {
    const fx = fixture();
    fx.store().commit({ content: 'first fact', source: 'user' });
    const real = homeMod.ensureHelixDir;
    let calls = 0;
    vi.spyOn(homeMod, 'ensureHelixDir').mockImplementation((dir: string) => {
      real(dir);
      if (++calls === 2) {                 // the first call stands in front of the lock, the second opens the append
        renameSync(fx.ledger, `${fx.ledger}.moved`);
        copyFileSync(`${fx.ledger}.moved`, fx.ledger);
      }
    });
    expect(() => fx.store('b').commit({ content: 'second fact', source: 'user' })).toThrow(DESTINATION_CHANGED_REFUSAL);
    expect(rowsIn(fx.ledger)).toEqual(['first fact']);
  });
});

describe('step 4: a memory file Helix did not create is refused under the lock, and only there (FW-R1, D7)', () => {
  it('a file that appears after the lock-free judgement is refused with the foreign-file text; the key, the registry and the file are untouched', () => {
    const fx = fixture();
    spyOnLock((target) => { if (target === fx.ledger && !existsSync(fx.ledger)) writeFileSync(fx.ledger, FOREIGN); });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(FOREIGN_TEXT);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(FOREIGN);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.home, 'ledger-mac-master.key'))).toBe(false);   // refused by the judgement, before the key check
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
  });

  it('a file that appears between the judgement under the lock and the ownership record gets the same text and is left untouched', () => {
    const fx = fixture();
    const real = ownershipMod.stampOwnership;
    vi.spyOn(ownershipMod, 'stampOwnership').mockImplementation(((root: string, home: string, opts?: Parameters<typeof real>[2]) => {
      writeFileSync(fx.ledger, FOREIGN);
      return real(root, home, opts);
    }) as typeof real);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(FOREIGN_TEXT);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(FOREIGN);
    expect(ownershipMod.isOwned(fx.root, fx.home)).toBe(false);
  });

  it('a file that is there before the first look is refused with the same text (not adopted, nothing recorded)', () => {
    const fx = fixture();
    writeFileSync(fx.ledger, FOREIGN);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(FOREIGN_TEXT);
    expect(readFileSync(fx.ledger, 'utf8')).toBe(FOREIGN);
    expect(registryKeys(fx.home)).toEqual([]);
  });
});

describe('the checks that do not concern the project file stand in front of the ownership record (4.3 step 5, "사전 확인")', () => {
  it('a damaged signing key refuses the first commit with nothing recorded (14 decision 3)', () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'ledger-mac-master.key'), 'short', { mode: 0o600 });
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow();
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it('a foreign object at the key lock of a fresh home refuses the first commit with nothing recorded', () => {
    const fx = fixture();
    symlinkSync(join(fx.base, 'nowhere'), join(fx.home, 'ledger-mac-master.key.lock'));
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(/not a lock Helix wrote/);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it('a witness file that cannot be used refuses the first commit before the home is touched, the lock, the ownership record and the memory file (prototype F-1; FW-R10, W-R9)', () => {
    const fx = fixture();
    mkdirSync(join(fx.home, 'witness.json'));
    chmodSync(fx.home, 0o755);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(/the rollback-witness file cannot be used/);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(`${fx.ledger}.lock`)).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
    expect(statSync(fx.home).mode & 0o777).toBe(0o755);                  // ensureHelixDir would have tightened it to 0700
  });

  it('control: a failure after the row is stored keeps the ownership and the row, and carries the stored mark', () => {
    const fx = fixture();
    vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw eio(); });
    let caught: unknown;
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { caught = e; }
    expect(witnessStoreMod.isRecordStoredError(caught)).toBe(true);
    expect(rowsIn(fx.ledger)).toEqual(['a fact']);
    expect(ownershipMod.isOwned(fx.root, fx.home)).toBe(true);
  });
});

describe('step 2: a memory folder that refuses the lock file (13.3 decision 5)', () => {
  it.skipIf(AS_ROOT)('a read-only .helix gets the fixed text, and nothing is recorded', () => {
    const fx = fixture();
    keepWritable(fx.helix);
    chmodSync(fx.helix, 0o555);
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(
      /this project's memory folder cannot be written \(a read-only folder or file system\), so nothing was written\. Ask the user whether to store this fact in global memory, which every project sees, or to make that folder writable; do not choose for them\./,
    );
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(existsSync(fx.ledger)).toBe(false);
  });

  it.skipIf(AS_ROOT)('control: an EACCES raised by a lock taken UNDER the ledger lock (a read-only home) is not converted; it stays the raw errno', () => {
    const fx = fixture();
    keepWritable(fx.home);
    chmodSync(fx.home, 0o500);
    let message = '';
    try { fx.store().commit({ content: 'a fact', source: 'user' }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/EACCES/);
    expect(message).not.toMatch(/memory folder cannot be written/);
    chmodSync(fx.home, 0o700);
    expect(registryKeys(fx.home)).toEqual([]);
  });
});

describe('isHelixDirLinked and the lock that is never published through a link', () => {
  it('is true for a link, false for a directory and for nothing', () => {
    const fx = fixture();
    expect(ownershipMod.isHelixDirLinked(fx.root)).toBe(false);
    renameSync(fx.helix, join(fx.root, 'helix-real'));
    expect(ownershipMod.isHelixDirLinked(fx.root)).toBe(false);          // nothing there
    symlinkSync(fx.outside, fx.helix);
    expect(ownershipMod.isHelixDirLinked(fx.root)).toBe(true);
  });

  it('a .helix that became a link after the lock-free judgement is refused with the unusable-layer text before any lock is tried; nothing is written where it leads', () => {
    const fx = fixture();
    const real = homeMod.ensureHelixDir;
    let planted = false;
    vi.spyOn(homeMod, 'ensureHelixDir').mockImplementation((dir: string) => {
      real(dir);
      if (!planted) { planted = true; renameSync(fx.helix, join(fx.root, 'helix-real')); symlinkSync(fx.outside, fx.helix); }
    });
    const seen = spyOnLock();
    expect(() => fx.store().commit({ content: 'a fact', source: 'user' })).toThrow(/this project's memory file cannot be used as it is/);
    expect(seen).toEqual([]);                              // no lock is tried: under the lock the same refusal would come from row 3, after a lock file was published in the folder the link leads to
    expect(readdirSync(fx.outside)).toEqual([]);
    expect(registryKeys(fx.home)).toEqual([]);
  });
});

describe('appendWitnessedUnlocked hands the judged destination to the append', () => {
  it('a path that resolves elsewhere than the judged one is refused before anything is opened', () => {
    const fx = fixture();
    let caught: unknown;
    try {
      appendWitnessedUnlocked(fx.ledger, record('m_1'), fx.home, fx.root, 'commit', 'commit', { path: join(fx.helix, 'other.jsonl'), identity: null });
    } catch (e) { caught = e; }
    expect(isLedgerDestinationChangedError(caught)).toBe(true);
    expect(existsSync(fx.ledger)).toBe(false);
    expect(existsSync(join(fx.helix, 'other.jsonl'))).toBe(false);
  });
});
