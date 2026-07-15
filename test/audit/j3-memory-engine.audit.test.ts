import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { withFileLock, lockPathOf, writeLockFileForTest } from '../../src/memory/lock.js';
import { selfIdentity } from '../../src/memory/lock-liveness.js';
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
    store.commit({ content: 'deployed commit da39a3ee5e6b4b0d3255bfef95601890afd80709 to prod', source: 'user' });
    const onDisk = parseLedger(ledger)[0]!;
    expect(onDisk.classification).toBe('secret-redacted');
    expect(onDisk.content).toContain('[redacted:high-entropy]'); // only the SHA is masked
    expect(onDisk.content).toContain('deployed commit');
    expect(onDisk.content).toContain('to prod'); // non-secret words preserved (no more total loss)
    expect(readFileSync(ledger, 'utf8')).not.toContain('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});

describe('J3 audit — lock release verifies ownership (J3-1 FIXED)', () => {
  it('J3-1 (new form): release never unlinks a lock it cannot prove it owns', () => {
    const t = join(mkdtempSync(join(tmpdir(), 'helix-j3-')), 'ledger.jsonl');
    writeFileSync(t, '');
    withFileLock(t, () => {
      writeFileSync(lockPathOf(t), JSON.stringify({ ...selfIdentity('f'.repeat(32)), threadId: 41 }));
    });
    expect(existsSync(lockPathOf(t))).toBe(true);  // we did NOT delete a lock we no longer own
    rmSync(lockPathOf(t), { force: true });
  });

  it('normal release (token intact) still removes the lock', () => {
    const t = join(mkdtempSync(join(tmpdir(), 'helix-audit-lock-')), 'ledger.jsonl');
    withFileLock(t, () => { /* leave the owner token intact */ });
    expect(existsSync(t + '.lock')).toBe(false);
  });

  it('J3-2 (REPLACED invariant): a LIVE holder is never stolen regardless of lock age', () => {
    const t = join(mkdtempSync(join(tmpdir(), 'helix-j3-')), 'ledger.jsonl');
    writeFileSync(t, '');
    writeLockFileForTest(lockPathOf(t), { ...selfIdentity('9'.repeat(32)), threadId: 40 }); // alive: our pid+ticks, other thread
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(lockPathOf(t), old, old);                                     // a DAY old
    expect(() => withFileLock(t, () => 1, { maxWaitMs: 150 })).toThrow(/timed out/i);
    expect(existsSync(lockPathOf(t))).toBe(true);
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
    const a = store.commit({ content: 'the prod db is postgres', source: 'user' });
    store.commit({ content: 'the prod db is mysql', supersedes: a.id, source: 'user' });
    const live = store.inspect();
    expect(live).toHaveLength(1);
    expect(live[0]!.record.content).toBe('the prod db is mysql');
  });
  it('plain re-commit (no supersedes) still adds a separate item — update is explicit/opt-in', () => {
    const { store } = tmpStore();
    store.commit({ content: 'the prod db is postgres', source: 'user' });
    store.commit({ content: 'the prod db is mysql', source: 'user' });
    expect(store.inspect()).toHaveLength(2);
  });
});
