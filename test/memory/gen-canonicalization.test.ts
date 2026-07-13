import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { subkeyForScope } from '../../src/memory/verified-read.js';
import { signVerify, signVerifyV1, digestContent, ensureMaster } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

describe('D2: gen type-punning cannot split a cross-lane fail-low slot', () => {
  it('a v1-signed "Verified" pun at gen "1" (string) cannot escalate past a genuine v2 "Corroborated" at gen 1 (number)', () => {
    // The MAC encodes gen as BigInt(gen ?? 0), so number 1 and string "1" sign identically — a
    // ledger-write adversary can flip an existing verify's gen to the punned type WITHOUT invalidating
    // its MAC. Pre-fix, resolveTargetGrade's `byGen` Map keyed on the RAW value put `1` and `"1"` in
    // DIFFERENT slots, so the two records never went through the cross-lane fail-low comparison (spec
    // §4.5) at all — each slot's lone record was independently "active", and ordinary last-applicable-
    // wins tie-break let whichever record the adversary appended LAST simply overwrite the grade in
    // EITHER direction, including upward. Post-fix, canonicalizing to BigInt makes both land in the
    // SAME slot, so the pre-existing cross-lane rule (keep the lower-rank lane) correctly fires and the
    // forged higher grade cannot win, no matter where the adversary appends it.
    const home = mkdtempSync(join(tmpdir(), 'helix-d2-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'the fact', source: 'user' });
    ensureMaster(home); // mint the master directly — store.confirm() only ever mints Verified, which
                         // leaves no lower genuine grade at gen 1 for the pun to escalate past.
    const subkey = subkeyForScope(home)!;
    const digest = digestContent('the fact');
    // The genuine (honest) v2 assessment: Corroborated at gen 1.
    const genuine = signVerify({
      id: 'genuine', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Corroborated', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      gen: 1, targetDigest: digest,
    } as MemoryRecord, subkey);
    appendFileSync(ledger, JSON.stringify(genuine) + '\n');
    // The forged pun: MAC-valid (v1 scheme, still dual-accepted) claiming Verified at gen "1" (STRING).
    const punned = signVerifyV1({
      id: 'punned', tx: '2026-01-03T00:00:00.000Z', validFrom: '2026-01-03T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      gen: '1' as unknown as number, targetDigest: digest,
    } as MemoryRecord, subkey);
    appendFileSync(ledger, JSON.stringify(punned) + '\n');
    const hit = store.recall('fact').items.find((i) => i.record.id === a.id)!;
    // Fail-low: the forged Verified pun cannot escalate the target past the genuine Corroborated.
    expect(hit.record.state).toBe('Corroborated');
    // Cross-lane fail-low is a designed downgrade (spec §4.5), not full tamper evidence — the target
    // still resolves to an honest, if lower, grade rather than clamping all the way to Fresh.
    expect(hit.integrity).toBe('ok');
  });
});
