import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, appendFileSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  appendRecord, parseLedger, compactLedger, planCompaction, isHorizonMarker, landedCompactionStats,
  type CompactOptions,
} from '../../src/memory/ledger.js';
import { buildHistory } from '../../src/memory/history.js';
import { buildProjection } from '../../src/memory/projection.js';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';
import { witnessPath } from '../../src/memory/witness-store.js';
import type { MemoryRecord } from '../../src/types.js';

function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}
function tmpLedger() {
  return join(mkdtempSync(join(tmpdir(), 'helix-compact-')), 'memory.jsonl');
}
function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}` });
  return { store, ledger, home };
}

describe('legacy compaction is an explicit opt-in (C1.4 residual 2)', () => {
  it('a predicate-less call without the legacy marker throws instead of silently dropping verifies', () => {
    expect(() => planCompaction([], { erasedIds: new Set() } as unknown as CompactOptions))
      .toThrow(/legacyBakeAndDrop/);
  });
  it('the options type refuses a predicate-less object at compile time', () => {
    // @ts-expect-error — neither predicates nor the explicit legacy marker: must not compile
    const bad: CompactOptions = { erasedIds: new Set<string>() };
    void bad;
  });

  // A FALSY NON-UNDEFINED keepValidVerify used to sail past the guard (`=== undefined`) and then land
  // in the worst state in the option space, because two later sites asked the question differently:
  // `hmacAware` (`!== undefined`) counted it as HMAC-aware and reset every kept asset to Fresh,
  // discarding the baked states, while the verify-preserve loop's truthiness test skipped entirely and
  // dropped every verify row. Both mechanisms for losing an elevation firing at once — worse than
  // either mode alone. MEASURED against the pre-fix code (2026-08-12) with one live fact and one
  // eligible verify and `keepValidVerify: null`: it returned with NO error, the fact kept at Fresh and
  // the verify row gone. All three sites now ask `typeof === 'function'`, so the value cannot get in.
  // Labelled with String(), not JSON.stringify(): the latter renders NaN as "null" and would give two
  // of these cases the same test name.
  for (const bogus of [null, false, 0, '', Number.NaN]) {
    it(`a falsy non-undefined keepValidVerify (${String(bogus)}) throws instead of selecting the worst mode`, () => {
      expect(() => planCompaction([], { erasedIds: new Set(), keepValidVerify: bogus } as unknown as CompactOptions))
        .toThrow(/legacyBakeAndDrop/);
    });
  }

  it('a NON-CALLABLE truthy keepValidVerify is refused at the guard, not deeper in', () => {
    // Truthiness was the wrong question in BOTH directions: it admitted values that are not callable at
    // all. Under the old `=== undefined` guard such a value got through, and what happened next depended
    // on the ledger — measured on this fixture (an empty record list, so no eligible verify ever reaches
    // the predicate) NOTHING threw; the call simply returned having silently selected HMAC-aware mode.
    // A ledger that does reach the predicate would instead throw a TypeError partway through, after the
    // Fresh reset had already been applied. Refusing at the entry guard collapses both outcomes into one
    // loud failure and keeps the rewrite all-or-nothing.
    expect(() => planCompaction([], { erasedIds: new Set(), keepValidVerify: 'yes' } as unknown as CompactOptions))
      .toThrow(/legacyBakeAndDrop/);
  });
});

describe('compactLedger', () => {
  it('drops the erased item from the live set but keeps a content-free tombstone', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'keep me' }));
    appendRecord(p, rec({ id: 'secret', content: 'PASSWORD', classification: 'personal' }));
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'secret', content: '' }));

    compactLedger(p, { erasedIds: new Set(['secret']), legacyBakeAndDrop: true });

    const after = parseLedger(p);
    expect(after.find((r) => r.id === 'm_1')?.content).toBe('keep me'); // unaffected fact kept
    expect(after.find((r) => r.id === 'secret')).toBeUndefined();       // erased: gone from live set
    const tomb = after.find((r) => r.id === 'e_1');                     // tombstone remains for audit
    expect(tomb).toBeDefined();
    expect(tomb!.content).toBe('');
    expect(JSON.stringify(after)).not.toContain('PASSWORD');            // no plaintext anywhere
  });

  it('drops superseded records entirely', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));

    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });

    const ids = parseLedger(p).map((r) => r.id);
    expect(ids).not.toContain('m_1');
    expect(ids).toContain('m_2');
  });

  it('leaves no temp file behind (atomic rename)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    const files = readdirSync(dirname(p));
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(existsSync(p)).toBe(true);
  });

  // The returned stats are what a caller emits as a past-tense metric, so they must equal the REAL
  // on-disk deltas: droppedRows is the rows removed (never the rows kept), reclaimedBytes is
  // before-minus-after (never the reverse).
  it('returns the row and byte deltas it actually wrote', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old fact with some length to it' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    appendRecord(p, rec({ id: 'm_3', content: 'another fact that will be superseded' }));
    appendRecord(p, rec({ id: 'm_4', type: 'supersede', supersedes: 'm_3', content: 'newer' }));
    const rowsBefore = parseLedger(p).length;
    const bytesBefore = statSync(p).size;

    const stats = compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });

    const rowsAfter = parseLedger(p).length;
    const bytesAfter = statSync(p).size;
    expect(stats.droppedRows).toBe(rowsBefore - rowsAfter);   // dropped, not surviving
    expect(stats.droppedRows).toBeGreaterThan(0);
    expect(stats.reclaimedBytes).toBe(bytesBefore - bytesAfter); // before - after, not after - before
    expect(stats.reclaimedBytes).toBeGreaterThan(0);
  });

  // A compaction that drops NOTHING but mints a content-free horizon marker makes the ledger net-GROW.
  // That is a truthful negative reclaim, not an error: clamping it to 0 would report "reclaimed
  // nothing" for a compaction that actually cost disk space — the one case an operator needs to see.
  it('reports a net-growing compaction as a NEGATIVE reclaim (never clamped)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'x' }));                                  // tiny fact
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'm_1', content: '' }));  // closes it
    const bytesBefore = statSync(p).size;

    const stats = compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });

    const bytesAfter = statSync(p).size;
    // Kept: the erase tombstone + a freshly minted horizon marker (m_1's assert row is now closed).
    expect(stats.droppedRows).toBe(0);
    expect(bytesAfter).toBeGreaterThan(bytesBefore);              // the file really did grow
    expect(stats.reclaimedBytes).toBe(bytesBefore - bytesAfter);  // reported as-is...
    expect(stats.reclaimedBytes).toBeLessThan(0);                 // ...i.e. negative, not clamped to 0
  });
});

// LEAD-METRIC-MISREPORT: compactLedger only ever returned CompactionStats on its success path — every
// throw, including one that hits AFTER the atomic rename has already landed the rewrite, left a caller
// with nothing but the error. store.ts's maybeAutoCompact swallows that throw and mapped it to
// {droppedRows: 0, reclaimedBytes: 0, ok: false} unconditionally, misreporting "nothing happened" for a
// rewrite that DID land and DID drop rows. These lock landedCompactionStats: real counts when the
// rename already succeeded, nothing attached when it did not.
describe('compactLedger — a failure AFTER the rename lands still reports the REAL deltas', () => {
  it('a dir-fsync failure after the rename attaches the REAL dropped-row/byte counts to the thrown error', () => {
    const p = tmpLedger();
    // Same fixture as "returns the row and byte deltas it actually wrote" above, so a genuinely
    // positive drop is guaranteed regardless of fixpoint-marker bookkeeping.
    appendRecord(p, rec({ id: 'm_1', content: 'old fact with some length to it' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    appendRecord(p, rec({ id: 'm_3', content: 'another fact that will be superseded' }));
    appendRecord(p, rec({ id: 'm_4', type: 'supersede', supersedes: 'm_3', content: 'newer' }));
    const rowsBefore = parseLedger(p).length;
    const bytesBefore = statSync(p).size;

    // Same DurableFsOps seam test/memory/witness-rewrite.test.ts:189 uses: fsyncDir throws AFTER a
    // successful rename, so the new bytes are already on disk when this fires.
    const faultyFs: DurableFsOps = { ...realFsOps, fsyncDir: () => { throw new Error('injected dir fsync failure (post-rename)'); } };

    let caught: unknown = null;
    try {
      compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true, fsOps: faultyFs });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/injected dir fsync failure/); // original failure preserved verbatim

    // The rewrite really DID land: the ledger genuinely shrank on disk.
    const rowsAfter = parseLedger(p).length;
    const bytesAfter = statSync(p).size;
    expect(rowsAfter).toBeLessThan(rowsBefore);

    const stats = landedCompactionStats(caught);
    expect(stats).toBeDefined();
    expect(stats!.droppedRows).toBe(rowsBefore - rowsAfter);      // REAL count, never 0
    expect(stats!.droppedRows).toBeGreaterThan(0);
    expect(stats!.reclaimedBytes).toBe(bytesBefore - bytesAfter); // REAL bytes, never 0
    expect(stats!.reclaimedBytes).toBeGreaterThan(0);
  });

  // Discrimination check: the mechanism must NOT attach stats to a failure that never landed — a
  // pre-rename throw is a genuine no-op, and reporting nonzero drops for it would be its own
  // misreport, in the opposite direction.
  it('a PRE-rename failure attaches nothing — landedCompactionStats is undefined when nothing landed', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old fact with some length to it' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    const before = statSync(p).size;

    const faultyFs: DurableFsOps = { ...realFsOps, renameSync: () => { throw new Error('injected rename failure (pre-landing)'); } };
    let caught: unknown = null;
    try {
      compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true, fsOps: faultyFs });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(Error);
    expect(landedCompactionStats(caught)).toBeUndefined(); // nothing landed -> nothing attached
    expect(statSync(p).size).toBe(before);                  // and the ledger really is untouched
  });

  // Fix round 1 (review Important 1): the attach was a bare assignment. ESM is strict mode, so
  // assigning a NEW property to a non-extensible (e.g. frozen) object throws instead of landing —
  // and that throw would replace the real failure with a TypeError, reachable via the public
  // `opts.fsOps` seam (not just an internal invariant). The attach must never destroy the error it
  // is trying to enrich.
  it('a frozen (non-extensible) error thrown post-rename reaches the caller UNCHANGED — no TypeError from the attach', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old fact with some length to it' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    appendRecord(p, rec({ id: 'm_3', content: 'another fact that will be superseded' }));
    appendRecord(p, rec({ id: 'm_4', type: 'supersede', supersedes: 'm_3', content: 'newer' }));

    const frozen = Object.freeze(new Error('injected dir fsync failure (frozen, post-rename)'));
    const faultyFs: DurableFsOps = { ...realFsOps, fsyncDir: () => { throw frozen; } };

    let caught: unknown = null;
    try {
      compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true, fsOps: faultyFs });
    } catch (e) { caught = e; }

    expect(caught).toBe(frozen);                                              // the SAME object, not a TypeError
    expect((caught as Error).message).toBe('injected dir fsync failure (frozen, post-rename)');
  });

  // Fix round 1 (review Important 2): landedCompactionStats must never report stale stats from an
  // EARLIER call on a REUSED error object. No throw site in this codebase reuses one today, but the
  // channel's own contract (":undefined for every other throw... a pre-rename failure") must hold
  // even against a future module-level sentinel error a caller reuses across calls — otherwise a
  // pre-rename (nothing-happened) failure could read back a PRIOR call's real, nonzero counts: this
  // task's own defect class, inverted.
  it('a REUSED error object does not leak stale landed stats into a later PRE-rename failure', () => {
    const shared = new Error('shared sentinel error, reused across two compactLedger calls');

    // Call 1: a genuine post-rename landing -> shared SHOULD carry real stats afterward.
    const landedLedger = tmpLedger();
    appendRecord(landedLedger, rec({ id: 'm_1', content: 'old fact with some length to it' }));
    appendRecord(landedLedger, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    appendRecord(landedLedger, rec({ id: 'm_3', content: 'another fact that will be superseded' }));
    appendRecord(landedLedger, rec({ id: 'm_4', type: 'supersede', supersedes: 'm_3', content: 'newer' }));
    const faultyFsLanded: DurableFsOps = { ...realFsOps, fsyncDir: () => { throw shared; } };
    let caught1: unknown = null;
    try { compactLedger(landedLedger, { erasedIds: new Set(), legacyBakeAndDrop: true, fsOps: faultyFsLanded }); } catch (e) { caught1 = e; }
    expect(caught1).toBe(shared);
    expect(landedCompactionStats(shared)).toBeDefined(); // sanity: the first call really did attach

    // Call 2: the SAME error object, but this time a PRE-rename failure — the stale stats from call 1
    // must be cleared, not carried forward onto an unrelated ledger that never landed anything.
    const untouchedLedger = tmpLedger();
    appendRecord(untouchedLedger, rec({ id: 'x_1', content: 'unrelated fact' }));
    const faultyFsPre: DurableFsOps = { ...realFsOps, renameSync: () => { throw shared; } };
    let caught2: unknown = null;
    try { compactLedger(untouchedLedger, { erasedIds: new Set(), legacyBakeAndDrop: true, fsOps: faultyFsPre }); } catch (e) { caught2 = e; }
    expect(caught2).toBe(shared);
    expect(landedCompactionStats(shared)).toBeUndefined(); // must NOT still report call 1's stats
  });

  // The other post-rename throw site (spec §4.9): completeTransition runs AFTER the rename too. Models
  // the exact fault docs/issues/repros/lead-rename-then-witness-throw-metric.ts uses (delete
  // witness.json between rename and completeTransition), so both post-rename failure sites are proven,
  // not just fsyncDir.
  it('a witness-completion failure after the rename also attaches the REAL counts (the other post-rename throw site)', () => {
    const { store, ledger, home } = tmpStore();
    store.commit({ content: 'alpha fact', source: 'user' });
    store.commit({ content: 'bravo fact', source: 'user' });
    const c = store.commit({ content: 'charlie fact', source: 'user' });
    const d = store.commit({ content: 'delta fact', source: 'user' });
    const rowsBefore = parseLedger(ledger).length;
    const bytesBefore = statSync(ledger).size;

    const wpath = witnessPath(home);
    const sabotageFs: DurableFsOps = {
      ...realFsOps,
      renameSync: (from: string, to: string) => { realFsOps.renameSync(from, to); unlinkSync(wpath); },
    };

    let caught: unknown = null;
    try {
      compactLedger(ledger, {
        erasedIds: new Set([c.id, d.id]), // 2 dropped so the net survives the fence row's own drop-cost
        witness: { home, scopeKey: '@global', now: () => '2026-06-09T00:00:00.000Z', kind: 'erase' },
        fsOps: sabotageFs,
        legacyBakeAndDrop: true,
      });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(Error);
    const rowsAfter = parseLedger(ledger).length;
    const bytesAfter = statSync(ledger).size;
    expect(rowsAfter).toBeLessThan(rowsBefore); // the rewrite DID land

    const stats = landedCompactionStats(caught);
    expect(stats).toBeDefined();
    expect(stats!.droppedRows).toBe(rowsBefore - rowsAfter);
    expect(stats!.droppedRows).toBeGreaterThan(0);
    expect(stats!.reclaimedBytes).toBe(bytesBefore - bytesAfter);
  });
});

describe('compactLedger HMAC-aware (via store permanent-erase)', () => {
  it('preserves a genuine signed verify, drops a forged one, and emits an integrity tombstone', () => {
    const { store, ledger } = tmpStore();

    // A: genuine — committed by the user, then confirmed (a real signed Verified verify).
    const a = store.commit({ content: 'alpha fact', source: 'user' });
    store.confirm(a.id);

    // B: committed, then a FORGED Verified verify is hand-appended (no MAC/keyId/macVersion).
    const b = store.commit({ content: 'beta fact', source: 'user' });
    appendFileSync(ledger, JSON.stringify({
      id: 'forgedB', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: b.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5,
      targetDigest: digestContent('beta fact'),
    }) + '\n');

    // C: committed, then permanently erased — this triggers HMAC-aware compaction.
    const c = store.commit({ content: 'gamma fact', source: 'user' });
    store.erase(c.id, { permanent: true });

    // Recall reflects the verifying replay over the compacted ledger.
    const items = store.recall('fact').items;
    const byId = (id: string) => items.find((i) => i.record.id === id);
    expect(byId(a.id)!.record.state).toBe('Verified'); // genuine elevation preserved across compaction
    expect(byId(b.id)!.record.state).toBe('Fresh');     // forged elevation dropped -> honest floor
    expect(byId(c.id)).toBeUndefined();                  // erased -> gone

    const after = parseLedger(ledger);
    // Integrity-incident tombstone: a content-free verify, no MAC, no target.
    const tomb = after.find((r) => r.id.startsWith('integrity_'));
    expect(tomb).toBeDefined();
    expect(tomb!.state).toBe('Suspect');
    // The forged B verify (gen 5) is physically gone.
    expect(after.find((r) => r.gen === 5)).toBeUndefined();
    // The genuine signed verify for A is preserved (still carries its MAC, still targets A).
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && !!r.mac)).toBe(true);
  });

  it('key-absent compaction PRESERVES genuine verifies (non-destructive: cannot tell genuine from forged)', () => {
    // Compaction is DESTRUCTIVE (unlike the recoverable read-path clamp). When the subkey is
    // unresolvable (key removed / transient registry-read failure), we cannot distinguish a genuine
    // verify from a forgery — so we must DROP NOTHING rather than permanently destroy recoverable
    // elevations. With no key, the read path clamps everything to Fresh anyway, so kept records
    // confer no trust; the next key-present compaction purges any forgeries.
    //
    // W-T5 note: every witnessed append (including a plain commit, or an erase's own tombstone
    // append) now mints the master key too if it is absent (advanceWitness MACs the witness entry
    // via the same ensureMaster — plan Global Constraints: "write paths may mint via ensureMaster").
    // So `c` must be committed AND soft-erased (already dead) BEFORE the key is deleted: a permanent
    // erase of an ALREADY-dead id skips its tombstone append entirely (T1-g/D8) and goes straight to
    // compactLedger, which is the only sequencing left that reaches compaction with a genuinely,
    // still-absent key.
    const { store, ledger, home } = tmpStore();
    const a = store.commit({ content: 'alpha fact', source: 'user' });
    store.confirm(a.id); // mints the master + signs A's genuine verify
    const c = store.commit({ content: 'gamma fact', source: 'user' });
    store.erase(c.id); // soft erase (key still present) — c is already dead by the time we go permanent

    const masterPath = join(home, 'ledger-mac-master.key');
    expect(existsSync(masterPath)).toBe(true);
    rmSync(masterPath); // key now unavailable -> subkeyForLedger returns null at compact time

    store.erase(c.id, { permanent: true }); // c already dead -> tombstone skipped -> compacts with a null subkey

    const after = parseLedger(ledger);
    // A's genuine signed verify MUST still be on disk — key-absent compaction must not destroy it.
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && !!r.mac)).toBe(true);
    expect(after.find((r) => r.id === c.id)).toBeUndefined(); // erase still took effect
  });

  it('preserves a genuine SIGNED demotion (Suspect) across compaction; the item stays Suspect on replay', () => {
    const { store, ledger } = tmpStore();
    // This path is committed into ledger content, and the write-path secret scanner redacts any
    // high-entropy segment to [redacted:high-entropy] — so the probe must be a FIXED, LOW-ENTROPY
    // name (a unique/random path would be redacted out and break the file-contains binding, which
    // needs the path present in content). It is placed under the REAL system temp (HELIX_TEST_SYS_TMP),
    // NOT the redirected per-run root, so its path stays low-entropy and it is never swept by the
    // per-run teardown. With constant content and no delete, concurrent runs sharing this one reused
    // file never flip the recheck outcome (the previous finally-rmSync could delete another run's probe
    // mid-recheck — the shared-path flake this removes).
    const probeDir = join(process.env.HELIX_TEST_SYS_TMP ?? tmpdir(), 'helix-demote-probe');
    mkdirSync(probeDir, { recursive: true });
    const probe = join(probeDir, 'probe.txt');
    writeFileSync(probe, 'placeholder file without the marker');
    const a = store.commit({ content: `deploy note: ${probe} must contain ENABLED_FLAG`, source: 'agent-inference' });
    const rc = store.recheck(a.id, { kind: 'file-contains', path: probe, pattern: 'ENABLED_FLAG' });
    expect(rc.record?.type).toBe('verify');
    expect(rc.record?.state).toBe('Suspect');
    expect(rc.record?.mac).toBeTruthy();
    expect(store.recall('deploy').items.find((i) => i.record.id === a.id)!.record.state).toBe('Suspect');
    const c = store.commit({ content: 'gamma fact', source: 'user' });
    store.erase(c.id, { permanent: true });
    const items = store.recall('deploy').items;
    expect(items.find((i) => i.record.id === a.id)!.record.state).toBe('Suspect');
    const after = parseLedger(ledger);
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && r.state === 'Suspect' && !!r.mac)).toBe(true);
    expect(after.find((r) => r.id.startsWith('integrity_'))).toBeUndefined();
    expect(items.find((i) => i.record.id === c.id)).toBeUndefined();
  });
});

describe('compactLedger — horizon marker (spec B)', () => {
  it('emits exactly one horizon marker when a supersede-closed row is dropped', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits a horizon marker for invalidate-closed history', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'fact' }));
    appendRecord(p, rec({ id: 'inv_1', type: 'invalidate', supersedes: 'm_1', content: '' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits a horizon marker for erase-dropped history', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'fact' }));
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'm_1', content: '' }));
    compactLedger(p, { erasedIds: new Set(['m_1']), legacyBakeAndDrop: true });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits NO horizon marker when nothing closed is dropped (all-live)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'only live fact' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(0);
  });

  it('a closed-history-dropping compaction makes the history view truncated (deterministic)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    expect(buildHistory(parseLedger(p)).truncated).toBe(true);
  });

  it('the emitted horizon marker never surfaces as a live fact (no phantom)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    const recs = parseLedger(p);
    const marker = recs.find(isHorizonMarker)!;
    expect(buildProjection(recs).has(marker.id)).toBe(false);
  });

  it('preserves the marker across a later all-live compaction (signal does not revert)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });            // drops m_1 -> emits one marker
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });            // all-live now: must PRESERVE the marker
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
    expect(buildHistory(parseLedger(p)).truncated).toBe(true);
  });

  // D2: pre-fix, this coalesced to whichever planted row was append-first, PRESERVED VERBATIM — so an
  // adversary who won the append race got their id/tx immortalized forever. Post-fix, neither planted
  // row survives: both collapse into the one canonical, reconstructed `horizon_marker` fixpoint.
  it('coalesces forged duplicate markers to ONE canonical marker (neither planted row survives verbatim)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_live', content: 'live fact' }));
    // Two forged horizon markers with distinct ids/tx, to prove neither's bytes survive selection.
    appendRecord(p, rec({ id: 'horizon_first', type: 'verify', supersedes: null, content: '', tx: '2026-06-09T00:00:02.000Z' }));
    appendRecord(p, rec({ id: 'horizon_second', type: 'verify', supersedes: null, content: '', tx: '2026-06-09T00:00:01.000Z' }));
    compactLedger(p, { erasedIds: new Set(), legacyBakeAndDrop: true });
    const markers = parseLedger(p).filter(isHorizonMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.id).toBe('horizon_marker');         // constant canonical id, not either planted id
    expect(markers[0]!.tx).not.toBe('2026-06-09T00:00:02.000Z');
    expect(markers[0]!.tx).not.toBe('2026-06-09T00:00:01.000Z');
  });
});
