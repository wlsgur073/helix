// Auto-compaction on the recall path (spec 2026-07-09), invariants I1-I6.
// NOTE: I4/I5 uses chmodSync to force a write failure — Linux/WSL (the repo's platform).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, chmodSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { subkeyForScope } from '../../src/memory/verified-read.js';
import { keyIdOf } from '../../src/memory/ledger-mac.js';
import type { CompactionConfig } from '../../src/config.js';
import { noopMetricsSink, type MetricsSink, type CompactionInput } from '../../src/metrics.js';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-autocompact-')); }
// minRows 3, minDirtyBytes 1 so a small churned fixture is "dirty"; graceMs is overridden per test.
const enabled: CompactionConfig = { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 };
// A store clock fixed FAR in the future makes any real ledger mtime "old", so quiescence passes
// deterministically (no dependence on wall-clock timing between the write and the recall).
const FUTURE = '2100-01-01T00:00:00.000Z';

/** Churn a ledger so it is mostly dead: commit 6 facts, then supersede 5 of them.
 *  Physical rows = 11; live rows = 6 (1 untouched assert + 5 supersede replacements).
 *  Returns the LIVE ids (the untouched assert first, then the 5 replacements). */
function makeDirty(store: MemoryStore): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(store.commit({ content: `fact ${i} deploy timeout`, source: 'user' }).id);
  const live = [ids[5]!];
  for (let i = 0; i < 5; i++) live.push(store.commit({ content: `fact ${i} updated deploy timeout`, source: 'user', supersedes: ids[i]! }).id);
  return live;
}

/** A sink that records every compaction metric (and nothing else). */
function recordingSink(): { sink: MetricsSink; emitted: CompactionInput[] } {
  const emitted: CompactionInput[] = [];
  return { sink: { ...noopMetricsSink, emitCompaction: (c) => { emitted.push(c); } }, emitted };
}

describe('auto-compaction on recall', () => {
  it('I3: does not fire when auto is off (no compaction config)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      expect(readFileSync(ledger, 'utf8')).toBe(before); // untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I3: does not fire when the config is present but auto:false (cheapGate notAuto)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: { ...enabled, auto: false } });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      expect(readFileSync(ledger, 'utf8')).toBe(before); // untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('fires on the first eligible recall and shrinks the ledger; live facts survive', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      makeDirty(store);
      const rowsBefore = parseLedger(ledger).length;
      const hit = store.recall('deploy');       // MISS -> eligible -> compaction
      expect(parseLedger(ledger).length).toBeLessThan(rowsBefore); // dead weight dropped
      expect(hit.items.length).toBeGreaterThan(0); // recall still returns the live facts
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // The metric fields are only verifiable here (Task 3 shipped them unwitnessed). `droppedRows` is the
  // DROPPED count, never the surviving count; `reclaimedBytes` is pre-minus-post (positive), never the
  // reverse. Both are pinned to the ACTUAL on-disk deltas, so a swap or a sign flip goes red.
  it('emits a compaction metric whose droppedRows/reclaimedBytes match the real on-disk deltas', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const { sink, emitted } = recordingSink();
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled, metricsSink: sink });
      makeDirty(store);
      const rowsBefore = parseLedger(ledger).length;
      const bytesBefore = statSync(ledger).size;
      store.recall('deploy');
      const rowsAfter = parseLedger(ledger).length;
      const bytesAfter = statSync(ledger).size;

      expect(rowsAfter).toBeLessThan(rowsBefore);
      expect(bytesAfter).toBeLessThan(bytesBefore);
      expect(emitted).toHaveLength(1);
      const m = emitted[0]!;
      expect(m.ok).toBe(true);
      expect(m.scope).toBe('global');
      expect(m.droppedRows).toBe(rowsBefore - rowsAfter);       // DROPPED, not surviving (rowsAfter)
      expect(m.droppedRows).toBeGreaterThan(0);
      expect(m.reclaimedBytes).toBe(bytesBefore - bytesAfter);  // pre - post, not post - pre
      expect(m.reclaimedBytes).toBeGreaterThan(0);
      expect(m.durationMs).toBeGreaterThanOrEqual(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // ATTRIBUTION: the metric must report what compactLedger measured under its LOCK, not what the
  // lock-free eligibility pass PLANNED. A write landing between the two is compacted into the same
  // rewrite, so plan-derived numbers would silently attribute that writer's rows/bytes to us.
  // The injectable clock is the seam: `now()` is called exactly once during recall(), inside
  // maybeAutoCompact, AFTER the read loop snapshotted the ledger text and BEFORE compactLedger locks.
  it('reports the counts measured under the lock, not the eligibility plan (late write attribution)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      let armed = false;
      let bytesAtLock = 0;
      let rowsAtLock = 0;
      let lateTarget = '';
      const now = (): string => {
        if (armed) {
          armed = false;
          // A late supersede: +1 physical row, and it kills a live record. The lock-free plan (11 rows)
          // projects 4 drops; the locked compaction (12 rows) actually performs 5.
          appendFileSync(ledger, JSON.stringify({
            id: 'late_1', tx: FUTURE, validFrom: FUTURE, validTo: null,
            type: 'supersede', state: 'Fresh', content: 'late deploy timeout fact',
            provenance: { source: 'user', sessionId: 't' },
            supersedes: lateTarget, blastRadius: null, reverifyTrigger: null, classification: 'normal',
          }) + '\n');
          rowsAtLock = parseLedger(ledger).length;
          bytesAtLock = statSync(ledger).size;
        }
        return FUTURE;
      };
      const { sink, emitted } = recordingSink();
      const store = new MemoryStore(ledger, { home, sessionId: 't', now, compaction: enabled, metricsSink: sink });
      const live = makeDirty(store);
      lateTarget = live[0]!;
      expect(parseLedger(ledger).length).toBe(11);   // the snapshot the recall will read

      armed = true;
      store.recall('deploy');

      expect(rowsAtLock).toBe(12);                   // the late write really did land before the lock
      const rowsAfter = parseLedger(ledger).length;
      const bytesAfter = statSync(ledger).size;
      const m = emitted[0]!;
      expect(m.ok).toBe(true);
      expect(m.droppedRows).toBe(rowsAtLock - rowsAfter);      // 5 (measured), not 4 (planned)
      expect(m.droppedRows).toBe(5);
      expect(m.reclaimedBytes).toBe(bytesAtLock - bytesAfter); // measured from the locked file
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I1: self-limiting — a second session over the compacted ledger is not eligible again', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const s1 = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      makeDirty(s1);
      s1.recall('deploy');                        // compacts
      const afterFirst = readFileSync(ledger, 'utf8');
      const s2 = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      s2.recall('deploy');                        // fresh session, fresh guard
      expect(readFileSync(ledger, 'utf8')).toBe(afterFirst); // reclaimable == 0 -> no re-fire
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I2: a ledger written within the grace window is not compacted (quiescence)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      // Real wall-clock now() + a 1-hour grace, so a just-written ledger's mtime is firmly within grace.
      const store = new MemoryStore(ledger, { home, sessionId: 't', compaction: { ...enabled, graceMs: 3_600_000 } });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      expect(readFileSync(ledger, 'utf8')).toBe(before); // recent write -> not quiescent -> untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I4/I5: a failing compaction is swallowed (recall still returns) and does not retry that session', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const { sink, emitted } = recordingSink();
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled, metricsSink: sink });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      chmodSync(home, 0o500); // deny writes in the ledger dir -> compactLedger's tmp openSync throws EACCES
      try {
        const r1 = store.recall('deploy');
        expect(r1.items.length).toBeGreaterThan(0);   // I5: recall still returns despite the throw
        expect(emitted).toHaveLength(1);              // attempted once...
        expect(emitted[0]!.ok).toBe(false);           // ...failed, swallowed (metric ok:false)
        // A failed compaction reclaimed NOTHING: tmp+rename leaves the ledger untouched, so the metric
        // must not report the PLAN's projected numbers as if they had happened.
        expect(emitted[0]!.droppedRows).toBe(0);
        expect(emitted[0]!.reclaimedBytes).toBe(0);
        const r2 = store.recall('deploy');
        expect(r2.items.length).toBeGreaterThan(0);
        expect(emitted).toHaveLength(1);   // I4: no retry this session (guard set on attempt, not success)
      } finally { chmodSync(home, 0o700); }           // restore so rmSync can clean up
      expect(readFileSync(ledger, 'utf8')).toBe(before); // the ledger really is untouched
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('I6: a ledger above maxBytes defers (no compaction)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const tiny: CompactionConfig = { ...enabled, maxBytes: 1 }; // any real ledger exceeds 1 byte
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: tiny });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      expect(readFileSync(ledger, 'utf8')).toBe(before); // above ceiling -> deferred
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // `rows` is the TOTAL PHYSICAL row count (11 here), never liveRows (6). The two gates that consume it
  // are pinned separately, because feeding liveRows to either one silently redefines its meaning.
  it('rows is the physical row count, not liveRows (minRows above liveRows still fires)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      // 6 live < minRows 8 <= 11 physical: only the physical count clears the tooSmall gate.
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: { ...enabled, minRows: 8 } });
      makeDirty(store);
      expect(parseLedger(ledger).length).toBe(11);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      expect(readFileSync(ledger, 'utf8')).not.toBe(before); // fired: 11 >= 8
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the dirty RATIO is measured against physical rows (4/11 < 0.5 defers; 4/6 would not)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      // minDirtyBytes high enough to disable the absolute branch, so only the ratio decides.
      const ratioOnly: CompactionConfig = { ...enabled, dirtyRatio: 0.5, minDirtyBytes: 1_000_000 };
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: ratioOnly });
      makeDirty(store);
      const before = readFileSync(ledger, 'utf8');
      store.recall('deploy');
      // reclaimable = 4 (5 dead asserts dropped, 1 horizon marker minted). 4/11 = 0.36 < 0.5 -> defer.
      // Against liveRows it would be 4/6 = 0.67 -> fire. The file proves which denominator was used.
      expect(readFileSync(ledger, 'utf8')).toBe(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // Constraint: ONE resolved subkey, shared by the eligibility plan AND the compaction. A second
  // resolution can transiently return null (registry/master read failure), which flips the keep
  // predicate to the key-absent `() => true` and preserves a forgery the plan had counted as dropped.
  //
  // F6: this is also the only test in the file that DROPS a forged verify, so it is the sole place
  // that can lock `droppedForgedVerifies` end to end. Both pass-through hops
  // (compactLedger's return in ledger.ts, the emitCompaction call in store.ts) are otherwise
  // unwitnessed: zeroing either one keeps the rest of the suite green.
  it('resolves the subkey ONCE and shares it with compactLedger (a forged verify is still dropped)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const { sink, emitted } = recordingSink();
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled, metricsSink: sink });
      const live = makeDirty(store);
      store.confirm(live[1]!);                       // mints the master key (+ one genuine verify)
      const subkey = subkeyForScope(home)!;
      expect(subkey).not.toBeNull();
      // Forged verify on a DIFFERENT live target (no equal-gen conflict): passes planCompaction's
      // live-target filter, fails verifyVerify (1-byte mac) -> must be dropped as a forgery.
      appendFileSync(ledger, JSON.stringify({
        id: 'forged_verify', tx: FUTURE, validFrom: FUTURE, validTo: null,
        type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 't' },
        supersedes: live[0]!, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        gen: 1, mac: 'ab', keyId: keyIdOf(subkey), macVersion: 2,
      }) + '\n');

      // Any subkey resolution AFTER the read loop's single one yields null — exactly the transient
      // failure the shared-value rule defends against.
      type Probe = { subkeyForLedger: (l: string) => Buffer | null };
      const probe = store as unknown as Probe;
      const orig = probe.subkeyForLedger.bind(store);
      let calls = 0;
      probe.subkeyForLedger = (l: string): Buffer | null => (++calls === 1 ? orig(l) : null);

      store.recall('deploy');

      expect(calls).toBe(1);                                                     // resolved once
      const after = parseLedger(ledger);
      expect(after.some((r) => r.id === 'forged_verify')).toBe(false);           // forgery destroyed
      expect(after.filter((r) => r.id.startsWith('integrity_'))).toHaveLength(1); // audit tombstone minted
      expect(after.some((r) => r.type === 'verify' && r.supersedes === live[1]!)).toBe(true); // genuine kept
      // F6: locks BOTH pass-through hops (ledger.ts's compactLedger return, store.ts's emitCompaction
      // call) — the real count (1 forged verify dropped above), never the zeroed default.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.droppedForgedVerifies).toBe(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // White-box on purpose: the rank cache is keyed on a ledger content digest, so a SUCCESSFUL
  // compaction always changes the key and a stale entry can never be served — no black-box assertion
  // can catch the removal of `this.rankCache = null`. It pins a DEFENSIVE line, not a live behavioural
  // contract: dropping the clear is close to behaviour-preserving today (on the failed path a cache HIT
  // suppresses the retry instead of the guard; on the success path the trigger self-limits because
  // reclaimable is then ~0). Kept because the line is what makes the guard — rather than an incidental
  // cache hit — the thing that stops a second attempt, and that should not silently rot.
  it('clears the rank cache after a compaction attempt', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      makeDirty(store);
      store.recall('deploy');
      expect((store as unknown as { rankCache: unknown }).rankCache).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // CROSS-CUTTING SEAM (a): auto-compaction dropping closed fact rows must surface as truncation on
  // BOTH bitemporal read surfaces. planCompaction mints a `horizon_` marker, ledgerTruncated detects
  // it, and historyView()/asOfView() report it. No per-task test covers this trigger -> surface seam;
  // it went RED under a mutation that skips minting the horizon marker.
  it('surfaces truncated history on BOTH inspect surfaces after an auto-compaction', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      makeDirty(store);
      expect(store.historyView().truncated).toBe(false);                  // no compaction yet -> no horizon
      store.recall('deploy');                                             // eligible MISS -> auto-compaction
      expect(parseLedger(ledger).some((r) => r.id.startsWith('horizon_'))).toBe(true); // it actually ran
      expect(store.historyView().truncated).toBe(true);                   // closed rows were dropped
      expect(store.asOfView('2100-06-01T00:00:00.000Z').truncated).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // CROSS-CUTTING SEAM (b): a genuine Verified grade must survive an auto-compaction. planCompaction
  // resets each kept asset's declared `state` to 'Fresh' (invisible: the verifying replay clamps
  // declared state anyway), and the SHARED keepValidVerifyFor predicate preserves the genuine signed
  // verify, which re-elevates the asset to Verified on replay. It went RED under a mutation that makes
  // keepValidVerifyFor drop genuine verifies (`() => false`).
  it('preserves a genuine Verified grade across an auto-compaction (fresh store re-elevates)', () => {
    const home = newHome();
    try {
      const ledger = join(home, 'memory.jsonl');
      const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FUTURE, compaction: enabled });
      const live = makeDirty(store);
      const target = live[1]!;
      store.confirm(target);                       // mints the master key + a genuine signed verify -> Verified

      const beforeInspect = store.inspect();
      const beforeIds = new Set(beforeInspect.map((s) => s.record.id));
      expect(beforeInspect.find((s) => s.record.id === target)!.record.state).toBe('Verified');
      const rowsBefore = parseLedger(ledger).length;

      const beforeRecall = store.recall('deploy timeout');  // eligible MISS -> auto-compaction fires here
      const beforeIntegrity = beforeRecall.integrityAvailable;
      expect(beforeIntegrity).toBe(true);
      expect(parseLedger(ledger).length).toBeLessThan(rowsBefore);   // compaction really ran (else vacuous)

      // A FRESH store re-derives the grade from the compacted ledger: the kept asset's declared state is
      // now 'Fresh', but the preserved signed verify re-elevates it to Verified on replay.
      const fresh = new MemoryStore(ledger, { home, sessionId: 't2', now: () => FUTURE, compaction: enabled });
      const afterInspect = fresh.inspect();
      const afterIds = new Set(afterInspect.map((s) => s.record.id));
      expect(afterInspect.find((s) => s.record.id === target)!.record.state).toBe('Verified'); // survived
      expect(afterIds).toEqual(beforeIds);                                                      // live id-set identical
      expect(fresh.recall('deploy timeout').integrityAvailable).toBe(beforeIntegrity);          // unchanged
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
