// Acceptance: the trust store follows HELIX_HOME, never the ledger's directory.
//
// SECURITY.md's promise is that the ledger-MAC master key lives only under the user's home and is
// never written into a repo ledger. HELIX_LEDGER is documented as pointing "the memory ledger"
// elsewhere — a DATA-file knob. But the store derived its home as `opts.home ?? dirname(global)`,
// and the server passed no top-level `home`, so repointing HELIX_LEDGER silently relocated the
// signing key, the ownership registry and the rollback witness alongside it. Point it into a
// git-tracked tree and commit, and anyone with the repo can mint valid MACs while the witness —
// whose whole premise is living on the trusted side of the boundary — sits on the untrusted side.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

// Strip every HELIX_* so a developer's exported vars cannot reach these processes; the test sets
// exactly the two it is about.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

/** A split layout: HELIX_HOME and the HELIX_LEDGER directory are different places. */
function splitLayout(): { home: string; ledgerDir: string; ledger: string } {
  const base = mkdtempSync(join(tmpdir(), 'helix-split-'));
  const home = join(base, 'dot-helix');
  const ledgerDir = join(base, 'a-git-repo');
  mkdirSync(home);
  mkdirSync(ledgerDir);
  return { home, ledgerDir, ledger: join(ledgerDir, 'memory.jsonl') };
}

let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
});

async function connect(home: string, ledger: string, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd,
    env: { ...cleanEnv(), HELIX_HOME: home, HELIX_LEDGER: ledger },
  });
  const client = new Client({ name: 'helix-trust-store-acceptance', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

/** Spawn the bundle directly and report how it exited — for the cases where it must REFUSE. */
function startAndWait(home: string, ledger: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { cwd, env: { ...cleanEnv(), HELIX_HOME: home, HELIX_LEDGER: ledger } });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    // The server reads MCP framing from stdin; closing it lets a healthy server shut down cleanly
    // instead of hanging this test, while a refusing server has already exited.
    child.stdin.end();
  });
}

const TRUST_FILES = ['ledger-mac-master.key', 'projects.json', 'witness.json'];

describe('trust store location vs HELIX_LEDGER', () => {
  it('mints the signing key under HELIX_HOME, never beside a relocated ledger', async () => {
    const { home, ledgerDir, ledger } = splitLayout();
    const client = await connect(home, ledger, home);
    await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'staging uses port five four three three', source: 'user' } });
    await client.close();

    // The ledger itself SHOULD be where HELIX_LEDGER points — that is the knob's documented job.
    expect(existsSync(ledger), 'the ledger should follow HELIX_LEDGER').toBe(true);
    // The trust store should not have followed it.
    const strayed = TRUST_FILES.filter((f) => existsSync(join(ledgerDir, f)));
    expect(strayed, `trust files were written beside the ledger: ${readdirSync(ledgerDir).join(', ')}`).toEqual([]);
    expect(existsSync(join(home, 'ledger-mac-master.key')), 'the master key belongs under HELIX_HOME').toBe(true);
  }, 30_000);

  it('refuses to start when a previous run left trust state beside the ledger', async () => {
    const { home, ledgerDir, ledger } = splitLayout();
    // Exactly what the old behaviour produced: a master key sitting next to a relocated ledger.
    // Silently pinning home now would mint a SECOND key, revoking every grade the first one
    // conferred and orphaning a witness that still attests to this scope — so this state has to be
    // reported, not stepped over.
    writeFileSync(join(ledgerDir, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(ledger, '');

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'the server should refuse to start on a split trust store').not.toBe(0);
    expect(stderr).toMatch(/ledger-mac-master\.key/);
    expect(stderr, 'the operator needs both directories named to act on this').toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  it('warns but does NOT refuse when the stray key is byte-identical to HELIX_HOME\'s own (F1B-DETECTOR-DOS)', async () => {
    // The stray key is the SAME key as HOME's -- a genuine, inert leftover. Re-grading the ledger
    // under HOME's key is a no-op because HOME's key IS the key that signed it, so there is no
    // migration left to protect and nothing to lose. Blocking startup forever over it would itself
    // be the startup denial of service the detector must not become
    // (docs/issues/repros/f1-detector-startup-dos.ts).
    const { home, ledgerDir, ledger } = splitLayout();
    const key = randomBytes(32);
    writeFileSync(join(home, 'ledger-mac-master.key'), key, { mode: 0o600 });
    writeFileSync(join(ledgerDir, 'ledger-mac-master.key'), key, { mode: 0o600 });
    writeFileSync(ledger, '');

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'a HELIX_HOME whose key matches the stray leftover must not be blocked').toBe(0);
    expect(stderr).not.toContain('REFUSING TO START');
    expect(stderr).toMatch(/NOTE/);
    expect(stderr).toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  it('still refuses when the stray key DIFFERS from HELIX_HOME\'s own (F1 preserved)', async () => {
    // The Critical this closes: a user runs Helix normally (a key mints under HOME); later they set
    // HELIX_LEDGER on a pre-pin version, which builds a SECOND trust store beside the relocated
    // ledger. HOME has *a* key, so a presence-only gate would wave this through -- but starting
    // would then re-grade the ledger under HOME's key, which is NOT the key that signed those
    // records, silently clamping every elevated grade to Fresh (store.ts's mismatch guard). Two
    // distinct keys beside/under each directory is exactly that setup: the refusal must still fire.
    const { home, ledgerDir, ledger } = splitLayout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(join(ledgerDir, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(ledger, '');

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'a stray key that differs from HELIX_HOME\'s own must still refuse to start').not.toBe(0);
    expect(stderr).toContain('REFUSING TO START');
    expect(stderr).toMatch(/ledger-mac-master\.key/);
    expect(stderr).toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);
});
