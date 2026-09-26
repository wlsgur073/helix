// Acceptance: GitHub issue #1 end to end over the COMMITTED bundles — a session started in a
// subdirectory of a Helix project. Hermetic: temp HELIX_HOME, temp HOME, temp directories only.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(repo, 'bin', 'helix-mcp.mjs');
const HOOK = join(repo, 'bin', 'hooks', 'session-start.mjs');

// Strip every HELIX_* so a developer's exported HELIX_LEDGER cannot outrank the temp HELIX_HOME.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;

interface World { userHome: string; helixHome: string; proj: string; sub: string; other: string }
const made: string[] = [];
let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(): World {
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'helix-anc-e2e-')));
  made.push(b);
  const userHome = join(b, 'home');
  const w = { userHome, helixHome: join(b, 'helix-home'), proj: join(userHome, 'proj'), sub: join(userHome, 'proj', 'sub'), other: join(userHome, 'other') };
  for (const d of [w.helixHome, join(w.proj, '.helix'), w.sub, w.other]) mkdirSync(d, { recursive: true });
  return w;
}
// HOME (USERPROFILE on Windows) is the walk's home boundary, so the walk never leaves the temp tree.
const env = (w: World): Record<string, string> => ({ ...cleanEnv(), HELIX_HOME: w.helixHome, HOME: w.userHome, USERPROFILE: w.userHome });
const text = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

async function connect(w: World, cwd: string): Promise<Client> {
  const client = new Client({ name: 'helix-anc-e2e', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd, env: env(w) }));
  open.push(client);
  return client;
}

function sessionStart(w: World, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { cwd, env: env(w) });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'startup' }));
  });
}

describe('issue #1: a session started in a project subdirectory', () => {
  it('reads and writes the adopted parent project, and nothing leaks to an unrelated directory', async () => {
    const w = world();
    const atRoot = await connect(w, w.proj);
    expect(text(await atRoot.callTool({ name: 'helix_memory_commit', arguments: { content: 'FACT-A lives in the project', source: 'user' } }))).toContain('"scope":"project"');

    const inSub = await connect(w, w.sub);
    expect(text(await inSub.callTool({ name: 'helix_memory_recall', arguments: { query: 'FACT-A lives in the project' } }))).toContain('FACT-A');
    expect(await sessionStart(w, w.sub)).toContain('FACT-A');
    expect(text(await inSub.callTool({ name: 'helix_memory_commit', arguments: { content: 'FACT-B belongs to the project too', source: 'user' } }))).toContain('"scope":"project"');

    const elsewhere = await connect(w, w.other);
    expect(text(await elsewhere.callTool({ name: 'helix_memory_recall', arguments: { query: 'FACT-B belongs to the project too' } }))).not.toContain('FACT-B');
    expect(await sessionStart(w, w.other)).not.toContain('FACT-B');
    expect(readFileSync(join(w.proj, '.helix', 'memory.jsonl'), 'utf8')).toContain('FACT-B');
    const globalLedger = join(w.helixHome, 'memory.jsonl');
    expect(existsSync(globalLedger) ? readFileSync(globalLedger, 'utf8') : '').not.toContain('FACT-B');
  });

  it('below a parent project that is not adopted, discloses it and refuses a scope-less commit', async () => {
    const w = world();
    const inSub = await connect(w, w.sub);
    const refused = await inSub.callTool({ name: 'helix_memory_commit', arguments: { content: 'FACT-C must not go global', source: 'user' } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(text(refused)).toContain('not adopted');
    expect(text(await inSub.callTool({ name: 'helix_memory_commit', arguments: { content: 'FACT-D is global on purpose', source: 'user', scope: 'global' } }))).toContain('"scope":"global"');
    expect(await sessionStart(w, w.sub)).toContain('a parent directory holds a Helix project that is not adopted');
    expect(existsSync(join(w.proj, '.helix', '.owner'))).toBe(false);
  });
});
