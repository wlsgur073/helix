import { describe, expect, it } from 'vitest';
import {
  advanceAllowed, classifyWitness, cleanupClearAllowed, fenceId, sha256Hex,
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
  it('pending journal + file == expected → transition-heal (even when entry also mismatches)', () => {
    const target = B('kept\nfence\n');
    const v = classifyWitness(target, entryFor(B('old-longer-bytes\n')), journalFor(target));
    expect(v.kind).toBe('transition-heal');
  });
  it('pending journal + ANY other state → transition-interrupted — INCLUDING exact predecessor match (R2-F2)', () => {
    const pred = B('pre-erase\n');
    const v = classifyWitness(pred, entryFor(pred), journalFor(B('post-erase\n')));
    expect(v.kind).toBe('transition-interrupted'); // naive table said in-sync; journal takes precedence
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
