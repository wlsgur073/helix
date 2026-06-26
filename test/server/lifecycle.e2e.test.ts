import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'helix-mcp.mjs');

/** Hermetic env: a temp HELIX_HOME and no inherited HELIX_* (mirror bundle.e2e.test.ts). */
function spawnServer(): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HELIX_')) env[k] = v;
  env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-life-'));
  return spawn(process.execPath, [BIN], { env, stdio: ['pipe', 'pipe', 'inherit'] });
}

function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function within(p: Promise<number>, ms: number): Promise<number> {
  return Promise.race([p, delay(ms).then(() => { throw new Error(`no exit within ${ms}ms`); })]);
}

describe('helix-mcp self-termination (integration)', () => {
  it('exits(0) when stdin is closed (client disconnect)', async () => {
    const child = spawnServer();
    const exit = exitOf(child);
    await delay(300);            // let it boot + connect
    child.stdin!.end();          // parent disconnects
    expect(await within(exit, 4000)).toBe(0);
  });

  it('exits(0) on stdout EPIPE after a request (inherited-write-handle backstop)', async () => {
    const child = spawnServer();
    const exit = exitOf(child);
    await delay(300);
    child.stdout!.destroy();     // kill our read end -> server's next write faults with EPIPE
    // elicit a write: a server is silent until it gets a request.
    child.stdin!.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n');
    expect(await within(exit, 4000)).toBe(0);
  });
});
