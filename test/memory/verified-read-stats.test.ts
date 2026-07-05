import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { ensureMaster, signVerify, digestContent } from '../../src/memory/ledger-mac.js';
import { subkeyForScope, verifiedLive, verifiedLiveStats } from '../../src/memory/verified-read.js';

const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'm_1', tx: '2026-07-05T00:00:00.000Z', validFrom: '2026-07-05T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: 'the build command is npm run build',
  provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...over,
});

function fixture(): { home: string; ledger: string } {
  const home = mkdtempSync(join(tmpdir(), 'helix-vrs-'));
  const ledger = join(home, 'memory.jsonl');
  ensureMaster(home);
  const subkey = subkeyForScope(home)!;
  const a = rec({ id: 'm_1' });
  const b = rec({ id: 'm_2', content: 'tests run with vitest' });
  const gone = rec({ id: 'm_3', content: 'stale fact' });
  const closer = rec({ id: 'm_4', type: 'supersede', supersedes: 'm_3', content: 'fresh fact' });
  const verify = signVerify(rec({
    id: 'v_1', type: 'verify', state: 'Corroborated', content: '',
    provenance: { source: 'reality-check', sessionId: 's' },
    supersedes: 'm_1', gen: 1, targetDigest: digestContent(a.content),
  }), subkey);
  const lines = [a, b, gone, closer, verify].map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(ledger, lines);
  return { home, ledger };
}

describe('verifiedLiveStats', () => {
  it('returns exact rows/live_rows/bytes and phase timings for a known ledger (spec §9.4)', () => {
    const { home, ledger } = fixture();
    const { projection, stats } = verifiedLiveStats(ledger, home);
    expect(stats.rows).toBe(5);                       // all parsed records incl. closer + verify
    expect(stats.liveRows).toBe(3);                   // m_1, m_2, m_4 (m_3 superseded; verify not live)
    expect(stats.bytes).toBe(statSync(ledger).size);
    expect(stats.keyAvailable).toBe(true);
    expect(projection.live.get('m_1')!.state).toBe('Corroborated'); // signed verify honored
    expect(stats.parseMs).toBeGreaterThanOrEqual(0);
    expect(stats.projectMs).toBeGreaterThanOrEqual(0);
  });

  it('parity: verifiedLive is exactly verifiedLiveStats().projection (spec §9.3)', () => {
    const { home, ledger } = fixture();
    const direct = verifiedLive(ledger, home);
    const viaStats = verifiedLiveStats(ledger, home).projection;
    expect([...direct.live.entries()]).toEqual([...viaStats.live.entries()]);
    expect(direct.keyAvailable).toBe(viaStats.keyAvailable);
    expect([...direct.compromised]).toEqual([...viaStats.compromised]);
  });

  it('missing ledger file yields zero rows/bytes without throwing (spec §9.9)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-vrs-'));
    const { projection, stats } = verifiedLiveStats(join(home, 'nope.jsonl'), home);
    expect(stats).toMatchObject({ rows: 0, liveRows: 0, bytes: 0 });
    expect(projection.live.size).toBe(0);
    expect(stats.keyAvailable).toBe(false); // no master minted in this home
  });
});
