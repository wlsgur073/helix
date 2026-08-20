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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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

  // Both stray-store messages tell the operator to MOVE the stray files into HELIX_HOME. Neither
  // said anything about the files of those names HELIX_HOME already has — and that is the normal
  // state whenever either message is reached, because reaching it at all means this install has its
  // own trust store somewhere else. Driven end to end before this guard: a record committed and
  // confirmed under HELIX_HOME read back `Verified`; following the printed remedy as a literal `mv`
  // replaced HOME's key and witness; the next session printed the forged/legacy warning and the same
  // record read back `Fresh`. The instruction destroyed the grade it exists to protect. The cited
  // proof only ever moved into an EMPTY home, so "lossless" was established for the no-collision
  // case alone.
  async function strayStoreStderr(opts: { elevated: boolean; homeHasItsOwn: boolean }): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), 'helix-remedy-home-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'helix-remedy-ledger-'));
    const cwd = mkdtempSync(join(tmpdir(), 'helix-remedy-cwd-'));
    // A trust store beside the ledger, shaped so the detector recognises it as ours.
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
    writeFileSync(join(elsewhere, 'witness.json'), JSON.stringify({ v: 1, scopes: {} }));
    writeFileSync(join(elsewhere, 'memory.jsonl'), opts.elevated
      ? JSON.stringify({
        id: 'rec-elevated-1', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null, type: 'assert', state: 'Verified', content: 'an elevated row',
        provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null,
        reverifyTrigger: null, classification: 'normal',
      }) + '\n'
      : '');
    if (opts.homeHasItsOwn) {                       // the collision: same names, different bytes
      writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));
      writeFileSync(join(home, 'witness.json'), JSON.stringify({ v: 1, scopes: {} }));
    }
    try {
      return await serverStderr({ HELIX_HOME: home, HELIX_LEDGER: join(elsewhere, 'memory.jsonl') }, cwd);
    } finally {
      for (const d of [home, elsewhere, cwd]) rmSync(d, { recursive: true, force: true });
    }
  }

  it('the refusal warns that moving would overwrite HELIX_HOME\'s own trust store', async () => {
    const err = await strayStoreStderr({ elevated: true, homeHasItsOwn: true });

    expect(err, 'the refusal branch was not reached').toContain('REFUSING TO START');
    expect(err, 'the remedy does not name the files it would overwrite').toMatch(/already has[^\n]*ledger-mac-master\.key/i);
    expect(err, 'the remedy still calls itself lossless with a collision present')
      .not.toMatch(/the only remedy proven lossless/);
  }, 90_000);

  it('the note branch carries the same warning, because it gives the same instruction', async () => {
    const err = await strayStoreStderr({ elevated: false, homeHasItsOwn: true });

    expect(err, 'the note branch was not reached').toContain('helix: NOTE');
    expect(err, 'the note tells the operator to move over their own store without saying so')
      .toMatch(/already has[^\n]*ledger-mac-master\.key/i);
  }, 90_000);

  it('with no collision the remedy keeps its unqualified form', async () => {
    // Non-vacuity: the warning must be driven by the collision, not printed unconditionally — and
    // the no-collision case is the one the cited proof actually establishes.
    const err = await strayStoreStderr({ elevated: true, homeHasItsOwn: false });

    expect(err).toContain('REFUSING TO START');
    expect(err, 'a collision was reported where HELIX_HOME holds nothing').not.toMatch(/already has/i);
  }, 90_000);

  it('session-start still runs when spawned through a SYMLINK to the bundle (F4)', () => {
    // isEntryPoint must answer identity, not spelling: argv[1] here is a symlink path whose
    // realpath is the bundle. A textual comparison reads them as different files, main() never
    // runs, and the hook exits 0 having done nothing — the exact defect shape F4 named.
    const home = mkdtempSync(join(tmpdir(), 'helix-f4-home-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'helix-f4-ledger-'));
    const linkDir = mkdtempSync(join(tmpdir(), 'helix-f4-link-'));
    const link = join(linkDir, 'session-start-linked.mjs');
    try {
      writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
      symlinkSync(sessionStart, link);
      const env = { ...process.env, HELIX_HOME: home, HELIX_LEDGER: join(elsewhere, 'memory.jsonl') };

      // Control (non-vacuity): spawned by its real path, the hook reports the stray file.
      const direct = execFileSync(process.execPath, [sessionStart], { input: '{}', encoding: 'utf8', env });
      expect(direct).toContain('helix: NOTE - trust-store files');

      // The leg: the SAME invocation through a symlink must behave identically.
      const viaLink = execFileSync(process.execPath, [link], { input: '{}', encoding: 'utf8', env });
      expect(viaLink, 'spawned via symlink, the hook went silent: isEntryPoint compared spellings, not identities').toContain('helix: NOTE - trust-store files');
    } finally {
      for (const d of [home, elsewhere, linkDir]) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
