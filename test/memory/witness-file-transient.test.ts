// Third fix batch B1, task A15 (D9, sixth item; W-R6): EMFILE, ENFILE and EINTR fail THAT call, say nothing about removing the
// file, and are not latched. The mock throws only for a path that ends in /witness.json while armed.
import { describe, it, expect, vi } from 'vitest';
const fault = vi.hoisted(() => ({ code: null as string | null, skip: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (p: unknown, ...rest: unknown[]) => {
      if (fault.code !== null && typeof p === 'string' && p.endsWith('/witness.json')) {
        if (fault.skip > 0) fault.skip--;
        else throw Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
      }
      return (real.openSync as (...a: unknown[]) => number)(p, ...rest);
    },
  };
});
import { mkdirSync, mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { WITNESS_READ_TRANSIENT_NOTE } from '../../src/memory/content-frame.js';
import { advanceWitness, readScopeWitness, witnessPath, isWitnessUnusableError, WITNESS_READ_AS_GIVEN, type WitnessUnusableError } from '../../src/memory/witness-store.js';
import { MemoryStore } from '../../src/memory/store.js';

const A = Buffer.from('row-a\n');
const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const home = (): string => { const h = realpathSync(mkdtempSync(join(tmpdir(), 'wt-'))); advanceWitness(h, '@global', A, 'tx-a'); return h; };

describe.each(['EMFILE', 'ENFILE', 'EINTR'])('%s while the witness file is opened', (code) => {
  it('a read and a write each fail once with the transient text (no advice to remove the file), leave the file alone, and the next call works', () => {
    const h = home(); const before = readFileSync(witnessPath(h), 'utf8');
    fault.code = code;
    try {
      for (const call of [() => readScopeWitness(h, '@global'), () => readScopeWitness(h, '@global', WITNESS_READ_AS_GIVEN), () => advanceWitness(h, '@global', A, 'tx-b')]) {
        const e = thrown(call) as WitnessUnusableError;
        expect(isWitnessUnusableError(e)).toBe(true); expect(e.reason).toBe('transient');
        expect(e.message).toMatch(/could not be read at this moment/);
        expect(e.message).not.toMatch(/remove|restore/i);
      }
    } finally { fault.code = null; }
    expect(readFileSync(witnessPath(h), 'utf8')).toBe(before);
    expect(readScopeWitness(h, '@global').entry!.headTx).toBe('tx-a');     // nothing latched
    advanceWitness(h, '@global', A, 'tx-b');
    expect(readScopeWitness(h, '@global').entry!.headTx).toBe('tx-b');
  });

  it('a recall fails once and the next recall is ordinary', () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'wt-'))); let n = 0;
    const s = new MemoryStore(join(h, 'memory.jsonl'), { home: h, sessionId: 't', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}` });
    s.commit({ content: 'alpha fact', source: 'user' });
    fault.code = code;
    try { expect(() => s.recall('alpha')).toThrow(/could not be read at this moment/); } finally { fault.code = null; }
    expect(s.recall('alpha').items.length).toBe(1);
  });

  it('the SessionStart gather: a fault on the project read keeps the global records and says so; a fault on the global read still throws, so main prints no block (W-R6, v-witness-05)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-'))); const home = join(base, 'home'); mkdirSync(home, { mode: 0o700 });
    const proj = join(base, 'proj'); mkdirSync(join(proj, '.helix'), { recursive: true });
    const gl = join(home, 'memory.jsonl'); const pl = join(proj, '.helix', 'memory.jsonl'); let n = 0;
    const s = new MemoryStore(gl, { home, sessionId: 't', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}`, project: { ledger: pl, root: proj, origin: 'cwd' } });
    s.commit({ content: 'alpha global fact', source: 'user', scope: 'global' });
    s.commit({ content: 'bravo project fact', source: 'user', scope: 'project' });
    const gather = () => gatherScopedRecords({ home, globalLedger: gl, cwd: proj, userHome: base });
    let partial!: ReturnType<typeof gather>;
    fault.code = code; fault.skip = 1;                                     // the global read takes the one open it skips, the project read meets the fault
    try { partial = gather(); } finally { fault.code = null; fault.skip = 0; }
    expect(partial.records.map((r) => r.scope)).toEqual(['global']);
    expect(partial.witnessNotes).toContain(WITNESS_READ_TRANSIENT_NOTE);
    expect(gather().witnessNotes).not.toContain(WITNESS_READ_TRANSIENT_NOTE);   // nothing latched
    fault.code = code;
    try { expect(gather).toThrow(/could not be read at this moment/); } finally { fault.code = null; }
  });
});
