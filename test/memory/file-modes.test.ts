import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { appendRecordUnlocked, witnessFenceRecord } from '../../src/memory/ledger.js';
import { appendAudit } from '../../src/audit.js';
import { realFsOps, type DurableFsOps } from '../../src/memory/fs-ops.js';

// Round 3 of the defect audit asked for exactly one test: "every persisted Helix file is owner-only".
// It did not exist, which is why F7 and N2-MODE could both ship — the adjacent invariants (the master
// key, witness.json, metrics.jsonl) each had their own test and passed, so the suite was green over a
// ledger and an audit log that were neither.
//
// THE VACUITY TRAP (see the note near line 50 of test/memory/witness-store.test.ts): asserting the
// ON-DISK mode is umask-dependent. Under umask 0077 the default 0o666 is already masked to 0o600 by
// the OS, so a `statSync(...) === 0o600` assertion stays green even with the fix deleted. Two
// defences are used below: the ledger assertion spies the injected fsOps seam and checks the MODE
// ARGUMENT (umask-independent, kills the mutant under any umask), and the on-disk assertions refuse
// to run vacuously — they fail loudly rather than pass by coincidence.

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'helix-modes-'));

/** Fail rather than pass-by-coincidence: under a umask this tight, an unfixed 0o666 create already
 *  lands at 0o600 and every on-disk assertion below is meaningless. */
function assertNotVacuous(): void {
  const mask = process.umask() as unknown as number;
  if ((mask & 0o066) === 0o066) {
    throw new Error(
      `this test is vacuous under umask 0${mask.toString(8)}: an unfixed 0o666 create is already `
      + 'masked to 0o600, so the on-disk assertions cannot fail. Re-run under a looser umask.',
    );
  }
}

describe('every persisted Helix file is owner-only', () => {
  it('the ledger is created with an explicit owner-only mode, not left to the umask', () => {
    if (platform() === 'win32') return; // mode bits are not enforced on Windows
    const home = tmpHome();
    try {
      // Umask-INDEPENDENT: assert the mode actually passed to open, not the mode the OS happened to
      // leave on disk. This is the assertion that dies if the mode argument is removed.
      // Driven through appendRecordUnlocked's own fsOps parameter rather than MemoryStore, which
      // takes no such seam — and cannot be given one while store.ts is a freeze-pinned path.
      const modes: Array<number | undefined> = [];
      const spy: DurableFsOps = {
        ...realFsOps,
        openSync: (path, flags, mode) => {
          if (path.endsWith('memory.jsonl')) modes.push(mode);
          return realFsOps.openSync(path, flags, mode);
        },
      };
      appendRecordUnlocked(join(home, 'memory.jsonl') as never, witnessFenceRecord(1, 'n1', 'tx-1'), spy);
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((m) => m === 0o600)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a real commit leaves nothing group- or world-accessible under HELIX_HOME', () => {
    if (platform() === 'win32') return;
    assertNotVacuous();
    const home = tmpHome();
    try {
      const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });
      store.commit({ content: 'a fact about the deploy', source: 'user' });
      appendAudit(join(home, 'audit.jsonl'), {
        kind: 'erase', ts: '1970-01-01T00:00:00.000Z', id: 'x', soft: true,
      } as never);

      const offenders = readdirSync(home)
        .map((f) => ({ f, mode: statSync(join(home, f)).mode & 0o777 }))
        .filter((x) => (x.mode & 0o077) !== 0)
        .map((x) => `${x.f}=0${x.mode.toString(8)}`);
      expect(offenders).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
