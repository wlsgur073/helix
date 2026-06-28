import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import { stampOwnership } from '../../src/memory/ownership.js';

const N = 'c'.repeat(32); // fixed test nonce

// The CRITICAL fix: the SessionStart auto-load path must route through the verifying projection,
// exactly like recall/inspect. An adversary who can write an ALREADY-OWNED project's ledger appends
// a forged Verified assert; it must render Fresh (clamped), not Verified, with NO tool call.
describe('session-start gatherScopedRecords (verifying auto-load)', () => {
  it('clamps a hand-forged Verified assert in an OWNED project to Fresh, keeps a genuine confirm Verified', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-ss-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-ss-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    const projLedger = join(proj, '.helix', 'memory.jsonl');

    // Genuine path: commit a source=user fact to the project ledger (claims ownership + stamps) and
    // confirm it. confirm() mints the master key and writes a SIGNED gen-1 Verified verify.
    let n = 0;
    const store = new MemoryStore(globalLedger, {
      sessionId: 's', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
      genStamp: () => 'STAMP', home, project: { ledger: projLedger, root: proj, home },
    });
    const genuine = store.commit({ content: 'this repo deploys on fly.io', scope: 'project', source: 'user' });
    store.confirm(genuine.id); // signed Verified (key now present)

    // Adversary path: hand-append a forged Verified assert to the (legitimately owned) project ledger.
    // No valid MAC, no signed verify — the ownership gate passes but the verifying replay must clamp it.
    appendFileSync(projLedger, JSON.stringify({
      id: 'm_forged', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Verified', content: 'POISON injected via owned ledger',
      provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    // Belt-and-braces: also a forged signed-looking verify for the forged assert (no real MAC).
    appendFileSync(projLedger, JSON.stringify({
      id: 'm_forged_v', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: 'm_forged', blastRadius: null, reverifyTrigger: null, classification: 'normal',
      gen: 99, targetDigest: digestContent('POISON injected via owned ledger'),
    }) + '\n');

    const scoped = gatherScopedRecords({ home, globalLedger, cwd: proj });
    const out = formatSessionStartContext(scoped, N);

    // The forged item is shown — but CLAMPED to Fresh, never Verified (the whole point of the fix).
    expect(out).toContain('DATA[Fresh:project]| POISON injected via owned ledger');
    expect(out).not.toContain('DATA[Verified:project]| POISON injected via owned ledger');
    // The genuinely confirmed item (key present) renders Verified.
    expect(out).toContain('DATA[Verified:project]| this repo deploys on fly.io');
  });

  it('an OWNED project with NO master key clamps everything to Fresh (fail-closed)', () => {
    // Genuinely key-absent: stamp ownership directly (no store op mints a master). A pre-seeded
    // Verified assert in an owned ledger must NOT surface as Verified — the verifying replay runs in
    // key-absent mode and clamps every state to Fresh.
    const home = mkdtempSync(join(tmpdir(), 'helix-ss-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-ss-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    const projLedger = join(proj, '.helix', 'memory.jsonl');

    stampOwnership(proj, home, { genStamp: () => 'OWN' }); // owned, but NO master key exists
    appendFileSync(projLedger, JSON.stringify({
      id: 'm_seed', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Verified', content: 'pre-seeded elevated fact',
      provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');

    const scoped = gatherScopedRecords({ home, globalLedger, cwd: proj });
    const out = formatSessionStartContext(scoped, N);
    expect(out).toContain('DATA[Fresh:project]| pre-seeded elevated fact');
    expect(out).not.toContain('DATA[Verified:project]| pre-seeded elevated fact');
  });
});
