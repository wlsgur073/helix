import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger, readLedgerBytes, planCompaction } from '../../src/memory/ledger.js';
import { verifiedLiveOf } from '../../src/memory/verified-read.js';
import { classifyState, readScopeWitness, scopeKeyOf } from '../../src/memory/witness-store.js';
import type { MemoryRecord } from '../../src/types.js';

/** A live ledger on disk plus a factory for fresh stores over it — every leg re-reads the FILE, so
 *  nothing here can pass on in-memory state that a rewrite would have destroyed. */
function tmpLedger() {
  const home = mkdtempSync(join(tmpdir(), 'helix-forge-'));
  const ledger = join(home, 'memory.jsonl');
  const mk = () => new MemoryStore(ledger, { home, sessionId: 's', now: () => '2026-06-09T00:00:00.000Z' });
  return { mk, ledger, home };
}

/** The physical assert row for `id` as it currently sits in the file — the row a forger copies. */
const assertRowFor = (ledger: string, id: string): MemoryRecord =>
  parseLedger(ledger).find((r) => r.id === id && r.type === 'assert')!;

const rowsFor = (ledger: string, id: string): MemoryRecord[] =>
  parseLedger(ledger).filter((r) => r.id === id && r.type !== 'verify');

describe('duplicate fact id survives a ledger rewrite', () => {
  // The guard added for a forged twin (verified-projection.forgedFactIds) is a property of two rows
  // CO-EXISTING physically: it reads the record array, not a durable flag. A rewrite that keeps one
  // row per live id therefore does not merely hide the evidence, it DESTROYS it — whichever row the
  // projection's tie-break leaves standing re-grades to what the original earned, so these tests
  // assert the EVIDENCE survives and deliberately do not pin which occurrence wins (that is
  // buildProjection's contract, not this one). `store.erase(id, { permanent: true })` rewrites
  // UNCONDITIONALLY, config-independent, and the erased id need not be the forged one: a user
  // exercising right-to-erasure on one item would silently launder a forgery against another.
  it('a forged provenance twin stays compromised after a permanent erase of an UNRELATED fact', () => {
    const { mk, ledger, home } = tmpLedger();
    let s = mk();
    const target = s.commit({ content: 'prod database host is db.internal', source: 'user' });
    const unrelated = s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user' });
    s.confirm(target.id); // genuine signed verify -> Verified, and mints the master (key present)

    const original = assertRowFor(ledger, target.id);
    appendFileSync(ledger, JSON.stringify({
      ...original, provenance: { ...original.provenance, source: 'agent-inference' },
    }) + '\n'); // content byte-identical -> the verify's digest binding still passes untouched

    const before = verifiedLiveOf(parseLedger(ledger), home);
    expect(before.compromised.has(target.id)).toBe(true);      // the guard fires while both rows exist
    expect(before.live.get(target.id)!.state).toBe('Fresh');

    s = mk();
    s.erase(unrelated.id, { permanent: true });                // unconditional rewrite; unrelated id

    const after = verifiedLiveOf(parseLedger(ledger), home);
    expect(after.compromised.has(target.id)).toBe(true);       // evidence is DURABLE, not per-read
    expect(after.live.get(target.id)!.state).toBe('Fresh');    // never re-graded off the surviving twin
  });

  // The trap on preserving both rows: HMAC-aware planCompaction resets each kept asset's `state` to
  // Fresh. Normalizing preserved duplicates the same way makes two rows that differed ONLY in state
  // byte-identical — and forgedFactIds EXEMPTS byte-identical repeats (at-least-once append replay).
  // That would destroy exactly the evidence this path exists to preserve.
  it('a twin differing ONLY in state stays compromised after the rewrite (normalization must not merge it)', () => {
    const { mk, ledger, home } = tmpLedger();
    let s = mk();
    const target = s.commit({ content: 'prod database host is db.internal', source: 'user' });
    const unrelated = s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user' });
    s.confirm(target.id);

    const original = assertRowFor(ledger, target.id);
    expect(original.state).toBe('Fresh');                      // pin the premise: the twin below DIFFERS
    appendFileSync(ledger, JSON.stringify({ ...original, state: 'Suspect' }) + '\n');

    expect(verifiedLiveOf(parseLedger(ledger), home).compromised.has(target.id)).toBe(true);

    s = mk();
    s.erase(unrelated.id, { permanent: true });

    const kept = rowsFor(ledger, target.id);
    expect(new Set(kept.map((r) => JSON.stringify(r))).size).toBe(2); // still two DISTINCT rows
    expect(verifiedLiveOf(parseLedger(ledger), home).compromised.has(target.id)).toBe(true);
  });

  // The GENERAL form of the trap above. `state` is not special — the identity forgedFactIds compares
  // is whole-record JSON, so normalizing WHICHEVER field two occurrences differ in merges them into
  // the byte-identical exemption and destroys the evidence. The test above is field-specific: its
  // twin differs in `state`, so it survives any normalization that leaves `state` alone. This one
  // differs in `tx` and nothing else — a plausible future "canonicalize timestamps at the horizon"
  // pass, the same shape canonicalMarker already applies to markers, would sail past the other test
  // and fail here.
  it('a twin differing ONLY in tx stays compromised after the rewrite (no field may be normalized)', () => {
    const { mk, ledger, home } = tmpLedger();
    let s = mk();
    const target = s.commit({ content: 'prod database host is db.internal', source: 'user' });
    const unrelated = s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user' });
    s.confirm(target.id);

    const original = assertRowFor(ledger, target.id);
    const twinTx = '2026-06-09T00:00:01.000Z';
    expect(original.tx).not.toBe(twinTx);                      // pin the premise: the twin below DIFFERS
    expect(original.state).toBe('Fresh');                      // ...and differs in NOTHING ELSE:
    appendFileSync(ledger, JSON.stringify({ ...original, tx: twinTx }) + '\n'); // same state, same provenance

    const before = verifiedLiveOf(parseLedger(ledger), home);
    expect(before.compromised.has(target.id)).toBe(true);
    expect(before.live.get(target.id)!.state).toBe('Fresh');

    s = mk();
    s.erase(unrelated.id, { permanent: true });

    const kept = rowsFor(ledger, target.id);
    expect(new Set(kept.map((r) => JSON.stringify(r))).size).toBe(2); // still two DISTINCT rows
    const after = verifiedLiveOf(parseLedger(ledger), home);
    expect(after.compromised.has(target.id)).toBe(true);
    expect(after.live.get(target.id)!.state).toBe('Fresh');     // never re-graded off the surviving twin
  });

  // The scope that actually matters. The global ledger above assumes an attacker who can already
  // write under `home`; the design's confirmed attack surface is the GIT-DELIVERED project ledger.
  // A delivery that PRESERVES the witnessed prefix and appends produces `unwitnessed-suffix`, not
  // `mismatch` — so erase's anti-laundering gate (which refuses `mismatch` ONLY) does not fire, the
  // permanent erase proceeds, and the rewrite ADVANCES the witness over its result. Pre-fix that
  // promoted the forgery into the blessed prefix: measured Verified / integrity=ok / witness=in-sync
  // with the original row gone. `unwitnessed-suffix` itself clamps nothing (enforceWitnessProjection
  // acts on mismatch + transition-interrupted only), so the duplicate guard is the SOLE thing
  // standing between a git-delivered twin and an inherited grade.
  it('holds in the ADOPTED PROJECT scope against a prefix-preserving append, across the witness advance', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-forge-h-'));
    const root = mkdtempSync(join(tmpdir(), 'helix-forge-p-'));
    const projLedger = join(root, '.helix', 'memory.jsonl');
    mkdirSync(join(root, '.helix'), { recursive: true });
    const mk = () => new MemoryStore(join(home, 'memory.jsonl'), {
      home, sessionId: 's', now: () => '2026-06-09T00:00:00.000Z', project: { ledger: projLedger, root },
    });
    let s = mk();
    s.adopt(root);
    const target = s.commit({ content: 'prod database host is db.internal', source: 'user', scope: 'project' });
    const unrelated = s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user', scope: 'project' });
    s.confirm(target.id);

    const prefix = readFileSync(projLedger);            // the bytes the witness has blessed
    const original = assertRowFor(projLedger, target.id);
    appendFileSync(projLedger, JSON.stringify({
      ...original, provenance: { ...original.provenance, source: 'agent-inference' },
    }) + '\n');
    // Pin the DELIVERY SHAPE, not just the outcome: this is an append, not a rewrite, so the verdict
    // is `unwitnessed-suffix` and the gate that would otherwise stop this never fires.
    expect(readFileSync(projLedger).subarray(0, prefix.length).equals(prefix)).toBe(true);
    const key = scopeKeyOf(home, root);
    expect(classifyState(readScopeWitness(home, key), readLedgerBytes(projLedger)).kind).toBe('unwitnessed-suffix');

    s = mk();
    s.erase(unrelated.id, { permanent: true, scope: 'project' });  // proceeds: not a mismatch

    // The witness DID advance — the rewrite is now the blessed prefix. The forgery must not be in it.
    expect(classifyState(readScopeWitness(home, key), readLedgerBytes(projLedger)).kind).toBe('in-sync');
    const after = verifiedLiveOf(parseLedger(projLedger), home, root);
    expect(after.compromised.has(target.id)).toBe(true);
    expect(after.live.get(target.id)!.state).toBe('Fresh');
  });

  // planCompaction documents itself as PURE — "two calls over the same records/opts produce
  // byte-identical output, and callers may use the kept-set for identity, not just counts". The
  // preserve branch is the one place that emits MORE than one row per live id, so it is the one
  // place that can break that by emitting them in an unstable order. Row COUNTS would not notice
  // (they are equal under any permutation), so assert serialized identity, not length.
  it('planCompaction over its own output is byte-identical when a forged id is preserved', () => {
    const base: MemoryRecord = {
      id: 'X', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: 'prod database host is db.internal',
      provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null,
      reverifyTrigger: null, classification: 'normal',
    };
    const records: MemoryRecord[] = [
      base,
      { ...base, provenance: { source: 'agent-inference', sessionId: 't' } }, // provenance-only twin
      { ...base, id: 'Y' },
      { ...base, id: 'Y', state: 'Suspect' },                                  // state-only twin
      { ...base, id: 'other', content: 'an unrelated fact' },
    ];
    const opts = { erasedIds: new Set<string>() };
    const lines = (rs: MemoryRecord[]): string[] => rs.map((r) => JSON.stringify(r));

    const pass1 = planCompaction(records, opts).kept;
    expect(pass1.filter((r) => r.id === 'X' || r.id === 'Y')).toHaveLength(4); // premise: both preserved
    const pass2 = planCompaction(pass1, opts).kept;
    const pass3 = planCompaction(pass2, opts).kept;

    expect(lines(pass2)).toEqual(lines(pass1)); // fixpoint: the rewrite is already its own output
    expect(lines(pass3)).toEqual(lines(pass2)); // and stable, not merely period-2 oscillating
  });

  // Right-to-erasure OUTRANKS the evidence, and that ordering is what the `erasedIds` check being
  // FIRST in the keep loop buys. Unit level, because that is the only level where the check is
  // reachable: store.erase appends a tombstone before compacting, which drops the id from `live`
  // so the keep loop never iterates it (the e2e leg below pins that outcome instead). Reorder the
  // two — let a preserved occurrence outrank the erasure — and this fails: the rows come back and
  // the erased plaintext is retained.
  it('planCompaction: a permanent erase of the FORGED id itself destroys every occurrence', () => {
    const SECRET = 'the prod database password is hunter2';
    const base: MemoryRecord = {
      id: 'X', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: SECRET,
      provenance: { source: 'user', sessionId: 't' }, supersedes: null, blastRadius: null,
      reverifyTrigger: null, classification: 'normal',
    };
    const twin: MemoryRecord = { ...base, provenance: { source: 'agent-inference', sessionId: 't' } };
    const other: MemoryRecord = { ...base, id: 'other', content: 'an unrelated fact' };
    const records = [base, twin, other];

    // Premise: WITHOUT the erasure both occurrences are preserved — so the assertion below is about
    // erasure winning, not about the preserve branch being inert.
    const preserved = planCompaction(records, { erasedIds: new Set() }).kept;
    expect(preserved.filter((r) => r.id === 'X')).toHaveLength(2);

    const { kept } = planCompaction(records, { erasedIds: new Set(['X']) });
    expect(kept.filter((r) => r.id === 'X')).toHaveLength(0);       // erasure wins over the evidence
    expect(JSON.stringify(kept)).not.toContain(SECRET);             // physical destruction, not just delisting
    expect(kept.some((r) => r.id === 'other')).toBe(true);          // and it erased only what was asked
  });

  // The same property at the surface an operator actually drives. This one pins the OUTCOME the
  // erase path promises; the mechanism protecting it here is the erase TOMBSTONE (it removes the id
  // from `live`, so the keep loop above never reaches its `erasedIds` check for an ordinary id).
  it('store.erase(forgedId, permanent) leaves no row and no plaintext for the forged id', () => {
    const { mk, ledger } = tmpLedger();
    const SECRET = 'the prod database password is hunter2';
    let s = mk();
    const target = s.commit({ content: SECRET, source: 'user' });
    s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user' });
    s.confirm(target.id);

    const original = assertRowFor(ledger, target.id);
    appendFileSync(ledger, JSON.stringify({
      ...original, provenance: { ...original.provenance, source: 'agent-inference' },
    }) + '\n');
    expect(rowsFor(ledger, target.id)).toHaveLength(2);             // premise: two occurrences on disk

    s = mk();
    s.erase(target.id, { permanent: true });                        // erase the FORGED id itself

    expect(rowsFor(ledger, target.id)).toHaveLength(0);
    expect(readFileSync(ledger, 'utf8')).not.toContain(SECRET);     // right-to-erasure is physical
  });

  // The counterweight: an at-least-once append replay is NOT tamper evidence, and preserving
  // duplicates must not turn ordinary crash recovery into permanent unreclaimable ledger growth.
  it('a byte-identical repeat still collapses to one row and keeps its grade across the rewrite', () => {
    const { mk, ledger, home } = tmpLedger();
    let s = mk();
    const target = s.commit({ content: 'prod database host is db.internal', source: 'user' });
    const unrelated = s.commit({ content: 'the office wifi password is on the whiteboard', source: 'user' });
    s.confirm(target.id);

    appendFileSync(ledger, JSON.stringify(assertRowFor(ledger, target.id)) + '\n'); // verbatim replay

    s = mk();
    s.erase(unrelated.id, { permanent: true });

    expect(rowsFor(ledger, target.id)).toHaveLength(1);        // collapsed, not immortalized
    const after = verifiedLiveOf(parseLedger(ledger), home);
    expect(after.compromised.has(target.id)).toBe(false);
    expect(after.live.get(target.id)!.state).toBe('Verified'); // durability property, not grade loss
  });
});
