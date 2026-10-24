// Acceptance for issue #9 over the COMMITTED bundle, which is what a cloned plugin runs: by default up to
// three of the newest records follow the ranked matches, each named with the time it carries, and
// `recencyAppendix: false` returns the ranked matches alone, so that maxItems bounds the response. The
// facts and calls are the issue's own reproduction. Hermetic: temp HELIX_HOME and a temp cwd.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

// Strip ALL HELIX_* from the inherited env, as bundle.e2e.test.ts does, so only the HELIX_HOME below applies.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

let open: Client[] = [];

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd: home, // no project .helix/config.json in scope
    env: { ...cleanEnv(), HELIX_HOME: home },
  });
  const client = new Client({ name: 'helix-acceptance-i9', version: '0.0.0' });
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
const records = (t: string): number => (t.match(/^PROOF\[/gm) ?? []).length;

describe('recall recency appendix over the shipped bundle (issue #9)', () => {
  it('maxItems 1 returns four records by default and one with recencyAppendix false', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-acc-i9-'));
    const client = await connect(home);
    const commit = (content: string) =>
      client.callTool({ name: 'helix_memory_commit', arguments: { content, source: 'agent-inference', scope: 'global' } });
    await commit('The alpha build tool on this machine needs the flag --offline.');
    for (const content of [
      'Bravo: the printer on the second floor needs the legacy driver.',
      'Charlie: the staging database is restored every Monday morning.',
      'Delta: screenshots time out in the headless browser here.',
      'Echo: the package registry mirror is reachable only over the VPN.',
      'Foxtrot: the linter config lives in the repository root.',
    ]) await commit(content);
    const byDefault = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'alpha build tool', maxItems: 1 } }));
    const alone = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'alpha build tool', maxItems: 1, recencyAppendix: false } }));
    expect(records(byDefault)).toBe(4);
    // Every entry of the note, not only the first, carries a canonical time (review F6).
    const entries = (byDefault.match(/^\(recency appendix — newest records included regardless of rank: (.*)\)$/m)?.[1] ?? '').split(', ');
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e).toMatch(/^m_[0-9a-f-]+ \(dated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/);
    expect(records(alone)).toBe(1);
    expect(alone).toContain('The alpha build tool on this machine needs the flag --offline.');
    expect(alone).not.toContain('recency appendix');
  }, 30_000);
});
