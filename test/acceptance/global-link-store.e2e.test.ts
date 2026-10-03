// Ruling R6 (second fix batch §4.5): a project whose memory file is a link — dangling or not — to the
// GLOBAL ledger when the server starts is not refused. The existing rule (src/memory/project-root.ts: a
// `.helix` holding the global ledger is the global store, not a project) gives the session NO project
// layer, so an omitted-scope commit is a global commit (`"scope":"global"`), nothing is adopted, and an
// explicit `scope: 'project'` is refused for the missing layer. Pinned through a server bundle built
// FROM SOURCE (the startup-scan-classes.test.ts discipline), because the layer is decided once at server
// start. A link that appears after start in a project not yet adopted is refused instead
// (test/memory/preadopt-alias.test.ts).
// Hermetic: a throwaway HOME and HELIX_HOME per case, every inherited HELIX_* stripped.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundleCli } from '../helpers/bundle-cli.js';
import { projectLedgerPath, canonicalRoot } from '../../src/memory/ownership.js';

let server: string;
beforeAll(async () => { server = await bundleCli('src/server/index.ts'); }, 120_000);

const cleanEnv = (home: string, userHome: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>,
  HELIX_HOME: home,
  HOME: userHome,
});

let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
});

async function connect(home: string, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd, env: cleanEnv(home, mkdtempSync(join(tmpdir(), 'helix-r6-userhome-'))) });
  const client = new Client({ name: 'helix-r6', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

const text = (r: unknown): string =>
  ((r as { content: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

describe('a project memory file linked to the global ledger makes that .helix the global store (R6)', () => {
  it.each([
    ['a DANGLING link (the global ledger does not exist yet)', false],
    ['a link to the EXISTING global ledger', true],
  ] as const)('%s: no project layer, an omitted-scope commit is global, nothing adopted, scope project refused', async (_label, existing) => {
    const home = mkdtempSync(join(tmpdir(), 'helix-r6-home-'));
    const u = mkdtempSync(join(tmpdir(), 'helix-r6-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    mkdirSync(join(u, '.helix'));
    if (existing) writeFileSync(globalLedger, '');
    symlinkSync(globalLedger, projectLedgerPath(u));

    const client = await connect(home, u);
    const res = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the deploy target is the blue cluster', source: 'user' } });
    expect((res as { isError?: boolean }).isError ?? false).toBe(false);
    const out = text(res);
    expect(out.startsWith('committed {')).toBe(true);
    const payload = JSON.parse(out.slice('committed '.length)) as Record<string, unknown>;
    expect(payload.scope).toBe('global');
    expect(Object.keys(payload)).toEqual(['id', 'scope', 'state', 'classification']);

    expect(readFileSync(globalLedger, 'utf8')).toContain(payload.id as string);            // the global ledger holds it
    expect(existsSync(join(u, '.helix', '.owner'))).toBe(false);                           // nothing adopted
    const registry = existsSync(join(home, 'projects.json')) ? JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown> : {};
    expect(registry[canonicalRoot(u)]).toBeUndefined();

    const refused = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'a project fact', source: 'user', scope: 'project' } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(text(refused)).toContain("scope 'project' was requested but no project memory layer is active here");
  }, 60_000);
});
