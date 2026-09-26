import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { MemoryStore } from '../../src/memory/store.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(): { userHome: string; home: string; proj: string; sub: string } {
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'helix-ssa-')));
  made.push(b);
  const userHome = join(b, 'userhome');
  const proj = join(userHome, 'proj');
  const sub = join(proj, 'sub');
  mkdirSync(sub, { recursive: true });
  const home = join(b, 'helixhome');
  mkdirSync(home); // an installed HELIX_HOME exists; the hook's global read does not create it
  return { userHome, home, proj, sub };
}

describe('SessionStart below a parent project (issue #1)', () => {
  it('reads the parent project once it is adopted', () => {
    const w = world();
    const atRoot = new MemoryStore(join(w.home, 'memory.jsonl'), {
      home: w.home, sessionId: 't', project: { ledger: join(w.proj, '.helix', 'memory.jsonl'), root: w.proj },
    });
    atRoot.commit({ content: 'kilo project fact', source: 'user' }); // the first commit at the root adopts it
    const r = gatherScopedRecords({ home: w.home, globalLedger: join(w.home, 'memory.jsonl'), cwd: w.sub, userHome: w.userHome });
    expect(r.projectDisposition).toBe('owned');
    expect(r.records.map((s) => [s.scope, s.record.content])).toContainEqual(['project', 'kilo project fact']);
  });

  it('discloses an unadopted parent project and reads none of it', () => {
    const w = world();
    mkdirSync(join(w.proj, '.helix'));
    writeFileSync(join(w.proj, '.helix', 'memory.jsonl'), JSON.stringify({
      id: 'm_parent', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: 'lima planted fact', provenance: { source: 'user', sessionId: 'x' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const r = gatherScopedRecords({ home: w.home, globalLedger: join(w.home, 'memory.jsonl'), cwd: w.sub, userHome: w.userHome });
    expect(r.projectDisposition).toBe('ancestor-unadopted');
    expect(r.records).toHaveLength(0);
  });
});
