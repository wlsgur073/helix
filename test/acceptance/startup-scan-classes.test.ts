// IT-M15 (second fix batch §4.3, D3) with rulings R8 and R9: the startup integrity scan in
// src/server/index.ts, measured through a server bundle built FROM SOURCE (the entry-point-startup.test.ts
// discipline): after a `--fresh` resolution the old lineage is an other-key NOTE, never the forged/legacy
// WARNING; a MAC-covered field moved under the current key is the tampered WARNING; a future macVersion
// is the newer-version NOTE, while a deleted one is forged/legacy (R8); an aliased
// project layer, and an unadopted cwd project whose memory file leads to an adopted project's file or
// cannot be resolved (R9), print no scan line.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';
import { MemoryStore } from '../../src/memory/store.js';
import { projectLedgerPath, stampOwnership, resolveTrust, trustStateOf } from '../../src/memory/ownership.js';

let server: string;
beforeAll(async () => { server = await bundleCli('src/server/index.ts'); }, 120_000);

/** Every inherited HELIX_* is stripped before HELIX_HOME is set, so a developer's own variables never
 *  reach the "hermetic" run. */
const cleanEnv = (home: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HELIX_'))),
  HELIX_HOME: home,
});

async function serverStderr(home: string, cwd: string): Promise<string> {
  const child = spawn(process.execPath, [server], { cwd, env: cleanEnv(home), stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1_500));
  child.kill('SIGKILL');
  return err;
}

/** An adopted project holding one fact confirmed to Verified: a genuine verify signed under its key. */
function verifiedProject() {
  const home = mkdtempSync(join(tmpdir(), 'helix-m15e-home-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-m15e-proj-'));
  mkdirSync(join(root, '.helix'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', project: { root, ledger: projectLedgerPath(root), origin: 'cwd' } });
  const fact = store.commit({ content: 'the deploy target is the blue cluster', source: 'user' });
  store.confirm(fact.id);
  return { home, root, ledger: projectLedgerPath(root) };
}

describe('the startup scan names each class of verify offender (IT-M15)', () => {
  it('after a --fresh resolution the old lineage is an other-key NOTE, not a forged WARNING', async () => {
    const { home, root, ledger } = verifiedProject();
    writeFileSync(join(root, '.helix', '.owner'), 'a-different-stamp');   // lost/overwritten .owner
    stampOwnership(root, home, {});                                        // ambiguous re-adoption -> pending
    expect(trustStateOf(root, home)).toBe('pending');
    resolveTrust(root, home, 'fresh');                                     // what helix-trust-resolve --fresh runs
    const err = await serverStderr(home, root);
    expect(err).toContain(`helix: NOTE - 1 verify record(s) in ${ledger} were signed under a different key (a nonce rotated by --fresh, a key lost and re-minted, or a forgery); their grades are not applied`);
    expect(err).not.toContain('forged/legacy');
    expect(err).not.toContain('WARNING');
  }, 60_000);

  it('a MAC-covered field moved under the current key id is the tampered WARNING', async () => {
    const { home, root, ledger } = verifiedProject();
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const edited = lines.map((r) => (r.type === 'verify' ? { ...r, gen: Number(r.gen ?? 0) + 5 } : r));
    writeFileSync(ledger, edited.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const err = await serverStderr(home, root);
    expect(err).toContain(`helix: WARNING - 1 verify record(s) in ${ledger} carry this scope's current key id but fail its MAC; they were altered after signing and their grades are not applied`);
    expect(err).not.toContain('forged/legacy');
    expect(err).not.toContain('signed under a different key');
  }, 60_000);

  it('a future macVersion is the newer-version NOTE', async () => {
    const { home, root, ledger } = verifiedProject();
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    writeFileSync(ledger, lines.map((r) => JSON.stringify(r.type === 'verify' ? { ...r, macVersion: 3 } : r)).join('\n') + '\n');
    const err = await serverStderr(home, root);
    expect(err).toContain(`helix: NOTE - 1 verify record(s) in ${ledger} use a MAC format or state this Helix does not accept, likely written by a newer version or forged; their grades are not applied`);
    expect(err).not.toContain('forged/legacy');
  }, 60_000);

  it('R8: a current-key verify whose macVersion is deleted is the forged/legacy WARNING, never the newer-version NOTE', async () => {
    const { home, root, ledger } = verifiedProject();
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    writeFileSync(ledger, lines.map((r) => {
      if (r.type !== 'verify') return JSON.stringify(r);
      const { macVersion: _dropped, ...rest } = r;
      return JSON.stringify({ ...rest, mac: '0'.repeat(64) });
    }).join('\n') + '\n');
    const err = await serverStderr(home, root);
    expect(err).toContain(`helix: WARNING - 1 forged/legacy elevated record(s) in ${ledger}; trust states there are not tool-minted`);
    expect(err).not.toContain('likely written by a newer version');
  }, 60_000);

  it("R9: an UNADOPTED cwd project whose memory file is a link into an adopted project's file prints no scan line for it", async () => {
    const { home, ledger: bLedger } = verifiedProject();               // B: a Verified fact signed under B's key
    const u = mkdtempSync(join(tmpdir(), 'helix-m15e-proj-'));
    mkdirSync(join(u, '.helix'));
    symlinkSync(bLedger, projectLedgerPath(u));                         // U (never adopted) reads B's file
    const err = await serverStderr(home, u);
    expect(err).not.toContain(projectLedgerPath(u));
  }, 60_000);

  it('R9: an UNADOPTED cwd project whose memory file Helix cannot resolve (a non-UTF-8 link body) prints no scan line for it', async () => {
    const { home, ledger: bLedger } = verifiedProject();
    const u = mkdtempSync(join(tmpdir(), 'helix-m15e-proj-'));
    mkdirSync(join(u, '.helix'));
    // The link leads to a REAL file the kernel opens (`<U>/.helix/<0xff>`, holding B's signed verify), so
    // the scan would print a line for it; only ledgerDestination's UTF-8 round trip makes it unresolvable.
    // (A dangling <0xff> link reads as an empty ledger and would pass on the old rule too: measured.)
    writeFileSync(Buffer.concat([Buffer.from(`${join(u, '.helix')}/`), Buffer.from([0xff])]), readFileSync(bLedger));
    symlinkSync(Buffer.from([0xff]), projectLedgerPath(u));
    const err = await serverStderr(home, u);
    expect(err).not.toContain(projectLedgerPath(u));
  }, 60_000);

  it("control: an UNADOPTED cwd project's own foreign memory file is still scanned", async () => {
    const { home, ledger: bLedger } = verifiedProject();
    const u = mkdtempSync(join(tmpdir(), 'helix-m15e-proj-'));
    mkdirSync(join(u, '.helix'));
    writeFileSync(projectLedgerPath(u), readFileSync(bLedger));         // a COPY: U's own file, holding B's signed verify
    const err = await serverStderr(home, u);
    expect(err).toContain(`helix: WARNING - 1 unverifiable verify record(s) in ${projectLedgerPath(u)}`);
  }, 60_000);

  it('an aliased project layer prints no scan line for its ledger', async () => {
    const { home, ledger: bLedger } = verifiedProject();               // B: a Verified fact signed under B's key
    const a = mkdtempSync(join(tmpdir(), 'helix-m15e-proj-'));
    stampOwnership(a, home, {});
    symlinkSync(bLedger, projectLedgerPath(a));                         // A's ledger is B's file
    const err = await serverStderr(home, a);
    expect(err).not.toContain(projectLedgerPath(a));
  }, 60_000);
});
