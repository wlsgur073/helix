import { describe, expect, it } from 'vitest';
import {
  advanceAllowed, classifyWitness, cleanupClearAllowed, fenceId, sha256Hex, interruptedAtPredecessor,
  type JournalEntry, type WitnessEntry,
} from '../../src/memory/witness-core.js';

const B = (s: string) => Buffer.from(s, 'utf8');
const entryFor = (bytes: Buffer, over: Partial<WitnessEntry> = {}): WitnessEntry => ({
  epoch: 1, byteLength: bytes.length, prefixHash: sha256Hex(bytes), headTx: null, mac: 'm', ...over,
});
const journalFor = (expected: Buffer, over: Partial<JournalEntry> = {}): JournalEntry => ({
  kind: 'erase', epoch: 2, predecessor: null,
  expected: { byteLength: expected.length, prefixHash: sha256Hex(expected) },
  nonce: 'n'.repeat(32), tx: '2026-07-18T00:00:00.000Z', supersedes: null, mac: 'm', ...over,
});

describe('classifyWitness — journal-first (§4.4)', () => {
  it('bytes on neither the pre- nor the post-transition lineage are a mismatch, not an interruption', () => {
    // A pending journal knows both ends of the transition it opened: `predecessor` is what the
    // ledger held when it opened, `expected` is what the rewrite would produce. Bytes that diverge
    // from BOTH prefixes are neither the before nor the after — they are a fork, and calling that
    // an interruption hands it to the rewrite gate, which refuses only 'mismatch'.
    const before = B('r1\nr2\n');
    const after = B('r1\nr2\nr3\n');
    const fork = B('r1\nPOISON\n');
    const j = journalFor(after, { predecessor: { byteLength: before.length, prefixHash: sha256Hex(before) } });
    expect(classifyWitness(fork, entryFor(before), j).kind).toBe('mismatch');
  });
  it('bytes still at the predecessor are an interruption: the legitimate re-drive must not be refused', () => {
    const before = B('r1\nr2\n');
    const after = B('r1\nr2\nr3\n');
    const j = journalFor(after, { predecessor: { byteLength: before.length, prefixHash: sha256Hex(before) } });
    expect(classifyWitness(before, entryFor(before), j).kind).toBe('transition-interrupted');
  });
  it('no entry, no journal → first-contact/no-entry', () => {
    expect(classifyWitness(B('a\n'), null, null)).toEqual({ kind: 'first-contact', reason: 'no-entry' });
  });
  it('entry match, equal length → in-sync', () => {
    const b = B('r1\nr2\n');
    expect(classifyWitness(b, entryFor(b), null).kind).toBe('in-sync');
  });
  it('prefix match, longer file → unwitnessed-suffix', () => {
    const pre = B('r1\n');
    expect(classifyWitness(B('r1\nr2\n'), entryFor(pre), null).kind).toBe('unwitnessed-suffix');
  });
  it('shorter file → mismatch; equal-length different bytes (fork) → mismatch', () => {
    const w = entryFor(B('r1\nr2\n'));
    expect(classifyWitness(B('r1\n'), w, null).kind).toBe('mismatch');
    expect(classifyWitness(B('r1\nrX\n'), w, null).kind).toBe('mismatch');
  });
  it("forged over-length entry (byteLength beyond the bytes, prefixHash OF the short bytes) → mismatch — locks matchesAt's short-input guard, which the plain shorter-file case does NOT (its hash never matches regardless)", () => {
    const short = B('r1\n');
    const w = entryFor(short, { byteLength: short.length + 3 });
    expect(classifyWitness(short, w, null).kind).toBe('mismatch');
  });
  it('pending journal + file == expected → transition-heal (even when entry also mismatches)', () => {
    const target = B('kept\nfence\n');
    const v = classifyWitness(target, entryFor(B('old-longer-bytes\n')), journalFor(target));
    expect(v.kind).toBe('transition-heal');
  });
  // RETITLED. This read "pending journal + ANY other state → transition-interrupted — INCLUDING
  // exact predecessor match (R2-F2)". "ANY other state" is precisely the rule the fork/mismatch fix
  // DELETED: bytes carrying neither the journal's `expected` nor its `predecessor` are a mismatch
  // now (first test in this file). The fixture never exercised that rule anyway — `journalFor`
  // defaults `predecessor: null`, so it takes the null-predecessor escape hatch and passes
  // identically under the fix AND under a rule that reopens the defect, i.e. it discriminated
  // nothing about the change while its name asserted the opposite of the current contract.
  // What it genuinely pins is journal-first precedence in the no-lineage case. That is worth
  // keeping, so it stays — under an accurate name, with the null default made load-bearing by the
  // last leg rather than left as an unremarked helper default.
  it('pending journal with a NULL predecessor → transition-interrupted even when the file exactly matches the witness entry', () => {
    const pred = B('pre-erase\n');
    const j = journalFor(B('post-erase\n'));
    expect(j.predecessor).toBeNull();                                              // the escape hatch this rests on
    expect(classifyWitness(pred, entryFor(pred), null).kind).toBe('in-sync');       // naive table: in-sync
    expect(classifyWitness(pred, entryFor(pred), j).kind).toBe('transition-interrupted'); // journal takes precedence
    // ...and the null predecessor is the ONLY reason. Give the journal a predecessor these bytes are
    // not on and the same call is a mismatch. A rule restoring "ANY other state →
    // transition-interrupted" passes every leg above and fails this one.
    const offLineage = B('other\n');
    const withPred = journalFor(B('post-erase\n'), {
      predecessor: { byteLength: offLineage.length, prefixHash: sha256Hex(offLineage) },
    });
    expect(classifyWitness(pred, entryFor(pred), withPred).kind).toBe('mismatch');
  });
  it('pending journal + expected-plus-suffix → transition-interrupted (spec literal: only exact expected heals)', () => {
    const target = B('kept\n');
    expect(classifyWitness(B('kept\nlate\n'), null, journalFor(target)).kind).toBe('transition-interrupted');
  });
});

describe('advanceAllowed — anti-laundering (§4.2)', () => {
  it('allows first-contact / in-sync / unwitnessed-suffix only', () => {
    expect(advanceAllowed({ kind: 'first-contact', reason: 'no-entry' })).toBe(true);
    expect(advanceAllowed({ kind: 'in-sync' })).toBe(true);
    expect(advanceAllowed({ kind: 'unwitnessed-suffix' })).toBe(true);
    expect(advanceAllowed({ kind: 'mismatch' })).toBe(false);
    const j = journalFor(B('x'));
    expect(advanceAllowed({ kind: 'transition-heal', journal: j })).toBe(false);
    expect(advanceAllowed({ kind: 'transition-interrupted', journal: j })).toBe(false);
  });
});

describe('cleanupClearAllowed — two-part predicate (R4-F1)', () => {
  const target = B('post\n');
  const j = journalFor(target, { epoch: 2 });
  it('true when witness at/beyond target AND file validates against witness', () => {
    expect(cleanupClearAllowed(target, entryFor(target, { epoch: 2 }), j)).toBe(true);
  });
  it('false when file was restored to the predecessor after the witness advanced (R4-F1 counter-sequence)', () => {
    const pred = B('pre\n');
    expect(cleanupClearAllowed(pred, entryFor(target, { epoch: 2 }), j)).toBe(false);
  });
  it('false when witness has not reached the target epoch', () => {
    expect(cleanupClearAllowed(target, entryFor(target, { epoch: 1 }), j)).toBe(false);
    expect(cleanupClearAllowed(target, null, j)).toBe(false);
  });
});

it('fenceId shape', () => {
  expect(fenceId(3, 'a'.repeat(32))).toBe(`witness_fence_3_${'a'.repeat(32)}`);
});

// Startup recovery needs to tell apart the states `transition-interrupted` bundles together, because
// only ONE of them is safe to retract. The verdict is returned for bytes on EITHER lineage — the
// rewrite did not land (predecessor prefix), or it landed and something appended afterwards
// (expected prefix, suffix-tolerant) — and also when there is no predecessor to compare against.
// Discarding the journal is right for the first and WRONG for the second: that transition completed,
// and retracting its journal would throw away a witness advance that actually happened.
describe('interruptedAtPredecessor — which interruptions startup may retract', () => {
  const before = B('r1\nr2\n');
  const after = B('r1\nr2\nr3\n');
  const predecessorOf = (b: Buffer) => ({ byteLength: b.length, prefixHash: sha256Hex(b) });

  it('true when the bytes are the predecessor — the rename never landed', () => {
    const j = journalFor(after, { predecessor: predecessorOf(before) });
    expect(interruptedAtPredecessor(before, j)).toBe(true);
  });

  it('FALSE when the bytes carry the expected prefix — the rewrite landed and was appended to', () => {
    const j = journalFor(after, { predecessor: predecessorOf(before) });
    expect(interruptedAtPredecessor(Buffer.concat([after, B('r4\n')]), j)).toBe(false);
  });

  it('false when there is no predecessor to compare against — no lineage, nothing to retract to', () => {
    const j = journalFor(after, { predecessor: null });
    expect(interruptedAtPredecessor(before, j)).toBe(false);
  });

  it('false on a fork — those are a mismatch, and startup must not touch them', () => {
    const j = journalFor(after, { predecessor: predecessorOf(before) });
    expect(interruptedAtPredecessor(B('r1\nPOISON\n'), j)).toBe(false);
  });

  it('false when the bytes satisfy BOTH lineages — ambiguous, so fail closed rather than guess', () => {
    // `before` is a strict prefix of `after`, so a journal whose predecessor is `before` and whose
    // expected is `after` cannot distinguish them from the predecessor bytes alone.
    const j = journalFor(before, { predecessor: predecessorOf(before) });
    expect(interruptedAtPredecessor(before, j)).toBe(false);
  });
});
