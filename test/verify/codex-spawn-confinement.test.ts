import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createCodexRunner } from '../../src/verify/codex.js';

// The dual-verify subprocess used to be spawned with ONLY `stdio` set — no cwd, no env. It therefore
// inherited the user's project directory as its working directory and the server's entire
// environment. Codex's `read-only` sandbox prevents WRITES, not reads, and the egress firewall
// inspects the prompt bytes: it cannot see what the external model chooses to read once it is
// running. So a prompt-injected "check the file next to you" question routed project files, or a
// readable .env, into an external model through a channel the guard never observes.
//
// This exercises the REAL spawn. Only the launcher RESOLUTION is stubbed — the thing under test,
// runCodex's spawn options, is the production one. A test that injected a fake `run` would compile
// only after the signature changed and could never have been watched failing.
let stub: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-codexstub-'));
  stub = join(dir, 'codex-stub.mjs');
  // Stands in for the codex CLI: reports the two things the confinement is about, through the same
  // `-o <file>` channel the real CLI writes its answer to.
  writeFileSync(stub, `
import { writeFileSync, realpathSync } from 'node:fs';
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('-o') + 1];
const ci = argv.indexOf('-C');
// process.cwd() is symlink-RESOLVED while -C carries whatever spelling the caller built from
// os.tmpdir(). On a platform where the temp root is a symlink (macOS: /tmp -> /private/tmp) the two
// differ for reasons that have nothing to do with the guarantee, so the flag is reported resolved.
writeFileSync(out, JSON.stringify({
  cwd: process.cwd(),
  canary: process.env.HELIX_F5_CANARY ?? null,
  hasPath: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
  cFlag: ci === -1 ? null : realpathSync(argv[ci + 1]),
}));
`);
});

const CANARY = 'this-must-not-reach-the-subprocess';
afterEach(() => { delete process.env.HELIX_F5_CANARY; });

/** Run through the production runner with only the launcher swapped for the stub. */
type Observed = { cwd: string; canary: string | null; hasPath: boolean; cFlag: string | null };
async function runStubbed(): Promise<Observed> {
  const runner = createCodexRunner(async () => ({ file: process.execPath, argsPrefix: [stub] }));
  const res = await runner('any question');
  if (!res.ok) throw new Error(`stub runner failed: ${res.error}`);
  return JSON.parse(res.answer) as Observed;
}

describe('the codex subprocess is confined', () => {
  it('does not run in the user\'s working directory', async () => {
    const observed = await runStubbed();
    expect(observed.cwd, 'the subprocess inherited the project directory').not.toBe(process.cwd());
  }, 30_000);

  it('does not inherit the server\'s environment', async () => {
    process.env.HELIX_F5_CANARY = CANARY;
    const observed = await runStubbed();
    expect(observed.canary, 'an environment variable leaked into the external model\'s process').toBeNull();
  }, 30_000);

  // `buildCodexExecArgs` is pinned as a pure function by an exact-array assertion in codex.test.ts,
  // so the FLAG is guarded. Nothing observed the WIRING: dropping the third argument at the only call
  // site left the whole suite green, because the spawn's own `cwd` already places the child in the
  // scratch directory and no test read argv for `-C`. The two are independent guarantees — the spawn
  // decides where the process starts, the flag decides which directory the CLI treats as its project,
  // and a CLI that infers its project from somewhere else is exactly what F5 was about. This asserts
  // the flag on a REAL invocation rather than on the builder's return value.
  it('tells the CLI to treat the scratch directory as its project (-C on a real invocation)', async () => {
    const observed = await runStubbed();
    expect(observed.cFlag, 'no -C reached the CLI, so it is free to infer a project directory').not.toBeNull();
    expect(observed.cFlag, '-C named a directory other than the one the child runs in').toBe(observed.cwd);
  }, 30_000);

  // ensureScratchRoot's own vetting is covered in scratch-gc.test.ts for the cases an unprivileged
  // suite can build — symlink, squatting file, over-permissive mode. (The foreign-owner branch is not
  // among them: creating a directory owned by another uid needs privilege this suite does not have,
  // and it is tracked separately as an unmeasured leg.) What nothing covered is that the CALL SITE consults the
  // verdict. A correct vetting function is inert if its caller ignores the null and mkdtemps into the
  // shared corral anyway, and that is exactly what the suite could not see: replacing the conditional
  // with an unconditional `join(tmpdir(), 'helix', 'codex-')` left everything green, because no test
  // ever presented a root that FAILS vetting.
  //
  // The corral path is computed from os.tmpdir(), which re-reads TMPDIR on every call, so the hostile
  // root is planted under a private TMPDIR rather than in the run's shared one — squatting the shared
  // corral would reach into whatever else is running in parallel.
  it('falls back to a private directory when the shared corral fails vetting', async () => {
    // realpath'd for the same reason the stub resolves -C: the child reports a resolved cwd, so a
    // symlinked temp root would make every comparison below fail for an irrelevant reason.
    const priv = realpathSync(mkdtempSync(join(tmpdir(), 'helix-f9e-')));
    writeFileSync(join(priv, 'helix'), 'a squatter, not a directory');   // ensureScratchRoot -> null
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    try {
      const observed = await runStubbed();
      // The separator matters: `<priv>/helix` is a string prefix of `<priv>/helix-codexAbC`, so a
      // bare startsWith would call the fallback a corral hit and pass no matter what the code did.
      expect(observed.cwd.startsWith(join(priv, 'helix') + sep), 'the runner used the corral it was told to refuse').toBe(false);
      expect(observed.cwd.startsWith(join(priv, 'helix-codex-')), 'the fallback did not land beside the refused corral').toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
  }, 30_000);

  it('still receives a PATH, without which the launcher cannot resolve at all', async () => {
    // The env is CONSTRUCTED, not merely filtered, so this is the assertion that keeps the
    // construction honest: an allowlist that forgets PATH breaks every dual-verify call with ENOENT,
    // and on POSIX the npm shim's `#!/usr/bin/env node` needs it even given an absolute launcher.
    const observed = await runStubbed();
    expect(observed.hasPath).toBe(true);
  }, 30_000);
});
