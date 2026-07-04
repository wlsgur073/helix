import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSubkey, signVerify, signVerifyV1, digestContent as dc } from '../../src/memory/ledger-mac.js';
import { isVerifyTxAuthenticated, isVerifyTxAuthenticatedForScope } from '../../src/memory/verify-tx.js';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

const rec = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'v1', tx: '2026-07-01T00:00:00.000Z', validFrom: '2026-07-01T00:00:00.000Z', validTo: null,
  type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
  supersedes: 'target1', blastRadius: null, reverifyTrigger: null, classification: 'normal',
  gen: 1, targetDigest: dc('the fact'), ...over,
});

describe('isVerifyTxAuthenticated', () => {
  const k = deriveSubkey(Buffer.alloc(32, 9), 'proj');
  it('true for a valid v2 verify with an ISO instant tx', () => {
    expect(isVerifyTxAuthenticated(signVerify(rec(), k), k)).toBe(true);
  });
  it('false for a valid v1 verify (tx not authenticated by the scheme)', () => {
    expect(isVerifyTxAuthenticated(signVerifyV1(rec(), k), k)).toBe(false);
  });
  it('false for a valid v2 mac over a non-ISO tx (fail-closed on shape)', () => {
    expect(isVerifyTxAuthenticated(signVerify(rec({ tx: 'not-an-instant' }), k), k)).toBe(false);
  });
  it('false when the MAC is invalid', () => {
    expect(isVerifyTxAuthenticated({ ...signVerify(rec(), k), state: 'Corroborated' }, k)).toBe(false);
  });

  it('ForScope resolves the per-scope subkey like the read paths; key-absent is fail-closed false', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-vt-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { sessionId: 's', home });
    const a = store.commit({ content: 'fact', source: 'user' });
    store.confirm(a.id); // mints the master + global scope nonce + a genuine v2 verify (canonical clock)
    const v2 = parseLedger(join(home, 'memory.jsonl')).find((r) => r.type === 'verify' && r.supersedes === a.id)!;
    expect(isVerifyTxAuthenticatedForScope(v2, home)).toBe(true);
    const emptyHome = mkdtempSync(join(tmpdir(), 'helix-vt-'));
    expect(isVerifyTxAuthenticatedForScope(v2, emptyHome)).toBe(false); // no key -> never authenticated
  });
});
