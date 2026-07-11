import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLedgerText, parseLedger, compactLedger } from '../../src/memory/ledger.js';
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

/** Write a ledger whose lines are given VERBATIM (so a line can be a bare `null`), then compact it
 *  through the real `compactLedger` entry point — mirroring every production caller. Both
 *  `store.ts` call sites (maybeAutoCompact and permanent-erase) only ever hand `planCompaction` an
 *  array that already passed through `parseLedger`/`parseLedgerText`, never a hand-built
 *  `MemoryRecord[]`; calling `planCompaction` directly with raw `JSON.parse` output — as this file
 *  used to — exercises a shape no production caller produces, and would stay green even if the real
 *  guard in `parseLedgerText` were weakened. Returns whether compaction threw and the post-compaction
 *  records re-read from disk (not the in-memory plan), so a caller can prove the legitimate row
 *  actually survived the rewrite. */
function compactOver(lines: string[]): { records: MemoryRecord[]; threw: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'helix-malformed-'));
  try {
    const path = join(dir, 'memory.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    try {
      compactLedger(path, { erasedIds: new Set() });
      return { records: parseLedger(path), threw: null };
    } catch (e) {
      return { records: [], threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
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
    const good = rec();
    const out = compactOver([
      JSON.stringify(good),
      '{"id":null,"type":"verify","supersedes":null,"content":"","provenance":{}}',
    ]);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'startsWith'
    expect(out.records.find((r) => r.id === good.id)?.content).toBe(good.content); // legitimate row survives the rewrite
  });

  it('a bare `null` row does not throw in compaction', () => {
    const good = rec();
    const out = compactOver([JSON.stringify(good), 'null']);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'type'
    expect(out.records.find((r) => r.id === good.id)?.content).toBe(good.content); // legitimate row survives the rewrite
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

describe('N1 follow-up (CRITICAL): a malformed `tx` still bricks the recall tie-break (`.localeCompare`)', () => {
  // Two DISTINCT ids with IDENTICAL content tie on relevance, so ranking falls through to
  // `b.rec.tx.localeCompare(a.rec.tx)` (retrieval.ts). A malformed `tx` on either row makes that
  // total function throw -- exactly the class of bug isWellFormedRecord exists to close, but `tx`
  // was never in the guard.
  it('two distinct tx-omitted rows with identical content do not throw in recall (both structurally invalid, both dropped)', () => {
    const a = JSON.stringify({ ...rec({ id: 'm_a' }), tx: undefined });
    const b = JSON.stringify({ ...rec({ id: 'm_b' }), tx: undefined });
    const out = recallOver([a, b]);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'localeCompare'
    expect(out.items).toHaveLength(0);     // both rows are structurally invalid -> neither survives the parse boundary
  });

  it('two distinct tx: null rows with identical content do not throw in recall (both structurally invalid, both dropped)', () => {
    const a = JSON.stringify({ ...rec({ id: 'm_a' }), tx: null });
    const b = JSON.stringify({ ...rec({ id: 'm_b' }), tx: null });
    const out = recallOver([a, b]);
    expect(out.threw).toBeNull();          // today: TypeError … reading 'localeCompare'
    expect(out.items).toHaveLength(0);
  });

  it('control: two distinct rows with valid tx still recall (tie-break reached, no throw)', () => {
    const out = recallOver([JSON.stringify(rec({ id: 'm_a' })), JSON.stringify(rec({ id: 'm_b' }))]);
    expect(out.threw).toBeNull();
    expect(out.items).toHaveLength(2);     // both well-formed rows survive and recall
  });
});
