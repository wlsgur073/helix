import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
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

// N2-MODE named TWO files: audit.jsonl and sessions.jsonl. The sweep above covers audit.jsonl,
// because a real commit writes one. Nothing covered sessions.jsonl — measured, not assumed: removing
// `{ mode: 0o600 }` from src/hooks/session-end.ts and running the whole suite produced no failure at
// all. The hook is a top-level script with no exports, the same shape as server/index.ts, so the one
// existing session-end e2e runs the SHIPPED bundle in bin/ — which is frozen for the pilot window and
// therefore cannot witness a change to src/ either.
//
// So this bundles the SOURCE with the pinned esbuild and spawns it as plain node, the discipline
// bundle-cli.ts exists for. It fails if the mode argument is dropped, which is what a guard has to do.
describe('sessions.jsonl is created owner-only (N2-MODE, second site)', () => {
  it('the session-end hook, built from source, creates its ledger 0600', async () => {
    if (platform() === 'win32') return; // POSIX mode bits only
    const { bundleCli } = await import('../helpers/bundle-cli.js');
    const { execFileSync } = await import('node:child_process');
    const cli = await bundleCli('src/hooks/session-end.ts');

    const home = mkdtempSync(join(tmpdir(), 'helix-sessmode-'));
    const sessions = join(home, 'sessions.jsonl');
    execFileSync(process.execPath, [cli], {
      input: '{"session_id":"s-mode","reason":"clear"}',
      env: { ...process.env, HELIX_HOME: home, HELIX_SESSIONS: sessions },
    });

    expect(statSync(sessions).mode & 0o777).toBe(0o600);
    rmSync(home, { recursive: true, force: true });
  }, 30_000);
});

// Third fix batch B2a, task A6 (IT-M7 E01-E02d, E07c, E10; design 4.2, 4.7): the hook appends into a directory the user
// named and does not change that directory's mode.
describe('the SessionEnd hook leaves the mode of the directory it writes into alone', () => {
  const run = async (env: Record<string, string>, cwd: string): Promise<void> => {
    const { bundleCli } = await import('../helpers/bundle-cli.js');
    const { execFileSync } = await import('node:child_process');
    const cli = await bundleCli('src/hooks/session-end.ts');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;
    execFileSync(process.execPath, [cli], { cwd, env: { ...clean, ...env }, input: '{"session_id":"s-dir","reason":"clear"}' });
  };
  const fixture = (): { base: string; shared: string; home: string; cwd: string } => {
    const base = mkdtempSync(join(tmpdir(), 'helix-sedir-'));
    const shared = join(base, 'sh'); const home = join(base, 'hh'); const cwd = join(base, 'cwd');
    mkdirSync(shared); mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
    return { base, shared, home, cwd };
  };

  for (const m of [0o755, 0o775, 0o750, 0o1777, 0o2775]) {
    it(`HELIX_SESSIONS in a ${m.toString(8)} directory: the record is appended 0600 and the directory keeps its mode`, async () => {
      if (platform() === 'win32') return;
      const fx = fixture();
      try {
        chmodSync(fx.shared, m);
        expect(statSync(fx.shared).mode & 0o7777, 'premise').toBe(m);
        const file = join(fx.shared, 's.jsonl');
        await run({ HELIX_HOME: fx.home, HELIX_SESSIONS: file }, fx.cwd);
        expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(fx.shared).mode & 0o7777).toBe(m);
      } finally { rmSync(fx.base, { recursive: true, force: true }); }
    }, 30_000);
  }

  it('a 0755 HELIX_HOME keeps 0755 through a record too (the startup pass is the one place that tightens it)', async () => {
    if (platform() === 'win32') return;
    const fx = fixture();
    try {
      chmodSync(fx.home, 0o755);
      await run({ HELIX_HOME: fx.home }, fx.cwd);
      expect(readFileSync(join(fx.home, 'sessions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(statSync(fx.home).mode & 0o777).toBe(0o755);
    } finally { rmSync(fx.base, { recursive: true, force: true }); }
  }, 30_000);

  it('control: one missing level under a 0755 directory is created 0700 and the parent keeps 0755 (E10)', async () => {
    if (platform() === 'win32') return;
    const fx = fixture();
    try {
      chmodSync(fx.shared, 0o755);
      const file = join(fx.shared, 'new', 's.jsonl');
      await run({ HELIX_HOME: fx.home, HELIX_SESSIONS: file }, fx.cwd);
      expect(statSync(join(fx.shared, 'new')).mode & 0o777).toBe(0o700);
      expect(statSync(fx.shared).mode & 0o777).toBe(0o755);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { rmSync(fx.base, { recursive: true, force: true }); }
  }, 30_000);
});
