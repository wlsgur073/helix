// Third fix batch B1, task A3 (design 4.2 rows 4 and 5; 14: decision 8, RR-1): a memory path the resolver cannot
// resolve is `aliased` (row 4); one it cannot inspect is `unusable` (row 5). Adopted or not, nothing is stamped.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath, projectDispositionOf, startupScanReadsProject, judgeProjectLayer } from '../../src/memory/ownership.js';
import { resolveScopeTarget } from '../../src/memory/scope-target.js';
import { UNUSABLE_LEDGER_NOTE } from '../../src/memory/content-frame.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { handleRecall } from '../../src/server/handlers.js';

const FF = Buffer.from([0xff]);
const text = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('');
const messageOf = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return '<no refusal>'; };

/** 4.9 drafts, verbatim. */
const UNUSABLE_COMMIT_REFUSAL =
  "commit: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory records), so the project layer is disabled here — nothing was written. Ask the user whether to store this fact in global memory, which every project sees, or to repair the project's memory file; do not choose for them.";
const UNUSABLE_ERASE_REFUSAL =
  "erase: this project's memory file cannot be used as it is (it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory records) — nothing was erased.";
const UNUSABLE_NOTE =
  "(this project's memory file cannot be used as it is: it is not a regular file, it or its folder cannot be read, that folder is missing or not a directory, or it is a link to a file that does not hold Helix memory records; project memory is off for this session)";

type Row = 4 | 5;
/** A project whose `.helix` exists. Row 4: the memory file is a link whose body is not valid UTF-8 (the target exists).
 *  Row 5: the memory file is a link whose body ends in a slash over a regular file (the kernel answers ENOTDIR). */
function layer(row: Row, adopted: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'helix-r45-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'helix-r45-proj-')));
  mkdirSync(join(root, '.helix'));
  if (adopted) stampOwnership(root, home, {});
  const ledger = projectLedgerPath(root);
  if (row === 4) { const t = Buffer.concat([Buffer.from(`${root}/t-`), FF, Buffer.from('.jsonl')]); writeFileSync(t, ''); symlinkSync(t, ledger); }
  else { writeFileSync(join(root, '.helix', 'real.jsonl'), ''); symlinkSync('real.jsonl/', ledger); }
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', project: { root, ledger, origin: 'cwd' } });
  return { home, root, ledger, store, desc: { root, home, ledger, globalLedger: join(home, 'memory.jsonl') } };
}
const EXPECT: Record<Row, 'aliased' | 'unusable'> = { 4: 'aliased', 5: 'unusable' };

describe('rows 4 and 5 decide the disposition, adopted or not', () => {
  it.each([[4, true], [4, false], [5, true], [5, false]] as const)('row %i, adopted %s', (row, adopted) => {
    const l = layer(row, adopted);
    expect(judgeProjectLayer(l.desc).row).toBe(String(row));
    expect(projectDispositionOf(l.desc)).toBe(EXPECT[row]);
    expect(startupScanReadsProject({ root: l.root, ledger: l.ledger }, l.home, join(l.home, 'memory.jsonl'))).toBe(false);
  });

  it('controls: a plain adopted project is owned, a plain unadopted one with a file is unadopted-present', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-r45-home-'));
    const a = realpathSync(mkdtempSync(join(tmpdir(), 'helix-r45-proj-'))); stampOwnership(a, home, {});
    expect(projectDispositionOf({ root: a, home, ledger: projectLedgerPath(a), globalLedger: join(home, 'memory.jsonl') })).toBe('owned');
    const u = realpathSync(mkdtempSync(join(tmpdir(), 'helix-r45-proj-'))); mkdirSync(join(u, '.helix')); writeFileSync(projectLedgerPath(u), '');
    expect(projectDispositionOf({ root: u, home, ledger: projectLedgerPath(u), globalLedger: join(home, 'memory.jsonl') })).toBe('unadopted-present');
  });

  it('an unadopted ANCESTOR project is still ancestor-unadopted first (row 2 precedes rows 4 and 5)', () => {
    const l = layer(5, false);
    expect(projectDispositionOf({ ...l.desc, origin: 'ancestor' })).toBe('ancestor-unadopted');
  });
});

describe('row 5 (unusable): reads, writes and notes', () => {
  it('the layer is left out of reads and the note renders on recall and in the SessionStart block', () => {
    const l = layer(5, true);
    l.store.commit({ content: 'a global fact', source: 'user', scope: 'global' });
    expect(l.store.currentView().projectDisposition).toBe('unusable');
    expect(UNUSABLE_LEDGER_NOTE).toBe(UNUSABLE_NOTE);
    expect(text(handleRecall(l.store, { query: 'global fact' }))).toContain(UNUSABLE_NOTE);
    expect(formatSessionStartContext([], 'n'.repeat(32), { unusablePresent: true })).toContain(UNUSABLE_NOTE);
  });

  it.each([[true], [false]] as const)('a project-routed commit is refused with the 4.9 text; nothing is stamped or created (adopted %s)', (adopted) => {
    const l = layer(5, adopted);
    expect(messageOf(() => l.store.commit({ content: 'a fact for the project', source: 'user' }))).toBe(UNUSABLE_COMMIT_REFUSAL);
    expect(readdirSync(join(l.root, '.helix')).sort()).toEqual(adopted ? ['.owner', 'memory.jsonl', 'real.jsonl'] : ['memory.jsonl', 'real.jsonl']);
    if (!adopted) expect(existsSync(join(l.home, 'projects.json'))).toBe(false);
  });

  it('an explicit global commit stores, and reports the layer as bypassed with the existing notice', () => {
    const l = layer(5, true);
    const out = l.store.commitScoped({ content: 'a global fact', source: 'user', scope: 'global' });
    expect(out.scope).toBe('global');
    expect(out.bypassedProject).toBe('unusable');
  });

  it("erase with scope 'project' is refused with the 4.9 text", () => {
    const l = layer(5, true);
    expect(messageOf(() => l.store.erase('m_1', { scope: 'project' }))).toBe(UNUSABLE_ERASE_REFUSAL);
  });

  it('resolveScopeTarget (the rebaseline CLI) names the cause: unusable for row 5, aliased for row 4', () => {
    const l5 = layer(5, true); const l4 = layer(4, true);
    expect(resolveScopeTarget(l5.home, join(l5.home, 'memory.jsonl'), l5.root)).toMatchObject({ ok: false, reason: 'unusable' });
    expect(resolveScopeTarget(l4.home, join(l4.home, 'memory.jsonl'), l4.root)).toMatchObject({ ok: false, reason: 'aliased', cause: 'unresolvable' });
  });
});

describe('row 4 (aliased): an unadopted layer is refused before anything is stamped', () => {
  it('the commit is refused with the alias refusal (cause clause: a path Helix cannot resolve), nothing stamped', () => {
    const l = layer(4, false);
    expect(messageOf(() => l.store.commit({ content: 'a fact for the project', source: 'user' }))).toMatch(/through a path Helix cannot resolve/);
    expect(existsSync(join(l.home, 'projects.json'))).toBe(false);
    expect(existsSync(join(l.root, '.helix', '.owner'))).toBe(false);
  });
});
