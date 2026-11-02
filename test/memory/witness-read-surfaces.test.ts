// Third fix batch B1, task A15 (design 4.8 and D9): witness.json objects x operations, through the real store.
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, chmodSync, lstatSync, realpathSync, rmSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { compactLedger } from '../../src/memory/ledger.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { isWitnessUnusableError } from '../../src/memory/witness-store.js';
import { WITNESS_FILE_UNUSABLE_NOTE, WITNESS_INIT_NOTE } from '../../src/memory/content-frame.js';

const isRoot = process.getuid?.() === 0;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const AS_OF = '2026-10-02T00:00:00.000Z';
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

interface Fx { base: string; home: string; proj: string; gl: string; pl: string; W: string; ids: Record<'g1' | 'g2' | 'g3' | 'p1' | 'p2', string>; mk: () => MemoryStore }
function build(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wr-')));
  const home = `${base}/home`; mkdirSync(home, { mode: 0o700 });
  const proj = `${base}/proj`; mkdirSync(`${proj}/.helix`, { recursive: true });
  const gl = `${home}/memory.jsonl`; const pl = `${proj}/.helix/memory.jsonl`;
  let n = 0; let k = 0;
  const mk = (): MemoryStore => new MemoryStore(gl, {
    home, sessionId: 't', now: () => new Date(T0 + (k++) * 1000).toISOString(), genId: () => `m_${++n}`,
    project: { ledger: pl, root: proj, origin: 'cwd' },
  });
  const s = mk(); const ids = {} as Fx['ids'];
  ids.g1 = s.commit({ content: 'alpha global fact one', source: 'user', scope: 'global' }).id; s.confirm(ids.g1);
  ids.g2 = s.commit({ content: 'bravo global fact two', source: 'user', scope: 'global' }).id;
  ids.g3 = s.commit({ content: 'api base /v2/users in app.json', source: 'user-relayed', scope: 'global' }).id;
  ids.p1 = s.commit({ content: 'charlie project fact', source: 'user', scope: 'project' }).id; s.confirm(ids.p1);
  ids.p2 = s.commit({ content: 'delta project fact', source: 'user', scope: 'project' }).id;
  writeFileSync(`${base}/app.json`, 'base /v2/users');
  return { base, home, proj, gl, pl, W: `${home}/witness.json`, ids, mk };
}
const swap = (fx: Fx, f: (w: string) => void): void => { unlinkSync(fx.W); f(fx.W); };
const damaged = (fx: Fx, f: (g: any) => void): void => { const c = JSON.parse(readFileSync(fx.W, 'utf8')); f(c.scopes['@global']); writeFileSync(fx.W, JSON.stringify(c)); };

const UNUSABLE: Array<{ name: string; skip?: boolean; plant: (fx: Fx) => void | Promise<void> }> = [
  { name: 'link to a JSON file of the home', plant: (fx) => { writeFileSync(`${fx.home}/config.json`, '{"metrics":{"enabled":false}}'); swap(fx, (w) => symlinkSync(`${fx.home}/config.json`, w)); } },
  { name: 'link to the registry', plant: (fx) => swap(fx, (w) => symlinkSync(`${fx.home}/projects.json`, w)) },
  { name: 'link to the global ledger', plant: (fx) => swap(fx, (w) => symlinkSync(fx.gl, w)) },
  { name: 'link to another home\'s witness file', plant: (fx) => {
      const h2 = `${fx.base}/home2`; mkdirSync(h2, { mode: 0o700 }); let m = 0;
      new MemoryStore(`${h2}/memory.jsonl`, { home: h2, sessionId: 't2', now: () => new Date(T0).toISOString(), genId: () => `o_${++m}` }).commit({ content: 'other home fact', source: 'user' });
      swap(fx, (w) => symlinkSync(`${h2}/witness.json`, w)); } },
  { name: 'dangling link into an existing folder', plant: (fx) => { mkdirSync(`${fx.home}/sub`); swap(fx, (w) => symlinkSync(`${fx.home}/sub/w.json`, w)); } },
  { name: 'dangling link into a missing folder', plant: (fx) => swap(fx, (w) => symlinkSync(`${fx.home}/nodir/w.json`, w)) },
  { name: 'link to a directory', plant: (fx) => { mkdirSync(`${fx.home}/sub`); swap(fx, (w) => symlinkSync(`${fx.home}/sub`, w)); } },
  { name: 'directory', plant: (fx) => swap(fx, (w) => mkdirSync(w)) },
  { name: 'socket', plant: async (fx) => { unlinkSync(fx.W); const s = createServer(); servers.push(s); await new Promise<void>((r) => s.listen(fx.W, r)); } },
  { name: 'mode 000', skip: isRoot, plant: (fx) => chmodSync(fx.W, 0o000) },
  { name: 'empty file', plant: (fx) => writeFileSync(fx.W, '') },
  { name: 'not JSON', plant: (fx) => writeFileSync(fx.W, 'this is not json at all {{{') },
  { name: 'v is 2', plant: (fx) => writeFileSync(fx.W, JSON.stringify({ v: 2, scopes: {} })) },
  { name: 'scopes is a string', plant: (fx) => writeFileSync(fx.W, JSON.stringify({ v: 1, scopes: 'nope' })) },
  { name: 'scopes is null', plant: (fx) => writeFileSync(fx.W, JSON.stringify({ v: 1, scopes: null })) },
  { name: 'scopes is an array', plant: (fx) => writeFileSync(fx.W, JSON.stringify({ v: 1, scopes: [] })) },
  { name: 'scopes is missing', plant: (fx) => writeFileSync(fx.W, JSON.stringify({ v: 1 })) },
];
const CONTROLS: Array<{ name: string; plant: (fx: Fx) => void }> = [
  { name: 'absent', plant: (fx) => unlinkSync(fx.W) },
  { name: 'valid', plant: () => {} },
  { name: 'entry without mac', plant: (fx) => damaged(fx, (g) => { delete g.entry.mac; }) },
  { name: 'entry with a wrong-typed epoch', plant: (fx) => damaged(fx, (g) => { g.entry.epoch = 'one'; }) },
  { name: 'entry is a scalar', plant: (fx) => damaged(fx, (g) => { g.entry = 42; }) },
  { name: 'entry with a wrong mac', plant: (fx) => damaged(fx, (g) => { g.entry.mac = (g.entry.mac[0] === '0' ? '1' : '0') + g.entry.mac.slice(1); }) },
];

/** What a refused write must leave as it was. */
function snapshot(fx: Fx): string {
  const at = (p: string): string => {
    let st; try { st = lstatSync(p, { bigint: true }); } catch (e) { return `absent(${(e as NodeJS.ErrnoException).code})`; }
    if (st.isSymbolicLink()) return `link->${readlinkSync(p)}`;
    if (!st.isFile()) return `object ino=${st.ino}`;
    try { return `file ino=${st.ino} ${readFileSync(p).toString('base64')}`; } catch { return `file ino=${st.ino} unreadable`; }
  };
  let dest = '-'; try { if (lstatSync(fx.W).isSymbolicLink()) dest = at(readlinkSync(fx.W)); } catch { /* none */ }
  return JSON.stringify({ gl: at(fx.gl), pl: at(fx.pl), w: at(fx.W), dest, registry: at(`${fx.home}/projects.json`), config: at(`${fx.home}/config.json`),
    home: readdirSync(fx.home).sort(), projDir: readdirSync(`${fx.proj}/.helix`).sort() });
}
const elevated = (states: string[]): boolean => states.some((s) => s === 'Verified' || s === 'Corroborated');
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

type Read = { states: string[]; notes: string[] };
const READS: Record<string, (fx: Fx) => Read> = {
  recall: (fx) => { const r = fx.mk().recall('alpha charlie fact'); return { states: [...r.items, ...r.appendix].map((i) => i.record.state), notes: r.witnessNotes }; },
  inspect: (fx) => { const v = fx.mk().currentView(); return { states: v.records.map((x) => x.record.state), notes: v.witnessNotes }; },
  'inspect history': (fx) => { const v = fx.mk().historyView(); return { states: v.rows.filter((r) => r.closedBy === null).map((r) => r.record.state), notes: v.witnessNotes }; },
  hook: (fx) => { const g = gatherScopedRecords({ home: fx.home, globalLedger: fx.gl, cwd: fx.proj, userHome: fx.base }); return { states: g.records.map((x) => x.record.state), notes: g.witnessNotes }; },
};
const WRITES: Record<string, (fx: Fx) => unknown> = {
  'commit global': (fx) => fx.mk().commit({ content: 'echo new global fact', source: 'user', scope: 'global' }),
  'commit project': (fx) => fx.mk().commit({ content: 'foxtrot new project fact', source: 'user', scope: 'project' }),
  'erase soft': (fx) => fx.mk().erase(fx.ids.g2),
  'erase permanent': (fx) => fx.mk().erase(fx.ids.g2, { permanent: true, scope: 'global' }),
  confirm: (fx) => fx.mk().confirm(fx.ids.g2),
  recheck: (fx) => { const cwd = process.cwd(); process.chdir(fx.base); try { return fx.mk().recheck(fx.ids.g3, { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' }); } finally { process.chdir(cwd); } },
  compaction: (fx) => compactLedger(fx.gl, { erasedIds: new Set(), keepValidVerify: () => true, provesKey: () => true, witness: { home: fx.home, scopeKey: '@global', now: () => new Date(T0 + 3_600_000).toISOString(), kind: 'compaction' } }),
};

describe('the fixture proves the clamp can be seen: with a valid witness file the grades are elevated', () => {
  it('valid: recall, inspect, history and the hook all show a Verified record and no witness note about the file', () => {
    const fx = build();
    for (const [name, read] of Object.entries(READS)) {
      const r = read(fx);
      expect(elevated(r.states), name).toBe(true);
      expect(r.notes, name).not.toContain(WITNESS_FILE_UNUSABLE_NOTE);
    }
    rmSync(fx.base, { recursive: true, force: true });
  });
});

describe('an unusable witness file: reads show Fresh only with the fixed note; writes are refused and change nothing (D9)', () => {
  const cells = UNUSABLE.filter((o) => !o.skip).map((o) => [o.name, o] as const);
  describe.each(cells)('%s', (_name, o) => {
    it.each(Object.keys(READS))('read: %s', async (op) => {
      const fx = build(); await o.plant(fx);
      const r = READS[op]!(fx);
      expect(r.states.length).toBeGreaterThan(0);
      expect(elevated(r.states)).toBe(false);                                           // every grade is limited to Fresh
      expect(r.notes.filter((x) => x === WITNESS_FILE_UNUSABLE_NOTE)).toHaveLength(1);   // the fixed note, once
      expect(r.notes).not.toContain(WITNESS_INIT_NOTE);                                  // it REPLACES the first-contact note (that one promises a baseline at the next write)
      rmSync(fx.base, { recursive: true, force: true });
    });
    it('read: inspect as-of serves its facts and carries no witness note for that scope (W-R2)', async () => {
      const fx = build(); await o.plant(fx);
      const v = fx.mk().asOfView(AS_OF);
      expect(v.facts.length).toBeGreaterThan(0);
      expect(v.witnessNotes).toEqual([]);
      rmSync(fx.base, { recursive: true, force: true });
    });
    it.each(Object.keys(WRITES))('write: %s is refused with the witness refusal and nothing changes', async (op) => {
      const fx = build(); await o.plant(fx);
      const before = snapshot(fx);
      const e = thrown(() => WRITES[op]!(fx));
      expect(isWitnessUnusableError(e), `${op} threw ${String(e)}`).toBe(true);
      expect(snapshot(fx)).toBe(before);
      rmSync(fx.base, { recursive: true, force: true });
    });
    it('heal returns and changes nothing', async () => {
      const fx = build(); await o.plant(fx);
      const before = snapshot(fx);
      fx.mk().healWitness();
      expect(snapshot(fx)).toBe(before);
      rmSync(fx.base, { recursive: true, force: true });
    });
  });
});

describe('a witness file that is usable, or damaged only inside one scope\'s entry, is not the witness refusal (the controls)', () => {
  describe.each(CONTROLS.map((o) => [o.name, o] as const))('%s', (_name, o) => {
    it.each(Object.keys(READS))('read: %s carries no note about the file', (op) => {
      const fx = build(); o.plant(fx);
      expect(READS[op]!(fx).notes).not.toContain(WITNESS_FILE_UNUSABLE_NOTE);
      rmSync(fx.base, { recursive: true, force: true });
    });
    it.each(Object.keys(WRITES))('write: %s is not refused by the witness check', (op) => {
      const fx = build(); o.plant(fx);
      expect(isWitnessUnusableError(thrown(() => WRITES[op]!(fx)))).toBe(false);
      rmSync(fx.base, { recursive: true, force: true });
    });
  });
});

describe('the gate of a rewrite names the rewrite (the op travels into the refusal)', () => {
  it('compactLedger over an unusable file is refused with "compaction:" in front', () => {
    const fx = build(); writeFileSync(fx.W, 'garbage {');
    const e = thrown(() => WRITES.compaction!(fx)) as Error;
    expect(isWitnessUnusableError(e)).toBe(true);
    expect(e.message.startsWith('compaction: the rollback-witness file cannot be used')).toBe(true);
    rmSync(fx.base, { recursive: true, force: true });
  });
});
