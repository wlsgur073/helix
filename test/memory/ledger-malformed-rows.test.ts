import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLedgerText, planCompaction } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';
import type { MemoryRecord } from '../../src/types.js';

/** A complete, legitimate record. Overrides let each case mutate exactly one field. */
const rec = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'm_1',
  tx: '2026-01-01T00:00:00.000Z',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
  type: 'assert',
  state: 'Fresh',
  content: 'the deploy target is staging',
  provenance: { source: 'user', sessionId: 's' },
  supersedes: null,
  blastRadius: null,
  reverifyTrigger: null,
  classification: 'normal',
  ...over,
});

/** Write a ledger whose lines are given VERBATIM (so a line can be a bare `null`), then recall. */
function recallOver(lines: string[]): { items: unknown[]; threw: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'helix-malformed-'));
  try {
    const path = join(dir, 'memory.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    const store = new MemoryStore(path);
    try {
      const r = store.recall('deploy target');
      return { items: r.items, threw: null };
    } catch (e) {
      return { items: [], threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('N1: a malformed ledger row must never brick a total function', () => {
  it('a bare `null` line does not throw in recall', () => {
    const out = recallOver([JSON.stringify(rec()), 'null']);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'type'
    expect(out.items).toHaveLength(1);     // the legitimate row still recalls
  });

  it('content: null does not throw in recall', () => {
    const evil = JSON.stringify({ ...rec({ id: 'm_2' }), content: null });
    const out = recallOver([JSON.stringify(rec()), evil]);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'normalize'
    expect(out.items).toHaveLength(1);
  });

  it('a non-object row (string / number / array) does not throw in recall', () => {
    const out = recallOver([JSON.stringify(rec()), '"pwned"', '42', '[]']);
    expect(out.threw).toBeNull();
    expect(out.items).toHaveLength(1);
  });

  it('id: null does not throw in compaction (marker predicate)', () => {
    const rows = [rec(), JSON.parse('{"id":null,"type":"verify","supersedes":null,"content":"","provenance":{}}')];
    expect(() => planCompaction(rows as MemoryRecord[], { erasedIds: new Set() })).not.toThrow();
  });

  it('a bare `null` row does not throw in compaction', () => {
    const rows = [rec(), JSON.parse('null')];
    expect(() => planCompaction(rows as MemoryRecord[], { erasedIds: new Set() })).not.toThrow();
  });

  it('a skipped row does not shift its neighbours out of the projection', () => {
    const a = rec({ id: 'm_a', content: 'the deploy target is staging' });
    const b = rec({ id: 'm_b', content: 'the deploy target is production' });
    const out = recallOver([JSON.stringify(a), 'null', JSON.stringify(b)]);
    expect(out.threw).toBeNull();
    expect(out.items).toHaveLength(2);
  });
});

describe('N1: the guard is MINIMAL — every legitimate shape survives byte-identically', () => {
  it('accepts a plain assert, a signed verify, an erase tombstone, and a marker', () => {
    const rows: MemoryRecord[] = [
      rec(),
      // signed verify: every optional HMAC field populated
      rec({ id: 'm_v', type: 'verify', state: 'Verified', supersedes: 'm_1', content: '',
            mac: 'ab'.repeat(32), gen: 1, targetDigest: 'cd'.repeat(32), keyId: 'ef01', macVersion: 2 }),
      // erase tombstone: content emptied by compaction
      rec({ id: 'm_e', type: 'erase', supersedes: 'm_1', content: '' }),
      // horizon marker: unsigned, null target, content-free
      rec({ id: 'horizon_x', type: 'verify', state: 'Suspect', content: '',
            provenance: { source: 'user', sessionId: 'compaction' } }),
    ];
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    expect(parseLedgerText(text)).toEqual(rows);   // deep-equal: nothing dropped, nothing mutated
  });

  it('does NOT reject an unknown type/state/timestamp (a future schema must not be data-lost)', () => {
    const future = { ...rec({ id: 'm_f' }), type: 'annotate', state: 'Provisional', macVersion: 99 };
    const text = JSON.stringify(future) + '\n';
    expect(parseLedgerText(text)).toEqual([future]);
  });
});
