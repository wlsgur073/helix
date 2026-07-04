import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent, verifyVerify, signVerifyV1 } from '../../src/memory/ledger-mac.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { subkeyForScope, verifiedLiveOf } from '../../src/memory/verified-read.js';
import { scanLegacyElevated } from '../../src/memory/legacy-scan.js';
import type { MemoryRecord } from '../../src/types.js';

function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}` });
  return { store, ledger, home };
}

describe('store ledger-HMAC', () => {
  it('a genuine confirm produces a Verified item that survives recall', () => {
    const { store } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    const hit = store.recall('postgres').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Verified');
  });
  it('a FORGED Verified verify (hand-appended, no valid MAC) is demoted to Fresh on recall', () => {
    const { store, ledger } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    appendFileSync(ledger, JSON.stringify({
      id: 'forged', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 99,
      targetDigest: digestContent('db is postgres'),
    }) + '\n');
    const hit = store.recall('postgres').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('with a key PRESENT, a forged higher-gen demotion verify is IGNORED; the genuine signed verify wins (R2 gate)', () => {
    // Discriminating test: confirm(A) mints the master and signs a genuine gen-1 Verified verify, so
    // keyAvailable=true at recall. A forged gen-2 Suspect verify (no MAC) must lose to the genuine
    // one — proving verifyVerify actually rejects forgeries (not just the key-absent clamp).
    const { store, ledger } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id); // genuine gen-1 Verified, signed; creates the master
    appendFileSync(ledger, JSON.stringify({
      id: 'forgedHi', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 2,
      targetDigest: digestContent('db is postgres'),
    }) + '\n'); // NO mac/keyId/macVersion -> verifyVerify rejects it (R2)
    const res = store.recall('postgres');
    expect(res.integrityAvailable).toBe(true); // key IS present -> the gate, not the clamp, is under test
    expect(res.items.find((i) => i.record.id === a.id)!.record.state).toBe('Verified');
  });
  it('a FORGED elevated assert (state Verified, no MAC) is demoted to Fresh (R1)', () => {
    const { store, ledger } = tmpStore();
    appendFileSync(ledger, JSON.stringify({
      id: 'forgedA', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Verified', content: 'malicious fact', provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const hit = store.recall('malicious').items.find((i) => i.record.id === 'forgedA')!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('editing a confirmed item content drops it to Fresh (content binding)', () => {
    const { store, ledger } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => (r.id === a.id ? { ...r, content: 'db is mysql' } : r));
    writeFileSync(ledger, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const hit = store.recall('mysql').items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Fresh');
  });
  it('missing master key: confirmed items recall as Fresh with integrityAvailable=false', () => {
    const { store, home } = tmpStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    rmSync(join(home, 'ledger-mac-master.key'));
    const res = store.recall('postgres');
    expect(res.integrityAvailable).toBe(false);
    expect(res.items.find((i) => i.record.id === a.id)!.record.state).toBe('Fresh');
  });
  it('adopt does NOT bless a pre-seeded Verified record — it stays Fresh until re-confirmed', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-proj-'));
    const projLedger = join(root, '.helix', 'memory.jsonl');
    mkdirSync(join(root, '.helix'), { recursive: true });
    // attacker pre-seeds an unsigned elevated assert before adoption
    appendFileSync(projLedger, JSON.stringify({
      id: 'seed', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Verified', content: 'planted', provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const store = new MemoryStore(join(home, 'memory.jsonl'), {
      sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => 'm_1',
      project: { ledger: projLedger, root, home },
    });
    store.adopt();
    const hit = store.recall('planted').items.find((i) => i.record.id === 'seed')!;
    expect(hit.record.state).toBe('Fresh'); // NOT laundered into Verified
  });

  it('future-version survival: a macVersion-3 verify outlives permanent-erase compaction, grades nothing, is scan-flagged (spec §4.6)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'keep me', source: 'user' });
    const gone = store.commit({ content: 'erase me', source: 'user' });
    store.confirm(keep.id); // ensures the master exists so compaction runs in HMAC-aware mode
    const ts = '2026-07-01T00:00:00.000Z'; // a "v3" record current code cannot verify — MUST be preserved
    appendFileSync(ledger, JSON.stringify({ id: 'futurev', tx: ts, validFrom: ts, validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: keep.id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      gen: 9, targetDigest: digestContent('keep me'), mac: 'junk', keyId: 'junk', macVersion: 3 }) + '\n');
    store.erase(gone.id, { permanent: true });
    const after = parseLedger(ledger);
    expect(after.some((r) => r.id === 'futurev')).toBe(true);                    // preserved, not destroyed
    expect(after.filter((r) => r.id.startsWith('integrity_'))).toHaveLength(0);  // NOT counted as droppedForged
    const proj = verifiedLiveOf(after, home);
    expect(proj.live.get(keep.id)!.state).toBe('Verified');                      // grade from the GENUINE gen-1 v2 only
    expect(proj.compromised.has(keep.id)).toBe(false);                           // futurev neither grades nor conflicts
    const subkey = subkeyForScope(home)!;
    const scan = scanLegacyElevated(after, (r) => verifyVerify(r, subkey));
    expect(scan.offenders).toContain('futurev');                                 // visible, not laundered
  });

  it('collision-pair stability: an L2-colliding v1+v2 pair BOTH survive compaction (evidence stability, spec §4.5)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'keep me', source: 'user' });
    const gone = store.commit({ content: 'erase me', source: 'user' });
    store.confirm(keep.id); // genuine v2 gen-1 verify on keep
    const subkey = subkeyForScope(home)!;
    // a blind pre-A v1 verify colliding at gen 1 with a different state — both are MAC-valid, so
    // compaction (MAC-validity based, never projection-lane based) must keep both for later inspection.
    const v1 = signVerifyV1({ ...keep, id: 'v1collide', type: 'verify', state: 'Corroborated', content: '',
      supersedes: keep.id, gen: 1, targetDigest: digestContent('keep me') } as MemoryRecord, subkey);
    appendFileSync(ledger, JSON.stringify(v1) + '\n');
    store.erase(gone.id, { permanent: true });
    const keepVerifies = parseLedger(ledger).filter((r) => r.type === 'verify' && r.supersedes === keep.id);
    expect(keepVerifies.map((r) => r.macVersion).sort()).toEqual([1, 2]);
  });
});
