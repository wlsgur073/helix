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
});
