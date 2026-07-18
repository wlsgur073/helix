// Witnessed appends (spec 2026-07-17-high-water-counter-decision §4.2, W-T5): appends are
// UNCONDITIONAL (availability), but the witness only ADVANCES from a healthy pre-append verdict.
// Drives a REAL MemoryStore over a tmp home so the full commit/writeVerify/erase call sites are
// exercised exactly as production wires them (appendWitnessed / appendWitnessedUnlocked are never
// imported directly here — that would test the module in isolation, not the store integration).
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import {
  readScopeWitness, scopeKeyOf, planTransition, openTransition, classifyScope, WitnessBlockedError,
} from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';

function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-witnesswrite-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, {
    sessionId: 's', home, now: () => '2026-07-18T00:00:00.000Z', genId: () => `m_${++n}`,
  });
  return { store, ledger, home };
}

describe('appendWitnessed via MemoryStore.commit', () => {
  it('commit on a virgin scope mints a TOFU witness entry matching the file bytes', () => {
    const { store, ledger, home } = tmpStore();
    try {
      store.commit({ content: 'db is postgres', source: 'user' });
      const bytes = readFileSync(ledger);
      const state = readScopeWitness(home, scopeKeyOf(home));
      expect(state.macInvalid).toBe(false);
      expect(state.journal).toBeNull();
      expect(state.entry).not.toBeNull();
      expect(state.entry!.epoch).toBe(1); // TOFU
      expect(state.entry!.byteLength).toBe(bytes.length);
      expect(state.entry!.prefixHash).toBe(sha256Hex(bytes));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("a plain commit mints the ledger-mac master key too (the witness entry is MAC'd) — cross-cutting note", () => {
    const { store, home } = tmpStore();
    expect(existsSync(join(home, 'ledger-mac-master.key'))).toBe(false);
    store.commit({ content: 'db is postgres', source: 'user' });
    // advanceWitness MACs the witness entry via the SAME ensureMaster ledger-mac.ts already uses for
    // signed verifies (plan Global Constraints: "write paths may mint via ensureMaster") — so a
    // plain commit (no confirm/recheck) now mints the master key as a side effect, where before this
    // task only writeVerify (confirm/recheck) ever did. Several pre-existing tests assumed a bare
    // commit left the master unminted (store-metrics/history-store/store-asof/inspect-history/
    // compaction tests) — all adjusted to force genuine absence via rmSync where they specifically
    // need the key-absent replay path; this test pins the new behavior directly and explicitly.
    expect(existsSync(join(home, 'ledger-mac-master.key'))).toBe(true);
  });

  it('commit twice advances the witness in an in-sync chain (same epoch, growing byteLength)', () => {
    const { store, ledger, home } = tmpStore();
    try {
      store.commit({ content: 'fact one', source: 'user' });
      const first = readScopeWitness(home, scopeKeyOf(home)).entry!;

      store.commit({ content: 'fact two', source: 'user' });
      const bytes = readFileSync(ledger);
      const second = readScopeWitness(home, scopeKeyOf(home)).entry!;

      expect(second.epoch).toBe(first.epoch); // plain appends never bump the epoch (journal-only)
      expect(second.byteLength).toBe(bytes.length);
      expect(second.prefixHash).toBe(sha256Hex(bytes));
      expect(second.byteLength).toBeGreaterThan(first.byteLength);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('anti-laundering: an append after a rollback lands, but the witness stays UNTOUCHED and the mismatch persists', () => {
    const { store, ledger, home } = tmpStore();
    try {
      store.commit({ content: 'fact one', source: 'user' });
      store.commit({ content: 'fact two', source: 'user' });
      const witnessBeforeRoll = readScopeWitness(home, scopeKeyOf(home)).entry!;

      // Roll the ledger back to just its first line (simulates an out-of-band rollback/restore).
      const firstLine = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '')[0]!;
      writeFileSync(ledger, firstLine + '\n');

      // The next commit still lands (availability) ...
      store.commit({ content: 'fact three', source: 'user' });
      const onDisk = readFileSync(ledger, 'utf8');
      expect(onDisk).toContain('fact one');
      expect(onDisk).toContain('fact three');
      expect(onDisk).not.toContain('fact two'); // genuinely rolled back, not resurrected

      // ... but the witness entry is BYTE-IDENTICAL to its pre-rollback value: it never advanced
      // onto the forked head. The next legitimate write must NOT silently retire the alarm.
      const witnessAfter = readScopeWitness(home, scopeKeyOf(home)).entry!;
      expect(witnessAfter).toEqual(witnessBeforeRoll);

      // A read against the CURRENT bytes still verdicts mismatch — the alarm persists.
      const verdict = classifyScope(home, scopeKeyOf(home), readFileSync(ledger));
      expect(verdict.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a pending journal whose expected matches current bytes heals before the next append, then advances past the healed epoch', () => {
    const { store, ledger, home } = tmpStore();
    try {
      store.commit({ content: 'fact one', source: 'user' });
      const bytes = readFileSync(ledger);
      const key = scopeKeyOf(home);
      const p = planTransition(home, key, 'compaction');
      const journal = openTransition(home, key, {
        kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: bytes.length, prefixHash: sha256Hex(bytes) },
        tx: '2026-07-18T00:00:30.000Z',
      });
      expect(readScopeWitness(home, key).journal).not.toBeNull();

      store.commit({ content: 'fact two', source: 'user' }); // heals, then appends, then advances

      const afterBytes = readFileSync(ledger);
      const state = readScopeWitness(home, key);
      expect(state.journal).toBeNull(); // healed and cleared, not left pending
      expect(state.entry).not.toBeNull();
      expect(state.entry!.epoch).toBe(journal.epoch); // healed epoch; no further transition since
      expect(state.entry!.byteLength).toBe(afterBytes.length);
      expect(state.entry!.prefixHash).toBe(sha256Hex(afterBytes));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a pending journal whose expected does NOT match current bytes blocks the next commit with WitnessBlockedError; the ledger is byte-identical after', () => {
    const { store, ledger, home } = tmpStore();
    try {
      store.commit({ content: 'fact one', source: 'user' });
      const key = scopeKeyOf(home);
      const p = planTransition(home, key, 'erase');
      openTransition(home, key, {
        kind: 'erase', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: 999, prefixHash: sha256Hex(Buffer.from('nonsense-not-on-disk')) },
        tx: '2026-07-18T00:00:30.000Z',
      });
      const before = readFileSync(ledger, 'utf8');

      expect(() => store.commit({ content: 'fact two', source: 'user' })).toThrow(WitnessBlockedError);

      expect(readFileSync(ledger, 'utf8')).toBe(before); // ledger untouched
      expect(readScopeWitness(home, key).journal).not.toBeNull(); // still pending, unresolved
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('appendWitnessedUnlocked via MemoryStore.confirm (writeVerify path)', () => {
  it('store.confirm advances the witness under the same ledger lock', () => {
    const { store, ledger, home } = tmpStore();
    try {
      const a = store.commit({ content: 'db is postgres', source: 'user' });
      const key = scopeKeyOf(home);
      const before = readScopeWitness(home, key).entry!;

      store.confirm(a.id);

      const bytes = readFileSync(ledger);
      const after = readScopeWitness(home, key).entry!;
      expect(after.byteLength).toBe(bytes.length);
      expect(after.prefixHash).toBe(sha256Hex(bytes));
      expect(after.byteLength).toBeGreaterThan(before.byteLength);
      expect(after.epoch).toBe(before.epoch); // plain (unwitnessed-suffix) advance, no transition involved
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('WitnessBlockedError propagation out of store.erase (context point 6)', () => {
  it("erase's tombstone append is witnessed too — an interrupted transition blocks it, ledger byte-identical after", () => {
    const { store, ledger, home } = tmpStore();
    try {
      const a = store.commit({ content: 'db is postgres', source: 'user' });
      const key = scopeKeyOf(home);
      const p = planTransition(home, key, 'erase');
      openTransition(home, key, {
        kind: 'erase', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: 999, prefixHash: sha256Hex(Buffer.from('nonsense-not-on-disk')) },
        tx: '2026-07-18T00:00:30.000Z',
      });
      const before = readFileSync(ledger, 'utf8');

      expect(() => store.erase(a.id, { scope: 'global' })).toThrow(WitnessBlockedError);

      expect(readFileSync(ledger, 'utf8')).toBe(before); // ledger untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
