// Third fix batch B1, task A13 (design 4.2, 4.9, 4.10): every site that reads, writes, scans or re-baselines a
// project layer asks the ONE judgement (ownership.ts judgeProjectLayer); nothing keeps a rule of its own.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync, readFileSync, existsSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath, projectDispositionOf, judgeProjectLayer, startupScanDecision, startupScanReadsProject, isOwned } from '../../src/memory/ownership.js';
import { resolveScopeTarget } from '../../src/memory/scope-target.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { resolveProjectDisposition } from '../../scripts/trigger-measure.js';
import { ALIASED_LEDGER_NOTE, UNUSABLE_LEDGER_NOTE } from '../../src/memory/content-frame.js';
import { handleErase } from '../../src/server/handlers.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = '2026-10-01T00:00:00.000Z';
const REC = (id: string): string => JSON.stringify({ id, tx: NOW, validFrom: NOW, validTo: null, type: 'assert', state: 'Fresh', content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal' }) + '\n';
const refusalOf = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return '<no refusal>'; };

// The 4.9 drafts, verbatim (B9 settles the final words once; this task writes them).
const ALIAS_REFUSAL =
  "commit: this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve, so the project layer is disabled here — the write is refused rather than written somewhere else. ' +
  "Ask the user whether to store this fact in global memory, which every project sees, or to replace the link with the project's own file; do not choose for them.";
const UNUSABLE_REFUSAL =
  "commit: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, " +
  "or it is a link to a file that does not hold Helix memory records), so the project layer is disabled here — nothing was written. " +
  "Ask the user whether to store this fact in global memory, which every project sees, or to repair the project's memory file; do not choose for them.";
const ERASE_ALIAS_REFUSAL =
  "erase: this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve — the erase is refused rather than applied somewhere else.';
const ERASE_UNUSABLE_REFUSAL =
  "erase: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, " +
  'or it is a link to a file that does not hold Helix memory records) — nothing was erased.';
const NEW_ALIASED_NOTE =
  "(this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve, and is excluded from results)';

interface W { home: string; global: string; a: string; b: string; store: (root?: string, origin?: 'cwd' | 'ancestor') => MemoryStore }
/** Project A (`a`), another project's folder B (`b`, outside A), a home, the global ledger path. Nothing is adopted. */
function world(): W {
  const home = tmp('jcs-home-'); const a = tmp('jcs-a-'); const b = tmp('jcs-b-');
  const global = join(home, 'memory.jsonl');
  const store = (root = a, origin: 'cwd' | 'ancestor' = 'cwd') =>
    new MemoryStore(global, { home, sessionId: 's', project: { root, ledger: projectLedgerPath(root), origin } });
  return { home, global, a, b, store };
}
const helix = (w: W): void => { mkdirSync(join(w.a, '.helix'), { recursive: true }); };

interface Layout { id: string; adopted: boolean; plant: (w: W) => void; state: 'aliased' | 'unusable'; row: string; cause: string }
const LAYOUTS: Layout[] = [
  { id: 'adopted, the memory path links to a file outside the project (D1)', adopted: true, state: 'aliased', row: '6', cause: 'outside-root',
    plant: (w) => { writeFileSync(join(w.b, 'out.jsonl'), ''); symlinkSync(join(w.b, 'out.jsonl'), projectLedgerPath(w.a)); } },
  { id: 'adopted, the memory file has a second hard link (D6)', adopted: true, state: 'aliased', row: '8', cause: 'hard-link',
    plant: (w) => { writeFileSync(projectLedgerPath(w.a), REC('m_1')); linkSync(projectLedgerPath(w.a), join(w.a, '.helix', 'second.jsonl')); } },
  { id: 'adopted, the memory path links to the existing global ledger (the home is outside the project)', adopted: true, state: 'aliased', row: '6', cause: 'outside-root',
    plant: (w) => { writeFileSync(w.global, ''); symlinkSync(w.global, projectLedgerPath(w.a)); } },
  { id: 'NOT adopted, the memory path links to the existing global ledger (T10-3 retired: no foreign-file text)', adopted: false, state: 'aliased', row: '6', cause: 'outside-root',
    plant: (w) => { writeFileSync(w.global, REC('g_1')); symlinkSync(w.global, projectLedgerPath(w.a)); } },
  { id: 'NOT adopted, `.helix` is a regular file (row 3)', adopted: false, state: 'unusable', row: '3', cause: 'helix-not-directory',
    plant: (w) => { writeFileSync(join(w.a, '.helix'), 'x\n'); } },
  { id: 'NOT adopted, a FIFO stands at the memory path (row 9; never opened)', adopted: false, state: 'unusable', row: '9', cause: 'not-regular',
    plant: (w) => { execFileSync('mkfifo', [projectLedgerPath(w.a)]); } },
  { id: 'NOT adopted, the memory path links to a plain-text file inside the project (row 9a)', adopted: false, state: 'unusable', row: '9a', cause: 'not-ledger-content',
    plant: (w) => { writeFileSync(join(w.a, 'README.md'), '# readme\nsome text\n'); symlinkSync(join(w.a, 'README.md'), projectLedgerPath(w.a)); } },
  { id: 'NOT adopted, a dangling link into a project folder that does not exist (row 10)', adopted: false, state: 'unusable', row: '10', cause: 'target-directory-missing',
    plant: (w) => { symlinkSync(join(w.a, 'nodir', 'new.jsonl'), projectLedgerPath(w.a)); } },
];
function build(l: Layout): W {
  const w = world();
  if (l.adopted) stampOwnership(w.a, w.home, {}); else if (l.state !== 'unusable' || l.row !== '3') helix(w);
  l.plant(w);
  return w;
}

describe('MemoryStore: reads, commit and erase use the judgement, adopted or not', () => {
  for (const l of LAYOUTS) {
    it(`${l.id}: the state, the exclusion from reads, the fixed commit refusal with nothing written`, () => {
      const w = build(l);
      const j = { root: w.a, ledger: projectLedgerPath(w.a), home: w.home, globalLedger: w.global, origin: 'cwd' as const };
      expect(projectDispositionOf(j)).toBe(l.state);
      const s = w.store();
      expect(s.currentView().projectDisposition).toBe(l.state);
      expect(s.recall('fact').projectDisposition).toBe(l.state);
      const globalBefore = existsSync(w.global) ? readFileSync(w.global, 'utf8') : '<absent>';
      expect(refusalOf(() => s.commit({ content: 'a project fact', source: 'user' }))).toBe(l.state === 'aliased' ? ALIAS_REFUSAL : UNUSABLE_REFUSAL);
      expect(refusalOf(() => s.commit({ content: 'a project fact', source: 'user', scope: 'project' }))).toBe(l.state === 'aliased' ? ALIAS_REFUSAL : UNUSABLE_REFUSAL);
      expect(existsSync(w.global) ? readFileSync(w.global, 'utf8') : '<absent>').toBe(globalBefore);   // never widened to global
      if (!l.adopted) { expect(isOwned(w.a, w.home)).toBe(false); expect(existsSync(join(w.a, '.helix', '.owner'))).toBe(false); }
      expect(refusalOf(() => s.erase('m_any', { scope: 'project' }))).toBe(l.state === 'aliased' ? ERASE_ALIAS_REFUSAL : ERASE_UNUSABLE_REFUSAL);
    });

    it(`${l.id}: an explicit global commit goes through and is flagged as bypassing the layer; a no-scope erase reaches only the global ledger`, () => {
      const w = build(l);
      const s = w.store();
      const out = s.commitScoped({ content: 'a fact for every project', source: 'user', scope: 'global' });
      expect(out.scope).toBe('global');
      expect(out.bypassedProject).toBe(l.state);
      expect(() => s.erase(out.record.id)).not.toThrow();
    });
  }

  it('the read-side note names the state: the revised aliased note, and the unusable note', () => {
    expect(ALIASED_LEDGER_NOTE).toBe(NEW_ALIASED_NOTE);
    expect(UNUSABLE_LEDGER_NOTE.startsWith("(this project's memory file cannot be used as it is")).toBe(true);
  });

  it('the write gate reads the link target afresh; the read side answers from the per-process memory (A12, finding v2-judgement-03)', () => {
    const w = world(); stampOwnership(w.a, w.home, {});
    mkdirSync(join(w.a, 'data'));
    const target = join(w.a, 'data', 'mem.jsonl');
    writeFileSync(target, REC('m_1'));
    symlinkSync(target, projectLedgerPath(w.a));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);     // the file counts as settled (older than 2 s)
    const spy = vi.spyOn(ledgerMod, 'ledgerContentKindOfFd');
    const s = w.store();
    expect(s.currentView().projectDisposition).toBe('owned');
    expect(s.currentView().projectDisposition).toBe('owned');
    expect(spy).toHaveBeenCalledTimes(1);                                         // the second read came from memory
    clock.mockRestore();                                                          // the write below runs on the real clock
    const readsBeforeWrite = spy.mock.calls.length;
    expect(s.commitScoped({ content: 'a project fact', source: 'user' }).scope).toBe('project');
    expect(spy.mock.calls.length).toBeGreaterThan(readsBeforeWrite);               // the write gate did not trust the memory
    expect(readFileSync(target, 'utf8')).toContain('a project fact');
  });

  it('a write answers the unusable text when the target stopped being ledger rows (same size, mtime put back)', () => {
    const w = world(); stampOwnership(w.a, w.home, {});
    mkdirSync(join(w.a, 'data'));
    const target = join(w.a, 'data', 'mem.jsonl');
    const text = REC('m_1');
    writeFileSync(target, text);
    symlinkSync(target, projectLedgerPath(w.a));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const s = w.store();
    expect(s.currentView().projectDisposition).toBe('owned');                      // remembered as rows
    clock.mockRestore();
    const before = statSync(target);
    writeFileSync(target, 'x'.repeat(text.length - 1) + '\n');
    utimesSync(target, before.atime, before.mtime);
    expect(statSync(target).size).toBe(before.size);
    expect(refusalOf(() => s.commit({ content: 'a project fact', source: 'user' }))).toBe(UNUSABLE_REFUSAL);
    expect(readFileSync(target, 'utf8')).toBe('x'.repeat(text.length - 1) + '\n'); // nothing was appended
  });
});

describe('decisions 6 and 7 reach the call sites with both readings (spec 14 decision 9)', () => {
  const inTreeLink = (w: W): void => { helix(w); mkdirSync(join(w.a, 'data')); writeFileSync(join(w.a, 'data', 'mem.jsonl'), REC('m_1')); symlinkSync('../data/mem.jsonl', projectLedgerPath(w.a)); };
  const uninspectableGlobal = (w: W): void => { writeFileSync(join(w.home, 'kept.jsonl'), ''); symlinkSync('kept.jsonl/', w.global); };   // the kernel answers ENOTDIR
  const desc = (w: W) => ({ root: w.a, ledger: projectLedgerPath(w.a), home: w.home, globalLedger: w.global, origin: 'cwd' as const });

  it('an UNINSPECTABLE global ledger counts as "cannot be resolved": an in-tree link is aliased at the store and at the ceremony', () => {
    const w = world(); inTreeLink(w); uninspectableGlobal(w);
    expect(judgeProjectLayer(desc(w))).toMatchObject({ state: 'aliased', row: '7', cause: 'unjudgeable-target' });
    expect(refusalOf(() => w.store().commit({ content: 'a project fact', source: 'user', scope: 'project' }))).toBe(ALIAS_REFUSAL);
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: false, reason: 'aliased', cause: 'unjudgeable-target' });
    expect(readFileSync(join(w.a, 'data', 'mem.jsonl'), 'utf8')).toBe(REC('m_1'));
  });

  it('with the same global ledger the project\'s own memory file is exempt: the disposition and the ceremony keep it', () => {
    const w = world(); stampOwnership(w.a, w.home, {}); writeFileSync(projectLedgerPath(w.a), REC('m_1')); uninspectableGlobal(w);
    expect(projectDispositionOf(desc(w))).toBe('owned');
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: true });
  });

  it('a project inside HELIX_HOME writes its own file: the commit is stored there (the home rule leaves the own path alone)', () => {
    const home = tmp('jcs-home-'); const root = join(home, 'work', 'proj'); mkdirSync(join(root, '.helix'), { recursive: true });
    stampOwnership(root, home, {});
    const s = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', project: { root, ledger: projectLedgerPath(root), origin: 'cwd' } });
    expect(s.commitScoped({ content: 'a project fact', source: 'user' }).scope).toBe('project');
    expect(readFileSync(projectLedgerPath(root), 'utf8')).toContain('a project fact');
  });

  it('a link inside the root that reaches a home file stays aliased, at the store and at the ceremony, and the home file is untouched', () => {
    const w = world(); const home = join(w.a, 'inner', 'home'); mkdirSync(home, { recursive: true });
    const audit = join(home, 'audit.jsonl'); writeFileSync(audit, ''); helix(w); symlinkSync(audit, projectLedgerPath(w.a));
    const g = join(home, 'memory.jsonl');
    const s = new MemoryStore(g, { home, sessionId: 's', project: { root: w.a, ledger: projectLedgerPath(w.a), origin: 'cwd' } });
    expect(refusalOf(() => s.commit({ content: 'a project fact', source: 'user', scope: 'project' }))).toBe(ALIAS_REFUSAL);
    expect(resolveScopeTarget(home, g, w.a)).toMatchObject({ ok: false, reason: 'aliased', cause: 'home-directory' });
    expect(readFileSync(audit, 'utf8')).toBe('');
  });
});

describe('a no-scope erase never reaches an excluded layer (rulings D3, row R11)', () => {
  it('an unusable layer whose excluded file holds the id: the MCP erase answers "no memory has id" and the file is unchanged', () => {
    const w = world(); stampOwnership(w.a, w.home, {});
    mkdirSync(join(w.a, 'data'));
    const target = join(w.a, 'data', 'mem.jsonl');
    const text = 'x\n'.repeat(600_000) + REC('m_1');                               // the one record lies past the first MiB: row 9a
    writeFileSync(target, text);
    symlinkSync(target, projectLedgerPath(w.a));
    const s = w.store();
    expect(s.currentView().projectDisposition).toBe('unusable');
    expect(refusalOf(() => handleErase(s, { id: 'm_1' }, { auditPath: join(w.home, 'audit.jsonl') })))
      .toBe(`erase: no memory has id "m_1" — nothing was erased; take a record's id from its PROOF line (helix_memory_recall or helix_memory_inspect)`);
    expect(readFileSync(target, 'utf8')).toBe(text);
  });
});

describe('the SessionStart gather uses the same judgement', () => {
  for (const l of LAYOUTS) {
    it(`${l.id}: the hook reports ${l.state} and reads no project row`, () => {
      const w = build(l);
      const r = gatherScopedRecords({ home: w.home, globalLedger: w.global, cwd: w.a, userHome: tmp('jcs-uh-') });
      expect(r.projectDisposition).toBe(l.state);
      expect(r.records.filter((x) => x.scope === 'project')).toEqual([]);
    });
  }
});

describe('startupScanDecision: M41, the scan reads only a file that passed rows 4 to 10, and the row-9 line is kept', () => {
  const decide = (w: W, origin: 'cwd' | 'ancestor' = 'cwd') => startupScanDecision({ root: w.a, ledger: projectLedgerPath(w.a), origin }, w.home, w.global);
  it.each([
    ['an owned project with its own file', (w: W) => { stampOwnership(w.a, w.home, {}); writeFileSync(projectLedgerPath(w.a), REC('m_1')); }, { read: true, notRegular: false }],
    ['an unadopted project with a foreign file (scanned as before)', (w: W) => { helix(w); writeFileSync(projectLedgerPath(w.a), REC('f_1')); }, { read: true, notRegular: false }],
    ['an unadopted project with an empty .helix (nothing to scan, nothing skipped)', (w: W) => { helix(w); }, { read: true, notRegular: false }],
    ['an owned project that links outside the project', (w: W) => { stampOwnership(w.a, w.home, {}); writeFileSync(join(w.b, 'o.jsonl'), REC('b_1')); symlinkSync(join(w.b, 'o.jsonl'), projectLedgerPath(w.a)); }, { read: false, notRegular: false }],
    ['an unadopted project whose memory file has a second hard link (read as its own file before)', (w: W) => { helix(w); writeFileSync(projectLedgerPath(w.a), REC('f_1')); linkSync(projectLedgerPath(w.a), join(w.a, '.helix', 'second.jsonl')); }, { read: false, notRegular: false }],
    ['a link to a plain-text file inside the project (row 9a: no line)', (w: W) => { helix(w); writeFileSync(join(w.a, 'README.md'), 'text\n'); symlinkSync(join(w.a, 'README.md'), projectLedgerPath(w.a)); }, { read: false, notRegular: false }],
    ['a FIFO at the memory path (row 9: the one line is kept, the file is never opened)', (w: W) => { helix(w); execFileSync('mkfifo', [projectLedgerPath(w.a)]); }, { read: false, notRegular: true }],
    ['a link to a FIFO inside the project (row 9)', (w: W) => { helix(w); mkdirSync(join(w.a, 'data')); execFileSync('mkfifo', [join(w.a, 'data', 'pipe')]); symlinkSync(join(w.a, 'data', 'pipe'), projectLedgerPath(w.a)); }, { read: false, notRegular: true }],
    ['a link to a FIFO outside the project (row 6 decides first: no line; the old scan printed one)', (w: W) => { helix(w); execFileSync('mkfifo', [join(w.b, 'pipe')]); symlinkSync(join(w.b, 'pipe'), projectLedgerPath(w.a)); }, { read: false, notRegular: false }],
  ] as const)('%s', (_label, plant, want) => {
    const w = world(); plant(w);
    expect(decide(w)).toEqual(want);
    expect(startupScanReadsProject({ root: w.a, ledger: projectLedgerPath(w.a) }, w.home, w.global)).toBe(want.read);
  });
  it('an unadopted PARENT project is never read, whatever stands at its memory path', () => {
    const w = world(); helix(w); execFileSync('mkfifo', [projectLedgerPath(w.a)]);
    expect(decide(w, 'ancestor')).toEqual({ read: false, notRegular: false });
  });
});

describe('resolveScopeTarget: the two ceremonies refuse by the judgement\'s cause (design 4.10)', () => {
  it('the memory path IS the global ledger entry (.helix is the home): aliases-global / global-store, destination = where the global ledger lands', () => {
    const root = tmp('jcs-root-'); const home = join(root, '.helix'); mkdirSync(home);
    const g = join(home, 'memory.jsonl');
    expect(resolveScopeTarget(home, g, root)).toMatchObject({ ok: false, reason: 'aliases-global', cause: 'global-store', ledger: g, destination: g });
  });
  it('a link out of the project: aliased / outside-root, and `destination` names the file the kernel reaches, not the link', () => {
    const w = world(); helix(w); writeFileSync(join(w.b, 'o.jsonl'), ''); symlinkSync(join(w.b, 'o.jsonl'), projectLedgerPath(w.a));
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: false, reason: 'aliased', cause: 'outside-root', ledger: projectLedgerPath(w.a), destination: join(w.b, 'o.jsonl') });
  });
  it('a link to the global ledger with the home INSIDE the project (row 7): aliases-global / global-ledger', () => {
    const w = world(); const home = join(w.a, 'inner', 'home'); mkdirSync(home, { recursive: true }); const g = join(home, 'memory.jsonl'); writeFileSync(g, '');
    helix(w); symlinkSync(g, projectLedgerPath(w.a));
    expect(resolveScopeTarget(home, g, w.a)).toMatchObject({ ok: false, reason: 'aliases-global', cause: 'global-ledger' });
  });
  it('a link to a registered project nested INSIDE this one (row 7): aliases-project / other-project', () => {
    const w = world(); const nested = join(w.a, 'nested', 'projB'); mkdirSync(nested, { recursive: true });
    stampOwnership(nested, w.home, {}); writeFileSync(projectLedgerPath(nested), '');
    helix(w); symlinkSync(projectLedgerPath(nested), projectLedgerPath(w.a));
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: false, reason: 'aliases-project', cause: 'other-project' });
  });
  it.each([
    ['a second hard link', (w: W) => { helix(w); writeFileSync(projectLedgerPath(w.a), ''); linkSync(projectLedgerPath(w.a), join(w.a, '.helix', 'second.jsonl')); }, { reason: 'aliased', cause: 'hard-link' }],
    ['.helix is a regular file', (w: W) => { writeFileSync(join(w.a, '.helix'), 'x\n'); }, { reason: 'unusable', cause: 'helix-not-directory' }],
    ['a FIFO at the memory path', (w: W) => { helix(w); execFileSync('mkfifo', [projectLedgerPath(w.a)]); }, { reason: 'unusable', cause: 'not-regular' }],
  ] as const)('%s', (_label, plant, want) => {
    const w = world(); plant(w);
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: false, ...want });
  });
  it('a project nobody adopted, with a foreign file or with nothing yet, is not refused (the ceremony of an unadopted project is not this function\'s to refuse)', () => {
    const w = world(); helix(w); writeFileSync(projectLedgerPath(w.a), REC('f_1'));
    expect(resolveScopeTarget(w.home, w.global, w.a)).toMatchObject({ ok: true, destination: join(w.a, '.helix', 'memory.jsonl') });
  });
});

describe('the helix-trigger copy of the rule is gone: the sink keeps three values (design 4.2)', () => {
  it.each([
    ['no .helix at all', (_w: W) => {}, 'absent'],
    ['owned, its own regular file', (w: W) => { stampOwnership(w.a, w.home, {}); writeFileSync(projectLedgerPath(w.a), REC('m_1')); }, 'owned'],
    ['owned, the memory path links out of the project (the old copy said owned)', (w: W) => { stampOwnership(w.a, w.home, {}); writeFileSync(join(w.b, 'o.jsonl'), REC('b_1')); symlinkSync(join(w.b, 'o.jsonl'), projectLedgerPath(w.a)); }, 'unowned'],
    ['owned, the memory file has a second hard link (the old copy said owned)', (w: W) => { stampOwnership(w.a, w.home, {}); writeFileSync(projectLedgerPath(w.a), REC('m_1')); linkSync(projectLedgerPath(w.a), join(w.a, '.helix', 'second.jsonl')); }, 'unowned'],
    ['unusable: .helix is a regular file', (w: W) => { writeFileSync(join(w.a, '.helix'), 'x\n'); }, 'unowned'],
    ['unusable: a FIFO at the memory path', (w: W) => { helix(w); execFileSync('mkfifo', [projectLedgerPath(w.a)]); }, 'unowned'],
    ['unadopted with a foreign file', (w: W) => { helix(w); writeFileSync(projectLedgerPath(w.a), REC('f_1')); }, 'unowned'],
  ] as const)('%s', (_label, plant, want) => {
    const w = world(); plant(w);
    expect(resolveProjectDisposition(w.a, w.home, w.global)).toBe(want);
  });
});
