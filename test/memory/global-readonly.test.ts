// Third fix batch B1, task B6 (design 4.7, second table; 13.3 decision 12; 14 decision 8: G-R1..G-R9, order items 1 to 4):
// every write to a global ledger whose path cannot be used is refused with one typed, fixed text before a lock is tried and
// before the store writes anything to the home; reads keep working through the path as given and carry the note first.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, unlinkSync, symlinkSync, chmodSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as lockMod from '../../src/memory/lock.js';
import * as homePermMod from '../../src/memory/home-permissions.js';
import * as realityMod from '../../src/memory/reality-check.js';
import * as pathIdentityMod from '../../src/memory/path-identity.js';
import * as globalLedgerMod from '../../src/memory/global-ledger.js';
import * as dirBoundMod from '../../src/memory/dir-bound.js';
import { realFsOps } from '../../src/memory/fs-ops.js';
import { GLOBAL_WRITE_REFUSAL, GLOBAL_DESTINATION_CHANGED, isGlobalLedgerReadOnlyError, type GlobalWriteOp } from '../../src/memory/global-ledger.js';
import { GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { isWitnessUnusableError } from '../../src/memory/witness-store.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { handleRecall, handleInspect, handleErase, handleConfirm, handleRecheck } from '../../src/server/handlers.js';
import { noopMetricsSink, type CompactionInput } from '../../src/metrics.js';
import type { CompactionConfig } from '../../src/config.js';
import { buildGlobalLayout, cleanupLayouts, snapshotTree, FF, type GlobalLayoutName } from '../helpers/global-layouts.js';

afterEach(() => { vi.restoreAllMocks(); cleanupLayouts(); });
const NOW = '2026-11-01T00:00:00.000Z';
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const text = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('');
const refusal = (op: GlobalWriteOp): string => GLOBAL_WRITE_REFUSAL[op];

const READ_ONLY: GlobalLayoutName[] = ['nonutf8-link-body', 'nonutf8-dir-link', 'chain-41', 'loop', 'dangling-target-dir-missing', 'below-dangling-dir-link'];
const WITH_ROWS: GlobalLayoutName[] = ['nonutf8-link-body', 'nonutf8-dir-link'];
const FACT_CHECK = (base: string) => ({ kind: 'file-contains' as const, path: join(base, 'fact.txt'), pattern: 'x' });

describe('a commit to a read-only global ledger is refused before any lock and any home write', () => {
  it.each(READ_ONLY)('%s: an omitted-scope commit (no project layer) and an explicit global commit, a supersede commit included', (name) => {
    const l = buildGlobalLayout(name);
    const before = snapshotTree(l.base);
    const lockSpy = vi.spyOn(lockMod, 'withFileLock');
    const homeSpy = vi.spyOn(homePermMod, 'ensureHelixDir');
    try {
      const inputs = [
        { content: 'gamma fact', source: 'user' as const },
        { content: 'gamma fact', source: 'user' as const, scope: 'global' as const },
        { content: 'gamma fact', source: 'user' as const, supersedes: 'g_1' },
      ];
      for (const input of inputs) {
        const e = thrownBy(() => l.store().commit(input));
        expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
        expect((e as Error).message).toBe(refusal('commit'));     // also for the supersede: no "target not found", nothing was read first
      }
      expect(lockSpy).not.toHaveBeenCalled();
      expect(homeSpy).not.toHaveBeenCalled();
    } finally { lockSpy.mockRestore(); homeSpy.mockRestore(); }
    expect(snapshotTree(l.base)).toEqual(before);
  });

  it('a commit with scope project and no project layer keeps its own refusal (the global text is for global routes only)', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const e = thrownBy(() => l.store().commit({ content: 'x', source: 'user', scope: 'project' })) as Error;
    expect(isGlobalLedgerReadOnlyError(e)).toBe(false);
    expect(e.message).toMatch(/no project memory layer is active/);
  });

  it('a project-scope write is not affected (4.7, last row of the second table)', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const root = join(l.base, 'proj');
    mkdirSync(join(root, '.helix'), { recursive: true });
    const s = l.store('p', { project: { root, ledger: join(root, '.helix', 'memory.jsonl'), origin: 'cwd' } });
    s.adopt(root);
    const out = s.commitScoped({ content: 'a project fact', source: 'user', scope: 'project' });
    expect(out.scope).toBe('project');
    expect(readFileSync(join(root, '.helix', 'memory.jsonl'), 'utf8')).toContain(out.record.id);
  });
});

describe('erase, confirm, recheck and the permanent erase of a row the path shows are refused the same way', () => {
  it.each(WITH_ROWS)('%s: five calls, one typed text each, the home and the kernel file untouched', (name) => {
    const l = buildGlobalLayout(name);
    const id = l.ids[0]!;
    const before = snapshotTree(l.base);
    const kernelBefore = readFileSync(l.kernelFile as Buffer);
    const s = l.store();
    const cases: Array<[GlobalWriteOp, () => unknown]> = [
      ['erase', () => s.erase(id)],
      ['erase', () => s.erase(id, { scope: 'global' })],
      ['erase', () => s.erase(id, { permanent: true })],
      ['confirm', () => s.confirm(id)],
      ['recheck', () => s.recheck(id, FACT_CHECK(l.base))],
    ];
    for (const [op, run] of cases) {
      const e = thrownBy(run);
      expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
      expect((e as Error).message).toBe(refusal(op));
    }
    expect(snapshotTree(l.base)).toEqual(before);
    expect(readFileSync(l.kernelFile as Buffer).equals(kernelBefore)).toBe(true);
  });

  it('G-R2: the soft erase of a global id that is already erased is refused too', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const dead = l.ids[1]!;
    appendFileSync(l.kernelFile as Buffer, JSON.stringify({
      id: 'g_tomb', tx: NOW, validFrom: NOW, validTo: null, type: 'erase', content: '', state: 'Suspect',
      provenance: { source: 'user', sessionId: 'seed' }, supersedes: dead, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    expect(isGlobalLedgerReadOnlyError(thrownBy(() => l.store().erase(dead)))).toBe(true);
  });

  it('an id no scope holds is still the quiet no-op (the refusal is for a global TARGET)', () => {
    for (const name of ['chain-41', 'dangling-target-dir-missing'] as const) {
      const l = buildGlobalLayout(name);
      expect(l.store().erase('g_1')).toBe('absent');
    }
  });

  it('order item 3: confirm and recheck of a global row are refused before the target is looked up and before the check runs', () => {
    const l = buildGlobalLayout('nonutf8-dir-link');
    expect(existsSync(join(l.home, 'ledger-mac-master.key'))).toBe(true);
    expect(existsSync(join(l.home, 'projects.json'))).toBe(false);          // the global scope nonce was never minted
    // A row that BINDS the check (checkBinding: its path and its pattern stand in the content), so a recheck that got past the
    // refusal would really run it. Over a row that does not bind, `run` stays uncalled whatever the order is.
    const fact = join(l.base, 'fact.txt');
    writeFileSync(fact, 'staging\n');
    appendFileSync(l.kernelFile as Buffer, JSON.stringify({
      id: 'g_fact', tx: NOW, validFrom: NOW, validTo: null, type: 'assert', content: `the file ${fact} says staging`, state: 'Fresh',
      provenance: { source: 'user', sessionId: 'seed' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const before = snapshotTree(l.base);
    const run = vi.spyOn(realityMod, 'runRealityCheck');
    try {
      expect(isGlobalLedgerReadOnlyError(thrownBy(() => l.store().confirm(l.ids[0]!)))).toBe(true);
      expect(isGlobalLedgerReadOnlyError(thrownBy(() => l.store().recheck('g_fact', { kind: 'file-contains', path: fact, pattern: 'staging' })))).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally { run.mockRestore(); }
    expect(snapshotTree(l.base)).toEqual(before);
    expect(existsSync(join(l.home, 'projects.json'))).toBe(false);
  });

  it('order item 3, control: an id that is nowhere is the ordinary "target not found", not the global refusal', () => {
    const l = buildGlobalLayout('nonutf8-dir-link');
    const e = thrownBy(() => l.store().confirm('g_nowhere')) as Error;
    expect(isGlobalLedgerReadOnlyError(e)).toBe(false);
    expect(e.message).toMatch(/target not found/);
  });
});

describe('the order of the checks (G-R3, G-R4)', () => {
  it('G-R4: when the path is read-only and the witness file is unusable too, the global text comes first', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const w = join(l.home, 'witness.json');
    rmSync(w);
    mkdirSync(w);                                                           // a directory where the witness file belongs
    for (const run of [() => l.store().commit({ content: 'x', source: 'user' }), () => l.store().erase(l.ids[0]!), () => l.store().confirm(l.ids[0]!)]) {
      expect(isGlobalLedgerReadOnlyError(thrownBy(run))).toBe(true);
    }
  });

  it.each(['commit', 'erase', 'confirm'] as const)('G-R3: on a writable global ledger an unusable witness file refuses %s without changing the home mode (A16\'s first statement passes it before B6; here it guards the new inner function)', (op) => {
    const l = buildGlobalLayout('plain');
    l.store().inspect();                                                    // mints the global scope nonce: a first mint runs ensureHelixDir itself, in the read in front of the write
    const w = join(l.home, 'witness.json');
    rmSync(w);
    mkdirSync(w);
    chmodSync(l.home, 0o755);
    const s = l.store();
    const run = {
      commit: () => s.commit({ content: 'x', source: 'user' }),
      erase: () => s.erase(l.ids[0]!),
      confirm: () => s.confirm(l.ids[0]!),
    }[op];
    const e = thrownBy(run);
    expect(isWitnessUnusableError(e) || /rollback-witness/.test((e as Error).message)).toBe(true);
    expect(statSync(l.home).mode & 0o777).toBe(0o755);                      // ensureHelixDir would have tightened it to 0700
  });

  it('a read-only refusal leaves a loose home mode alone too', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    chmodSync(l.home, 0o755);
    expect(isGlobalLedgerReadOnlyError(thrownBy(() => l.store().commit({ content: 'x', source: 'user' })))).toBe(true);
    expect(statSync(l.home).mode & 0o777).toBe(0o755);
  });
});

describe('reads: the path as given, the note first (4.7, G-R8)', () => {
  it.each(READ_ONLY)('%s: recall, inspect, history and as-of show what the path reaches and carry the note first', (name) => {
    const l = buildGlobalLayout(name);
    const s = l.store();
    const r = s.recall('deploy');
    expect(r.items.map((i) => i.record.id).sort()).toEqual([...l.ids].sort());
    expect(r.witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(s.currentView().witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(s.historyView().witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(s.asOfView('2026-11-02T00:00:00.000Z').witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(handleRecall(s, { query: 'deploy' }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(handleInspect(s, {}))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(handleInspect(s, { history: true }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(handleInspect(s, { asOf: '2026-11-02T00:00:00.000Z' }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(handleInspect(s, { ids: ['g_1'] }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });

  it('control: a writable ledger carries no note on any surface', () => {
    const l = buildGlobalLayout('plain');
    const s = l.store();
    expect(s.recall('deploy').witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(s.currentView().witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });

  it.each(READ_ONLY)('%s: the SessionStart block shows the note first, also when no record is usable', (name) => {
    const l = buildGlobalLayout(name);
    const g = gatherScopedRecords({ home: l.home, globalLedger: l.ledger });
    expect(g.witnessNotes[0]).toBe(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(g.records.map((r) => r.record.id).sort()).toEqual([...l.ids].sort());
    const block = formatSessionStartContext(g.records, 'n'.repeat(32), { witnessNotes: g.witnessNotes });
    expect(block).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });
});

describe('the layouts that stay writable keep writing (4.7, first table, first row and "link가 아닌 경로")', () => {
  it.each(['link-to-file', 'dangling-target-dir-present', 'plain-missing-dir', 'symlinked-ancestor-first-run'] as const)('%s: a commit is stored and read back, with no note', (name) => {
    const l = buildGlobalLayout(name);
    const s = l.store();
    const rec = s.commit({ content: 'a writable layout fact', source: 'user' });
    expect(s.inspect().map((r) => r.record.id)).toContain(rec.id);
    expect(readFileSync(l.ledger, 'utf8')).toContain(rec.id);
    expect(s.recall('writable').witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });
});

describe('a global ledger folder that refuses the lock file keeps the raw errno (design 4.3 step 5: 전역 scope의 같은 오류는 raw errno로 남는다)', () => {
  it.skipIf(process.getuid?.() === 0)('a mode-0555 folder answers the raw EACCES, neither a project text nor the read-only refusal', () => {
    const l = buildGlobalLayout('link-to-file');             // the lock stands beside the link's target, in a folder that is not the home
    const folder = join(l.base, 't');
    chmodSync(folder, 0o555);
    try {
      const e = thrownBy(() => l.store().commit({ content: 'a fact', source: 'user' })) as NodeJS.ErrnoException;
      expect(e.code).toBe('EACCES');
      expect(e.message).not.toMatch(/memory folder cannot be written/);
      expect(isGlobalLedgerReadOnlyError(e)).toBe(false);
    } finally { chmodSync(folder, 0o700); }                  // cleanupLayouts removes the tree
  });
});

describe('what a global write finds when it gets there (4.7 "거부의 위치", G-R7, FW-R7, v-global-03, v-global-08)', () => {
  type WithLock = typeof lockMod.withFileLock;
  /** Runs `plant` once, with the ledger lock held, before the store's callback looks at the path. */
  function armUnderLock(ledger: string, plant: () => void): void {
    const real: WithLock = lockMod.withFileLock;
    let fired = false;
    vi.spyOn(lockMod, 'withFileLock').mockImplementation(((t: string, fn: (ctx: lockMod.LockContext) => unknown, opts?: lockMod.LockOptions) => {
      if (t !== ledger || fired) return real(t, fn, opts);
      fired = true;
      return real(t, (ctx) => { plant(); return fn(ctx); }, opts);
    }) as unknown as WithLock);
  }
  /** Runs `plant` once, right after the store sampled the destination's identity under the lock (no project layer here: that sample is the first call). */
  function armAfterSample(plant: () => void): void {
    const real = pathIdentityMod.fileIdentityAt;
    vi.spyOn(pathIdentityMod, 'fileIdentityAt').mockImplementationOnce((p, o) => { const id = real(p, o); plant(); return id; });
  }
  /** The same bytes under a new inode, so the witness gate in front of the append sees nothing and only the identity differs. */
  const swapFile = (ledger: string): void => { copyFileSync(ledger, `${ledger}.copy`); renameSync(`${ledger}.copy`, ledger); };

  it('the inner function asks again: a path that turned read-only after the early refusal is refused in front of the home, the folder and the lock', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    chmodSync(l.home, 0o755);
    vi.spyOn(globalLedgerMod, 'globalLedgerWriteState').mockImplementationOnce(() => ({ kind: 'writable' }));   // the early refusal in commitScoped asks first
    const lockSpy = vi.spyOn(lockMod, 'withFileLock');
    expect((thrownBy(() => l.store().commit({ content: 'x', source: 'user' })) as Error).message).toBe(refusal('commit'));
    expect(lockSpy).not.toHaveBeenCalled();
    expect(statSync(l.home).mode & 0o777).toBe(0o755);
  });

  it('a file replaced after the identity was sampled: the check after the open refuses with the global text and nothing is written (G-R7)', () => {
    const l = buildGlobalLayout('plain');
    armAfterSample(() => swapFile(l.ledger));
    expect((thrownBy(() => l.store().commit({ content: 'gamma fact', source: 'user' })) as Error).message).toBe(GLOBAL_DESTINATION_CHANGED.commit);
    expect(readFileSync(l.ledger, 'utf8')).not.toContain('gamma fact');
  });

  it('the same for a confirm, and for an erase, whose refusal is typed so that its audit row says rejected', () => {
    const l = buildGlobalLayout('plain');
    armAfterSample(() => swapFile(l.ledger));
    expect((thrownBy(() => l.store().confirm(l.ids[0]!)) as Error).message).toBe(GLOBAL_DESTINATION_CHANGED.confirm);
    const auditPath = join(l.base, 'audit.jsonl');
    armAfterSample(() => swapFile(l.ledger));
    expect(() => handleErase(l.store(), { id: l.ids[0]! }, { auditPath, now: () => NOW })).toThrow(GLOBAL_DESTINATION_CHANGED.erase);
    expect(JSON.parse(readFileSync(auditPath, 'utf8').trim())).toMatchObject({ kind: 'erase', soft: true, outcome: 'rejected' });
  });

  it('a link that took the name after the sample gets the global text, not a raw error with a path (v-global-03)', () => {
    const l = buildGlobalLayout('plain');
    armAfterSample(() => { const moved = `${l.ledger}.moved`; renameSync(l.ledger, moved); symlinkSync(moved, l.ledger); });
    expect((thrownBy(() => l.store().commit({ content: 'gamma fact', source: 'user' })) as Error).message).toBe(GLOBAL_DESTINATION_CHANGED.commit);
    expect(readFileSync(`${l.ledger}.moved`, 'utf8')).not.toContain('gamma fact');
  });

  it('a path that resolves elsewhere under the lock: the global text, and nothing lands in either file', () => {
    const l = buildGlobalLayout('link-to-file');
    const other = join(l.base, 't', 'other.jsonl');
    writeFileSync(other, '');
    const before = readFileSync(l.kernelFile as string);
    armUnderLock(l.ledger, () => { unlinkSync(l.ledger); symlinkSync(other, l.ledger); });
    expect((thrownBy(() => l.store().commit({ content: 'gamma fact', source: 'user' })) as Error).message).toBe(GLOBAL_DESTINATION_CHANGED.commit);
    expect(readFileSync(l.kernelFile as string).equals(before)).toBe(true);
    expect(readFileSync(other, 'utf8')).toBe('');
  });

  it('a path that became read-only under the lock gets the read-only refusal', () => {
    const l = buildGlobalLayout('link-to-file');
    armUnderLock(l.ledger, () => { unlinkSync(l.ledger); symlinkSync(Buffer.concat([Buffer.from(`${l.base}/x`), FF]), l.ledger); });
    const e = thrownBy(() => l.store().commit({ content: 'gamma fact', source: 'user' })) as Error;
    expect(isGlobalLedgerReadOnlyError(e)).toBe(true);
    expect(e.message).toBe(refusal('commit'));
  });
});

describe('the inner function on a host without /proc (Review Focus 2: every write works, nothing is refused because /proc is missing)', () => {
  it('a commit, a confirm, a soft erase and a permanent erase of the global ledger are stored through the unbound route', () => {
    const l = buildGlobalLayout('plain');
    const s = l.store();
    const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
    realFsOps.procFd = { statSync: enoent, readlinkSync: enoent };   // a fresh stub has no memory: its first verification fails
    const opened = vi.spyOn(dirBoundMod, 'openJudgedDir');
    let rec: { id: string };
    try {
      rec = s.commit({ content: 'a fact on a host without proc', source: 'user' });
      expect(s.confirm(rec.id).record.state).toBe('Verified');
      expect(s.erase(l.ids[0]!)).toBe('erased');
      expect(s.erase(l.ids[1]!, { permanent: true })).toBe('erased');
      expect(opened).toHaveBeenCalled();
      expect(new Set(opened.mock.results.map((r) => (r.value as dirBoundMod.JudgedDirOutcome).kind))).toEqual(new Set(['unbound']));
      expect(dirBoundMod.procFdAvailable(realFsOps)).toBe(false);
    } finally { delete realFsOps.procFd; opened.mockRestore(); }
    const live = s.inspect().map((r) => r.record.id);
    expect(live).toContain(rec.id);
    expect(live).not.toContain(l.ids[0]);
    expect(readFileSync(l.ledger, 'utf8')).not.toContain('beta deploy fact');   // the permanent erase's rewrite landed
  });
});

describe('auto-compaction is not attempted (4.7, second table)', () => {
  const ENABLED: CompactionConfig = { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 };
  const FUTURE = '2100-01-01T00:00:00.000Z';

  it('a dirty read-only ledger is left as it is, no failure metric is written, and the once-per-session guard is kept', () => {
    const l = buildGlobalLayout('nonutf8-dir-link', { dirty: true });
    const emitted: CompactionInput[] = [];
    const s = l.store('c', { now: () => FUTURE, compaction: ENABLED, metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } } });
    const before = readFileSync(l.kernelFile as Buffer);
    s.recall('deploy');
    expect(emitted).toEqual([]);
    expect(readFileSync(l.kernelFile as Buffer).equals(before)).toBe(true);
    l.repair();                                                            // the path resolves again; the state is computed per call
    s.commit({ content: 'a fact after the repair', source: 'user' });
    s.recall('deploy');                                                    // a new content key: a MISS, so the trigger is consulted again
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.ok).toBe(true);                                     // the guard was not spent by the read-only call
  });
});

describe('the audit rows of the refusals (4.7 audit row; K)', () => {
  it('a refused erase is recorded as rejected, not indeterminate; confirm and recheck as rejected', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const auditPath = join(l.base, 'audit.jsonl');
    const s = l.store();
    expect(() => handleErase(s, { id: l.ids[0]! }, { auditPath, now: () => NOW })).toThrow(refusal('erase'));
    expect(() => handleConfirm(s, { id: l.ids[0]! }, { auditPath, now: () => NOW })).toThrow(refusal('confirm'));
    expect(() => handleRecheck(s, { id: l.ids[0]!, check: FACT_CHECK(l.base) }, { auditPath, now: () => NOW })).toThrow(refusal('recheck'));
    const rows = readFileSync(auditPath, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ kind: 'erase', soft: true, outcome: 'rejected' });
    expect(rows[1]).toMatchObject({ kind: 'verify', source: 'user', resultState: 'rejected' });
    expect(rows[2]).toMatchObject({ kind: 'verify', source: 'reality-check', resultState: 'rejected' });
  });
});

describe('the state is the path\'s, asked on every call', () => {
  it('a path repaired in the middle of the session is writable again, with no restart', () => {
    const l = buildGlobalLayout('below-dangling-dir-link');
    const s = l.store();
    expect(isGlobalLedgerReadOnlyError(thrownBy(() => s.commit({ content: 'x', source: 'user' })))).toBe(true);
    l.repair();                                                            // mkdir the missing target folder
    const rec = s.commit({ content: 'x fact', source: 'user' });
    expect(s.inspect().map((r) => r.record.id)).toContain(rec.id);
    expect(s.recall('fact').witnessNotes).not.toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
  });
});
