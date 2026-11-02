// Third fix batch B1, task B6 (design 4.7): the server over a global ledger whose path cannot be used. Measured through a
// bundle built FROM SOURCE (the global-link-store.e2e.test.ts discipline).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundleCli } from '../helpers/bundle-cli.js';
import { GLOBAL_READ_ONLY_STARTUP_LINE, GLOBAL_WRITE_REFUSAL } from '../../src/memory/global-ledger.js';
import { GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { buildGlobalLayout, cleanupLayouts, type GlobalLayoutName } from '../helpers/global-layouts.js';

let server: string;
beforeAll(async () => { server = await bundleCli('src/server/index.ts'); }, 120_000);
let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
  cleanupLayouts();
});

/** Every inherited HELIX_* is stripped before the case sets its own, so a developer's variables never reach the run. */
const cleanEnv = (home: string, ledger: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>,
  HELIX_HOME: home, HELIX_LEDGER: ledger, HOME: mkdtempSync(join(tmpdir(), 'gl-userhome-')),
});
const text = (r: unknown): string => ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');

/** The server's stderr once `until` holds over it (looked at every 50 ms), plus `settleMs` more, so a line printed again
 *  after the awaited one is still caught; at a 10 s deadline, or when the server exits, it returns what arrived. */
async function serverStderr(home: string, ledger: string, cwd: string, until: (err: string) => boolean, settleMs = 0): Promise<string> {
  const child = spawn(process.execPath, [server], { cwd, env: cleanEnv(home, ledger), stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let exited = false;
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.on('exit', () => { exited = true; });
  child.stdin.end();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const deadline = performance.now() + 10_000;   // monotonic: the host's wall clock steps back
  while (!until(err) && !exited && performance.now() < deadline) await sleep(50);
  if (until(err) && settleMs > 0) await sleep(settleMs);
  child.kill('SIGKILL');
  return err;
}

describe('a global ledger whose path cannot be used: the server starts, says so once, serves the rows and refuses the writes', () => {
  it.each(['nonutf8-link-body', 'dangling-target-dir-missing', 'below-dangling-dir-link', 'loop'] as GlobalLayoutName[])('%s: one stderr line', async (name) => {
    const l = buildGlobalLayout(name);
    const err = await serverStderr(l.home, l.ledger, l.base, (e) => e.includes(GLOBAL_READ_ONLY_STARTUP_LINE), 300);
    expect(err.split('\n').filter((x) => x === GLOBAL_READ_ONLY_STARTUP_LINE)).toHaveLength(1);
  }, 60_000);

  it('control: a writable global ledger prints no such line (a baked row proves the run reached its scan: the startup-scan-classes.test.ts discipline for an absence)', async () => {
    const l = buildGlobalLayout('plain');
    const ts = '2026-11-01T00:00:00.000Z';
    appendFileSync(l.ledger, JSON.stringify({
      id: 'g_baked', tx: ts, validFrom: ts, validTo: null, type: 'assert', state: 'Verified', content: 'a baked global fact',
      provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    const err = await serverStderr(l.home, l.ledger, l.base, (e) => e.includes('forged/legacy'));
    expect(err).toContain('forged/legacy');
    expect(err).not.toContain('read-only');
  }, 60_000);

  it('initialize answers, recall shows the rows with the note, a commit is refused with the typed text', async () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: l.base, env: cleanEnv(l.home, l.ledger) });
    const client = new Client({ name: 'helix-b6', version: '0.0.0' });
    await client.connect(transport);
    open.push(client);
    const recalled = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'deploy' } }));
    expect(recalled).toContain('alpha deploy fact');
    expect(recalled).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    const res = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'a new fact', source: 'user' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain(GLOBAL_WRITE_REFUSAL.commit);
  }, 60_000);
});
