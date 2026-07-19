// Anti-laundering regression lock (spec 2026-07-17-high-water-counter-decision §4.2, pre-registered
// Critical PR-1; SECURITY.md: "the very next ordinary append after a rollback can never silently
// launder the alarm away"). The witnessed APPEND path already refuses to advance the witness over a
// mismatch (witness-write.ts); these tests lock the same invariant on the witnessed REWRITE path
// (compactLedger + its two production callers, store.erase and maybeAutoCompact). Driven over real
// ledger files + a real MemoryStore, so a missing gate is observable end to end.
//
// MUTATION NOTE: deleting the `if (verdict.kind === 'mismatch') throw` gate in compactLedger's witness
// block turns the first test RED (the rewrite would advance the witness onto the fork). The third test
// is the complementary lock: it goes RED if the gate over-refuses (e.g. `!advanceAllowed(verdict)`),
// because a legitimate transition-interrupted re-drive must still compact.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { MemoryStore } from '../../src/memory/store.js';
import { compactLedger, readLedgerBytes, witnessFenceRecord } from '../../src/memory/ledger.js';
import {
  readScopeWitness, planTransition, openTransition, WitnessBlockedError,
} from '../../src/memory/witness-store.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import type { CompactionConfig } from '../../src/config.js';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-antilaunder-')); }
const FIXED = '2026-07-18T00:00:00.000Z';

function makeStore(home: string): MemoryStore {
  return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't', now: () => FIXED });
}

describe('anti-laundering — a witnessed rewrite never advances the witness over a mismatch (spec §4.2 PR-1)', () => {
  it('compactLedger over a MISMATCH throws WitnessBlockedError and leaves the witness + ledger UNTOUCHED', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
      const before = readScopeWitness(home, '@global').entry!;

      // ROLLBACK / FORK: overwrite the ledger with content that does NOT descend from the witnessed head
      // — a forged row planted as Verified. No pending journal => a stable MISMATCH (the rollback alarm
      // the whole feature exists to catch). A laundering compaction would bless this into a fresh epoch.
      const forged: MemoryRecord = {
        id: 'forged_1', tx: FIXED, validFrom: FIXED, validTo: null, type: 'assert', state: 'Verified',
        content: 'forged elevated content that a laundering rewrite would re-serve as Verified',
        provenance: { source: 'user', sessionId: 't' },
        supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      };
      const forgedBytes = JSON.stringify(forged) + '\n';
      writeFileSync(ledger, forgedBytes);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch'); // the alarm is live

      // The witnessed rewrite MUST refuse to advance the witness onto the forked content.
      let caught: unknown;
      try {
        compactLedger(ledger, {
          erasedIds: new Set(),
          witness: { home, scopeKey: '@global', now: () => '2026-07-18T00:05:00.000Z', kind: 'compaction' },
        });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(WitnessBlockedError);
      expect((caught as WitnessBlockedError).op).toBe('compaction');
      expect((caught as Error).message).toMatch(/^compaction: /);

      // The witness entry is UNCHANGED (never bumped to a fresh epoch over the fork), the scope STILL
      // verdicts MISMATCH (alarm not retired), and the ledger is byte-identical (tmp cleaned up, no
      // rename, no journal opened) — the throw is total.
      const after = readScopeWitness(home, '@global');
      expect(after.entry!.epoch).toBe(before.epoch);
      expect(after.entry!.byteLength).toBe(before.byteLength);
      expect(after.entry!.prefixHash).toBe(before.prefixHash);
      expect(after.journal).toBeNull();
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
      expect(readLedgerBytes(ledger).toString('utf8')).toBe(forgedBytes);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("permanent-erase that loses the advisory-precheck race is labeled 'permanent-erase' at the authoritative gate, never 'compaction'", () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      // Emulate the race: the advisory precheck in store.erase has already passed when a concurrent
      // writer forks the ledger; the under-lock gate inside compactLedger is what actually refuses.
      // Invoke the rewrite directly with kind 'erase' over a mismatched scope.
      const forged: MemoryRecord = {
        id: 'forged_2', tx: FIXED, validFrom: FIXED, validTo: null, type: 'assert', state: 'Verified',
        content: 'forked content', provenance: { source: 'user', sessionId: 't' },
        supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      };
      writeFileSync(ledger, JSON.stringify(forged) + '\n');
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
      let caught: unknown;
      try {
        compactLedger(ledger, { erasedIds: new Set(), witness: { home, scopeKey: '@global', now: () => '2026-07-18T00:05:00.000Z', kind: 'erase' } });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(WitnessBlockedError);
      expect((caught as WitnessBlockedError).op).toBe('permanent-erase');
      expect((caught as Error).message).toMatch(/^permanent-erase: /);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('permanent erase over a MISMATCH is refused up front (no tombstone-without-compaction half-state)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });
      const before = readScopeWitness(home, '@global').entry!;

      // Roll the ledger back to a forked state (mismatch) whose live content is a forged row — then
      // attempt to PERMANENTLY erase that forged row. The erase's tombstone+compaction would advance
      // the witness onto the fork, so the whole permanent erase must be refused up front.
      const forged: MemoryRecord = {
        id: 'forged_1', tx: FIXED, validFrom: FIXED, validTo: null, type: 'assert', state: 'Verified',
        content: 'forged forked content', provenance: { source: 'user', sessionId: 't' },
        supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
      };
      const forgedBytes = JSON.stringify(forged) + '\n';
      writeFileSync(ledger, forgedBytes);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');

      let caught: unknown;
      try { store.erase('forged_1', { permanent: true, scope: 'global' }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(WitnessBlockedError);
      expect((caught as WitnessBlockedError).op).toBe('permanent-erase');
      expect((caught as Error).message).toMatch(/^permanent-erase: /);

      // Refused BEFORE any side effect: no tombstone appended, witness untouched, still a mismatch.
      expect(readLedgerBytes(ledger).toString('utf8')).toBe(forgedBytes); // no tombstone row added
      expect(readScopeWitness(home, '@global').entry!.epoch).toBe(before.epoch);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('end-to-end: a recall with auto-compaction ON never launders a rolled-back scope (maybeAutoCompact skips the mismatch)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const enabled: CompactionConfig = { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 };
      const FUTURE = '2100-01-01T00:00:00.000Z'; // makes any real ledger mtime "old" => quiescence passes
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });

      // Churn to a dirty, compaction-ELIGIBLE ledger (11 physical rows, 6 live) and capture it as the
      // rollback target — absent the skip this scope WOULD auto-compact on the next recall MISS.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(store.commit({ content: `fact ${i} deploy`, source: 'user' }).id);
      for (let i = 0; i < 5; i++) store.commit({ content: `fact ${i} updated deploy`, source: 'user', supersedes: ids[i]! });
      const rolledBack = readLedgerBytes(ledger);            // dirty + witness in-sync with it
      // One more witnessed append advances the witness PAST the captured bytes.
      store.commit({ content: 'newest deploy fact', source: 'user' });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');

      // ROLLBACK: restore the earlier (shorter) bytes — not a prefix of the witnessed head => mismatch.
      writeFileSync(ledger, rolledBack);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
      const before = readScopeWitness(home, '@global').entry!;

      store.recall('deploy'); // MISS -> would fire maybeAutoCompact on this eligible-but-mismatched scope

      // The witness never advanced onto the rolled-back bytes: same epoch/head, alarm persists.
      const after = readScopeWitness(home, '@global').entry!;
      expect(after.epoch).toBe(before.epoch);
      expect(after.byteLength).toBe(before.byteLength);
      expect(after.prefixHash).toBe(before.prefixHash);
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('does NOT over-refuse: a transition-interrupted scope still compacts (re-drive supersedes -> in-sync)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = makeStore(home);
      store.commit({ content: 'alpha fact', source: 'user' });
      store.commit({ content: 'bravo fact', source: 'user' });
      const b0 = readLedgerBytes(ledger);
      const e0 = readScopeWitness(home, '@global').entry!;

      // Open a transition AHEAD of the entry promising a NEW head that never lands, leaving OLD bytes ->
      // transition-interrupted (a pending journal whose expected head != the current ledger).
      const plan = planTransition(home, '@global', 'compaction');
      const targetText = b0.toString('utf8')
        + JSON.stringify(witnessFenceRecord(plan.epoch, plan.nonce, '2026-07-18T00:05:00.000Z')) + '\n';
      const expected = { byteLength: Buffer.byteLength(targetText), prefixHash: sha256Hex(Buffer.from(targetText)) };
      openTransition(home, '@global', {
        kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
        supersedes: plan.supersedes, expected, tx: '2026-07-18T00:05:00.000Z',
      });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');

      // The gate refuses 'mismatch' ONLY — a transition-interrupted scope is the legitimate re-drive
      // path and MUST still compact. A naive `!advanceAllowed(verdict)` gate would wrongly throw here.
      compactLedger(ledger, {
        erasedIds: new Set(),
        witness: { home, scopeKey: '@global', now: () => '2026-07-18T00:06:00.000Z', kind: 'compaction' },
      });
      expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('in-sync');
      const after = readScopeWitness(home, '@global');
      expect(after.journal).toBeNull();
      expect(after.entry!.epoch).toBeGreaterThan(e0.epoch);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
