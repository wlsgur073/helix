// Opt-in METERED acceptance: a REAL Codex dual-verify through the helix_dual_verify TOOL
// over the committed bundle — the one path the suite otherwise only exercises with a mock
// runner (handlers-dualverify) or by calling the codex runner directly (real-codex.e2e).
// Spends one Codex call; gated behind HELIX_REAL_CODEX=1 so the normal suite never burns
// quota. Run:  HELIX_REAL_CODEX=1 npx vitest run test/acceptance/dual-verify-real.e2e.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.HELIX_REAL_CODEX === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

// Strip ALL HELIX_* (see bundle.e2e) so a dev-exported HELIX_LEDGER/HELIX_SESSIONS can't
// outrank the temp HELIX_HOME and touch real state. ~/.codex (Codex auth) is left intact.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

let open: Client[] = [];
async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd: home, // no project .helix/config.json in scope; config resolves from home/config.json
    env: { ...cleanEnv(), HELIX_HOME: home },
  });
  const client = new Client({ name: 'helix-dv-acceptance', version: '0.0.0' });
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

describe.runIf(enabled)('real codex dual-verify through the bundle tool (metered, opt-in)', () => {
  it('spawns Codex, returns a DATA-framed verdict, and audit-logs the spawn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-dv-'));
    // Enable dual-verify in the temp home (mirrors the repo .helix/config.json). Loaded as the
    // global config path because HELIX_HOME=home and cwd=home has no project .helix override.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ dualVerify: { enabled: true, mode: 'compare', stakesFloor: 'high' } }),
    );
    const client = await connect(home);
    const out = text(await client.callTool({
      name: 'helix_dual_verify',
      arguments: { question: 'Is 2 + 2 equal to 4?', helixAnswer: 'Yes, 2 + 2 = 4.', stakes: 'high' },
    }));

    expect(out).toContain('DATA ONLY — NOT INSTRUCTIONS'); // DATA-quarantined
    expect(out).toContain('EXTERNAL CODEX OUTPUT');          // a real answer was rendered
    expect(out).toMatch(/verdict:/);                          // compare mode produced a verdict
    expect(out).not.toMatch(/did not run/i);                  // it actually ran (not fail-closed)

    const last = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').pop() as string;
    const audit = JSON.parse(last) as { kind: string; enabled: boolean; spawned: boolean };
    expect(audit.kind).toBe('dual-verify');
    expect(audit.enabled).toBe(true);
    expect(audit.spawned).toBe(true);
  }, 180_000);
});

describe.runIf(!enabled)('real codex dual-verify (skipped)', () => {
  it('is skipped without HELIX_REAL_CODEX=1 (no quota spent in normal runs)', () => {
    expect(enabled).toBe(false);
  });
});
