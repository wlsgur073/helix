import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { withFileLock } from '../../src/memory/lock.js';
import { rankRecords } from '../../src/memory/retrieval.js';
import type { MemoryRecord, MemoryState } from '../../src/types.js';

// AUDIT 2026-06-15 — J3 memory engine. CHARACTERIZATION tests (current behavior).

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'helix-audit-store-'));
  const ledger = join(dir, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, {
    sessionId: 's1', now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}`,
  });
  return { store, ledger };
}

function mrec(id: string, content: string, state: MemoryState = 'Fresh'): MemoryRecord {
  return {
    id, tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state, content, provenance: { source: 'user', sessionId: 's' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  };
}

describe('J3 audit — secret-scan FP no longer causes whole-record data loss (J2-6 FIXED)', () => {
  it('a memory whose only "secret" is a git SHA keeps its surrounding text (span-level redaction)', () => {
    const { store, ledger } = tmpStore();
    store.commit({ content: 'deployed commit da39a3ee5e6b4b0d3255bfef95601890afd80709 to prod' });
    const onDisk = parseLedger(ledger)[0]!;
    expect(onDisk.classification).toBe('secret-redacted');
    expect(onDisk.content).toContain('[redacted:high-entropy]'); // only the SHA is masked
    expect(onDisk.content).toContain('deployed commit');
    expect(onDisk.content).toContain('to prod'); // non-secret words preserved (no more total loss)
    expect(readFileSync(ledger, 'utf8')).not.toContain('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});

describe('J3 audit — lock release verifies ownership (J3-1 FIXED)', () => {
  it('release does NOT free the lock when the owner token no longer matches (stolen-lock safety)', () => {
    // Simulate the steal-while-holding race: our lock was stolen and a new holder re-stamped the
    // owner file while our fn ran. Release must see the token mismatch and leave the lock alone.
    const t = join(mkdtempSync(join(tmpdir(), 'helix-audit-lock-')), 'ledger.jsonl');
    withFileLock(t, () => {
      writeFileSync(join(t + '.lock', 'owner'), 'stolen-by-another-process');
    });
    expect(existsSync(t + '.lock')).toBe(true); // we did NOT delete a lock we no longer own
    rmSync(t + '.lock', { recursive: true, force: true }); // test cleanup
  });

  it('normal release (token intact) still removes the lock', () => {
    const t = join(mkdtempSync(join(tmpdir(), 'helix-audit-lock-')), 'ledger.jsonl');
    withFileLock(t, () => { /* leave the owner token intact */ });
    expect(existsSync(t + '.lock')).toBe(false);
  });

  it('maxWaitMs < staleMs (the defaults are 5000 < 10000): a waiter throws before it can steal (J3-2)', () => {
    const t = join(mkdtempSync(join(tmpdir(), 'helix-audit-lock-')), 'ledger.jsonl');
    mkdirSync(t + '.lock'); // a FRESH live holder (mtime = now)
    // staleMs=1000 but maxWaitMs=150 -> the waiter gives up at 150ms, long before the 1000ms
    // staleness window opens, so it can neither acquire nor steal. Same shape as the defaults.
    expect(() => withFileLock(t, () => 1, { staleMs: 1000, maxWaitMs: 150 })).toThrow(/timed out/i);
  });
});

describe('J3 audit — phraseScore substring-in-word FP (J3-3)', () => {
  it('a 3-char query phrase-matches INSIDE a longer word (cat -> concatenate)', () => {
    // minLen=3 only blocks <3-char queries; 'cat' (3) still substring-matches 'concatenate',
    // surfacing an unrelated record (relevance 0.5 from phrase alone, coverage/bm25 = 0).
    const out = rankRecords([mrec('hit', 'concatenate the logs'), mrec('miss', 'lunch menu')], 'cat');
    expect(out.map((r) => r.id)).toContain('hit');
  });
});

describe('J3 audit — supersede/update path now wired (J3-4 FIXED)', () => {
  it('commit with supersedes replaces the old item (update), not a duplicate', () => {
    const { store } = tmpStore();
    const a = store.commit({ content: 'the prod db is postgres' });
    store.commit({ content: 'the prod db is mysql', supersedes: a.id });
    const live = store.inspect();
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toBe('the prod db is mysql');
  });
  it('plain re-commit (no supersedes) still adds a separate item — update is explicit/opt-in', () => {
    const { store } = tmpStore();
    store.commit({ content: 'the prod db is postgres' });
    store.commit({ content: 'the prod db is mysql' });
    expect(store.inspect()).toHaveLength(2);
  });
});
