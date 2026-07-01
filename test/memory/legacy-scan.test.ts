import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLegacyElevated } from '../../src/memory/legacy-scan.js';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { subkeyForScope } from '../../src/memory/verified-read.js';
import { verifyVerify } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

const base = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'm', tx: 't', validFrom: 't', validTo: null, type: 'assert', state: 'Fresh', content: 'c',
  provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null,
  reverifyTrigger: null, classification: 'normal', ...over,
});

// The exact validity predicate verifiedLive/buildVerifiedProjection use: a verify is genuine iff its
// MAC checks under the scope subkey; no subkey (key-absent) treats every verify as unverifiable.
const pred = (subkey: Buffer | null) => (r: MemoryRecord) => (subkey ? verifyVerify(r, subkey) : false);

describe('scanLegacyElevated', () => {
  it('is ok on a clean Fresh-only ledger', () => {
    expect(scanLegacyElevated([base({ id: 'a' }), base({ id: 'b' })], pred(null)).ok).toBe(true);
  });

  it('flags a forged unsigned verify and a baked-elevated assert', () => {
    const r = scanLegacyElevated(
      [base({ id: 'a' }), base({ id: 'v', type: 'verify', state: 'Verified' }), base({ id: 'c', state: 'Corroborated' })],
      pred(null),
    );
    expect(r.ok).toBe(false);
    expect(r.offenders.sort()).toEqual(['c', 'v']);
  });

  // The discriminating case: a GENUINE signed verify (minted by confirm) must NOT be reported. The
  // pre-feature scan flagged every `type:'verify'`, so it false-positived here (RED); the verifying
  // scan asks the same question the replay does — does the MAC check? — and stays quiet (GREEN).
  it('does NOT flag a genuine signed verify (no FP on real, tool-minted elevations)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'plain fact', source: 'user' });
    store.confirm(a.id); // appends a genuine SIGNED verify (state Verified) under the global subkey
    const subkey = subkeyForScope(home); // same master + global nonce the store signed with
    const scan = scanLegacyElevated(parseLedger(ledger), pred(subkey));
    expect(scan.offenders).toEqual([]);
    expect(scan.ok).toBe(true);
  });

  // Same real signed ledger, but a forged UNSIGNED verify is spliced in: its MAC fails under the live
  // subkey, so it is the only offender — the genuine verify beside it is still untouched.
  it('flags a forged unsigned verify even when a valid subkey is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const a = store.commit({ content: 'plain fact', source: 'user' });
    store.confirm(a.id);
    appendFileSync(
      ledger,
      JSON.stringify(base({ id: 'forged', type: 'verify', state: 'Verified', content: '', supersedes: a.id })) + '\n',
    );
    const subkey = subkeyForScope(home);
    const scan = scanLegacyElevated(parseLedger(ledger), pred(subkey));
    expect(scan.offenders).toEqual(['forged']);
  });

  // A baked elevated assert (no MAC) — the verifying replay (R1) clamps it to Fresh, so a persisted
  // non-Fresh assert/supersede state is a real legacy/forged elevation worth surfacing.
  it('flags a baked elevated assert (state Verified, no mac)', () => {
    const scan = scanLegacyElevated([base({ id: 'baked', type: 'assert', state: 'Verified' })], pred(null));
    expect(scan.offenders).toEqual(['baked']);
  });

  // A genuine erase tombstone carries state:'Suspect' by design (store.erase). It is NOT a content
  // elevation, so the scan must leave it alone — otherwise every real erase would warn at startup.
  it('does NOT flag a genuine erase tombstone (state Suspect by design)', () => {
    const scan = scanLegacyElevated([base({ id: 'tomb', type: 'erase', state: 'Suspect', content: '', supersedes: 'x' })], pred(null));
    expect(scan.offenders).toEqual([]);
  });

  // A content-free audit marker — the horizon marker (ledger.ts:141) and the integrity tombstone
  // (ledger.ts:124) — is a verify-shaped record with a null target, no MAC, empty content, state
  // Suspect. The replay treats it as inert (null target -> elevates nothing, verified-projection.ts:29),
  // so the scan must NOT report it. Otherwise every truncated-compaction ledger warns "forged/legacy
  // elevated" at startup, diluting the genuine-forgery signal it shares a count with (B1).
  it('does NOT flag content-free horizon/integrity markers (null-target, no mac, empty content)', () => {
    const horizon = base({ id: 'horizon_abc', type: 'verify', supersedes: null, content: '', state: 'Suspect' });
    const integrity = base({ id: 'integrity_def', type: 'verify', supersedes: null, content: '', state: 'Suspect' });
    const scan = scanLegacyElevated([base({ id: 'a' }), horizon, integrity], pred(null));
    expect(scan.offenders).toEqual([]);
    expect(scan.ok).toBe(true);
  });
});
