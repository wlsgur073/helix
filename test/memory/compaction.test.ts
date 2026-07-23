import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, appendFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendRecord, parseLedger, compactLedger, isHorizonMarker } from '../../src/memory/ledger.js';
import { buildHistory } from '../../src/memory/history.js';
import { buildProjection } from '../../src/memory/projection.js';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
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

describe('compactLedger', () => {
  it('drops the erased item from the live set but keeps a content-free tombstone', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'keep me' }));
    appendRecord(p, rec({ id: 'secret', content: 'PASSWORD', classification: 'personal' }));
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'secret', content: '' }));

    compactLedger(p, { erasedIds: new Set(['secret']) });

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

    compactLedger(p, { erasedIds: new Set() });

    const ids = parseLedger(p).map((r) => r.id);
    expect(ids).not.toContain('m_1');
    expect(ids).toContain('m_2');
  });

  it('leaves no temp file behind (atomic rename)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1' }));
    compactLedger(p, { erasedIds: new Set() });
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

    const stats = compactLedger(p, { erasedIds: new Set() });

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

    const stats = compactLedger(p, { erasedIds: new Set() });

    const bytesAfter = statSync(p).size;
    // Kept: the erase tombstone + a freshly minted horizon marker (m_1's assert row is now closed).
    expect(stats.droppedRows).toBe(0);
    expect(bytesAfter).toBeGreaterThan(bytesBefore);              // the file really did grow
    expect(stats.reclaimedBytes).toBe(bytesBefore - bytesAfter);  // reported as-is...
    expect(stats.reclaimedBytes).toBeLessThan(0);                 // ...i.e. negative, not clamped to 0
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
    compactLedger(p, { erasedIds: new Set() });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits a horizon marker for invalidate-closed history', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'fact' }));
    appendRecord(p, rec({ id: 'inv_1', type: 'invalidate', supersedes: 'm_1', content: '' }));
    compactLedger(p, { erasedIds: new Set() });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits a horizon marker for erase-dropped history', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'fact' }));
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'm_1', content: '' }));
    compactLedger(p, { erasedIds: new Set(['m_1']) });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
  });

  it('emits NO horizon marker when nothing closed is dropped (all-live)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'only live fact' }));
    compactLedger(p, { erasedIds: new Set() });
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(0);
  });

  it('a closed-history-dropping compaction makes the history view truncated (deterministic)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set() });
    expect(buildHistory(parseLedger(p)).truncated).toBe(true);
  });

  it('the emitted horizon marker never surfaces as a live fact (no phantom)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set() });
    const recs = parseLedger(p);
    const marker = recs.find(isHorizonMarker)!;
    expect(buildProjection(recs).has(marker.id)).toBe(false);
  });

  it('preserves the marker across a later all-live compaction (signal does not revert)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));
    compactLedger(p, { erasedIds: new Set() });            // drops m_1 -> emits one marker
    expect(parseLedger(p).filter(isHorizonMarker)).toHaveLength(1);
    compactLedger(p, { erasedIds: new Set() });            // all-live now: must PRESERVE the marker
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
    compactLedger(p, { erasedIds: new Set() });
    const markers = parseLedger(p).filter(isHorizonMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.id).toBe('horizon_marker');         // constant canonical id, not either planted id
    expect(markers[0]!.tx).not.toBe('2026-06-09T00:00:02.000Z');
    expect(markers[0]!.tx).not.toBe('2026-06-09T00:00:01.000Z');
  });
});
