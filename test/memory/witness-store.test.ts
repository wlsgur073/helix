import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  witnessPath, witnessLogPath, scopeKeyOf, readScopeWitness, classifyScope, classifyState,
  advanceWitness, planTransition, openTransition, completeTransition, discardTransition,
  maybeCleanupClear, WitnessAdvanceError, WitnessBlockedError,
} from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';

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

  // Task 7 (2026-08-03 dual-umask mutation re-verification): the round-trip test above asserts
  // the ON-DISK mode via statSync, which is umask-dependent — under umask 0077, plain openSync's
  // default 0o666 mode is ALREADY masked down to 0o600 by the OS, so deleting the fchmodSync(fd,
  // 0o600) call in writeStoreFileAt leaves that assertion green by coincidence. This test instead
  // spies on the injected fsOps seam and asserts fchmodSync was actually CALLED with 0o600 —
  // umask-independent, so it kills the fchmod-removal mutant under any ambient umask.
  it('owner-only mode is enforced by fchmod itself, not by the ambient umask', () => {
    const home = tmpHome();
    try {
      const modes: number[] = [];
      const spyFs: DurableFsOps = {
        ...realFsOps,
        fchmodSync: (fd, mode) => { modes.push(mode); realFsOps.fchmodSync(fd, mode); },
      };
      const bytes = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1', spyFs);
      expect(modes).toContain(0o600);
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

  // The journal-side counterpart of the tamper test above. deriveState checks both records with the
  // same two-part condition, but only the ENTRY line was measured: mutating the JOURNAL line's `&&`
  // to `||` left the whole suite green, while the same mutation on the entry line failed 14 files.
  // The asymmetry was fixture difficulty, not design — an entry exists in nearly every fixture, a
  // journal only mid-transaction.
  //
  // The entry is left VALID on purpose. `macInvalid` is an aggregate over both records, so corrupting
  // both would let the entry's failure raise the flag and the journal's acceptance would be
  // unobservable. The pre-corruption control reading is what attributes the flag to the journal.
  //
  // Two things this case deliberately does NOT assert. It does not claim the still-valid entry
  // survives the journal's tamper: every consumer reads `state.macInvalid ? null : state.entry` and
  // discards BOTH records, so partial recovery is not a reader contract and pinning it here would
  // block a wholesale-degrade refactor for no gain. And it does not claim the `&&` is otherwise
  // unguarded — `tsc` rejects the `||` form today, since `master` narrows to `null` in the right
  // operand, so the swap survives a vitest run but not a typecheck. That barrier lasts only as long
  // as `master` is nullable at this point; the case below enforces the check at runtime regardless.
  it('tamper: flip one hex char of the stored JOURNAL mac on disk -> macInvalid, journal suppressed', () => {
    const home = tmpHome();
    try {
      // An entry at epoch 1 plus a pending journal at epoch 2 — the only shape in which the journal
      // line is exercised with an intact entry beside it.
      const bytes = Buffer.from('row1\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1');
      const target = Buffer.from('row1\nfence\n', 'utf8');
      const p = planTransition(home, '@global', 'compaction');
      openTransition(home, '@global', {
        kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) },
        tx: '2026-08-12T00:00:00.000Z',
      });

      // CONTROL: both records present, both MACs verifying. Without this reading, a macInvalid below
      // could not be attributed to the journal rather than to the fixture.
      const before = readScopeWitness(home, '@global');
      expect(before.macInvalid).toBe(false);
      expect(before.entry).not.toBeNull();
      expect(before.journal).not.toBeNull();

      const originalText = readFileSync(witnessPath(home), 'utf8');
      type MacPair = { scopes: Record<string, { entry: { mac: string }; journal: { mac: string } }> };
      const raw = JSON.parse(originalText) as MacPair;
      const mac = raw.scopes['@global']!.journal.mac;

      // FORMAT-VALID corruption: one hex digit for a different hex digit, length preserved.
      // Buffer.from(s, 'hex') does NOT throw on malformed input — it stops at the first invalid pair
      // and returns a short buffer, which verifyMac rejects on its length comparison before
      // timingSafeEqual ever runs. Breaking the format would therefore measure the length check
      // rather than authentication.
      expect(mac).toMatch(/^[0-9a-f]{64}$/);
      const corrupted = (mac[0] === 'a' ? 'b' : 'a') + mac.slice(1);
      expect(corrupted).toMatch(/^[0-9a-f]{64}$/);
      expect(corrupted).not.toBe(mac);
      raw.scopes['@global']!.journal.mac = corrupted;
      writeFileSync(witnessPath(home), JSON.stringify(raw));

      // Nothing but journal.mac moved: putting the original mac back must restore the whole document.
      const check = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as MacPair;
      expect(check.scopes['@global']!.journal.mac).toBe(corrupted);
      check.scopes['@global']!.journal.mac = mac;
      expect(JSON.stringify(check)).toBe(JSON.stringify(JSON.parse(originalText)));

      const state = readScopeWitness(home, '@global');
      expect(state.macInvalid).toBe(true);
      expect(state.journal).toBeNull();   // the reader's stated contract: an invalid record reads as null
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

describe('discardTransition (a failed writer retracts its OWN journal)', () => {
  // The retract half of the open/complete pair, for a rewrite that provably never touched the
  // ledger. The bytes-unchanged proof is the CALLER's (it holds the ledger lock continuously and
  // re-reads under it); from disk state alone that state is indistinguishable from a landed-then-
  // rolled-back rewrite, which is why classifyWitness keeps calling it 'transition-interrupted'
  // and this function only enforces what it can see: a pending journal it owns, which superseded
  // nothing.
  it('nulls the pending journal for a matching nonce, leaves the entry standing, and logs the retraction', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\nrow2\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1');
      const entryBefore = readScopeWitness(home, '@global').entry;
      const p = planTransition(home, '@global', 'rebaseline');
      const fenced = Buffer.concat([bytes, Buffer.from('fence\n', 'utf8')]);
      const journal = openTransition(home, '@global', {
        kind: 'rebaseline', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: fenced.length, prefixHash: sha256Hex(fenced) },
        tx: 'tx-failed-append',
      });
      expect(readScopeWitness(home, '@global').journal).not.toBeNull();
      expect(journal.supersedes).toBeNull(); // the only shape a retraction can restore

      discardTransition(home, '@global', journal.nonce);

      const after = readScopeWitness(home, '@global');
      expect(after.journal).toBeNull();
      expect(after.entry).toEqual(entryBefore);                    // the standing attestation is untouched
      expect(classifyState(after, bytes).kind).toBe('in-sync');    // the scope is simply back
      const log = readFileSync(witnessLogPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(log.at(-1)).toMatchObject({ scope: '@global', tx: 'tx-failed-append', op: 'discard' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses an absent journal, a nonce it does not own, and the fence tx (a wall clock is not an identity)', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1');
      expect(() => discardTransition(home, '@global', 'nonce-none')).toThrow(WitnessAdvanceError);

      const p = planTransition(home, '@global', 'rebaseline');
      const journal = openTransition(home, '@global', {
        kind: 'rebaseline', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: 1, prefixHash: sha256Hex(Buffer.from('x')) },
        tx: '2026-07-18T00:00:00.000Z',
      });
      expect(() => discardTransition(home, '@global', 'someone-elses-nonce')).toThrow(WitnessAdvanceError);
      // The tx is a millisecond wall-clock stamp — guessable, and a CONSTANT under a fixed clock.
      // Keying on it would let a colliding stamp retract a transition its holder never opened.
      expect(() => discardTransition(home, '@global', journal.tx)).toThrow(WitnessAdvanceError);
      expect(readScopeWitness(home, '@global').journal).not.toBeNull(); // refused = untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses to retract a transition that SUPERSEDED a pending one — the predecessor it absorbed cannot be restored', () => {
    const home = tmpHome();
    try {
      const bytes = Buffer.from('row1\n', 'utf8');
      advanceWitness(home, '@global', bytes, 'tx-1');

      // J1: a writer that journaled and never landed its bytes (the interrupted alarm).
      const p1 = planTransition(home, '@global', 'compaction');
      const j1 = openTransition(home, '@global', {
        kind: 'compaction', epoch: p1.epoch, nonce: p1.nonce, predecessor: p1.predecessor, supersedes: p1.supersedes,
        expected: { byteLength: 99, prefixHash: sha256Hex(Buffer.from('never-written')) },
        tx: 'tx-crashed',
      });

      // J2: a re-drive that absorbs J1 — single-slot supersession, so J1's `expected` is gone from
      // the store and survives only as a nonce here.
      const p2 = planTransition(home, '@global', 'rebaseline');
      expect(p2.supersedes).toBe(j1.nonce);
      const j2 = openTransition(home, '@global', {
        kind: 'rebaseline', epoch: p2.epoch, nonce: p2.nonce, predecessor: p2.predecessor, supersedes: p2.supersedes,
        expected: { byteLength: 42, prefixHash: sha256Hex(Buffer.from('also-never-written')) },
        tx: 'tx-redrive',
      });

      // J2's owner can prove ITS rewrite never started; it can prove nothing about J1's window.
      expect(() => discardTransition(home, '@global', j2.nonce)).toThrow(WitnessAdvanceError);
      expect(readScopeWitness(home, '@global').journal!.nonce).toBe(j2.nonce); // still pending, for a re-drive to supersede
      expect(classifyState(readScopeWitness(home, '@global'), bytes).kind).toBe('transition-interrupted');
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

  // The BOUNDARY sibling of the case above. That one drives the witness strictly PAST the stale
  // journal; this one stops at equality, which is the half `>=` covers and `>` does not — swapping
  // `>=` for `>` in completeTransition left the whole suite green.
  //
  // What this case is, and what it is not. The equality state is written to disk directly because no
  // writer in this tree produces it: openTransition refuses a plan that does not advance past the
  // entry, advanceWitness cannot run at all while a journal is pending (advanceAllowed admits none of
  // the journal verdicts), and completeTransition advances the entry and clears the slot in one
  // atomic write. So the guard is pinned here as the SECOND enforcement of an invariant
  // openTransition establishes first — the enforcement that still runs on the startup-heal path
  // (MemoryStore.healWitness), where the journal comes off disk and no openTransition ran in the same
  // process; that caller's own comment names "stale" as an outcome it leaves alone, and this guard is
  // its only producer. It is NOT a defence against an adversary who can write witness.json: SECURITY
  // .md puts that file on the trusted side of the boundary and names a coordinated home restore as a
  // limitation it documents rather than defends.
  it('refuses a journal whose epoch the witness has exactly REACHED, not only one it has passed', () => {
    const home = tmpHome();
    try {
      const target = Buffer.from('row1\nfence\n', 'utf8');
      const p = planTransition(home, '@global', 'compaction');
      const journal = openTransition(home, '@global', {
        kind: 'compaction', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) }, tx: 'tx-1',
      });
      completeTransition(home, '@global', target, 'tx-1');

      const afterComplete = readScopeWitness(home, '@global');
      expect(afterComplete.entry!.epoch).toBe(journal.epoch);   // completion sets entry.epoch = journal.epoch
      expect(afterComplete.journal).toBeNull();

      // Put the journal back beside the entry it just advanced — the module's own signed object,
      // unmodified, so its MAC verifies and the refusal can only come from the epoch relation.
      const raw = JSON.parse(readFileSync(witnessPath(home), 'utf8')) as {
        scopes: Record<string, { journal: unknown }>;
      };
      raw.scopes['@global']!.journal = journal;
      writeFileSync(witnessPath(home), JSON.stringify(raw));
      const staged = readScopeWitness(home, '@global');
      expect(staged.macInvalid).toBe(false);                    // both records authentic
      expect(staged.entry!.epoch).toBe(staged.journal!.epoch);  // EXACTLY reached, not passed

      // The bytes deliberately MATCH the journal's expected head, so completeTransition's byte check
      // cannot be what refuses this. Weakened to `>`, the epoch check passes, the byte check passes,
      // and the already-consumed journal is applied a second time. Asserting the message rather than
      // merely "it threw" is what keeps this from passing on the wrong refusal.
      expect(() => completeTransition(home, '@global', target, 'tx-1'))
        .toThrow(/stale journal.*reached or passed/);

      // Whole objects, not just the epoch: a refusal that rewrote the entry to a different head at
      // the same epoch would satisfy an epoch-only postcondition while still moving the witness.
      const after = readScopeWitness(home, '@global');
      expect(after.entry).toEqual(afterComplete.entry);         // the witness did not move at all
      expect(after.journal).toEqual(journal);                   // the refused journal is intact, not partly applied
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
    expect(new WitnessBlockedError('commit', 'x')).toBeInstanceOf(Error);
    expect(new WitnessBlockedError('commit', 'x').op).toBe('commit');
  });
});

function recordingShortFs(): { fs: DurableFsOps; events: Array<{ kind: 'open' | 'write' | 'fsync' | 'close'; fd: number; path?: string; bytes?: Buffer }> } {
  const events: Array<{ kind: 'open' | 'write' | 'fsync' | 'close'; fd: number; path?: string; bytes?: Buffer }> = [];
  const fs: DurableFsOps = {
    ...realFsOps,
    openSync: (path, flags, mode) => { const fd = realFsOps.openSync(path, flags, mode); events.push({ kind: 'open', fd, path }); return fd; },
    writeSync: (fd, buf, off, len) => { const n = realFsOps.writeSync(fd, buf, off, Math.min(3, len)); events.push({ kind: 'write', fd, bytes: Buffer.from(buf.subarray(off, off + n)) }); return n; },
    fsyncSync: (fd) => { realFsOps.fsyncSync(fd); events.push({ kind: 'fsync', fd }); },
    closeSync: (fd) => { realFsOps.closeSync(fd); events.push({ kind: 'close', fd }); },
  };
  return { fs, events };
}

// openTransition refuses a plan whose epoch does not advance. The check lives in one condition that
// ALSO verifies the pending journal being superseded, so a test must weaken only the epoch half —
// otherwise a red result cannot say which invariant was unmeasured.
describe('openTransition — the epoch must advance', () => {
  it('refuses a plan whose epoch equals the current entry epoch', () => {
    const home = tmpHome();
    try {
      const target = Buffer.from('row1\nrow2\n', 'utf8');

      // Establish an entry at some epoch by driving one full transition.
      const p1 = planTransition(home, '@global', 'compaction');
      openTransition(home, '@global', {
        kind: 'compaction', epoch: p1.epoch, nonce: p1.nonce, predecessor: p1.predecessor,
        supersedes: p1.supersedes,
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) },
        tx: '2026-08-11T00:00:00.000Z',
      });
      completeTransition(home, '@global', target, '2026-08-11T00:00:00.000Z');

      const entryEpoch = readScopeWitness(home, '@global').entry!.epoch;
      const p2 = planTransition(home, '@global', 'compaction');

      // A plan that does not advance past the entry must be refused, even though its `supersedes`
      // matches the (now absent) pending journal exactly.
      expect(() => openTransition(home, '@global', {
        kind: 'compaction', epoch: entryEpoch, nonce: p2.nonce, predecessor: p2.predecessor,
        supersedes: p2.supersedes,
        expected: { byteLength: target.length, prefixHash: sha256Hex(target) },
        tx: '2026-08-11T00:01:00.000Z',
      })).toThrow(/epoch/i);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('M1: transition-log durability wiring (three locks)', () => {
  it('the log append goes through the injected seam, completes under short writes, and fsyncs the log fd before close', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-wlog-'));
    try {
      const { fs, events } = recordingShortFs();
      const key = '@global';
      const plan = planTransition(home, key, 'compaction');
      openTransition(home, key, {
        kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
        supersedes: plan.supersedes, expected: { byteLength: 4, prefixHash: sha256Hex(Buffer.from('abcd')) },
        tx: '2026-07-19T00:00:00.000Z',
      }, fs);

      const logPath = join(home, 'witness-log.jsonl');
      const openIdx = events.findIndex((e) => e.kind === 'open' && e.path === logPath);
      expect(openIdx).toBeGreaterThanOrEqual(0);                    // LOCK 1a: the seam saw the log open
      const fd = events[openIdx]!.fd;
      const closeRel = events.slice(openIdx + 1).findIndex((e) => e.kind === 'close' && e.fd === fd);
      expect(closeRel).toBeGreaterThan(0);
      const window = events.slice(openIdx + 1, openIdx + 1 + closeRel); // fd-recycling-safe window
      const writes = window.filter((e) => e.kind === 'write' && e.fd === fd);
      const expectedLine = JSON.stringify({ v: 1, scope: key, epoch: plan.epoch, kind: 'compaction', tx: '2026-07-19T00:00:00.000Z', nonce: plan.nonce }) + '\n';
      expect(readFileSync(logPath, 'utf8')).toBe(expectedLine);     // LOCK 2: complete on disk under short writes
      expect(writes.length).toBeGreaterThan(1);                     // short counts forced the loop
      expect(Buffer.concat(writes.map((w) => w.bytes!)).toString('utf8')).toBe(expectedLine); // LOCK 1b: content-associated
      const lastWriteIdx = window.reduce((acc, e, i) => (e.kind === 'write' && e.fd === fd ? i : acc), -1);
      const fsyncAfter = window.slice(lastWriteIdx + 1).some((e) => e.kind === 'fsync' && e.fd === fd);
      expect(fsyncAfter).toBe(true);                                // LOCK 3: fsync on the log fd, after the content
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
