import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CodexResult = { ok: true; answer: string } | { ok: false; error: string };
export type CodexRunner = (question: string) => Promise<CodexResult>;
export interface Availability { available: boolean; reason?: string }

/** Build the `codex exec` argv: read-only sandbox + ephemeral + final message to a file. */
export function buildCodexExecArgs(question: string, outFile: string): string[] {
  return ['exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', outFile, question];
}

/** Pure: decide availability from `codex --version` and `codex login status` output. */
export function interpretPreflight(versionOut: string, loginOut: string): Availability {
  if (!/codex-cli\s+\d+\.\d+\.\d+/i.test(versionOut)) return { available: false, reason: 'codex CLI not found' };
  // "logged in" is a substring of "Not logged in" — must exclude the negative forms.
  const loggedIn = /logged in/i.test(loginOut) && !/not logged in|logged out|not authenticated/i.test(loginOut);
  if (!loggedIn) return { available: false, reason: 'codex not logged in (run: codex login)' };
  return { available: true };
}

/** Real preflight: runs the CLI. Any error -> unavailable (fail-closed, no fabrication). */
export async function checkCodexAvailable(): Promise<Availability> {
  try {
    const v = await execFileAsync('codex', ['--version'], { timeout: 10_000 });
    const l = await execFileAsync('codex', ['login', 'status'], { timeout: 10_000 });
    return interpretPreflight(v.stdout ?? '', l.stdout ?? '');
  } catch (e) {
    return { available: false, reason: `codex preflight failed: ${(e as Error).message}` };
  }
}

/** Real runner: spawns `codex exec` into a temp file and returns its final message verbatim. */
export const realCodexRunner: CodexRunner = async (question) => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-codex-'));
  const outFile = join(dir, 'out.txt');
  try {
    await execFileAsync('codex', buildCodexExecArgs(question, outFile), { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const answer = readFileSync(outFile, 'utf8').trim();
    return answer ? { ok: true, answer } : { ok: false, error: 'codex produced no output' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
};
