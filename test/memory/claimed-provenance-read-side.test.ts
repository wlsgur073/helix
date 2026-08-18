// N2-CONTESTED read-side (REVERIFY / RESERVE / RANK) and F2.e — a CHARACTERIZATION test.
//
// WHAT THIS FILE ASSERTS, AND WHAT IT DOES NOT.
//
// `provenance.source` is an unauthenticated field: the ledger MAC does not cover it, so a forged or
// hand-edited row can claim `'user'` for free. On the WRITE side that no longer buys anything —
// resolveTransition stopped reading the target's claimed source, and firewall.test.ts pins
// isVerifyingSource per source. On the READ side it still does, at three separate consumers, and this
// file pins that it does.
//
// That is a characterization, NOT an endorsement. The project has recorded this as an open design
// question rather than a settled defect: framing prevents frame ESCAPE, not semantic compliance with
// instructions inside correctly marked data, so "the context leg is crowd-out only" was rejected as a
// closing argument on the evidence available. Until it is decided, the behaviour should at least be
// impossible to change silently — which is all these cases do.
//
// ALL THREE read one predicate, `isVerifyingSource` in src/memory/firewall.ts, backed by a single set
// literal. Removing `'user'` from VERIFYING_SOURCES flips every case here at once. If that decision is
// taken, this file is the place it lands: invert the expectations rather than delete them, so the new
// behaviour is pinned as tightly as the old one was.
import { describe, it, expect } from 'vitest';
import { requiresReverifyBeforeUse } from '../../src/memory/state-machine.js';
import { rankRecords } from '../../src/memory/retrieval.js';
import { formatSessionStartContext } from '../../src/hooks/format-context.js';
import { isVerifyingSource } from '../../src/memory/firewall.js';
import type { MemoryRecord, ScopedRecord } from '../../src/types.js';

const rec = (over: Partial<MemoryRecord> & { id: string }): MemoryRecord => ({
  tx: '2026-06-10T00:00:00.000Z', validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: 'the deploy key lives in vault path prod/db',
  provenance: { source: 'user', sessionId: 's1' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  ...over,
});

describe('a CLAIMED user provenance still carries read-side authority (N2-CONTESTED read-side, F2.e)', () => {
  it('the shared predicate is what all three consumers read', () => {
    // Stated first so the coupling is not something a reader has to infer from three separate cases.
    expect(isVerifyingSource('user')).toBe(true);
    expect(isVerifyingSource('agent-inference')).toBe(false);
  });

  it('REVERIFY: a claimed user source suppresses the re-verify-before-use flag', () => {
    const claimed = { state: 'Fresh' as const, blastRadius: null, source: 'user' as const };
    const honest = { state: 'Fresh' as const, blastRadius: null, source: 'agent-inference' as const };
    expect(requiresReverifyBeforeUse(claimed)).toBe(false);   // presented unflagged
    expect(requiresReverifyBeforeUse(honest)).toBe(true);     // non-authoritative -> always flagged
  });

  it('RANK: a claimed user source avoids the non-authoritative recall penalty', () => {
    // Identical in every ranked respect except the claim, so the ordering below is attributable to
    // provenance alone.
    const claimed = rec({ id: 'm_claimed', provenance: { source: 'user', sessionId: 's1' } });
    const honest = rec({ id: 'm_honest', provenance: { source: 'agent-inference', sessionId: 's1' } });
    const ranked = rankRecords([honest, claimed], 'deploy key vault path');
    expect(ranked.map((r) => r.id)).toEqual(['m_claimed', 'm_honest']);
  });

  it('RESERVE: a claimed user source reserves a SessionStart slot a newer record would take', () => {
    const scoped = (r: MemoryRecord): ScopedRecord => ({ record: r, scope: 'global' });
    // One claimed-user record, deliberately the OLDEST so sort order alone would drop it, plus enough
    // newer non-authoritative records to fill every slot.
    const old = scoped(rec({ id: 'm_claimed', tx: '2020-01-01T00:00:00.000Z', content: 'claimed-user fact' }));
    const newer = Array.from({ length: 5 }, (_, i) => scoped(rec({
      id: `m_new_${i}`, tx: `2026-06-1${i}T00:00:00.000Z`, content: `newer agent fact ${i}`,
      provenance: { source: 'agent-inference', sessionId: 's1' },
    })));

    const out = formatSessionStartContext([...newer, old], 'nonce-1', { maxItems: 3 });
    expect(out).toContain('claimed-user fact');   // survived the cap on the strength of the claim
  });
});
