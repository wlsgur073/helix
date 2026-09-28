// Acceptance for the first fix batch (spec docs/issues/2026-09-26-prerelease-itest/
// 2026-09-27-first-fix-batch-design.md §6): the COMMITTED bundles, spawned as Claude Code spawns
// them. Every scenario reproduced on the pre-batch bundle (spec §11). The server is driven over raw
// JSON-RPC with a deadline and a hard kill, because the FIFO case used to hang startup: a hung child
// must fail its test, never the run.
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYMLINKED_HOME_NOTE, SUPERSEDE_NOTE } from '../../src/memory/content-frame.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(root, 'bin', 'helix-mcp.mjs');
const START = join(root, 'bin', 'hooks', 'session-start.mjs');

// Strip ALL HELIX_* (see bundle.e2e.test.ts): only what a scenario sets may reach a child.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

interface Rpc { responses: Map<number, unknown>; stderr: string; timedOut: boolean }

/** initialize, then every call as a tools/call with ids 2..n+1; collect responses until all ids have
 *  answered or the deadline passes, then end stdin and SIGKILL the child. */
function rpc(env: Record<string, string>, cwd: string, calls: Array<{ name: string; args: Record<string, unknown> }>, deadlineMs = 15_000): Promise<Rpc> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd, env });
    child.stdin.on('error', () => { /* the child exited first; its exit is observed through 'close' */ });
    const responses = new Map<number, unknown>();
    let stderr = '';
    let buf = '';
    let timedOut = false;
    const finish = (): void => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already gone */ }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; finish(); }, deadlineMs);
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdout.on('data', (d: Buffer) => {
      buf += String(d);
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let msg: { id?: unknown };
        try { msg = JSON.parse(line) as { id?: unknown }; } catch { continue; }
        if (typeof msg.id !== 'number') continue;
        responses.set(msg.id, msg);
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          calls.forEach((c, i) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: c.name, arguments: c.args } }) + '\n'));
        }
        if (responses.size >= calls.length + 1) finish();
      }
    });
    child.on('close', () => resolve({ responses, stderr, timedOut }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'first-batch-e2e', version: '0' } } }) + '\n');
  });
}

function hook(env: Record<string, string>, stdin: unknown): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [START], { env });
    child.stdin.on('error', () => { /* the hook exited first; its exit is observed through 'close' */ });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const textOf = (r: unknown): string =>
  ((r as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content ?? []).map((c) => c.text ?? '').join('');
const isError = (r: unknown): boolean => (r as { result?: { isError?: boolean } } | undefined)?.result?.isError === true;
const rowsOf = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0);

const posixOnly = describe.skipIf(process.platform === 'win32');

describe('first fix batch — bundle e2e', () => {
  it('IT-H1: with no HELIX_HOME yet, the hook prints what an existing home prints and the first inspect is empty memory', async () => {
    const base = tmp('helix-fb-nohome-');
    const userHome = join(base, 'home');
    const proj = join(userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    writeFileSync(join(proj, '.helix', 'memory.jsonl'), '');
    const payload = { session_id: 's', transcript_path: join(base, 't.jsonl'), cwd: proj, hook_event_name: 'SessionStart', source: 'startup' };
    const present = join(base, 'hh-present');
    mkdirSync(present, { mode: 0o700 });
    const a = await hook({ ...cleanEnv(), HOME: userHome, HELIX_HOME: join(base, 'hh-missing') }, payload);
    const b = await hook({ ...cleanEnv(), HOME: userHome, HELIX_HOME: present }, payload);
    expect(a.code).toBe(0);
    expect(a.stdout).not.toBe('');
    expect(a.stdout).toBe(b.stdout);

    const cwd2 = join(userHome, 'proj2');
    mkdirSync(cwd2);
    const r = await rpc({ ...cleanEnv(), HOME: userHome, HELIX_HOME: join(base, 'hh2') }, cwd2, [{ name: 'helix_memory_inspect', args: {} }]);
    expect(r.timedOut).toBe(false);
    expect(textOf(r.responses.get(2))).toContain('(memory is empty)');
    expect(textOf(r.responses.get(2))).not.toContain('ENOENT');
  }, 45_000);

  it('IT-H1: the first commit with HELIX_LEDGER outside a missing HELIX_HOME succeeds and creates the home 0700', async () => {
    const base = tmp('helix-fb-ledger-');
    const userHome = join(base, 'home');
    mkdirSync(userHome);
    const hh = join(base, 'hh');
    const ledger = join(base, 'ledgers', 'memory.jsonl');
    const r = await rpc({ ...cleanEnv(), HOME: userHome, HELIX_HOME: hh, HELIX_LEDGER: ledger }, userHome, [
      { name: 'helix_memory_commit', args: { content: 'the build uses node 24', source: 'user' } },
    ]);
    expect(isError(r.responses.get(2))).toBe(false);
    expect(rowsOf(ledger)).toBe(1);
    if (process.platform !== 'win32') expect(statSync(hh).mode & 0o777).toBe(0o700);
  }, 30_000);

  posixOnly('POSIX only', () => {
    it('IT-H2: a symlinked HELIX_HOME refuses a commit before anything reaches the link target, and startup and the hook say why', async () => {
      const base = tmp('helix-fb-link-');
      const userHome = join(base, 'home');
      mkdirSync(userHome);
      const real = join(base, 'hreal');
      mkdirSync(real, { mode: 0o700 });
      const link = join(base, 'hlink');
      symlinkSync(real, link);
      const env = { ...cleanEnv(), HOME: userHome, HELIX_HOME: link };
      const r = await rpc(env, userHome, [{ name: 'helix_memory_commit', args: { content: 'the build uses node 24', source: 'user' } }]);
      expect(isError(r.responses.get(2))).toBe(true);
      expect(textOf(r.responses.get(2))).toContain('symlink');
      expect(rowsOf(join(real, 'memory.jsonl'))).toBe(0);
      expect(r.stderr).toContain('is a symlink');
      const h = await hook(env, { cwd: userHome, hook_event_name: 'SessionStart', source: 'startup' });
      expect(h.stdout).toContain(SYMLINKED_HOME_NOTE);
    }, 45_000);

    it('IT-H4: a FIFO at an unadopted cwd ledger no longer stalls startup; the scan skips it with a warning', async () => {
      const base = tmp('helix-fb-fifo-');
      const userHome = join(base, 'home');
      const proj = join(userHome, 'proj');
      mkdirSync(join(proj, '.helix'), { recursive: true });
      execFileSync('mkfifo', [join(proj, '.helix', 'memory.jsonl')]);
      const hh = join(base, 'hh');
      mkdirSync(hh, { mode: 0o700 });
      const r = await rpc({ ...cleanEnv(), HOME: userHome, HELIX_HOME: hh }, proj, [], 10_000);
      expect(r.timedOut).toBe(false);
      expect(r.responses.get(1)).toHaveProperty('result');
      expect(r.stderr).toContain('is not a regular file; skipped its integrity scan');
    }, 30_000);
  });

  it('IT-M1: a resumed session with empty memory gets the supersede note alone; a startup gets nothing', async () => {
    const base = tmp('helix-fb-resume-');
    const userHome = join(base, 'home');
    mkdirSync(userHome);
    const hh = join(base, 'hh');
    mkdirSync(hh, { mode: 0o700 });
    const env = { ...cleanEnv(), HOME: userHome, HELIX_HOME: hh };
    const resumed = await hook(env, { cwd: userHome, hook_event_name: 'SessionStart', source: 'resume' });
    const started = await hook(env, { cwd: userHome, hook_event_name: 'SessionStart', source: 'startup' });
    expect(resumed.stdout).toBe(`${SUPERSEDE_NOTE}\n`);
    expect(started.stdout).toBe('');
  }, 30_000);
});
