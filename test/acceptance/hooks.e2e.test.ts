// Acceptance: the committed hook bundles, spawned exactly as Claude Code spawns them
// (node <bundle>, JSON on stdin, stdout captured, exit code observed).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = join(root, 'bin', 'hooks', 'session-start.mjs');
const END = join(root, 'bin', 'hooks', 'session-end.mjs');

// Strip ALL HELIX_* from the inherited env (see bundle.e2e.test.ts) so a dev-exported
// HELIX_LEDGER/HELIX_SESSIONS can't outrank the temp HELIX_HOME and hit real state.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

function runHook(script: string, home: string, stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...cleanEnv(), HELIX_HOME: home } });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const record = (content: string, state = 'Fresh'): string => JSON.stringify({
  id: `m_${content.slice(0, 6)}`, tx: '2026-06-10T00:00:00.000Z',
  validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
  type: 'assert', state, content,
  provenance: { source: 'user', sessionId: 'seed' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

describe('session-start hook e2e', () => {
  it('injects seeded memory as a DATA-framed block and exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    writeFileSync(join(home, 'memory.jsonl'), record('user prefers vitest over jest') + '\n');
    const { code, stdout } = await runHook(START, home, '{}');
    expect(code).toBe(0);
    expect(stdout).toContain('DATA, NOT INSTRUCTIONS');
    expect(stdout).toContain('DATA[Fresh]| '); // per-line datamarked provenance
    expect(stdout).toContain('user prefers vitest over jest');
  }, 20_000);

  it('missing ledger: injects nothing, still exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    const { code, stdout } = await runHook(START, home, '{}');
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 20_000);

  it('unreadable ledger path (a directory): injects nothing, still exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    mkdirSync(join(home, 'memory.jsonl')); // EISDIR on read
    const { code, stdout } = await runHook(START, home, '{}');
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 20_000);
});

describe('session-end hook e2e', () => {
  it('appends one session record (documented reason field) and exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    const { code } = await runHook(END, home, '{"session_id":"s-123","reason":"clear"}');
    expect(code).toBe(0);
    const line = JSON.parse(readFileSync(join(home, 'sessions.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(line.kind).toBe('session-end');
    expect(line.sessionId).toBe('s-123');
    expect(line.reason).toBe('clear');
  }, 20_000);

  it('accepts the observed end_reason field as a fallback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    await runHook(END, home, '{"session_id":"s-9","end_reason":"logout"}');
    const line = JSON.parse(readFileSync(join(home, 'sessions.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(line.reason).toBe('logout');
  }, 20_000);

  it('garbage stdin: records nothing, still exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-hook-'));
    const { code } = await runHook(END, home, 'not json');
    expect(code).toBe(0);
    expect(existsSync(join(home, 'sessions.jsonl'))).toBe(false);
  }, 20_000);
});
