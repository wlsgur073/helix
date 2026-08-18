// F1.e, F3.b and F3.d — three obligations that live in TOP-LEVEL scripts.
//
// src/hooks/session-start.ts and src/server/index.ts export nothing: they run on import. Every guard
// around them is therefore either a unit test of a helper they call (which says nothing about whether
// they call it) or an e2e against the committed bin/ bundle (which says nothing about src/). These
// build the entry point FROM SOURCE with the pinned esbuild and spawn it as plain node — the
// discipline test/helpers/bundle-cli.ts exists for — so the wiring itself is what is measured.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';

let sessionStart: string;
let server: string;
beforeAll(async () => {
  sessionStart = await bundleCli('src/hooks/session-start.ts');
  server = await bundleCli('src/server/index.ts');
}, 120_000);

/** Start the MCP server, let it reach the end of its synchronous startup, and return its stderr.
 *  It serves on stdio and never exits on its own, so stdin is closed and the child is killed. */
async function serverStderr(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const child = spawn(process.execPath, [server], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1_500));
  child.kill('SIGKILL');
  return err;
}

describe('top-level entry points, measured through a bundle built from source', () => {
  it('session-start warns when trust-store files sit beside a relocated ledger (F1.e)', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-f1e-home-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'helix-f1e-ledger-'));
    try {
      // The stray condition: a trust-store-shaped file in the ledger's directory rather than under
      // HELIX_HOME. The detector is unit-tested; that the HOOK consults it and says so is not.
      writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
      const out = execFileSync(process.execPath, [sessionStart], {
        input: '{}', encoding: 'utf8',
        env: { ...process.env, HELIX_HOME: home, HELIX_LEDGER: join(elsewhere, 'memory.jsonl') },
      });
      expect(out).toContain('helix: NOTE - trust-store files');
      expect(out, 'the note must name the file it found, or it cannot be acted on').toContain('ledger-mac-master.key');
    } finally {
      for (const d of [home, elsewhere]) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it('the server announces a project config it will not read (F3.d)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-f3d-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-f3d-proj-'));
    try {
      mkdirSync(join(proj, '.helix'), { recursive: true });
      writeFileSync(join(proj, '.helix', 'config.json'), JSON.stringify({ dualVerify: { enabled: true } }));
      const err = await serverStderr({ HELIX_HOME: home }, proj);
      expect(err).toContain('is not read; dual-verify, egress and logging settings come only from');

      // Non-vacuity: with no project config there is nothing to announce, so the note must be absent.
      const quiet = mkdtempSync(join(tmpdir(), 'helix-f3d-quiet-'));
      try {
        expect(await serverStderr({ HELIX_HOME: home }, quiet)).not.toContain('is not read; dual-verify');
      } finally { rmSync(quiet, { recursive: true, force: true }); }
    } finally {
      for (const d of [home, proj]) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it('the server resolves config GLOBAL-only, so a project file is never parsed (F3.b)', async () => {
    // An announcement is not proof the file is unread. An INVALID value is: loadConfig warns on every
    // present-but-invalid key, so a project layer that were being read would report this one. The
    // warning going missing for the project file, while the SAME value in the global file produces it,
    // separates "not read" from "read and ignored".
    const bad = JSON.stringify({ dualVerify: { mode: 'nonsense-not-a-mode' } });

    const home1 = mkdtempSync(join(tmpdir(), 'helix-f3b-home1-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-f3b-proj-'));
    const home2 = mkdtempSync(join(tmpdir(), 'helix-f3b-home2-'));
    const quiet = mkdtempSync(join(tmpdir(), 'helix-f3b-quiet-'));
    try {
      // Non-vacuity first: the same garbage in the GLOBAL file must warn.
      writeFileSync(join(home2, 'config.json'), bad);
      expect(await serverStderr({ HELIX_HOME: home2 }, quiet)).toContain('invalid dualVerify.mode');

      // The leg: the project file is announced but never parsed.
      mkdirSync(join(proj, '.helix'), { recursive: true });
      writeFileSync(join(proj, '.helix', 'config.json'), bad);
      const err = await serverStderr({ HELIX_HOME: home1 }, proj);
      // Deliberate coupling to F3.d: this case claims the file is ANNOUNCED but not PARSED, so the
      // announcement is checked first as an anti-vacuity guard. Deleting the announcement therefore
      // reddens this case too — informative, not misleading: "not parsed" means nothing if the server
      // never reached the project directory at all.
      expect(err, 'the project file was not even noticed').toContain('is not read; dual-verify');
      expect(err, 'a project-layer parse happened: the invalid value was validated').not.toContain('invalid dualVerify.mode');
    } finally {
      for (const d of [home1, proj, home2, quiet]) rmSync(d, { recursive: true, force: true });
    }
  }, 90_000);
});
