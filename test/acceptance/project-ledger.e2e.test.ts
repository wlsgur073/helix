// Acceptance: two-scope (global + project) memory, end-to-end over the COMMITTED self-contained
// bundle. Hermetic: separate HELIX_HOME + project dir per test, so tests never touch each other's
// or the developer's real ledger.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

// Strip ALL HELIX_* from the inherited env so a developer's exported HELIX_LEDGER /
// HELIX_SESSIONS (precedence over HELIX_HOME) cannot make these hermetic tests read or compact
// the developer's real ledger. Only the explicit HELIX_HOME below takes effect.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

let open: Client[] = [];

/** Spawn the server with an active project layer.
 *  The project layer activates only when <cwd>/.helix/ EXISTS (server's existence-gate check).
 *  Pass cwd=projDir and a SEPARATE HELIX_HOME so the two ledgers stay independent. */
async function connectWithProject(projDir: string, homeDir: string): Promise<Client> {
  // Activation gate: create the .helix dir inside the project root BEFORE spawning.
  mkdirSync(join(projDir, '.helix'), { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd: projDir,
    env: { ...cleanEnv(), HELIX_HOME: homeDir },
  });
  const client = new Client({ name: 'helix-project-e2e', version: '0.0.0' });
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

describe('project-ledger e2e (over bin/)', () => {

  it('commits to project and global, recalls both with scope labels', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'helix-proj-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'helix-proj-cwd-'));

    const client = await connectWithProject(projDir, homeDir);

    // (a) commit to project scope
    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'repo uses esbuild', scope: 'project' },
    });
    // (b) commit to global scope
    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'user prefers concise output', scope: 'global' },
    });

    // (c) recall both
    const out = text(await client.callTool({
      name: 'helix_memory_recall',
      arguments: { query: 'esbuild concise' },
    }));

    // Both facts must be present, each labeled with the correct scope.
    expect(out).toContain('DATA[Fresh:project]| repo uses esbuild');
    expect(out).toContain('DATA[Fresh:global]| user prefers concise output');
  }, 30_000);

  it('a foreign project ledger (unowned) is absent from recall until helix_memory_adopt is called', async () => {
    // "Foreign" scenario: a ledger exists under <projDir>/.helix/memory.jsonl but was written by
    // a different Helix install (no registry entry in HELIX_HOME, no matching .owner stamp).
    const homeDir = mkdtempSync(join(tmpdir(), 'helix-proj-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'helix-proj-cwd-'));

    // Pre-populate a foreign ledger (claims state:"Verified" to test trust gating).
    const foreignLedgerDir = join(projDir, '.helix');
    mkdirSync(foreignLedgerDir, { recursive: true });
    const foreignRecord = JSON.stringify({
      id: 'm_foreign_001',
      tx: '2024-01-01T00:00:00.000Z',
      validFrom: '2024-01-01T00:00:00.000Z',
      validTo: null,
      type: 'assert',
      state: 'Verified',
      content: 'foreign secret blueprint',
      provenance: { source: 'user', sessionId: 'foreign-session' },
      supersedes: null,
      blastRadius: null,
      reverifyTrigger: null,
      classification: 'normal',
    });
    writeFileSync(join(foreignLedgerDir, 'memory.jsonl'), foreignRecord + '\n');

    // Spawn server with the project dir that has the foreign ledger (but no ownership stamp).
    const client = await connectWithProject(projDir, homeDir);

    // (c) recall: foreign ledger content must be ABSENT (unowned = ignored by scopedProjection).
    const outBefore = text(await client.callTool({
      name: 'helix_memory_recall',
      arguments: { query: 'foreign secret blueprint' },
    }));
    expect(outBefore).not.toContain('foreign secret blueprint');

    // (d) adopt: after explicit adoption the ledger is trusted and content appears on recall.
    await client.callTool({ name: 'helix_memory_adopt', arguments: {} });

    const outAfter = text(await client.callTool({
      name: 'helix_memory_recall',
      arguments: { query: 'foreign secret blueprint' },
    }));
    expect(outAfter).toContain('foreign secret blueprint');
  }, 30_000);

  it('project and global ledgers are stored in separate files', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'helix-proj-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'helix-proj-cwd-'));

    const client = await connectWithProject(projDir, homeDir);

    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'project-side fact', scope: 'project' },
    });
    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'global-side fact', scope: 'global' },
    });

    // Verify physical separation: project fact only in project ledger, global fact only in global ledger.
    const projectLedger = readFileSync(join(projDir, '.helix', 'memory.jsonl'), 'utf8');
    const globalLedger  = readFileSync(join(homeDir, 'memory.jsonl'), 'utf8');

    expect(projectLedger).toContain('project-side fact');
    expect(projectLedger).not.toContain('global-side fact');
    expect(globalLedger).toContain('global-side fact');
    expect(globalLedger).not.toContain('project-side fact');
  }, 30_000);

  it('inspect labels each item with its scope', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'helix-proj-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'helix-proj-cwd-'));

    const client = await connectWithProject(projDir, homeDir);

    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'arch decision: microservices', scope: 'project' },
    });
    await client.callTool({
      name: 'helix_memory_commit',
      arguments: { content: 'user timezone: UTC+9', scope: 'global' },
    });

    const out = text(await client.callTool({ name: 'helix_memory_inspect', arguments: {} }));
    // handleInspect formats as: "- <id> [<state>:<scope>] <content>"
    expect(out).toMatch(/\[Fresh:project\].*arch decision: microservices/);
    expect(out).toMatch(/\[Fresh:global\].*user timezone: UTC\+9/);
  }, 30_000);

});
