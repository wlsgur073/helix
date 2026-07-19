// Task 9 — user-only TTY re-baseline ceremony CLI (spec 2026-07-17-high-water-counter-decision
// §6/D2). Unit tests: deps-injected `main`, driven over a REAL MemoryStore + mkdtempSync homes (no
// mocked witness/ledger internals) so the actual serialization-consistency and lock-holding
// behavior is observed, not assumed. The compiled-artifact smoke test lives separately
// (test/rebaseline-smoke.test.ts) and only exercises the argv-parsing / TTY-gate surface (it can
// never reach the confirmation prompt from a non-interactive spawn).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/rebaseline-cli.js';
import { MemoryStore } from '../src/memory/store.js';
import { readLedgerBytes, witnessFenceRecord } from '../src/memory/ledger.js';
import { withFileLock } from '../src/memory/lock.js';
import {
  readScopeWitness, classifyState, scopeKeyOf, witnessLogPath, planTransition, openTransition,
} from '../src/memory/witness-store.js';
import { sha256Hex } from '../src/memory/witness-core.js';

function tmpHome(): string { return mkdtempSync(join(tmpdir(), 'helix-rebaseline-home-')); }

/** Global-scope MISMATCHED fixture: commit via a real MemoryStore (witnesses the scope in-sync),
 *  then fork the ledger tail with a SAME-LENGTH byte change so classifyState returns 'mismatch'
 *  (same recipe as witness-enforcement.test.ts's forkedMismatch). This is the ceremony's actual
 *  purpose — recovering a scope that is NOT currently in-sync. */
function mismatchedGlobalHome(): { home: string; ledger: string } {
  const home = tmpHome();
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 't', genId: () => `m_${++n}` });
  store.commit({ content: 'alpha target fact UNIQUEFORKZ', source: 'user' });
  store.commit({ content: 'beta filler row', source: 'user' });
  const bytes = readLedgerBytes(ledger);
  const forked = Buffer.from(bytes.toString('utf8').replace('UNIQUEFORKZ', 'UNIQUEFORKY'), 'utf8');
  expect(forked.length).toBe(bytes.length); // same-length fork, not a truncation/extension
  expect(forked.equals(bytes)).toBe(false);
  writeFileSync(ledger, forked);
  const key = scopeKeyOf(home);
  expect(classifyState(readScopeWitness(home, key), readLedgerBytes(ledger)).kind).toBe('mismatch'); // sanity
  return { home, ledger };
}

/** Global-scope TRANSITION-INTERRUPTED fixture (spec §4.3/§7 crash-window-A): witness a scope, then
 *  plant a pending journal whose `expected` target was NEVER actually written to the ledger — the
 *  ledger's real bytes stay at their pre-transition value while the journal describes a fenced
 *  rewrite that never landed (mirrors witness-enforcement.test.ts's plantInterrupted recipe). This
 *  is the state where re-driving the ORIGINAL operation is unavailable (nothing produced the target
 *  bytes) and only the ceremony's supersession can un-stick the scope (spec §7 round-4
 *  "non-re-runnable-transition recovery drill"). */
function transitionInterruptedGlobalHome() {
  const home = tmpHome();
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { home, sessionId: 't', genId: () => `m_${++n}` });
  store.commit({ content: 'alpha fact before interruption', source: 'user' });
  const key = scopeKeyOf(home);

  const preBytes = readLedgerBytes(ledger);
  const plan0 = planTransition(home, key, 'compaction');
  const neverAppliedTargetText = preBytes.toString('utf8')
    + JSON.stringify(witnessFenceRecord(plan0.epoch, plan0.nonce, '2026-07-18T00:05:00.000Z')) + '\n';
  const staleExpected = {
    byteLength: Buffer.byteLength(neverAppliedTargetText),
    prefixHash: sha256Hex(Buffer.from(neverAppliedTargetText)),
  };
  const staleJournal = openTransition(home, key, {
    kind: 'compaction', epoch: plan0.epoch, nonce: plan0.nonce, predecessor: plan0.predecessor,
    supersedes: plan0.supersedes, expected: staleExpected, tx: '2026-07-18T00:05:00.000Z',
  });
  // Sanity: the ledger's REAL bytes are still preBytes (the journaled target was never written), so
  // this IS transition-interrupted, not transition-heal.
  expect(classifyState(readScopeWitness(home, key), readLedgerBytes(ledger)).kind).toBe('transition-interrupted');
  return { home, ledger, key, staleJournal };
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { HELIX_HOME: home };
}

/** Captures process.stdout/stderr writes for the duration of one synchronous scope, without
 *  silencing them for anything else running concurrently in the process. Always restored. */
function captureStd(): { stdout: () => string; stderr: () => string; restore: () => void } {
  let out = '';
  let err = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += chunk.toString(); return true; });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += chunk.toString(); return true; });
  return { stdout: () => out, stderr: () => err, restore: () => { so.mockRestore(); se.mockRestore(); } };
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('rebaseline-cli main() — usage / TTY gate', () => {
  it('no args -> usage, exit 2, mentions --scope', async () => {
    const cap = captureStd();
    try {
      const code = await main([], {});
      expect(code).toBe(2);
      expect(cap.stderr()).toContain('--scope');
    } finally { cap.restore(); }
  });

  it('--help -> usage, exit 2 (falls through the same "anything else" branch)', async () => {
    const cap = captureStd();
    try {
      const code = await main(['--help'], {});
      expect(code).toBe(2);
      expect(cap.stderr()).toContain('usage');
    } finally { cap.restore(); }
  });

  it('a relative --scope value (neither "global" nor absolute) -> usage, exit 2', async () => {
    const cap = captureStd();
    try {
      const code = await main(['--scope', 'relative/proj'], {});
      expect(code).toBe(2);
    } finally { cap.restore(); }
  });

  it('valid --scope but non-TTY -> exit 2 with a DIFFERENT message than usage, before any prompt', async () => {
    const cap = captureStd();
    let promptCalled = false;
    try {
      const code = await main(['--scope', 'global'], {
        isTTY: false,
        promptLine: async () => { promptCalled = true; return 'bless'; },
      });
      expect(code).toBe(2);
      expect(cap.stderr()).toContain('interactive terminal');
      expect(cap.stderr()).not.toContain('usage');
      expect(promptCalled).toBe(false);
    } finally { cap.restore(); }
  });
});

describe('rebaseline-cli main() — happy path (mismatched scope)', () => {
  it('bless -> exit 0, verdict flips to in-sync, fence is the last ledger row, journal cleared, witness-log has the rebaseline line', async () => {
    const { home, ledger } = mismatchedGlobalHome();
    homes.push(home);
    const key = scopeKeyOf(home);
    const beforeEpoch = readScopeWitness(home, key).entry?.epoch ?? 0;

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', 'global'], {
        env: envFor(home), isTTY: true, promptLine: async () => 'bless', now: () => '2026-07-19T00:00:00.000Z',
      });
    } finally { cap.restore(); }

    expect(code).toBe(0);
    expect(cap.stdout()).toContain('re-baselined global at epoch');

    const finalBytes = readLedgerBytes(ledger);
    const state = readScopeWitness(home, key);
    const verdict = classifyState(state, finalBytes);
    expect(verdict.kind).toBe('in-sync');
    expect(state.journal).toBeNull();
    expect(state.entry!.epoch).toBeGreaterThan(beforeEpoch);

    const lines = finalBytes.toString('utf8').split('\n').filter((l) => l.length > 0);
    const lastRow = JSON.parse(lines[lines.length - 1]!) as { id: string; tx: string };
    expect(lastRow.id.startsWith('witness_fence_')).toBe(true);
    expect(lastRow.tx).toBe('2026-07-19T00:00:00.000Z');

    const logLines = readFileSync(witnessLogPath(home), 'utf8').trim().split('\n');
    const lastLog = JSON.parse(logLines[logLines.length - 1]!) as { kind: string; scope: string };
    expect(lastLog.kind).toBe('rebaseline');
    expect(lastLog.scope).toBe(key);
  });

  it('also works on a virgin (first-contact) project scope: resolves <root>/.helix/memory.jsonl and bumps to epoch 1', async () => {
    const home = tmpHome();
    homes.push(home);
    const root = mkdtempSync(join(tmpdir(), 'helix-rebaseline-proj-'));
    homes.push(root);
    const projLedger = join(root, '.helix', 'memory.jsonl');

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', root], { env: envFor(home), isTTY: true, promptLine: async () => 'bless' });
    } finally { cap.restore(); }

    expect(code).toBe(0);
    const key = scopeKeyOf(home, root);
    const state = readScopeWitness(home, key);
    expect(state.entry!.epoch).toBe(1);
    expect(classifyState(state, readLedgerBytes(projLedger)).kind).toBe('in-sync');
  });
});

describe('rebaseline-cli main() — recovers a transition-interrupted scope (spec §4.3/§7 recovery drill)', () => {
  it('bless supersedes the stale pending journal and un-sticks the scope to in-sync, exit 0', async () => {
    const { home, ledger, key, staleJournal } = transitionInterruptedGlobalHome();
    homes.push(home);

    // Independent, pure-read probe of what the ceremony's OWN internal planTransition call will
    // compute — taken BEFORE main() runs, over the identical (still-untouched) witness state main()
    // will see. planTransition never mutates (witness-store.ts), so this extra call is side-effect-
    // free and does not perturb the scenario; epoch/supersedes are derived deterministically from the
    // current entry/pending state (only `nonce` is randomized per call), so this is a faithful,
    // non-invasive stand-in for what main()'s internal call computes — no need to mock/intercept the
    // real one to observe the supersession.
    const expectedSupersession = planTransition(home, key, 'rebaseline');
    expect(expectedSupersession.supersedes).toBe(staleJournal.nonce);
    expect(expectedSupersession.epoch).toBeGreaterThan(staleJournal.epoch);

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', 'global'], { env: envFor(home), isTTY: true, promptLine: async () => 'bless' });
    } finally { cap.restore(); }

    expect(code).toBe(0);

    const finalBytes = readLedgerBytes(ledger);
    const postState = readScopeWitness(home, key);
    expect(postState.journal).toBeNull(); // the ceremony's own transition completed and cleared
    expect(postState.entry!.epoch).toBe(expectedSupersession.epoch); // landed exactly at the superseding plan's epoch
    expect(classifyState(postState, finalBytes).kind).toBe('in-sync'); // the scope is un-stuck

    const lines = finalBytes.toString('utf8').split('\n').filter((l) => l.length > 0);
    const lastRow = JSON.parse(lines[lines.length - 1]!) as { id: string };
    expect(lastRow.id.startsWith('witness_fence_')).toBe(true); // fence is the last ledger row

    const logLines = readFileSync(witnessLogPath(home), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { kind: string; scope: string; epoch: number; nonce: string });
    expect(logLines.some((l) => l.kind === 'compaction' && l.nonce === staleJournal.nonce)).toBe(true); // the stale journal's own creation line survives
    const lastLog = logLines[logLines.length - 1]!;
    expect(lastLog.kind).toBe('rebaseline'); // the ceremony's superseding transition is the newest log line
    expect(lastLog.scope).toBe(key);
    expect(lastLog.epoch).toBe(expectedSupersession.epoch);
  });
});

describe('rebaseline-cli main() — refusal paths', () => {
  it('wrong confirmation word -> exit 1, ledger byte-identical, witness untouched', async () => {
    const { home, ledger } = mismatchedGlobalHome();
    homes.push(home);
    const before = readLedgerBytes(ledger);
    const key = scopeKeyOf(home);
    const beforeState = readScopeWitness(home, key);

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', 'global'], { env: envFor(home), isTTY: true, promptLine: async () => 'nope' });
    } finally { cap.restore(); }

    expect(code).toBe(1);
    expect(readLedgerBytes(ledger).equals(before)).toBe(true);
    const afterState = readScopeWitness(home, key);
    expect(afterState.entry).toEqual(beforeState.entry);
    expect(afterState.journal).toEqual(beforeState.journal);
  });

  it('hash-race: promptLine mutates the ledger before resolving "bless" -> exit 3, nothing written', async () => {
    const { home, ledger } = mismatchedGlobalHome();
    homes.push(home);
    const before = readLedgerBytes(ledger);
    const key = scopeKeyOf(home);
    const beforeState = readScopeWitness(home, key);

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', 'global'], {
        env: envFor(home), isTTY: true,
        promptLine: async () => {
          writeFileSync(ledger, Buffer.concat([readLedgerBytes(ledger), Buffer.from('injected-during-confirmation\n')]));
          return 'bless';
        },
      });
    } finally { cap.restore(); }

    expect(code).toBe(3);
    expect(cap.stderr()).toContain('ledger changed during confirmation');
    // "nothing written": the mutation from inside promptLine is the ONLY change — the ceremony
    // itself appended no fence and the witness did not move.
    const after = readLedgerBytes(ledger);
    expect(after.toString('utf8')).toBe(before.toString('utf8') + 'injected-during-confirmation\n');
    const afterState = readScopeWitness(home, key);
    expect(afterState.entry).toEqual(beforeState.entry);
    expect(afterState.journal).toEqual(beforeState.journal);
  });
});

describe('rebaseline-cli main() — lock discipline (spec §6/§7 design invariant)', () => {
  it('holds the SAME ledger lock across the async confirmation prompt — never released and re-acquired', async () => {
    const { home, ledger } = mismatchedGlobalHome();
    homes.push(home);

    let innerThrew = false;
    let innerMessage = '';
    const promptLine = async (): Promise<string> => {
      // The `await setImmediate` FIRST is load-bearing, not decoration: it forces a genuine
      // event-loop turn before the nested probe runs. Without it, this whole function body would
      // execute SYNCHRONOUSLY as part of evaluating `await promptLine(...)` inside main()'s locked
      // callback — i.e. still inside the ORIGINAL synchronous call stack, before either a correct
      // or a buggy lock wrapper would have had any chance to release anything. That would make the
      // nested check pass for the WRONG reason (plain same-stack reentrancy) regardless of which
      // lock primitive main() uses, defeating the point of this test (caught empirically: an
      // earlier version of this test without the yield stayed green even when main() was pointed
      // at the naive, lock-releasing-too-early `withFileLock` instead of `withFileLockAsync`).
      await new Promise((resolve) => setImmediate(resolve));
      // Now genuinely on a later turn. If (and only if) main() still holds the ledger lock at this
      // point, a nested SYNCHRONOUS withFileLock attempt on the SAME path, from the SAME
      // process/thread, is classified 'reentrant-self' and throws immediately (lock.test.ts's own
      // precedent: "fails FAST with a diagnostic, not a 5s block"). If main() had (incorrectly)
      // released the lock before this await — the exact bug class `withFileLock(target, async fn)`
      // silently has — this nested call would succeed with no throw at all, falsifying the
      // assertion below.
      try {
        withFileLock(ledger, () => 'inner-must-not-run', { maxWaitMs: 50 });
      } catch (e) {
        innerThrew = true;
        innerMessage = e instanceof Error ? e.message : String(e);
      }
      return 'bless';
    };

    const cap = captureStd();
    let code: number;
    try {
      code = await main(['--scope', 'global'], { env: envFor(home), isTTY: true, promptLine });
    } finally { cap.restore(); }

    expect(innerThrew).toBe(true);
    expect(innerMessage).toMatch(/re-entrant/i);
    expect(code).toBe(0); // the ceremony itself still completed normally after the nested probe
  });
});
