// Decision D5 (third fix batch, design 4.2) retires ruling R6 of the second fix batch (§4.5): a project whose
// memory file is a link, dangling or not, to the GLOBAL ledger when the server starts keeps its project layer.
// Only a memory path that IS the global ledger's own directory entry gives no layer (src/memory/project-root.ts),
// so here the judgement excludes the layer as aliased: an omitted-scope commit is refused with the alias text,
// nothing is adopted and nothing widens to global, and an explicit global commit goes through with the notice.
// Pinned through a server bundle built FROM SOURCE (the startup-scan-classes.test.ts discipline), because the
// layer is decided once at server start. A link that appears after start in a project not yet adopted is refused
// in the same way (test/memory/preadopt-alias.test.ts).
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

describe('a project memory file linked to the global ledger keeps its project layer and is refused as an alias (D5; ruling R6 of the second batch is retired)', () => {
  it.each([
    ['a DANGLING link (the global ledger does not exist yet)', false],
    ['a link to the EXISTING global ledger', true],
  ] as const)('%s: an omitted-scope commit is refused with the alias text, nothing is adopted or written, an explicit global commit goes through with the notice', async (_label, existing) => {
    const home = mkdtempSync(join(tmpdir(), 'helix-r6-home-'));
    const u = mkdtempSync(join(tmpdir(), 'helix-r6-proj-'));
    const globalLedger = join(home, 'memory.jsonl');
    mkdirSync(join(u, '.helix'));
    if (existing) writeFileSync(globalLedger, '');
    symlinkSync(globalLedger, projectLedgerPath(u));

    const client = await connect(home, u);
    const refused = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the deploy target is the blue cluster', source: 'user' } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(text(refused)).toContain("this project's memory file resolves outside this project");
    expect(text(refused)).toContain('the write is refused rather than written somewhere else');
    expect(existsSync(globalLedger) ? readFileSync(globalLedger, 'utf8') : '<absent>').toBe(existing ? '' : '<absent>');   // nothing widened to global
    expect(existsSync(join(u, '.helix', '.owner'))).toBe(false);                                                          // nothing adopted
    const registry = existsSync(join(home, 'projects.json')) ? JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown> : {};
    expect(registry[canonicalRoot(u)]).toBeUndefined();

    const global = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'a fact for every project', source: 'user', scope: 'global' } });
    expect((global as { isError?: boolean }).isError ?? false).toBe(false);
    const payload = JSON.parse(text(global).slice('committed '.length)) as Record<string, unknown>;
    expect(payload.scope).toBe('global');
    expect(String(payload.notice)).toContain("while this session's project memory is off");
    expect(readFileSync(globalLedger, 'utf8')).toContain(payload.id as string);
  }, 60_000);
});
