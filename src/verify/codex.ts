import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 as winPath } from 'node:path';
import { promisify } from 'node:util';
import { MAX_TIMEOUT_MS } from '../config.js';
import { sweepScratchRoot } from './scratch-gc.js';

const execFileAsync = promisify(execFile);

export type CodexResult = { ok: true; answer: string } | { ok: false; error: string };
export interface CodexRunOptions { model?: string | null; effort?: string | null; timeoutMs?: number }
export type CodexRunner = (question: string, opts?: CodexRunOptions) => Promise<CodexResult>;
export interface Availability { available: boolean; reason?: string }

export type CodexAuthMode = 'chatgpt' | 'api-key' | 'none' | 'unknown';
export interface CodexStatus {
  cliFound: boolean;        // codex CLI present + version-parseable
  version?: string;         // e.g. "0.139.0"
  available: boolean;       // logged in (usable)
  authMode: CodexAuthMode;
  reason?: string;          // why unavailable, when !available
}

/** How to launch codex: the program file plus any argv prefix (e.g. the shim's JS entry). */
export interface CodexInvocation { file: string; argsPrefix: string[] }

/**
 * Build the `codex exec` argv: read-only sandbox + ephemeral + final message to a file.
 * The trailing '-' makes codex read the prompt from stdin (codex-cli 0.138 `exec --help`),
 * so the question never enters argv — there is no flag-smuggling surface left to guard.
 * model/effort come from user config but still become argv values — keep them argv-safe.
 */
export function buildCodexExecArgs(outFile: string, opts: CodexRunOptions = {}): string[] {
  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', outFile];
  if (opts.model != null && opts.model !== '') {
    if (!/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(opts.model)) throw new Error(`invalid codex model "${opts.model}" (argv safety)`);
    args.push('-m', opts.model);
  }
  if (opts.effort != null && opts.effort !== '') {
    if (!/^[a-z]+$/.test(opts.effort)) throw new Error(`invalid codex effort "${opts.effort}" (argv safety)`);
    args.push('-c', `model_reasoning_effort=${opts.effort}`);
  }
  args.push('-');
  return args;
}

/**
 * Pure: choose how to launch codex from `where`-style output, first usable entry in PATH
 * order. Windows CreateProcess cannot exec npm's .cmd shims and `shell: true` would reopen
 * the injection surface (DEP0190), so a .cmd is resolved to its underlying
 * `node_modules/@openai/codex/bin/codex.js` and run with our own node binary instead.
 * Extension-less lines are POSIX-sh shims — not spawnable on win32, skipped.
 */
export function interpretWhereOutput(
  platform: NodeJS.Platform,
  whereOutput: string,
  exists: (path: string) => boolean,
): CodexInvocation | null {
  if (platform !== 'win32') return { file: 'codex', argsPrefix: [] };
  for (const raw of whereOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const lower = line.toLowerCase();
    if (lower.endsWith('.exe')) return { file: line, argsPrefix: [] };
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // win32 path math regardless of host: this branch only runs for win32 input (prod calls
      // it only when process.platform==='win32'; tests exercise it cross-platform), so the
      // shim path must be split/joined with backslash semantics even when the host is POSIX.
      const js = winPath.join(winPath.dirname(line), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (exists(js)) return { file: process.execPath, argsPrefix: [js] };
    }
  }
  return null;
}

/** Pure: how to kill the codex process tree on timeout. On win32 the resolved launcher is
 *  `node codex.js`, which spawns the native codex as a GRANDCHILD; child.kill() (TerminateProcess)
 *  would orphan it (metered run keeps spending quota), so we tree-kill via taskkill /T. On POSIX
 *  the direct child IS codex and receives the signal — no tree kill needed. */
export function treeKillSpec(platform: NodeJS.Platform, pid: number): { cmd: string; args: string[] } | null {
  return platform === 'win32' ? { cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] } : null;
}

let cachedInvocation: CodexInvocation | null = null; // null = not yet resolved (NEGATIVE results are not cached)

/** Resolve the codex launcher, caching only SUCCESS. A transient `where` failure must not
 *  pin null for the whole server lifetime — a user who then installs codex can retry. */
export async function resolveCodexInvocation(): Promise<CodexInvocation | null> {
  if (cachedInvocation) return cachedInvocation;
  if (process.platform !== 'win32') {
    cachedInvocation = { file: 'codex', argsPrefix: [] };
    return cachedInvocation;
  }
  let inv: CodexInvocation | null = null;
  try {
    // where.exe is a real executable (System32), safe to execFile directly.
    const { stdout } = await execFileAsync('where', ['codex'], { timeout: 10_000 });
    inv = interpretWhereOutput('win32', stdout ?? '', existsSync);
  } catch {
    inv = null;
  }
  if (inv) cachedInvocation = inv; // cache success only
  return inv;
}

interface RunOutcome { code: number | null; stdout: string; stderr: string }

/** Spawn the resolved codex (no shell), optionally writing `input` to stdin. */
function runCodex(inv: CodexInvocation, args: string[], input: string | null, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(inv.file, [...inv.argsPrefix, ...args], {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      const spec = treeKillSpec(process.platform, child.pid ?? -1);
      if (spec && child.pid !== undefined) {
        try { execFileSync(spec.cmd, spec.args, { stdio: 'ignore' }); } catch { try { child.kill(); } catch { /* gone */ } }
      } else {
        try { child.kill(); } catch { /* gone */ }
      }
      reject(new Error(`codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 65_536) stdout += String(d); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8_192) stderr += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== null && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE if codex exits early — surfaced via close code */ });
      child.stdin.end(input);
    }
  });
}

/**
 * Pure: derive full status from `codex --version` and `codex login status` output.
 * version/availability reuse the existing preflight rules; authMode is best-effort text parsing
 * (Codex login status is human text, not a contract) with an `unknown` fallback so an
 * unrecognized-but-logged-in phrasing degrades instead of crashing. The OPENAI_API_KEY *presence*
 * (never its value) nudges ambiguous logged-in cases toward 'api-key'; login text is authoritative.
 */
export function interpretStatus(versionOut: string, loginOut: string): CodexStatus {
  const m = /codex-cli\s+(\d+\.\d+\.\d+)/i.exec(versionOut);
  const cliFound = m !== null;
  const version = m?.[1];
  if (!cliFound) {
    return { cliFound: false, version: undefined, available: false, authMode: 'none', reason: 'codex CLI not found' };
  }
  // "logged in" is a substring of "Not logged in" — exclude the negative forms.
  const loggedIn = /logged in/i.test(loginOut) && !/not logged in|logged out|not authenticated/i.test(loginOut);
  if (!loggedIn) {
    return { cliFound: true, version, available: false, authMode: 'none', reason: 'codex not logged in (run: codex login)' };
  }
  let authMode: CodexAuthMode;
  if (/using ChatGPT/i.test(loginOut)) {
    authMode = 'chatgpt';
  } else if (/api[ -]?key|using an API key/i.test(loginOut)) {
    authMode = 'api-key';
  } else if (process.env.OPENAI_API_KEY) {
    authMode = 'api-key'; // secondary signal: env-key presence (not value) on ambiguous phrasing
  } else {
    authMode = 'unknown';
  }
  return { cliFound: true, version, available: true, authMode };
}

/** Pure: decide availability from `codex --version` and `codex login status` output.
 *  Delegates to interpretStatus so parsing has a single source of truth; contract is unchanged. */
export function interpretPreflight(versionOut: string, loginOut: string): Availability {
  const s = interpretStatus(versionOut, loginOut);
  return s.available ? { available: true } : { available: false, reason: s.reason };
}

/** Real preflight through the resolved launcher. Any error -> unavailable (fail-closed). */
export async function checkCodexAvailable(invocation?: CodexInvocation | null): Promise<Availability> {
  try {
    const inv = invocation !== undefined ? invocation : await resolveCodexInvocation();
    if (!inv) return { available: false, reason: 'codex launcher not found on PATH' };
    const v = await runCodex(inv, ['--version'], null, 10_000);
    const l = await runCodex(inv, ['login', 'status'], null, 10_000);
    // Some CLIs print status to stderr; feed both streams to the interpreter.
    return interpretPreflight(v.stdout + v.stderr, l.stdout + l.stderr);
  } catch (e) {
    return { available: false, reason: `codex preflight failed: ${(e as Error).message}` };
  }
}

/**
 * Real status probe through the resolved launcher. Runs `--version` + `login status` (each a 10s
 * timeout, no quota spent), feeds stdout+stderr to interpretStatus. Any spawn/parse error ->
 * a fail-closed not-found/not-logged-in status; never throws. FREE (no `codex exec`).
 */
export async function checkCodexStatus(invocation?: CodexInvocation | null): Promise<CodexStatus> {
  try {
    const inv = invocation !== undefined ? invocation : await resolveCodexInvocation();
    if (!inv) {
      return { cliFound: false, version: undefined, available: false, authMode: 'none', reason: 'codex launcher not found on PATH' };
    }
    const v = await runCodex(inv, ['--version'], null, 10_000);
    const l = await runCodex(inv, ['login', 'status'], null, 10_000);
    // Some CLIs print to stderr; feed both streams to the interpreter.
    return interpretStatus(v.stdout + v.stderr, l.stdout + l.stderr);
  } catch (e) {
    return { cliFound: false, version: undefined, available: false, authMode: 'none', reason: `codex status check failed: ${(e as Error).message}` };
  }
}

/** Build a runner that spawns `codex exec` with the prompt on stdin and reads -o's file. */
export function createCodexRunner(
  resolveInv: () => Promise<CodexInvocation | null> = resolveCodexInvocation,
  run: (inv: CodexInvocation, args: string[], input: string | null, timeoutMs: number) => Promise<RunOutcome> = runCodex,
): CodexRunner {
  return async (question, opts = {}) => {
    const inv = await resolveInv();
    if (!inv) return { ok: false, error: 'codex launcher not found on PATH (npm .cmd shim unresolvable)' };
    // Corral all scratch under a single <temp>/helix/ folder (instead of scattering
    // helix-codex-* across the temp root). Leaked dirs — when the finally{} cleanup
    // below loses a race to a Windows file lock — then collect in one easily-purged place.
    const scratchRoot = join(tmpdir(), 'helix');
    mkdirSync(scratchRoot, { recursive: true });
    sweepScratchRoot(scratchRoot); // best-effort GC of leaked sibling scratch dirs (never throws)
    const dir = mkdtempSync(join(scratchRoot, 'codex-'));
    const outFile = join(dir, 'out.txt');
    try {
      // timeout is configurable (dualVerify.timeoutMs via opts), hard-clamped to MAX_TIMEOUT_MS so the
      // scratch-gc floor stays safe even for direct callers. 120s is the fallback default.
      const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, MAX_TIMEOUT_MS);
      const { code, stderr } = await run(inv, buildCodexExecArgs(outFile, opts), question, timeoutMs);
      if (code !== 0) {
        return { ok: false, error: `codex exited ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}` };
      }
      let answer = '';
      try { answer = readFileSync(outFile, 'utf8').trim(); } catch { /* missing file -> no output */ }
      return answer ? { ok: true, answer } : { ok: false, error: 'codex produced no output' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
    }
  };
}

/** Real runner used by the server (resolves the launcher on first use, then caches). */
export const realCodexRunner: CodexRunner = createCodexRunner();
