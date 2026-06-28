import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

// Backward-compatibility: a ledger written before ledger-HMAC has NO mac/gen/targetDigest/keyId
// fields on any record. Such a ledger must (a) parse and recall without throwing and (b) get NO
// free trust — every legacy elevation replays as Fresh (R1 for asserts, R2 for unsigned verifies).
// Content is deliberately low-entropy / non-secret so the secret scanner never interferes.

function legacyLedger() {
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  const ledger = join(home, 'memory.jsonl');
  return { home, ledger };
}

// A pre-HMAC record carries none of the integrity fields.
function legacyRecord(over: Record<string, unknown>) {
  return JSON.stringify({
    id: 'm_legacy', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'legacy fact', provenance: { source: 'user', sessionId: 's' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...over,
  }) + '\n';
}

describe('ledger-HMAC backward compatibility', () => {
  it('a legacy all-Fresh ledger (no MAC fields) recalls unchanged', () => {
    const { home, ledger } = legacyLedger();
    appendFileSync(ledger, legacyRecord({}));
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const hit = store.recall('legacy').items.find((i) => i.record.id === 'm_legacy')!;
    expect(hit.record.state).toBe('Fresh');
    expect(hit.record.content).toBe('legacy fact');
  });

  it('a legacy ELEVATED assert (state Verified, no MAC fields) recalls as Fresh (R1 clamp)', () => {
    const { home, ledger } = legacyLedger();
    // Pre-HMAC ledger that already claims a top grade on an assert. R1: non-verify records carry
    // no trust on replay, so this is projected at Fresh — old ledgers buy no free elevation.
    appendFileSync(ledger, legacyRecord({ type: 'assert', state: 'Verified' }));
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const hit = store.recall('legacy').items.find((i) => i.record.id === 'm_legacy')!;
    expect(hit.record.state).toBe('Fresh');
  });

  it('a legacy VERIFY record (no MAC fields) is ignored (R2); the target stays Fresh and parsing does not throw', () => {
    const { home, ledger } = legacyLedger();
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'plain fact', source: 'user' });
    // A pre-HMAC verify record elevating the target, with none of mac/gen/targetDigest. R2: every
    // trust transition requires a valid MAC, so this unsigned verify is ignored — the target keeps
    // its committed Fresh grade. Recall must not throw on the legacy (unsigned) verify line.
    appendFileSync(ledger, legacyRecord({
      id: 'm_legacy_verify', type: 'verify', state: 'Verified', content: '', supersedes: a.id,
    }));
    let res!: ReturnType<typeof store.recall>;
    expect(() => { res = store.recall('plain'); }).not.toThrow();
    const hit = res.items.find((i) => i.record.id === a.id)!;
    expect(hit.record.state).toBe('Fresh');
  });
});
