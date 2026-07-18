import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../src/types.js';
import { parseLedger, readLedgerRaw } from '../../src/memory/ledger.js';
import { advanceWitness, openTransition, scopeKeyOf, witnessPath } from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import { gatherScopedRecords } from '../../src/hooks/session-start.js';
import { MemoryStore } from '../../src/memory/store.js';

function tmpHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witnessread-')); }

const rec = (over: Partial<MemoryRecord> & { id: string }): MemoryRecord => ({
  tx: '2026-07-18T00:00:00.000Z', validFrom: '2026-07-18T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content: 'x',
  provenance: { source: 'user', sessionId: 's' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  ...over,
});

// Step 1a: readLedgerRaw must be a byte-faithful drop-in for parseLedger's record output, plus the
// health signal (skippedNonBlank) parseLedger itself discards. Both must tolerate the same malformed
// lines identically — this is what makes it safe for every grade-assigning reader to converge on it.
describe('readLedgerRaw parity with parseLedger (Step 1a)', () => {
  it('identical records to parseLedger on a fixture with a JSON-parse-failure line AND a structurally-invalid line', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const a = rec({ id: 'm_1', content: 'alpha' });
      const b = rec({ id: 'm_2', content: 'bravo' });
      writeFileSync(ledger, [
        JSON.stringify(a),
        'not-json{{{',                 // torn line: JSON.parse itself throws
        JSON.stringify({ id: 123 }),   // valid JSON, wrong shape: id must be a string
        JSON.stringify(b),
      ].join('\n') + '\n');

      const viaParseLedger = parseLedger(ledger);
      const raw = readLedgerRaw(ledger);

      expect(raw.records).toEqual(viaParseLedger);
      expect(raw.records).toEqual([a, b]);
      expect(raw.skippedNonBlank).toBe(2); // both bad lines counted
      expect(Buffer.isBuffer(raw.bytes)).toBe(true);
      expect(raw.bytes.length).toBe(readFileSync(ledger).length);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('ENOENT -> {bytes: Buffer.alloc(0), records: [], skippedNonBlank: 0}, matching parseLedger\'s [] convention', () => {
    const home = tmpHome();
    try {
      const missing = join(home, 'nope.jsonl');
      const raw = readLedgerRaw(missing);
      expect(raw.bytes).toEqual(Buffer.alloc(0));
      expect(raw.records).toEqual([]);
      expect(raw.skippedNonBlank).toBe(0);
      expect(parseLedger(missing)).toEqual([]); // parity with the existing ENOENT convention
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Step 1b: readLedgerWitnessed is a PURE read — it classifies current bytes against whatever witness
// state already exists on disk, never mints or advances anything itself.
describe('readLedgerWitnessed verdict (Step 1b)', () => {
  it('first-contact on a virgin home (no witness entry, no journal)', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');

      const w = readLedgerWitnessed(ledger, home);
      expect(w.verdict).toEqual({ kind: 'first-contact', reason: 'no-entry' });
      expect(w.witnessIdentity).toBe('witness-absent');
      expect(w.journalPending).toBe(false);
      expect(w.records).toHaveLength(1);
      expect(w.bytes.length).toBe(readFileSync(ledger).length);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('in-sync after advanceWitness records the SAME bytes readLedgerWitnessed sees', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');
      const bytes = readFileSync(ledger);
      advanceWitness(home, scopeKeyOf(home), bytes, null);

      const w = readLedgerWitnessed(ledger, home);
      expect(w.verdict).toEqual({ kind: 'in-sync' });
      expect(w.witnessIdentity).not.toBe('witness-absent');
      expect(typeof w.witnessIdentity).toBe('string');
      expect(w.witnessIdentity.length).toBeGreaterThan(0);
      expect(w.journalPending).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('mismatch after the file is truncated relative to the witnessed head', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, [JSON.stringify(rec({ id: 'm_1' })), JSON.stringify(rec({ id: 'm_2' }))].join('\n') + '\n');
      const bytes = readFileSync(ledger);
      advanceWitness(home, scopeKeyOf(home), bytes, null);

      // Truncate to a strict PREFIX (shorter than the witnessed byteLength) — classifyWitness's
      // matchesAt short-circuits `bytes.length < byteLength` to false regardless of hash, so this is
      // 'mismatch', not 'unwitnessed-suffix' (which requires a LONGER file).
      writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');
      const w = readLedgerWitnessed(ledger, home);
      expect(w.verdict).toEqual({ kind: 'mismatch' });
      // witnessIdentity still reflects the (still-valid, untouched) witness entry — mismatch is a
      // property of the CURRENT bytes vs. that entry, not a reason to hide the entry's own identity.
      expect(w.witnessIdentity).not.toBe('witness-absent');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // Beyond the brief's enumerated 3 verdict scenarios: journalPending is a separate field on the SAME
  // produced interface, and none of the three above exercise it true — a hardcoded `false` would pass
  // all three. openTransition (witness-store.ts) opens a journal without touching the ledger file, so
  // the on-disk bytes stay the OLD witnessed head while a journal for a DIFFERENT (not-yet-written)
  // expected head is pending — journal-first classification (witness-core.ts) makes this
  // 'transition-interrupted', not 'mismatch'.
  it('journalPending is true while a transition is open but not yet completed or cleared', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');
      const bytes = readFileSync(ledger);
      advanceWitness(home, scopeKeyOf(home), bytes, null);

      const target = Buffer.from(bytes.toString('utf8') + JSON.stringify(rec({ id: 'm_2' })) + '\n', 'utf8');
      openTransition(home, scopeKeyOf(home), {
        kind: 'compaction',
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) },
        tx: '2026-07-18T00:00:00.000Z',
      });

      const w = readLedgerWitnessed(ledger, home); // on-disk bytes are still the OLD head
      expect(w.journalPending).toBe(true);
      expect(w.verdict.kind).toBe('transition-interrupted');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Fix loop 1: readLedgerWitnessed now takes exactly ONE witness.json snapshot (readScopeWitness) and
// derives verdict/witnessIdentity/journalPending all from that SAME state object, rather than
// classifyScope's own internal second read. A macInvalid scope is the discriminating case: BEFORE the
// fix, `verdict` came from a fresh classifyScope(...) call and `witnessIdentity`/`journalPending` came
// from a SEPARATE readScopeWitness(...) call — two independent lock-free reads of the same file. This
// test cannot observe a genuine cross-call race (that needs a real concurrent writer), but it pins the
// CONTRACT: all three fields must agree with what ONE state snapshot says, which is what makes the
// two-read version and the one-read version behaviorally indistinguishable on this fixture — and what
// a future reviewer can rely on when reasoning about consistency.
describe('Fix loop 1: single witness.json snapshot — consistent triplet under macInvalid', () => {
  it('a tampered entry mac degrades verdict, witnessIdentity, AND journalPending together', () => {
    const home = tmpHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      writeFileSync(ledger, JSON.stringify(rec({ id: 'm_1' })) + '\n');
      const bytes = readFileSync(ledger);
      const scopeKey = scopeKeyOf(home);
      advanceWitness(home, scopeKey, bytes, null);

      // Tamper the stored entry's mac on disk (same technique as witness-store.test.ts's tamper test).
      const raw = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { entry: { mac: string } }>;
      };
      const mac = raw.scopes[scopeKey]!.entry.mac;
      raw.scopes[scopeKey]!.entry.mac = (mac[0] === 'a' ? 'b' : 'a') + mac.slice(1);
      writeFileSync(witnessPath(home), JSON.stringify(raw));

      const w = readLedgerWitnessed(ledger, home);
      expect(w.verdict).toEqual({ kind: 'first-contact', reason: 'mac-invalid' });
      expect(w.witnessIdentity).toBe('witness-absent');
      expect(w.journalPending).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Step 1c: gatherScopedRecords (the SessionStart hook's pure core) is NOT edited by this task — it
// inherits the verifiedLiveStats -> readLedgerRaw reroute automatically. This pins its output on a
// real owned-project + global fixture (mixed live/Verified/scope), a regression harness proving the
// byte-source substitution changed nothing observable.
describe('hook path parity: gatherScopedRecords unchanged after the reroute (Step 1c)', () => {
  it('an owned project + global fixture yields the same records/integrity/replay shape through the rerouted verifiedLiveStats', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-witnessread-hook-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-witnessread-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    const projLedger = join(proj, '.helix', 'memory.jsonl');
    try {
      const store = new MemoryStore(globalLedger, {
        sessionId: 's', home, project: { ledger: projLedger, root: proj, home },
      });
      store.commit({ content: 'global fact one', scope: 'global', source: 'user' });
      const owned = store.commit({ content: 'project fact confirmed', scope: 'project', source: 'user' });
      store.confirm(owned.id); // signed Verified — exercises the MAC-verifying replay end to end

      const { records, integrityAvailable, replays, projectDisposition } =
        gatherScopedRecords({ home, globalLedger, cwd: proj });

      expect(projectDisposition).toBe('owned');
      expect(integrityAvailable).toBe(true);
      const byContent = new Map(records.map((r) => [r.record.content, r]));
      expect(byContent.get('global fact one')).toMatchObject({ scope: 'global' });
      expect(byContent.get('global fact one')!.record.state).toBe('Fresh');
      expect(byContent.get('project fact confirmed')).toMatchObject({ scope: 'project' });
      expect(byContent.get('project fact confirmed')!.record.state).toBe('Verified');

      expect(replays).toHaveLength(2);
      const g = replays.find((r) => r.scope === 'global')!;
      const p = replays.find((r) => r.scope === 'project')!;
      expect(g).toMatchObject({ rows: 1, liveRows: 1, keyAvailable: true });
      expect(g.bytes).toBe(readFileSync(globalLedger).length); // raw byte length, exact (no stat race)
      expect(p).toMatchObject({ rows: 2, liveRows: 1, keyAvailable: true }); // assert + its signed verify
      expect(p.bytes).toBe(readFileSync(projLedger).length);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
