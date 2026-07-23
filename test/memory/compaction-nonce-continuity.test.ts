import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';

// Nonce-continuity chokepoint (Codex round-3 synthesis): the deletion chain's single chokepoint is
// compaction dropping a verify as "forged". A WRONG-but-present nonce — however it arose (a symlink
// aliasing two scopes onto one ledger, an un-migrated alias key, a stale/corrupt registry value) —
// made every genuine verify fail validation and get physically deleted. The fix: compaction may drop
// verifies ONLY when the resolved key is PROVEN correct for this ledger (it validates at least one).
// If it validates none, the KEY is wrong, not every verify forged (forgery needs the master key), so
// preserve all. This one guard closes the whole wrong-nonce trigger class at once.
describe('compaction nonce-continuity chokepoint', () => {
  it('preserves genuine verifies (no false marker) when the resolved nonce is WRONG (validates none)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'keep me alpha', source: 'user' });
    store.confirm(keep.id); // genuine signed verify under the @global nonce N1 (minted here)

    // Rotate the @global nonce to a WRONG value — the net effect of ANY wrong-nonce trigger.
    const regPath = join(home, 'projects.json');
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    reg['@global'].macNonce = 'ffffffffffffffffffffffffffffffff';
    writeFileSync(regPath, JSON.stringify(reg));

    const gone = store.commit({ content: 'erase me beta', source: 'user' });
    store.erase(gone.id, { permanent: true }); // compaction resolves the WRONG nonce

    const after = parseLedger(ledger);
    // The genuine verify must SURVIVE (the wrong key must not delete it as "forged")...
    expect(after.some((r) => r.type === 'verify' && r.supersedes === keep.id)).toBe(true);
    // ...and no FALSE integrity marker is minted from a bogus mass "forgery" drop.
    expect(after.filter((r) => r.id.startsWith('integrity_'))).toHaveLength(0);
  });

  it('still drops a genuine forgery when the key IS proven (a real verify validates)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'keep me alpha', source: 'user' });
    store.confirm(keep.id); // genuine verify (proves the key)
    // append a forged verify (invalid MAC) for a second live fact
    const other = store.commit({ content: 'other fact gamma', source: 'user' });
    appendForged(ledger, other.id);
    const gone = store.commit({ content: 'erase me beta', source: 'user' });
    store.erase(gone.id, { permanent: true });
    const after = parseLedger(ledger);
    expect(after.some((r) => r.type === 'verify' && r.supersedes === keep.id)).toBe(true); // genuine kept
    expect(after.some((r) => r.type === 'verify' && r.supersedes === other.id)).toBe(false); // forgery dropped
  });
});

function appendForged(ledger: string, targetId: string): void {
  const ts = '2026-07-01T00:00:00.000Z';
  writeFileSync(ledger, readFileSync(ledger, 'utf8') + JSON.stringify({
    id: 'forged_1', tx: ts, validFrom: ts, validTo: null, type: 'verify', state: 'Verified', content: '',
    provenance: { source: 'user', sessionId: 's' }, supersedes: targetId, blastRadius: null,
    reverifyTrigger: null, classification: 'normal', gen: 1, targetDigest: 'x', mac: 'junk', keyId: 'junk',
  }) + '\n');
}
