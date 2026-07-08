import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../src/types.js';
import { rankRecords, buildRankArtifacts, rankWithArtifacts, phraseScore, phraseScoreNorm, normalizeText } from '../src/memory/retrieval.js';

function rec(id: string, content: string, state: MemoryRecord['state'] = 'Fresh'): MemoryRecord {
  return {
    id, tx: `2026-01-01T00:00:${id.padStart(2, '0')}.000Z`, validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state, content,
    provenance: { source: 'user', sessionId: 't' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

const FIXTURE: MemoryRecord[] = [
  rec('01', 'deploy timeout config server'),
  rec('02', 'branch release commit workflow'),
  rec('03', 'memory ledger verify cache index'),
  rec('04', 'deploy config retry timeout'),
];

describe('retrieval split (behavior preservation)', () => {
  it('rankRecords is the explicit build+score composition (consistency, not a pre-A4 baseline)', () => {
    // NOTE: rankRecords is DEFINED as rankWithArtifacts∘buildRankArtifacts, so this only checks the
    // wrapper composes as declared — it is tautological w.r.t. behavior drift. The real behavior locks
    // are the hardcoded id-order below and the same-id scoring test that follows.
    for (const q of ['timeout', 'deploy config', 'ledger', 'release workflow', 'cache index']) {
      const viaWrapper = rankRecords(FIXTURE, q).map((r) => r.id);
      const arts = buildRankArtifacts(FIXTURE);
      const viaSplit = rankWithArtifacts(FIXTURE, arts, q).map((r) => r.id);
      expect(viaSplit).toEqual(viaWrapper);
    }
  });

  it('a known query returns a stable ranked id order', () => {
    // Run against CURRENT rankRecords first to confirm this expectation, then keep it as the lock.
    expect(rankRecords(FIXTURE, 'deploy timeout').map((r) => r.id)).toEqual(['01', '04']);
  });

  it('scores each record against its OWN content even when two records share an id (no last-wins)', () => {
    // Adversarial cross-scope id collision: two records, SAME id, different content. A prior id-keyed
    // (last-wins) lookup scored BOTH against the last record's content, poisoning relevance; positional
    // pairing must score each against itself. (Honest ids are random UUIDs, so this is unreachable in
    // normal use — but it locks the refactor's behavior-preservation contract.)
    const dup: MemoryRecord[] = [rec('X', 'deploy timeout config'), rec('X', 'lunch menu today')];
    const arts = buildRankArtifacts(dup);
    const deployHits = rankWithArtifacts(dup, arts, 'deploy').map((r) => r.content);
    expect(deployHits).toContain('deploy timeout config');
    expect(deployHits).not.toContain('lunch menu today'); // pre-fix: last-wins scored this against 'lunch'
    const lunchHits = rankWithArtifacts(dup, arts, 'lunch').map((r) => r.content);
    expect(lunchHits).toEqual(['lunch menu today']);       // only the record whose own content matches
  });

  it('phraseScore equals phraseScoreNorm over normalized content', () => {
    for (const c of ['Deploy Timeout Config', '배포 timeout 설정', 'ledger CACHE index']) {
      for (const q of ['timeout', 'deploy', '배포', 'cache index']) {
        expect(phraseScore(q, c)).toBe(phraseScoreNorm(q, normalizeText(c)));
      }
    }
  });
});
