// Issue #11, end to end over the COMMITTED bundle: a running server reads ~/.helix/config.json again
// on each dual-verify and status call and applies only what narrows the outbound path; a widening
// change waits for a restart. PATH is an empty directory, so no Codex CLI can start (an npm-installed
// codex sits in node's own bin directory, so that directory is not enough).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

// Strip every HELIX_* the developer exported, then set HELIX_HOME and a PATH that finds nothing.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_') && k !== 'PATH'),
  ) as Record<string, string>;

let open: Client[] = [];

async function connect(home: string, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd,
    env: { ...cleanEnv(), HELIX_HOME: home, PATH: mkdtempSync(join(tmpdir(), 'hx-cfgn-path-')) },
  });
  const client = new Client({ name: 'helix-config-narrowing', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

afterEach(async () => {
  for (const c of open) {
    try { await c.close(); } catch { /* already closed */ }
  }
  open = [];
});

const text = (r: unknown): string =>
  ((r as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .map((c) => c.text ?? '').join('');

const status = async (c: Client): Promise<string> => {
  const out = text(await c.callTool({ name: 'helix_codex_status', arguments: {} }));
  // Precondition of every case here: the status call could not start a Codex CLI.
  expect(out).toMatch(/- codex CLI:\s+NOT FOUND on PATH/);
  return out;
};
const verify = async (c: Client): Promise<string> =>
  text(await c.callTool({ name: 'helix_dual_verify', arguments: { question: 'Is 2+2 equal to 4?', helixAnswer: 'yes', stakes: 'low' } }));

describe('config.json changes reach a running server only in the narrowing direction (issue #11)', () => {
  it('a file that turns dual-verify off closes the path of a server that loaded it on', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hx-cfgn-'));
    const cwd = mkdtempSync(join(tmpdir(), 'hx-cfgn-cwd-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ dualVerify: { enabled: true, stakesFloor: 'low' } }));
    const c = await connect(home, cwd);
    expect(await status(c)).toMatch(/- dual-verify:\s+enabled/);

    writeFileSync(join(home, 'config.json'), JSON.stringify({ dualVerify: { enabled: false } }));
    expect(await status(c)).toMatch(/- dual-verify:\s+disabled/);
    expect(await verify(c)).toMatch(/stopped at enabled/);
  }, 30_000);

  it('a file that turns dual-verify on waits for a restart, and the restart applies it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hx-cfgn-'));
    const cwd = mkdtempSync(join(tmpdir(), 'hx-cfgn-cwd-'));
    const first = await connect(home, cwd);
    expect(await status(first)).toMatch(/- dual-verify:\s+disabled/);

    writeFileSync(join(home, 'config.json'), JSON.stringify({ dualVerify: { enabled: true, stakesFloor: 'low' } }));
    const waiting = await status(first);
    expect(waiting).toMatch(/- dual-verify:\s+disabled/);
    expect(waiting).toMatch(/until this server restarts[^\n]*\benabled\b/);
    expect(await verify(first)).toMatch(/stopped at enabled/);

    await first.close();
    const second = await connect(home, cwd);
    expect(await status(second)).toMatch(/- dual-verify:\s+enabled/);
  }, 30_000);
});
