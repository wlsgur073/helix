import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  witnessPath, witnessLogPath, scopeKeyOf, readScopeWitness, classifyScope, classifyState,
  advanceWitness, planTransition, openTransition, completeTransition, maybeCleanupClear,
  WitnessAdvanceError, WitnessBlockedError,
} from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';

function tmpHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witness-')); }

describe('witnessPath / witnessLogPath / scopeKeyOf', () => {
  it('scopeKeyOf: @global with no projectRoot, resolve(projectRoot) otherwise (registry-key convention)', () => {
    const home = tmpHome();
    try {
      expect(scopeKeyOf(home)).toBe('@global');
      expect(scopeKeyOf(home, '/tmp/some-proj')).toBe(resolve('/tmp/some-proj'));
      expect(scopeKeyOf(home, 'relative/proj')).toBe(resolve('relative/proj'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('round-trip / tamper / anti-laundering / key-absent', () => {
  it('round-trip: advanceWitness then readScopeWitness returns the entry; MAC verifies; file mode 0600', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1');
      const state = readScopeWitness(home, '@global');
      expect(state.macInvalid).toBe(false);
      expect(state.journal).toBeNull();
      expect(state.entry).not.toBeNull();
      expect(state.entry!.epoch).toBe(1); // TOFU entry epoch = 1
      expect(state.entry!.byteLength).toBe(bytes.length);
      expect(state.entry!.prefixHash).toBe(sha256Hex(bytes));
      expect(state.entry!.headTx).toBe('tx-1');
      expect(typeof state.entry!.mac).toBe('string');
      expect(state.entry!.mac.length).toBeGreaterThan(0);
      expect(statSync(witnessPath(home)).mode & 0o777).toBe(0o600);
      // MAC verifies through the classify path too (no macInvalid degrade)
      expect(classifyScope(home, '@global', bytes).kind).toBe('in-sync');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('tamper: flip one hex char of the stored entry mac on disk -> classifyScope -> first-contact/mac-invalid', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('a\n', 'utf8');
      advanceWitness(home, '@global', bytes, null);
      const raw = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { entry: { mac: string } }>;
      };
      const mac = raw.scopes['@global']!.entry.mac;
      const flippedChar = mac[0] === 'a' ? 'b' : 'a';
      raw.scopes['@global']!.entry.mac = flippedChar + mac.slice(1);
      writeFileSync(witnessPath(home), JSON.stringify(raw));

      const state = readScopeWitness(home, '@global');
      expect(state.macInvalid).toBe(true);
      expect(state.entry).toBeNull();

      const verdict = classifyScope(home, '@global', bytes);
      expect(verdict).toEqual({ kind: 'first-contact', reason: 'mac-invalid' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('structurally-malformed witness.json fail-safes to first-contact — never throws (partial write / corruption)', () => {
    // The hex-flip case above is a WELL-FORMED shape with a wrong MAC. This covers the other class:
    // a witness.json that is structurally broken (unparseable, wrong-typed, missing fields). Each
    // must degrade to first-contact (TOFU + note) rather than crash a read, so a corrupted/half-
    // written witness file can never brick recall. (Mutation-checked in authoring: making
    // readStoreFileAt rethrow instead of degrading to {} turns the garbage-JSON case RED.)
    const bytes = Buffer.from('a\n', 'utf8');
    const malformed: Array<[string, string]> = [
      ['unparseable garbage', 'this is not json at all {{{'],
      ['truncated json', '{"v":1,"scopes":{"@global":{"entry":{"epoch":1,'],
      ['scopes not an object', JSON.stringify({ v: 1, scopes: 'nope' })],
      ['scopes missing', JSON.stringify({ v: 1 })],
      ['entry missing mac', JSON.stringify({ v: 1, scopes: { '@global': { entry: { epoch: 1, byteLength: 2, prefixHash: sha256Hex(bytes), headTx: null }, journal: null } } })],
      ['entry wrong-typed epoch', JSON.stringify({ v: 1, scopes: { '@global': { entry: { epoch: 'one', byteLength: 2, prefixHash: sha256Hex(bytes), headTx: null, mac: 'x'.repeat(64) }, journal: null } } })],
      ['entry is a scalar', JSON.stringify({ v: 1, scopes: { '@global': { entry: 42, journal: null } } })],
    ];
    for (const [label, content] of malformed) {
      const home = tmpHome();
      try {
        writeFileSync(witnessPath(home), content);
        // Neither the raw read nor the classify may throw on a broken file.
        let state!: ReturnType<typeof readScopeWitness>;
        expect(() => { state = readScopeWitness(home, '@global'); }, label).not.toThrow();
        expect(state.entry, label).toBeNull();
        expect(classifyScope(home, '@global', bytes).kind, label).toBe('first-contact');
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });

  it('advance re-classifies under lock: rolled-back (shorter) bytes throw WitnessAdvanceError — anti-laundering at the store layer', () => {
    const home = tmpHome();
    try {
      const bytesA = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', bytesA, null);
      const rolledBack = Buffer.from('row1\n', 'utf8'); // shorter than the witnessed head -> mismatch
      expect(() => advanceWitness(home, '@global', rolledBack, null)).toThrow(WitnessAdvanceError);
      // witness entry is untouched by the rejected advance
      const state = readScopeWitness(home, '@global');
      expect(state.entry!.byteLength).toBe(bytesA.length);
      expect(state.entry!.prefixHash).toBe(sha256Hex(bytesA));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('key-absent read: readScopeWitness reports macInvalid true when entries exist; advanceWitness mints via ensureMaster and succeeds', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\n', 'utf8');
      advanceWitness(home, '@global', bytes, null); // mints the master key + writes the entry
      rmSync(join(home, 'ledger-mac-master.key'));  // simulate key rotation / absence

      const state = readScopeWitness(home, '@global');
      expect(state.macInvalid).toBe(true);
      expect(state.entry).toBeNull();

      const verdict = classifyScope(home, '@global', bytes);
      expect(verdict).toEqual({ kind: 'first-contact', reason: 'mac-invalid' });

      // advanceWitness re-mints via ensureMaster and succeeds — TOFU re-init
      advanceWitness(home, '@global', bytes, 'tx-2');
      const after = readScopeWitness(home, '@global');
      expect(after.macInvalid).toBe(false);
      expect(after.entry!.epoch).toBe(1);
      expect(existsSync(join(home, 'ledger-mac-master.key'))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Fix loop 1: classifyScope was refactored into readScopeWitness + classifyState (DRY extraction, so
// a caller holding one ScopeWitnessState snapshot — witness-read.ts's readLedgerWitnessed — can derive
// a verdict WITHOUT classifyScope's own internal second witness.json read). Pins that the two
// compositions are STILL byte-for-byte equivalent across the three verdict shapes classifyScope's own
// existing tests above already exercise individually (in-sync, mismatch, mac-invalid).
describe('classifyScope ≡ readScopeWitness + classifyState (Fix loop 1 parity)', () => {
  it('in-sync: both compositions agree', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', bytes, null);

      const viaScope = classifyScope(home, '@global', bytes);
      const viaState = classifyState(readScopeWitness(home, '@global'), bytes);
      expect(viaScope).toEqual(viaState);
      expect(viaScope.kind).toBe('in-sync');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('mismatch: both compositions agree', () => {
    const home = tmpHome();
    try {
      const witnessed = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', witnessed, null);
      const forked = Buffer.from('row1\nrowX\n', 'utf8'); // same length, different content -> fork

      const viaScope = classifyScope(home, '@global', forked);
      const viaState = classifyState(readScopeWitness(home, '@global'), forked);
      expect(viaScope).toEqual(viaState);
      expect(viaScope.kind).toBe('mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('mac-invalid: both compositions agree (tampered entry mac on disk)', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('a\n', 'utf8');
      advanceWitness(home, '@global', bytes, null);
      const raw = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { entry: { mac: string } }>;
      };
      const mac = raw.scopes['@global']!.entry.mac;
      raw.scopes['@global']!.entry.mac = (mac[0] === 'a' ? 'b' : 'a') + mac.slice(1);
      writeFileSync(witnessPath(home), JSON.stringify(raw));

      const viaScope = classifyScope(home, '@global', bytes);
      const viaState = classifyState(readScopeWitness(home, '@global'), bytes);
      expect(viaScope).toEqual(viaState);
      expect(viaScope).toEqual({ kind: 'first-contact', reason: 'mac-invalid' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('openTransition / completeTransition', () => {
  it('planTransition->openTransition supersession: plan/open T1, then plan (sees T1 pending)/open T2 -> single slot, T2.supersedes === T1.nonce, T2.epoch === T1.epoch + 1; witness-log has BOTH lines', () => {
    const home = tmpHome();
    try {
      const expected1 = { byteLength: 5, prefixHash: sha256Hex(Buffer.from('aaaaa')) };
      const p1 = planTransition(home, '@global', 'erase');
      const t1 = openTransition(home, '@global', { kind: 'erase', epoch: p1.epoch, nonce: p1.nonce, predecessor: p1.predecessor, supersedes: p1.supersedes, expected: expected1, tx: '2026-07-18T00:00:00.000Z' });
      expect(t1.supersedes).toBeNull();

      const expected2 = { byteLength: 6, prefixHash: sha256Hex(Buffer.from('bbbbbb')) };
      const p2 = planTransition(home, '@global', 'compaction');   // sees T1 pending -> supersedes it
      const t2 = openTransition(home, '@global', { kind: 'compaction', epoch: p2.epoch, nonce: p2.nonce, predecessor: p2.predecessor, supersedes: p2.supersedes, expected: expected2, tx: '2026-07-18T00:01:00.000Z' });

      expect(t2.supersedes).toBe(t1.nonce);
      expect(t2.epoch).toBe(t1.epoch + 1);

      // single slot: only T2 is the live pending journal
      const state = readScopeWitness(home, '@global');
      expect(state.journal).toEqual(t2);

      // witness-log carries both lines, in order, fsync'd append-only JSONL
      const lines = readFileSync(witnessLogPath(home), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const l1 = JSON.parse(lines[0]!) as { nonce: string; v: number; scope: string; kind: string };
      const l2 = JSON.parse(lines[1]!) as { nonce: string };
      expect(l1).toEqual({ v: 1, scope: '@global', epoch: t1.epoch, kind: 'erase', tx: t1.tx, nonce: t1.nonce });
      expect(l2.nonce).toBe(t2.nonce);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('completeTransition requires exact expected bytes (wrong bytes throw); on success entry.epoch === journal.epoch and slot cleared', () => {
    const home = tmpHome();
    try {
      const target = Buffer.from('row1\nrow2\n', 'utf8');
      const p = planTransition(home, '@global', 'compaction');
      const journal = openTransition(home, '@global', {
        kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) },
        tx: '2026-07-18T00:00:00.000Z',
      });

      const wrong = Buffer.from('row1\nrowX\n', 'utf8');
      expect(() => completeTransition(home, '@global', wrong, 'tx-x')).toThrow();
      expect(readScopeWitness(home, '@global').journal).not.toBeNull(); // failed attempt leaves journal pending

      completeTransition(home, '@global', target, 'tx-final');
      const state = readScopeWitness(home, '@global');
      expect(state.journal).toBeNull();
      expect(state.entry!.epoch).toBe(journal.epoch);
      expect(state.entry!.byteLength).toBe(target.length);
      expect(state.entry!.prefixHash).toBe(sha256Hex(target));
      expect(state.entry!.headTx).toBe('tx-final');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('journal never lowers (R1-F2 stale-journal replay / R4-F1 two-part cleanup-clear)', () => {
  it('a stale journal cannot be completed once the witness has advanced past it; cleanup-clear only fires when bytes validate against the CURRENT entry', () => {
    const home = tmpHome();
    try {
      // Reach epoch 1 via a completed transition to targetA.
      const targetA = Buffer.from('row1\nfenceA\n', 'utf8');
      const pA = planTransition(home, '@global', 'erase');
      const j1 = openTransition(home, '@global', {
        kind: 'erase', epoch: pA.epoch, nonce: pA.nonce, predecessor: pA.predecessor, supersedes: pA.supersedes,
        expected: { byteLength: targetA.length, prefixHash: sha256Hex(targetA) }, tx: 'tx-1',
      });
      completeTransition(home, '@global', targetA, 'tx-1');
      expect(readScopeWitness(home, '@global').entry!.epoch).toBe(j1.epoch);

      // Advance PAST j1 via a second completed transition to targetB (same length, different content — a fork).
      const targetB = Buffer.from('row1\nfenceB\n', 'utf8');
      const pB = planTransition(home, '@global', 'compaction');
      const j2 = openTransition(home, '@global', {
        kind: 'compaction', epoch: pB.epoch, nonce: pB.nonce, predecessor: pB.predecessor, supersedes: pB.supersedes,
        expected: { byteLength: targetB.length, prefixHash: sha256Hex(targetB) }, tx: 'tx-2',
      });
      completeTransition(home, '@global', targetB, 'tx-2');
      const afterB = readScopeWitness(home, '@global');
      expect(afterB.entry!.epoch).toBe(j2.epoch);
      expect(afterB.entry!.epoch).toBeGreaterThan(j1.epoch);
      expect(afterB.journal).toBeNull();

      // Simulate a crash-then-restore that resurrects the now-stale j1 journal on disk (j1 is already
      // correctly MAC'd — it is the exact object openTransition returned earlier).
      const raw = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { journal: unknown }>;
      };
      raw.scopes['@global']!.journal = j1;
      writeFileSync(witnessPath(home), JSON.stringify(raw));

      // completeTransition on the stale journal MUST throw: the witness is already past j1's epoch —
      // applying it would lower the witness.
      expect(() => completeTransition(home, '@global', targetA, 'tx-1')).toThrow(WitnessAdvanceError);
      expect(readScopeWitness(home, '@global').journal).not.toBeNull(); // untouched by the failed attempt

      // maybeCleanupClear with the CURRENT entry's validating bytes (targetB) returns true and clears.
      expect(maybeCleanupClear(home, '@global', targetB)).toBe(true);
      expect(readScopeWitness(home, '@global').journal).toBeNull();

      // Re-inject the stale journal once more for the R4-F1 counter-sequence.
      const raw2 = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { journal: unknown }>;
      };
      raw2.scopes['@global']!.journal = j1;
      writeFileSync(witnessPath(home), JSON.stringify(raw2));

      // Restore bytes to the OLD PREDECESSOR (targetA): same length as the current entry (targetB) so a
      // length-only check would wrongly pass, but content diverges — cleanup-clear must return false and
      // the journal must REMAIN (R4-F1: witness monotonicity alone is not read containment).
      expect(maybeCleanupClear(home, '@global', targetA)).toBe(false);
      expect(readScopeWitness(home, '@global').journal).not.toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('orphan sweep', () => {
  it('a stray witness.json.w-<hex32>.tmp is removed by the next mutation (ledger-sweep pattern extension)', () => {
    const home = tmpHome();
    try {
      const orphan = `${witnessPath(home)}.w-${'a'.repeat(32)}.tmp`;
      writeFileSync(orphan, 'stale partial write');
      advanceWitness(home, '@global', Buffer.from('x\n', 'utf8'), null);
      expect(existsSync(orphan)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('error classes', () => {
  it('WitnessAdvanceError and WitnessBlockedError are Error subclasses (Task 5 imports them)', () => {
    expect(new WitnessAdvanceError('x')).toBeInstanceOf(Error);
    expect(new WitnessBlockedError('x')).toBeInstanceOf(Error);
  });
});
