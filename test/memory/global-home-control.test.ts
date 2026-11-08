// B2a task B1 (ruling E, design 4.3): a global ledger that leads to a file the home keeps for itself is refused before the
// append, whatever the way it got there: a link at <home>/memory.jsonl (WBR-bundle F1, G17 and G18), HELIX_LEDGER at the file,
// or a link retargeted after the early check. Reads go on as before and carry the read-only note first.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as homePermMod from '../../src/memory/home-permissions.js';
import { MemoryStore } from '../../src/memory/store.js';
import { GLOBAL_WRITE_REFUSAL, isGlobalLedgerReadOnlyError } from '../../src/memory/global-ledger.js';
import { isHomeRefusalError } from '../../src/memory/home-env.js';
import { GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { handleErase } from '../../src/server/handlers.js';
import {
  buildControlHome, linkOwnerLedgerTo, relocatedLedger, homeDigest, sha256Of, cleanupControlLayouts, CONTROL_FILES, CONTROL_LOCKS, NOW,
} from '../helpers/home-control-layouts.js';

afterEach(() => { vi.restoreAllMocks(); cleanupControlLayouts(); });
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

describe('a commit whose destination is a control file of the home is refused before any lock and any home write', () => {
  it.each([...CONTROL_FILES, ...CONTROL_LOCKS])('HELIX_LEDGER at %s: a default-scope and a global-scope commit are refused, the home is as it was', (name) => {
    const l = buildControlHome();
    const ledger = join(l.home, name);
    const before = homeDigest(l.home);
    const lockSpy = vi.spyOn(lockMod, 'withFileLock');
    const homeSpy = vi.spyOn(homePermMod, 'ensureHelixDir');
    for (const input of [{ content: 'gamma fact', source: 'user' as const }, { content: 'gamma fact', source: 'user' as const, scope: 'global' as const }]) {
      const e = thrownBy(() => l.store(ledger).commit(input));
      expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
      expect(isHomeRefusalError(e)).toBe(true);
      expect((e as { readOnlyCause?: string }).readOnlyCause).toBe('home-control-file');
      expect((e as Error).message).toBe(GLOBAL_WRITE_REFUSAL.commit);
    }
    expect(lockSpy).not.toHaveBeenCalled();
    expect(homeSpy).not.toHaveBeenCalled();
    expect(homeDigest(l.home)).toEqual(before);                       // no row, no lock file, no mode change, nothing else
  });

  it.each(['witness.json', 'projects.json', 'ledger-mac-master.key', 'config.json'])('G17/G18: the owner ledger is a link to %s: refused, that file and the moved ledger keep their bytes', (name) => {
    const l = buildControlHome();
    const ledger = linkOwnerLedgerTo(l, name);
    expect(lstatSync(ledger).isSymbolicLink()).toBe(true);            // precondition: the link is what stands at the owner's name
    const target = join(l.home, name);
    const moved = join(l.base, 'owner-ledger.jsonl');
    const targetBefore = sha256Of(target);
    const movedBefore = sha256Of(moved);
    const before = homeDigest(l.home);
    const e = thrownBy(() => l.store(ledger).commit({ content: 'gamma fact', source: 'user' }));
    expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
    expect((e as Error).message).toBe(GLOBAL_WRITE_REFUSAL.commit);
    expect(sha256Of(target)).toBe(targetBefore);
    expect(sha256Of(moved)).toBe(movedBefore);
    expect(homeDigest(l.home)).toEqual(before);
  });

  it('a home that does not exist yet: HELIX_LEDGER at the registry name is refused and the home is not created', () => {
    const l = buildControlHome();
    const home = join(l.base, 'fresh');
    const s = new MemoryStore(join(home, 'projects.json'), { home, sessionId: 's', now: () => NOW, genId: () => 'n_1' });
    expect(isGlobalLedgerReadOnlyError(thrownBy(() => s.commit({ content: 'gamma fact', source: 'user' })))).toBe(true);
    expect(() => lstatSync(home)).toThrow();
  });

  it('controls (Review Focus 3): the owner ledger at its own name and a ledger relocated outside the home take the commit and carry no note', () => {
    const l = buildControlHome();
    for (const ledger of [join(l.home, 'memory.jsonl'), relocatedLedger(l)]) {
      const s = l.store(ledger);
      const rec = s.commit({ content: 'gamma fact', source: 'user' });
      expect(readFileSync(ledger, 'utf8')).toContain(rec.id);
      expect(s.recall('gamma').witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    }
  });
});

describe('the destination is judged again under the lock (a link retargeted after the early refusal)', () => {
  type WithLock = typeof lockMod.withFileLock;
  /** Runs `plant` once, just before the store's first lock on `ledger` is taken (after the early refusal, before the path is resolved for the lock). */
  function armBeforeLock(ledger: string, plant: () => void): void {
    const real: WithLock = lockMod.withFileLock;
    let fired = false;
    vi.spyOn(lockMod, 'withFileLock').mockImplementation(((t: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
      if (t !== ledger || fired) return real(t, fn, opts);
      fired = true;
      plant();
      return real(t, fn, opts);
    }) as unknown as WithLock);
  }

  it.each(['commit', 'confirm', 'erase'] as const)('%s: the owner ledger becomes a link to the registry between the early check and the lock: refused, nothing appended, no lock left', (op) => {
    const l = buildControlHome();
    const ledger = join(l.home, 'memory.jsonl');
    const registry = join(l.home, 'projects.json');
    const registryBefore = sha256Of(registry);
    const ownerBefore = sha256Of(ledger);
    const s = l.store(ledger);
    armBeforeLock(ledger, () => { linkOwnerLedgerTo(l, 'projects.json'); });
    const run = {
      commit: () => s.commit({ content: 'gamma fact', source: 'user' }),
      confirm: () => s.confirm(l.ids[0]!),
      erase: () => s.erase(l.ids[0]!),
    }[op];
    const e = thrownBy(run);
    expect(lstatSync(ledger).isSymbolicLink()).toBe(true);           // the plant ran, so the case tested what it says
    expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
    expect((e as Error).message).toBe(GLOBAL_WRITE_REFUSAL[op]);
    expect(sha256Of(registry)).toBe(registryBefore);
    expect(sha256Of(join(l.base, 'owner-ledger.jsonl'))).toBe(ownerBefore);
    expect(readdirSync(l.home).filter((n) => n.endsWith('.lock'))).toEqual([]);   // the lock taken beside the registry was released
  });

  it('an erase refused there is audited as rejected, the class every refusal before the write has', () => {
    const l = buildControlHome();
    const ledger = join(l.home, 'memory.jsonl');
    const s = l.store(ledger);
    armBeforeLock(ledger, () => { linkOwnerLedgerTo(l, 'projects.json'); });
    const auditPath = join(l.base, 'audit.jsonl');                    // outside the home: the home's own audit.jsonl is a fixture file
    expect(() => handleErase(s, { id: l.ids[0]! }, { auditPath, now: () => NOW })).toThrow(GLOBAL_WRITE_REFUSAL.erase);
    expect(JSON.parse(readFileSync(auditPath, 'utf8').trim())).toMatchObject({ kind: 'erase', soft: true, outcome: 'rejected' });
  });
});

describe('reads go on as they did and carry the read-only note first (design 4.3, last paragraph)', () => {
  it.each([...CONTROL_FILES])('%s as the ledger path: recall shows no record and the note stands first; the current view and the SessionStart gather say the same', (name) => {
    const l = buildControlHome();
    const ledger = join(l.home, name);
    const s = l.store(ledger);
    const r = s.recall('deploy');
    expect(r.items).toEqual([]);
    expect(r.witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(s.currentView().witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    const g = gatherScopedRecords({ home: l.home, globalLedger: ledger });
    expect(g.records).toEqual([]);
    expect(g.witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });

  it('control: the owner ledger shows its rows and no note on every surface', () => {
    const l = buildControlHome();
    const ledger = join(l.home, 'memory.jsonl');
    const s = l.store(ledger);
    expect(s.recall('deploy').items.map((i) => i.record.id).sort()).toEqual([...l.ids].sort());
    expect(s.recall('deploy').witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(gatherScopedRecords({ home: l.home, globalLedger: ledger }).witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });
});
