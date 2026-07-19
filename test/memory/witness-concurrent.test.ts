// Task 8 fix — spec §7 "concurrent reader spanning the two files". Every witnessed read reads the
// WITNESS snapshot FIRST and the LEDGER bytes SECOND, and RETRIES EXACTLY ONCE on an alarm verdict
// (mismatch OR transition-interrupted). Together these turn an ordinary concurrent append into a
// benign unwitnessed-suffix (never a spurious mismatch) and reclassify a transient epoch-transition
// interleave — WITHOUT ever masking a genuine, stable rollback.
//
// The order + retry live in ONE place: witnessedRead(readWitness, readLedger) in witness-read.ts. Its
// two read closures ARE the injection seam (spec §7 "read witness before ledger; on mismatch, re-read
// witness + journal once before verdicting") — the unit tests drive it with stub closures to exercise
// the interleave/retry deterministically; the production helpers (readLedgerWitnessed /
// readLedgerBytesWitnessed) pass the real disk reads. Integration tests then prove store.recall wires
// the fixed read path end to end.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import {
  witnessedRead, readLedgerWitnessed, readLedgerBytesWitnessed,
} from '../../src/memory/witness-read.js';
import {
  advanceWitness, classifyState, scopeKeyOf,
  type ScopeWitnessState,
} from '../../src/memory/witness-store.js';
import { sha256Hex, type WitnessEntry, type JournalEntry } from '../../src/memory/witness-core.js';
import { appendRecord, readLedgerBytes } from '../../src/memory/ledger.js';
import * as ledgerMod from '../../src/memory/ledger.js';
import { WITNESS_MISMATCH_NOTE } from '../../src/memory/content-frame.js';
import type { MemoryRecord } from '../../src/types.js';

const FIXED = '2026-07-18T00:00:00.000Z';
function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witconc-')); }

const rec = (over: Partial<MemoryRecord> & { id: string }): MemoryRecord => ({
  tx: FIXED, validFrom: FIXED, validTo: null, type: 'assert', state: 'Fresh', content: 'x',
  provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal', ...over,
});

// A ScopeWitnessState that classifies a `byteLength`-long buffer as in-sync (and any strict prefix as
// mismatch, any longer append-preserving buffer as unwitnessed-suffix). Pure data — no disk, no MAC.
function stateAt(bytes: Buffer): ScopeWitnessState {
  const entry: WitnessEntry = {
    epoch: 1, byteLength: bytes.length, prefixHash: sha256Hex(bytes), headTx: null, mac: 'entry-mac',
  };
  return { entry, journal: null, macInvalid: false };
}
function pendingState(expected: Buffer): ScopeWitnessState {
  const journal: JournalEntry = {
    kind: 'compaction', epoch: 2, predecessor: null,
    expected: { byteLength: expected.length, prefixHash: sha256Hex(expected) },
    nonce: 'n', tx: FIXED, supersedes: null, mac: 'journal-mac',
  };
  return { entry: null, journal, macInvalid: false };
}

// A pair of read closures that return `first` on call #1 and `second` on every later call, while
// counting invocations — the minimal deterministic seam for the retry (1st read alarms, 2nd resolves).
function seam<T>(first: T, second: T): { read: () => T; calls: () => number } {
  let n = 0;
  return { read: () => (++n === 1 ? first : second), calls: () => n };
}

// SUSTAINED concurrent-append seam (Fix loop 2 — the ORDER discriminator). One shared tick advances on
// EVERY read; a fresh append lands between the two reads of each pair, so whichever read fires SECOND
// always observes exactly one append MORE than the read that fired FIRST — and this holds on the
// retry's pair too, so a ledger-first reader cannot self-heal. States are append-preserving
// (bytesAt(i+1) extends bytesAt(i)), so:
//   - WITNESS-FIRST (correct): witness snapshot @ M paired with the LONGER ledger read afterward ->
//     unwitnessed-suffix (benign), no retry.
//   - LEDGER-FIRST (the release-blocking bug): the shorter ledger read first, then the ADVANCED witness
//     -> ledger shorter than the witnessed byteLength -> mismatch, on both the attempt and the retry.
// The read that fires first in each pair sees the pre-append state; the second sees post-append. Pair k
// reads at ticks 2k, 2k+1 -> stateIndex ceil(t/2) = M_k, M_{k+1}.
function sustainedAppendSeam(): { readWitness: () => ScopeWitnessState; readLedger: () => { bytes: Buffer }; ticks: () => number } {
  let tick = 0;
  const stateIndex = (t: number): number => Math.floor((t + 1) / 2);
  const bytesAt = (i: number): Buffer =>
    Buffer.from(Array.from({ length: i + 1 }, (_, n) => `row-${n}\n`).join(''), 'utf8');
  return {
    readWitness: () => stateAt(bytesAt(stateIndex(tick++))),
    readLedger: () => ({ bytes: bytesAt(stateIndex(tick++)) }),
    ticks: () => tick,
  };
}

describe('witnessedRead — witness-first ordering + retry-once (spec §7)', () => {
  describe('append-race benign: an ordinary concurrent append never yields a spurious mismatch', () => {
    it('report repro at the classify level: fresh-witness vs stale-bytes is mismatch, but witness-first (stale-witness vs fresh-bytes) is unwitnessed-suffix', () => {
      const stale = Buffer.from('row-one\n', 'utf8');
      const fresh = Buffer.from('row-one\nrow-two-longer\n', 'utf8'); // append preserves the prefix
      const staleWitness = stateAt(stale);
      const freshWitness = stateAt(fresh);
      // LEDGER-FIRST hazard (the OLD order): stale ledger bytes held, fresher witness read second.
      expect(classifyState(freshWitness, stale).kind).toBe('mismatch');
      // WITNESS-FIRST fix: stale witness held, fresher ledger read second -> benign.
      expect(classifyState(staleWitness, fresh).kind).toBe('unwitnessed-suffix');
    });

    it('drives witnessedRead across a concurrent append (witness stale, ledger advanced) -> unwitnessed-suffix, NO retry', () => {
      const stale = Buffer.from('row-one\n', 'utf8');
      const fresh = Buffer.from('row-one\nrow-two-longer\n', 'utf8');
      let witnessReads = 0; let ledgerReads = 0;
      const out = witnessedRead(
        () => { witnessReads += 1; return stateAt(stale); },   // witness FIRST: captured before the append
        () => { ledgerReads += 1; return { bytes: fresh }; },  // ledger SECOND: the append already landed
      );
      expect(out.verdict.kind).toBe('unwitnessed-suffix'); // benign — not an alarm
      expect(witnessReads).toBe(1);                        // benign verdict => exactly one read pair
      expect(ledgerReads).toBe(1);
      expect(out.ledger.bytes).toBe(fresh);               // downstream uses the bytes we classified
    });

    it('integration: store.recall does NOT clamp a previously-Verified row and emits NO mismatch note from a mere concurrent append (witness behind ledger = unwitnessed-suffix)', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      let n = 0;
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` });
      try {
        const a = store.commit({ content: 'alpha deploy config fact', source: 'user' });
        store.confirm(a.id); // A -> Verified, witnessed in-sync at the full ledger
        // A concurrent append that the witness has NOT yet advanced over: the reader sees witness@L_old
        // + ledger@L_new (append-preserving). This is exactly the append-race end-state, classified
        // benignly as unwitnessed-suffix.
        appendRecord(ledger, rec({ id: 'm_concurrent', content: 'bravo landed concurrently' }));

        const res = store.recall('alpha');
        const hitA = res.items.find((i) => i.record.id === a.id)!;
        expect(hitA).toBeDefined();                 // still served
        expect(hitA.record.state).toBe('Verified'); // NOT clamped by a spurious mismatch
        expect(res.witnessNotes).not.toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('retry-does-not-mask-rollback (SAFETY-CRITICAL): a stable genuine rollback still verdicts mismatch AFTER the retry', () => {
    it('witnessedRead over a STABLE rollback (both reads see the shorter, non-descending bytes) -> mismatch, and it DID retry (two read pairs)', () => {
      const witnessed = Buffer.from('row-one\nrow-two\n', 'utf8'); // witness attests this length
      const rolledBack = Buffer.from('DIFFERENT\n', 'utf8');       // shorter AND not a prefix: genuine mismatch
      const wSeam = seam(stateAt(witnessed), stateAt(witnessed));  // stable witness across both reads
      const lSeam = seam({ bytes: rolledBack }, { bytes: rolledBack }); // stable rolled-back bytes
      const out = witnessedRead(wSeam.read, lSeam.read);
      expect(out.verdict.kind).toBe('mismatch');  // retry did NOT swallow it
      expect(wSeam.calls()).toBe(2);              // it retried (alarm on the first verdict)
      expect(lSeam.calls()).toBe(2);
      expect(out.ledger.bytes).toBe(rolledBack);  // final downstream = the re-read pair
    });

    it('integration: a genuine same-length fork of the witnessed ledger STILL clamps the Verified row to Fresh and notes (retry never weakens real detection)', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      let n = 0;
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` });
      try {
        const a = store.commit({ content: 'alpha target deploy fact', source: 'user' });
        store.confirm(a.id);
        store.commit({ content: 'gamma tail filler UNIQUEFORKZ', source: 'user' }); // fork victim
        const bytes = readLedgerBytes(ledger);
        // Same-length byte fork of the tail: bytes.length is unchanged so it is NOT a suffix; the prefix
        // hash diverges -> a STABLE mismatch that both reads of the retry see identically.
        const forked = Buffer.from(bytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
        expect(forked.length).toBe(bytes.length);
        expect(forked.equals(bytes)).toBe(false);
        writeFileSync(ledger, forked);

        const res = store.recall('alpha');
        const hitA = res.items.find((i) => i.record.id === a.id)!;
        expect(hitA.record.state).toBe('Fresh');                    // D1 clamp survived the retry
        expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);  // note survived the retry
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('retry-resolves-transient: a transient interleave flips alarm -> benign ONLY when the second read genuinely resolves', () => {
    it('mismatch on read #1, in-sync on read #2 (a concurrent REWRITE completed) -> final verdict in-sync', () => {
      const oldHead = Buffer.from('row-one\nrow-two\n', 'utf8');
      const rewritten = Buffer.from('compacted-row\n', 'utf8');
      // Read #1: witness still at the OLD epoch, bytes ALREADY rewritten -> the old entry no longer
      // matches -> mismatch (the transient). Read #2: witness advanced to the rewritten head -> in-sync.
      const wSeam = seam(stateAt(oldHead), stateAt(rewritten));
      const lSeam = seam({ bytes: rewritten }, { bytes: rewritten });
      const out = witnessedRead(wSeam.read, lSeam.read);
      expect(out.verdict.kind).toBe('in-sync'); // retry resolved the transient
      expect(wSeam.calls()).toBe(2);
      expect(lSeam.calls()).toBe(2);
      // Final witness state (identity/journalPending source) is the resolved SECOND read, not the first.
      expect(out.state.entry?.byteLength).toBe(rewritten.length);
    });

    it('transition-interrupted on read #1, in-sync on read #2 -> resolved to in-sync', () => {
      const target = Buffer.from('row-one\nrow-two\nfence\n', 'utf8');
      // Read #1: a journal is pending and the on-disk bytes are still the OLD head (rewrite not landed)
      // -> transition-interrupted. Read #2: the transition completed -> witness at target, in-sync.
      const wSeam = seam(pendingState(target), stateAt(target));
      const lSeam = seam({ bytes: Buffer.from('row-one\n', 'utf8') }, { bytes: target });
      const out = witnessedRead(wSeam.read, lSeam.read);
      expect(out.verdict.kind).toBe('in-sync');
      expect(wSeam.calls()).toBe(2);
      expect(lSeam.calls()).toBe(2);
    });

    it('does NOT flip when the second read still alarms: alarm on BOTH reads -> the SECOND verdict stands (no loop)', () => {
      const target = Buffer.from('row-one\nrow-two\nfence\n', 'utf8');
      const still = Buffer.from('row-one\n', 'utf8');
      const wSeam = seam(pendingState(target), pendingState(target)); // still pending on the re-read
      const lSeam = seam({ bytes: still }, { bytes: still });          // rewrite still not landed
      const out = witnessedRead(wSeam.read, lSeam.read);
      expect(out.verdict.kind).toBe('transition-interrupted'); // still an alarm after exactly one retry
      expect(wSeam.calls()).toBe(2);                            // exactly one retry — never a third read
      expect(lSeam.calls()).toBe(2);
    });
  });

  describe('production helpers route through the shared order+retry', () => {
    it('readLedgerWitnessed on a real stable mismatch re-reads but still reports mismatch (retry idempotent on stable disk)', () => {
      const home = newHome();
      try {
        const ledger = join(home, 'memory.jsonl');
        writeFileSync(ledger, [JSON.stringify(rec({ id: 'm_1' })), JSON.stringify(rec({ id: 'm_2' }))].join('\n') + '\n');
        advanceWitness(home, scopeKeyOf(home), readFileSync(ledger), null);
        writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n'); // truncate to a strict prefix -> mismatch
        expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('mismatch');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('readLedgerBytesWitnessed is bytes-only (no records field) and reports the same verdict as the parsing helper', () => {
      const home = newHome();
      try {
        const ledger = join(home, 'memory.jsonl');
        writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');
        appendFileSync(ledger, JSON.stringify(rec({ id: 'm_2' })) + '\n');
        advanceWitness(home, scopeKeyOf(home), readLedgerBytes(ledger), null); // in-sync at full ledger
        const b = readLedgerBytesWitnessed(ledger, home);
        expect(b.verdict.kind).toBe('in-sync');
        expect(b.witnessIdentity).not.toBe('witness-absent');
        expect(b.journalPending).toBe(false);
        expect((b as unknown as { records?: unknown }).records).toBeUndefined(); // bytes-only: zero-parse
        expect(b.bytes.equals(readLedgerBytes(ledger))).toBe(true);
        expect(typeof b.readMs).toBe('number');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  // Fix loop 2 (efficacy). The tests above lock the retry + classify PROPERTIES but none of them
  // discriminates witness-first from ledger-first, nor catches a parse-and-discard on a cache HIT — so
  // the release-blocking regression (reversing the read order) or the Task-4 regression (parsing on a
  // HIT) could be reintroduced and leave the suite GREEN. These two locks close that: each is
  // mutation-verified to go RED under exactly the reversal/parse it exists to catch (see
  // task-8-fix-report.md "Fix loop 2").
  describe('efficacy locks — the regression this file exists to catch actually goes RED', () => {
    it('ORDER LOCK: a SUSTAINED concurrent append is benign witness-first, but a ledger-first reversal makes it mismatch (RED under the reversal)', () => {
      // Under witness-first (correct): witness@M paired with the LONGER ledger read afterward ->
      // unwitnessed-suffix, no retry (exactly one read pair). Under ledger-first (the bug): the shorter
      // ledger read first, then the advanced witness -> mismatch on the attempt AND the sustained retry.
      const s = sustainedAppendSeam();
      const out = witnessedRead(s.readWitness, s.readLedger);
      expect(out.verdict.kind).toBe('unwitnessed-suffix'); // <- flips to 'mismatch' iff reads are ledger-first
      expect(s.ticks()).toBe(2);                            // benign => one read pair (no retry). Ledger-first => 4.
    });

    it('ZERO-PARSE-ON-HIT LOCK: a recall cache HIT triggers ZERO ledger parses through the witnessed path (RED if readLedgerBytesWitnessed parses)', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      let n = 0;
      const box = { replays: 0 };
      const store = new MemoryStore(ledger, {
        home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
        metricsSink: { emitReplay: () => { box.replays += 1; }, emitCompaction: () => {}, runOp: async (_t, fn) => await fn() },
      });
      // readLedgerRaw is the ONLY read+parse entry the witnessed read path could route through; the
      // correct bytes-only path (readLedgerBytes) never calls it. Spy it AFTER the cold recall warms the
      // cache, so we count only what the HIT does.
      const parseSpy = vi.spyOn(ledgerMod, 'readLedgerRaw');
      try {
        store.commit({ content: 'cacheable deploy fact', source: 'user' });
        store.recall('deploy');                 // MISS -> warms the single-slot cache
        box.replays = 0;
        parseSpy.mockClear();
        const before = store.recall('deploy');   // HIT
        // It is a genuine HIT (no verifying replay emitted) AND it parsed the ledger ZERO times.
        expect(box.replays).toBe(0);
        expect(parseSpy).toHaveBeenCalledTimes(0); // <- becomes >=1 iff the witnessed read parses on the HIT
        // sanity: the HIT still answered (cache is not simply broken to zero rows)
        expect(before.items.length).toBeGreaterThan(0);
      } finally { parseSpy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
    });
  });
});
