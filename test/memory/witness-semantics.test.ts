// Task 8 — semantics table + failpoint scenario suite (spec 2026-07-17-high-water-counter-decision
// §4.8 rows + §7 failpoints not already locked by Tasks 1-7). Integration-level: drives a REAL
// MemoryStore over mkdtempSync homes (plus direct witness-store/witness-core calls where a scenario
// needs a lower-level seam than the store exposes). Tasks 1-7 are merged, so every scenario here is
// expected to PASS against shipped behavior — a red result is a real defect, not an expected gap.
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync, readdirSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { readLedgerBytes, witnessFenceRecord } from '../../src/memory/ledger.js';
import {
  witnessPath, scopeKeyOf, readScopeWitness, classifyScope, classifyState,
  advanceWitness, planTransition, openTransition, WitnessBlockedError,
} from '../../src/memory/witness-store.js';
import { sha256Hex, classifyWitness, type WitnessEntry } from '../../src/memory/witness-core.js';
import { readLedgerWitnessed } from '../../src/memory/witness-read.js';
import {
  WITNESS_MISMATCH_NOTE, WITNESS_TRANSITION_NOTE, WITNESS_INIT_NOTE,
} from '../../src/memory/content-frame.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';

const FIXED = '2026-07-19T00:00:00.000Z';

function newHome(): string { return mkdtempSync(join(tmpdir(), 'helix-witsem-')); }

function newProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-witsem-proj-'));
  mkdirSync(join(root, '.helix'), { recursive: true });
  return root;
}

/** A store with a fixed clock + monotonic ids over a fresh tmp home (no project layer). */
function makeStore(home: string): { store: MemoryStore; ledger: string } {
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}` });
  return { store, ledger };
}

/** Open an interrupted transition for `scopeKey`: journal a NEW head that never lands, leaving the
 *  ledger at its OLD bytes so classifyWitness returns transition-interrupted (spec §4.9, crash
 *  window A). Mirrors witness-enforcement.test.ts's (Task 7) identical recipe. */
function plantInterrupted(home: string, scopeKey: string, ledger: string, tx: string): void {
  const plan = planTransition(home, scopeKey, 'compaction');
  const targetText = readLedgerBytes(ledger).toString('utf8')
    + JSON.stringify(witnessFenceRecord(plan.epoch, plan.nonce, tx)) + '\n';
  const expected = { byteLength: Buffer.byteLength(targetText), prefixHash: sha256Hex(Buffer.from(targetText)) };
  openTransition(home, scopeKey, {
    kind: 'compaction', epoch: plan.epoch, nonce: plan.nonce, predecessor: plan.predecessor,
    supersedes: plan.supersedes, expected, tx,
  });
}

describe('Task 8 — semantics table + failpoint scenarios', () => {
  describe('scenario: first run ever / new scope first contact -> TOFU + INIT note (spec rows 1-2)', () => {
    it('row 1 — first run ever: witness.json is literally absent; first read is first-contact/no-entry; the first commit establishes TOFU at epoch 1; the INIT note renders before, and disappears after', () => {
      const home = newHome();
      try {
        const { store, ledger } = makeStore(home);
        expect(existsSync(witnessPath(home))).toBe(false); // witness.json has never been written

        expect(classifyScope(home, scopeKeyOf(home), readLedgerBytes(ledger))).toEqual({ kind: 'first-contact', reason: 'no-entry' });
        const before = store.recall('anything');
        expect(before.witnessNotes).toContain(WITNESS_INIT_NOTE);

        store.commit({ content: 'first ever fact', source: 'user' });
        expect(existsSync(witnessPath(home))).toBe(true);
        const entry = readScopeWitness(home, scopeKeyOf(home)).entry!;
        const bytes = readFileSync(ledger);
        expect(entry.epoch).toBe(1); // TOFU
        expect(entry.byteLength).toBe(bytes.length);
        expect(entry.prefixHash).toBe(sha256Hex(bytes));

        const after = store.recall('first ever');
        expect(after.witnessNotes).not.toContain(WITNESS_INIT_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('row 2 — new scope first contact: GLOBAL is already witnessed; adopting a fresh PROJECT scope makes it participate before it has ever been witnessed, so its own independent first-contact renders the INIT note until its first commit', () => {
      const home = newHome();
      const root = newProjectRoot();
      try {
        const globalLedger = join(home, 'memory.jsonl');
        const projLedger = join(root, '.helix', 'memory.jsonl');
        let n = 0;
        const store = new MemoryStore(globalLedger, {
          home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
          project: { ledger: projLedger, root, home },
        });
        store.commit({ content: 'global already witnessed fact', scope: 'global', source: 'user' });
        expect(readScopeWitness(home, '@global').entry).not.toBeNull(); // global: already past first-contact

        // adopt() stamps ownership (making the project scope PARTICIPATE in reads) WITHOUT ever
        // witnessing it — unlike an ordinary commit, which stamps ownership AND witnesses atomically
        // within one call, this is the genuine "a scope newly participates, unwitnessed" window
        // (the team-shared-ledger precedent, store.ts adopt() doc-comment).
        store.adopt();
        expect(readScopeWitness(home, scopeKeyOf(home, root)).entry).toBeNull(); // never witnessed

        const res = store.recall('global already');
        expect(res.witnessNotes).toContain(WITNESS_INIT_NOTE); // triggered by the project scope alone

        store.commit({ content: 'project first contact fact', scope: 'project', source: 'user' });
        const projEntry = readScopeWitness(home, scopeKeyOf(home, root)).entry!;
        expect(projEntry.epoch).toBe(1); // TOFU

        const res2 = store.recall('project first contact');
        expect(res2.witnessNotes).not.toContain(WITNESS_INIT_NOTE); // both scopes now past first-contact
      } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('scenario: key rotation — overwriting the master key invalidates every witness MAC -> first-contact/mac-invalid + INIT note; the next write re-establishes (row 4)', () => {
    it('overwriting ledger-mac-master.key with fresh (different) 32 bytes degrades the witness to first-contact/mac-invalid, without excluding rows; a subsequent commit re-establishes TOFU under the new key', () => {
      const home = newHome();
      try {
        const { store, ledger } = makeStore(home);
        store.commit({ content: 'pre-rotation fact', source: 'user' });
        store.commit({ content: 'pre-rotation fact two', source: 'user' });
        const before = readScopeWitness(home, scopeKeyOf(home)).entry!;
        expect(before.epoch).toBe(1);

        // Key rotation: the master key file is overwritten with NEW, different, valid-length bytes.
        writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));

        const rotated = readScopeWitness(home, scopeKeyOf(home));
        expect(rotated.macInvalid).toBe(true);
        expect(rotated.entry).toBeNull(); // the OLD entry's MAC no longer verifies under the new key

        // classifyState directly (the brief names it explicitly): the SAME degraded state, classified
        // against the current ledger bytes.
        const verdict = classifyState(rotated, readFileSync(ledger));
        expect(verdict).toEqual({ kind: 'first-contact', reason: 'mac-invalid' });

        const res = store.recall('pre-rotation');
        expect(res.witnessNotes).toContain(WITNESS_INIT_NOTE);
        expect(res.items.length).toBeGreaterThan(0); // first-contact never excludes — rows still served

        store.commit({ content: 'post-rotation fact', source: 'user' });
        const after = readScopeWitness(home, scopeKeyOf(home));
        expect(after.macInvalid).toBe(false);
        expect(after.entry!.epoch).toBe(1); // fresh TOFU — epoch resets, does not resume the old lineage
        expect(after.entry!.byteLength).toBe(readFileSync(ledger).length);

        const res2 = store.recall('post-rotation');
        expect(res2.witnessNotes).not.toContain(WITNESS_INIT_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('scenario: machine migration — home copied (witness intact), project ledger reset to an older byte-prefix -> mismatch (row 3, the CORRECT alarm)', () => {
    it('a second machine whose home carries the latest witnessed head, but whose project clone is an older checkout, alarms rather than staying silent', () => {
      const home = newHome();
      const root = newProjectRoot();
      const home2Base = mkdtempSync(join(tmpdir(), 'helix-witsem-home2-'));
      try {
        const projLedger = join(root, '.helix', 'memory.jsonl');
        let n = 0;
        const store = new MemoryStore(join(home, 'memory.jsonl'), {
          home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
          project: { ledger: projLedger, root, home },
        });
        store.commit({ content: 'project fact one (older era)', scope: 'project', source: 'user' });
        const olderClone = readFileSync(projLedger); // snapshot: what a clone taken right now would see
        store.commit({ content: 'project fact two', scope: 'project', source: 'user' });
        store.commit({ content: 'project fact three', scope: 'project', source: 'user' });
        expect(readFileSync(projLedger).length).toBeGreaterThan(olderClone.length);

        // "copy the home dir (witness intact)": the second machine's ~/.helix is a byte-for-byte
        // duplicate of the first machine's, carrying the LATEST witnessed head.
        const home2 = join(home2Base, 'home');
        cpSync(home, home2, { recursive: true });

        // "reset the project ledger to an older byte-prefix": the SAME shared project tree, on the
        // second machine, is an older git checkout — regressed to the earlier snapshot.
        writeFileSync(projLedger, olderClone);

        const key = scopeKeyOf(home2, root);
        expect(classifyScope(home2, key, readFileSync(projLedger)).kind).toBe('mismatch'); // row 3: the CORRECT alarm, not silence

        const store2 = new MemoryStore(join(home2, 'memory.jsonl'), {
          home: home2, sessionId: 't', now: () => FIXED,
          project: { ledger: projLedger, root, home: home2 },
        });
        const res = store2.recall('project fact');
        expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
        expect(res.items.some((i) => i.record.content === 'project fact one (older era)')).toBe(true); // D1b: still served
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(home2Base, { recursive: true, force: true });
      }
    });
  });

  describe('scenario: witness deletion — rm witness.json -> first-contact + INIT note, never a crash (row 7)', () => {
    it('deleting witness.json mid-life is a visible reset, not a crash: reads degrade to first-contact/no-entry and keep serving, the next write re-establishes cleanly', () => {
      const home = newHome();
      try {
        const { store, ledger } = makeStore(home);
        store.commit({ content: 'fact before deletion', source: 'user' });
        expect(existsSync(witnessPath(home))).toBe(true);

        rmSync(witnessPath(home));
        expect(existsSync(witnessPath(home))).toBe(false);

        expect(() => classifyScope(home, scopeKeyOf(home), readFileSync(ledger))).not.toThrow();
        expect(classifyScope(home, scopeKeyOf(home), readFileSync(ledger))).toEqual({ kind: 'first-contact', reason: 'no-entry' });

        expect(() => store.recall('fact before deletion')).not.toThrow();
        const res = store.recall('fact before deletion');
        expect(res.witnessNotes).toContain(WITNESS_INIT_NOTE);
        expect(res.items.length).toBeGreaterThan(0); // never a crash, rows still served

        expect(() => store.commit({ content: 'fact after deletion', source: 'user' })).not.toThrow();
        const entry = readScopeWitness(home, scopeKeyOf(home)).entry!;
        expect(entry.epoch).toBe(1); // fresh TOFU
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('scenario: same-height fork — two same-length, different-content valid branches -> mismatch (fork detection)', () => {
    it('a byte-identical-length fork of the witnessed head is caught as mismatch even though both branches are individually well-formed JSONL', () => {
      const home = newHome();
      try {
        const { store, ledger } = makeStore(home);
        store.commit({ content: 'alpha fact', source: 'user' });
        store.commit({ content: 'branch marker UNIQUEFORKZ', source: 'user' });
        const branchA = readFileSync(ledger);
        expect(classifyScope(home, scopeKeyOf(home), branchA).kind).toBe('in-sync');

        // Branch B: a same-length, different-content fork (a single-character substitution keeps the
        // byte length IDENTICAL — a length-only check would miss it; this exercises the hash compare).
        const branchB = Buffer.from(branchA.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
        expect(branchB.length).toBe(branchA.length);
        expect(branchB.equals(branchA)).toBe(false);

        // Both branches are independently well-formed JSONL (a genuine fork, not a torn/corrupt file).
        for (const branch of [branchA, branchB]) {
          for (const line of branch.toString('utf8').trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
        }

        writeFileSync(ledger, branchB);
        expect(classifyScope(home, scopeKeyOf(home), branchB).kind).toBe('mismatch');

        const res = store.recall('branch marker');
        expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  // "Torn reader" — read-order rationale (spec §7 "concurrent reader spanning the two files"). The
  // public API (readLedgerWitnessed, store.recall/currentView/historyView/asOfView) exposes no seam
  // to pause mid-read and inject a mutation between its internal witness-state read and its
  // ledger-bytes read, so the live interleave cannot be driven through it (per the task brief, this
  // is expected — see the SEPARATE investigation reported alongside this suite for what WAS checked
  // at the integration level via manual decomposition of the two reads, and what it found about the
  // production read ORDER at every call site). What this scenario proves directly, at the classify
  // level: capturing the witness snapshot BEFORE a concurrent legitimate append lands, then hashing
  // the (now longer) ledger bytes AFTER, is unconditionally benign — never a spurious mismatch —
  // because a plain append preserves the witnessed prefix regardless of when it is observed.
  describe('scenario: torn reader — witness read first, ledger swapped to a LONGER file before the hash -> stays benign unwitnessed-suffix, never a spurious mismatch (read-order rationale)', () => {
    it('a witness snapshot taken BEFORE a concurrent append lands, paired with the ledger bytes hashed AFTER, classifies unwitnessed-suffix — not mismatch', () => {
      const home = newHome();
      try {
        const { store, ledger } = makeStore(home);
        store.commit({ content: 'alpha fact', source: 'user' });

        // Reader step 1: witness state, captured BEFORE the concurrent append.
        const witnessSnapshot = readScopeWitness(home, scopeKeyOf(home));
        expect(witnessSnapshot.entry).not.toBeNull();

        // Concurrently: a real production append lands (ledger grows; the witnessed prefix is preserved).
        store.commit({ content: 'bravo fact landed concurrently', source: 'user' });

        // Reader step 2: hash the CURRENT (now-longer) ledger bytes against the snapshot from step 1.
        const grownBytes = readFileSync(ledger);
        expect(grownBytes.length).toBeGreaterThan(witnessSnapshot.entry!.byteLength);

        const verdict = classifyState(witnessSnapshot, grownBytes);
        expect(verdict.kind).toBe('unwitnessed-suffix'); // benign — never a spurious mismatch
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('pure classifyWitness equivalent (no IO): growth-after-snapshot with an intact prefix is unwitnessed-suffix, independent of any store/IO plumbing', () => {
      const witnessed = Buffer.from('row1\nrow2\n', 'utf8');
      const entry: WitnessEntry = { epoch: 1, byteLength: witnessed.length, prefixHash: sha256Hex(witnessed), headTx: null, mac: 'm' };
      const grown = Buffer.from('row1\nrow2\nrow3\n', 'utf8'); // a legitimate append on top
      expect(classifyWitness(grown, entry, null).kind).toBe('unwitnessed-suffix');
    });
  });

  describe('failpoint: disk-full / short-write on the witness.json replace', () => {
    it('a write failure mid-replace leaves witness.json byte-identical to its pre-attempt content; the tmp is cleaned up immediately', () => {
      const home = newHome();
      try {
        advanceWitness(home, '@global', Buffer.from('row1\n', 'utf8'), 'tx-1'); // seed "old content"
        const before = readFileSync(witnessPath(home), 'utf8');

        const faulty: DurableFsOps = { ...realFsOps, writeSync: () => { throw new Error('ENOSPC fake (witness write)'); } };
        expect(() => advanceWitness(home, '@global', Buffer.from('row1\nrow2\n', 'utf8'), 'tx-2', faulty))
          .toThrow(/ENOSPC fake/);

        expect(readFileSync(witnessPath(home), 'utf8')).toBe(before); // OLD content intact — the write never landed
        const strays = readdirSync(home).filter((n) => n.includes('.w-') && n.endsWith('.tmp'));
        expect(strays).toHaveLength(0); // the failing call's own catch-block cleans up its tmp immediately
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('a stray tmp left by a doubly-failed write (even the cleanup unlink fails) is swept by the next successful mutation', () => {
      const home = newHome();
      try {
        advanceWitness(home, '@global', Buffer.from('row1\n', 'utf8'), 'tx-1');
        const before = readFileSync(witnessPath(home), 'utf8');

        const faulty: DurableFsOps = {
          ...realFsOps,
          writeSync: () => { throw new Error('ENOSPC fake'); },
          unlinkSync: (p: string) => { if (p.includes('.w-')) throw new Error('EACCES fake (cannot even unlink)'); realFsOps.unlinkSync(p); },
        };
        expect(() => advanceWitness(home, '@global', Buffer.from('row1\nrow2\n', 'utf8'), 'tx-2', faulty))
          .toThrow(/ENOSPC fake/);
        expect(readFileSync(witnessPath(home), 'utf8')).toBe(before); // still intact

        const strayBefore = readdirSync(home).filter((n) => n.includes('.w-') && n.endsWith('.tmp'));
        expect(strayBefore.length).toBeGreaterThan(0); // this failure's own orphan survives (unlink itself failed)

        advanceWitness(home, '@global', Buffer.from('row1\nrow2\nrow3\n', 'utf8'), 'tx-3'); // next mutation, real fsOps
        const strayAfter = readdirSync(home).filter((n) => n.includes('.w-') && n.endsWith('.tmp'));
        expect(strayAfter).toHaveLength(0); // swept by the next mutation's sweepOrphanTmps
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('failpoint: fsync error path — a thrown fsyncSync on the witness fd aborts the replace, leaving OLD content intact (fs-ops.ts fsyncDir already swallows in production)', () => {
    it('a thrown fsyncSync leaves witness.json byte-identical to its pre-attempt content; rename never runs', () => {
      const home = newHome();
      try {
        advanceWitness(home, '@global', Buffer.from('row1\n', 'utf8'), 'tx-1');
        const before = readFileSync(witnessPath(home), 'utf8');

        const faulty: DurableFsOps = { ...realFsOps, fsyncSync: () => { throw new Error('EIO fake (fsync)'); } };
        expect(() => advanceWitness(home, '@global', Buffer.from('row1\nrow2\n', 'utf8'), 'tx-2', faulty))
          .toThrow(/EIO fake/);

        expect(readFileSync(witnessPath(home), 'utf8')).toBe(before); // OLD content intact — rename never reached
        const strays = readdirSync(home).filter((n) => n.includes('.w-') && n.endsWith('.tmp'));
        expect(strays).toHaveLength(0); // cleaned up by the catch block
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    // fs-ops.ts's OWN fsyncDir (the directory-level fsync AFTER rename) already swallows EINVAL/EISDIR
    // internally (fs-ops.ts:24-29) — a REAL failure there can never propagate to a DurableFsOps caller
    // in production, so it is not a "content stays old" failpoint the way fsyncSync-on-fd is; it runs
    // only after the rename already landed the NEW content. Confirmed directly for completeness: even
    // an INJECTED fsOps.fsyncDir override (which bypasses the internal swallow, since it replaces the
    // whole function) still fires too late to protect old content — a durability-only concern the
    // design already accepts, not a correctness gap.
    it('a thrown fsyncDir fires only AFTER the rename already landed the new content (not a content-intact failpoint)', () => {
      const home = newHome();
      try {
        advanceWitness(home, '@global', Buffer.from('row1\n', 'utf8'), 'tx-1');
        const faulty: DurableFsOps = { ...realFsOps, fsyncDir: () => { throw new Error('EINVAL fake (dir fsync)'); } };
        expect(() => advanceWitness(home, '@global', Buffer.from('row1\nrow2\n', 'utf8'), 'tx-2', faulty))
          .toThrow(/EINVAL fake/);
        const state = readScopeWitness(home, '@global');
        expect(state.entry!.byteLength).toBe(Buffer.from('row1\nrow2\n', 'utf8').length); // the NEW content landed anyway
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('scenario: repeated-interference containment — the project scope stays mismatched across 3 separate write+read cycles; global scope recall is unaffected every single time (per-scope isolation)', () => {
    it('3 cycles of project writes landing during an active mismatch never leak into global', () => {
      const home = newHome();
      const root = newProjectRoot();
      try {
        const projLedger = join(root, '.helix', 'memory.jsonl');
        let n = 0;
        const store = new MemoryStore(join(home, 'memory.jsonl'), {
          home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
          project: { ledger: projLedger, root, home },
        });
        const g = store.commit({ content: 'global keepme fact', scope: 'global', source: 'user' });
        store.commit({ content: 'project seed UNIQUEFORKZ', scope: 'project', source: 'user' });

        // Force interference once: fork the project ledger (same length, different content).
        const seedBytes = readFileSync(projLedger);
        const forked = Buffer.from(seedBytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
        expect(forked.length).toBe(seedBytes.length);
        writeFileSync(projLedger, forked);
        expect(classifyScope(home, scopeKeyOf(home, root), forked).kind).toBe('mismatch');

        for (let i = 0; i < 3; i++) {
          // A further project write LANDS (availability, anti-laundering: the witness never advances
          // over mismatch, so the alarm persists across every one of these writes).
          store.commit({ content: `project write during interference cycle ${i}`, scope: 'project', source: 'user' });

          const res = store.recall('keepme');
          expect(res.items.find((it) => it.record.id === g.id)).toBeDefined(); // global unaffected — EVERY cycle
          expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);

          expect(classifyScope(home, scopeKeyOf(home, root), readFileSync(projLedger)).kind).toBe('mismatch'); // still mismatched
          expect(classifyScope(home, '@global', readFileSync(join(home, 'memory.jsonl'))).kind).toBe('in-sync'); // global healthy throughout
        }
      } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('scenario: COMBINED clamp+exclusion — global mismatch (clamp) + owned project transition-interrupted (exclusion) in ONE recall call (Task 7 review gap)', () => {
    it('global rows are served but clamped (Verified -> Fresh) with the MISMATCH note; project rows are fully excluded with the TRANSITION note; both notes present, ordered global-first, deduped', () => {
      const home = newHome();
      const root = newProjectRoot();
      try {
        const globalLedger = join(home, 'memory.jsonl');
        const projLedger = join(root, '.helix', 'memory.jsonl');
        let n = 0;
        const store = new MemoryStore(globalLedger, {
          home, sessionId: 't', now: () => FIXED, genId: () => `m_${++n}`,
          project: { ledger: projLedger, root, home },
        });

        // Global: a genuinely Verified row, then fork a DIFFERENT trailing fact (same length) so the
        // mismatch is caused by the witness, not by tampering the verify record itself (isolates D1
        // exactly like witness-enforcement.test.ts's forkedMismatch() recipe).
        const g = store.commit({ content: 'global target SHAREDTERM deploy fact', scope: 'global', source: 'user' });
        store.confirm(g.id); // Verified, witnessed
        store.commit({ content: 'global tail filler UNIQUEFORKZ', scope: 'global', source: 'user' });
        const gBytes = readFileSync(globalLedger);
        const gForked = Buffer.from(gBytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
        expect(gForked.length).toBe(gBytes.length);
        writeFileSync(globalLedger, gForked);
        expect(classifyScope(home, '@global', gForked).kind).toBe('mismatch');

        // Project (owned): a pending transition whose expected bytes never land -> transition-interrupted.
        const pj = store.commit({ content: 'project excluded SHAREDTERM fact', scope: 'project', source: 'user' });
        plantInterrupted(home, scopeKeyOf(home, root), projLedger, '2026-07-19T00:05:00.000Z');
        expect(classifyScope(home, scopeKeyOf(home, root), readFileSync(projLedger)).kind).toBe('transition-interrupted');

        // ONE recall call, both conditions active simultaneously.
        const res = store.recall('SHAREDTERM');

        const globalHit = res.items.find((i) => i.record.id === g.id);
        expect(globalHit).toBeDefined();               // D1b: global rows still served
        expect(globalHit!.record.state).toBe('Fresh');  // D1: clamped from Verified

        expect(res.items.find((i) => i.record.id === pj.id)).toBeUndefined(); // project fully excluded

        expect(res.witnessNotes).toContain(WITNESS_MISMATCH_NOTE);
        expect(res.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);
        expect(res.witnessNotes).toHaveLength(2); // both present, no duplicates
        expect(res.witnessNotes.indexOf(WITNESS_MISMATCH_NOTE))
          .toBeLessThan(res.witnessNotes.indexOf(WITNESS_TRANSITION_NOTE)); // ordered global-first
      } finally { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
    });
  });

  describe('scenario: ceremony-bound honesty — a rebaseline-kind pending journal with non-matching bytes blocks writes + excludes reads, persisting across a store restart (no auto-decay)', () => {
    it('constructs the rebaseline journal directly (Task 9 ceremony CLI is not implemented yet) via openTransition(kind: "rebaseline", ...); the block/exclusion survives a fresh MemoryStore instance over the same home', () => {
      const home = newHome();
      const ledger = join(home, 'memory.jsonl');
      try {
        const store1 = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED });
        store1.commit({ content: 'pre-rebaseline fact', source: 'user' });

        const key = scopeKeyOf(home);
        // Task 9's ceremony CLI is not implemented on this branch yet — construct the SAME journal
        // state directly via planTransition/openTransition(kind:'rebaseline', ...), simulating an
        // interrupted/incomplete re-baseline ceremony (a "bless" confirmation that was interrupted
        // before the ledger was ever rewritten to the promised bytes).
        const p = planTransition(home, key, 'rebaseline');
        openTransition(home, key, {
          kind: 'rebaseline', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
          expected: { byteLength: 99999, prefixHash: sha256Hex(Buffer.from('never-written-rebaseline-bytes')) },
          tx: '2026-07-19T00:10:00.000Z',
        });
        expect(readLedgerWitnessed(ledger, home).verdict.kind).toBe('transition-interrupted');

        expect(() => store1.commit({ content: 'blocked write attempt', source: 'user' })).toThrow(WitnessBlockedError);
        const recallBefore = store1.recall('pre-rebaseline');
        expect(recallBefore.items).toHaveLength(0); // excluded
        expect(recallBefore.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);

        // "restart": a FRESH MemoryStore instance over the SAME home/ledger — no in-memory cache
        // carried over, no auto-decay just because the process/store object is new.
        const store2 = new MemoryStore(ledger, { home, sessionId: 't', now: () => FIXED });
        expect(() => store2.commit({ content: 'blocked again after restart', source: 'user' })).toThrow(WitnessBlockedError);
        const recallAfter = store2.recall('pre-rebaseline');
        expect(recallAfter.items).toHaveLength(0);
        expect(recallAfter.witnessNotes).toContain(WITNESS_TRANSITION_NOTE);

        const onDisk = readFileSync(ledger, 'utf8');
        expect(onDisk).toContain('pre-rebaseline fact');       // untouched by either blocked attempt
        expect(onDisk).not.toContain('blocked write attempt');
        expect(onDisk).not.toContain('blocked again after restart');
        expect(readScopeWitness(home, key).journal).not.toBeNull(); // still pending — no auto-decay
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });
});
