// Final review G7 (owner, 2026-11-09, ruling B): neither the server's startup pass nor a SessionStart's read of the signing
// key adds the owner's write permission to a home file. A home made read-only by its user (0555, its files 0444) keeps its
// files without owner write: the pass removes group and other bits only (0444 becomes 0400), and so does the key repair
// on every read. The server and the hook are bundled FROM SOURCE and spawned with cwd outside the repository and every
// inherited HELIX_* removed.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundleCli } from '../helpers/bundle-cli.js';

const posixOnly = describe.skipIf(process.platform === 'win32');
const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

let server = '';
let start = '';
beforeAll(async () => {
  server = await bundleCli('src/server/index.ts');
  start = await bundleCli('src/hooks/session-start.ts');
}, 120_000);

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) {
    try { chmodSync(join(b, 'h'), 0o700); } catch { /* absent */ }
    rmSync(b, { recursive: true, force: true });
  }
});

const strippedEnv = (userHome: string, home: string): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>),
  HOME: userHome,
  HELIX_HOME: home,
});

const modeOf = (p: string): number => statSync(p).mode & 0o7777;
const modes = (home: string): Record<string, number> =>
  Object.fromEntries(readdirSync(home).sort().map((n) => [n, modeOf(join(home, n))]));

interface Ran { code: number | null; stdout: string; stderr: string }
function run(script: string, env: Record<string, string>, cwd: string, stdin: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('did not exit within 20 s')); }, 20_000);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

posixOnly('a read-only home keeps its files without owner write (ruling B, final review G7)', () => {
  it.skipIf(isRoot())('0555 home, 0444 files: after a SessionStart the key is 0400, after the server start every file is 0400 and the home 0500', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'rohf-')));
    bases.push(base);
    const userHome = join(base, 'u');
    const cwd = join(base, 'w');
    const home = join(base, 'h');
    mkdirSync(userHome);
    mkdirSync(cwd);
    mkdirSync(home, { mode: 0o700 });
    const env = strippedEnv(userHome, home);

    // Seed: one global commit, so the ledger, the signing key and the witness exist.
    const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd, env });
    const client = new Client({ name: 'rohf', version: '0.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the read only fact', source: 'user' } }) as { isError?: boolean };
      expect(res.isError === true, 'precondition: the seed commit succeeded').toBe(false);
    } finally { await client.close(); }
    const files = readdirSync(home).sort();
    expect(files, 'precondition: the key and the ledger exist').toEqual(expect.arrayContaining(['ledger-mac-master.key', 'memory.jsonl']));
    const ledgerBefore = readFileSync(join(home, 'memory.jsonl'));

    for (const n of files) chmodSync(join(home, n), 0o444);
    chmodSync(home, 0o555);

    // SessionStart reads the signing key (tryReadMaster, which repairs an over-broad key on every read).
    const s = await run(start, env, cwd, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(s.code).toBe(0);
    expect(s.stdout, 'the hook read the home').toContain('the read only fact');
    expect(modeOf(join(home, 'ledger-mac-master.key')), 'the key read removed group and other bits only').toBe(0o400);
    expect(modeOf(home), 'the hook leaves the home directory alone').toBe(0o555);

    // The server's start runs the startup pass, then serves until stdin ends.
    const r = await run(server, env, cwd, '');
    expect(r.code).toBe(0);
    expect(modeOf(home)).toBe(0o500);
    const after = modes(home);
    for (const n of files) expect((after[n] ?? -1) & 0o200, `${n} gained no owner write`).toBe(0);
    for (const n of files.filter((f) => f !== 'ledger-mac-master.key')) {
      expect(after[n], n).toBe(0o400);
      expect(r.stderr).toContain(`helix: tightened ${join(home, n)} from 0444 to 0400`);
    }
    expect(r.stderr).not.toMatch(/to 0600/);
    expect(readFileSync(join(home, 'memory.jsonl')).equals(ledgerBefore), 'the ledger bytes are unchanged').toBe(true);
  }, 90_000);
});
