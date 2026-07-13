import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { MemoryStore } from '../../src/memory/store.js';
import { subkeyForScope } from '../../src/memory/verified-read.js';
import { signVerify, digestContent, keyIdOf } from '../../src/memory/ledger-mac.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { verifyVerify } from '../../src/memory/ledger-mac.js';
import { scanLegacyElevated } from '../../src/memory/legacy-scan.js';
import type { MemoryRecord } from '../../src/types.js';

// An array-like object whose Buffer.from(...,'utf8') bytes are exactly "Verified", so it MAC-collides
// with a genuine state:"Verified" verify but is a hostile object at a property-key/interpolation site.
const HOSTILE_STATE = { 0:86,1:101,2:114,3:105,4:102,5:105,6:101,7:100, length:8, toString:{} } as unknown;

describe('D1: non-enum verify state is inert, never crashes', () => {
  it('recall does not throw on a MAC-valid hostile-object state, and the target stays Fresh', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d1-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'the fact', source: 'user' });
    store.confirm(keep.id);                       // mints master + a genuine v2 verify
    const subkey = subkeyForScope(home)!;
    // forge a signed verify whose state is the hostile object (MAC covers Buffer.from(state) = "Verified")
    const unsigned: MemoryRecord = { id: 'poison', tx: '2026-01-02T00:00:00.000Z', validFrom: '2026-01-02T00:00:00.000Z', validTo: null,
      type: 'verify', state: HOSTILE_STATE as MemoryRecord['state'], content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: keep.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5, targetDigest: digestContent('the fact') };
    appendFileSync(ledger, JSON.stringify(signVerify(unsigned, subkey)) + '\n');
    expect(() => store.recall('fact')).not.toThrow();           // D1: was TypeError before the fix
    const hit = store.recall('fact').items.find((i) => i.record.id === keep.id)!;
    expect(hit.record.state).toBe('Verified');                  // grade from the GENUINE gen-1 verify only
  });

  it('scanLegacyElevated flags a MAC-valid non-enum-state verify as an offender (C9)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d1b-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'the fact', source: 'user' });
    store.confirm(a.id);
    const subkey = subkeyForScope(home)!;
    const unsigned: MemoryRecord = { id: 'poison', tx: '2026-01-02T00:00:00.000Z', validFrom: '2026-01-02T00:00:00.000Z', validTo: null,
      type: 'verify', state: HOSTILE_STATE as MemoryRecord['state'], content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5, targetDigest: digestContent('the fact') };
    appendFileSync(ledger, JSON.stringify(signVerify(unsigned, subkey)) + '\n');
    const scan = scanLegacyElevated(parseLedger(ledger), (r) => verifyVerify(r, subkey));
    expect(scan.offenders).toContain('poison');
  });

  it('finding 4: asOfView does not leak a hostile-object state onto the forensic snapshot (asof.ts gate is the SOLE gate on that path)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d1c-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'the fact', source: 'user' });
    store.confirm(keep.id);                       // master + a genuine v2 Verified verify at gen 1
    const subkey = subkeyForScope(home)!;
    const unsigned: MemoryRecord = { id: 'poison', tx: '2026-06-02T00:00:00.000Z', validFrom: '2026-06-02T00:00:00.000Z', validTo: null,
      type: 'verify', state: HOSTILE_STATE as MemoryRecord['state'], content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: keep.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5, targetDigest: digestContent('the fact') };
    appendFileSync(ledger, JSON.stringify(signVerify(unsigned, subkey)) + '\n');
    const t = '2026-12-31T00:00:00.000Z';         // window covers both the genuine verify and the poison
    expect(() => store.asOfView(t)).not.toThrow();
    const view = store.asOfView(t);
    const fact = view.facts.find((f) => f.record.id === keep.id)!;
    // grade + every evidence state must be a known enum STRING — never the hostile object (which would
    // then throw the moment inspect interpolates ${e.state} / ${f.grade}). Reverting the asof.ts:26
    // isKnownState clause makes grade/state/evidence[].state the object and fails these typeof checks.
    expect(typeof fact.grade).toBe('string');
    expect(typeof fact.record.state).toBe('string');
    expect(fact.evidence.every((e) => typeof e.state === 'string')).toBe(true);
    expect(fact.grade).toBe('Verified');           // graded by the genuine gen-1 verify only
  });

  it('finding 5: compaction DROPS a MAC-valid hostile-state verify (keepValidVerifyFor enum gate) while keeping the genuine one', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d1d-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'keep me', source: 'user' });
    store.confirm(a.id);                           // genuine v2 verify on the surviving fact
    const subkey = subkeyForScope(home)!;
    const b = store.commit({ content: 'erase me', source: 'user' });
    const unsigned: MemoryRecord = { id: 'poison', tx: '2026-06-02T00:00:00.000Z', validFrom: '2026-06-02T00:00:00.000Z', validTo: null,
      type: 'verify', state: HOSTILE_STATE as MemoryRecord['state'], content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5, targetDigest: digestContent('keep me') };
    appendFileSync(ledger, JSON.stringify(signVerify(unsigned, subkey)) + '\n');
    store.erase(b.id, { permanent: true });        // forces HMAC-aware compaction over the ledger
    const after = parseLedger(ledger);
    expect(after.some((r) => r.id === 'poison')).toBe(false);                       // hostile-state verify dropped as forged
    expect(after.some((r) => r.id.startsWith('integrity_'))).toBe(true);            // integrity marker minted
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && r.macVersion === 2)).toBe(true); // genuine kept
  });
});
