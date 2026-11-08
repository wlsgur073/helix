// Third fix batch B2a, task D1: how the COMMITTED bundles are spawned by test/acceptance/b2a-home-*.e2e.test.ts. Every child gets
// an environment without any HELIX_* variable, HOME at a throwaway user home, and a cwd that is never the repository (CLAUDE.md,
// Driving the shipped bundle). The helpers take no position on what a bundle should do; the cases say that.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, type Stats, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = {
  server: join(REPO, 'bin', 'helix-mcp.mjs'),
  start: join(REPO, 'bin', 'hooks', 'session-start.mjs'),
  end: join(REPO, 'bin', 'hooks', 'session-end.mjs'),
  rebaseline: join(REPO, 'bin', 'helix-rebaseline.mjs'),
  trustResolve: join(REPO, 'bin', 'helix-trust-resolve.mjs'),
  trigger: join(REPO, 'bin', 'helix-trigger.mjs'),
  postrun: join(REPO, 'scripts', 'dogfood-postrun.sh'),
} as const;

export const POSIX = process.platform !== 'win32';
export const AS_ROOT = process.getuid?.() === 0;

/** The inherited environment without any HELIX_* variable: only what a case sets reaches a child. */
export const strippedEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>;

/** One case's directories under one base: `userHome` stands in for $HOME (0755), `work` is the child's cwd (0755), `home` an
 *  ordinary HELIX_HOME (0700), `out` a 0755 folder outside it. Modes are set with chmod, so the umask cannot hide a repair. */
export interface World { base: string; userHome: string; work: string; home: string; out: string }
const made: string[] = [];
export function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-')));
  made.push(base);
  const mk = (name: string, mode: number): string => { const p = join(base, name); mkdirSync(p); chmodSync(p, mode); return p; };
  return { base, userHome: mk('u', 0o755), work: mk('w', 0o755), home: mk('h', 0o700), out: mk('o', 0o755) };
}
/** Gives owner permissions back to a tree a case narrowed (0500, 0555) before removing every tree `world()` made. */
export function cleanupWorlds(): void {
  for (const b of made.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', b]);
    rmSync(b, { recursive: true, force: true });
  }
}

/** The environment of a child: stripped, HOME at the case's user home, then the HELIX_* values the case sets. An empty string is
 *  passed as an empty variable (the case of ruling C), not left out. */
export const envFor = (w: Pick<World, 'userHome'>, helix: Record<string, string> = {}): Record<string, string> =>
  ({ ...strippedEnv(), HOME: w.userHome, ...helix });

/** `<dir>/../name` spelled by string concatenation (path.join would fold the ".." as text) and the two directories it could mean:
 *  `kernel` is where the kernel goes through the link, `flat` where a text-collapsed name lands. */
export function dotdotLayout(w: World): { spelled: string; kernel: string; flat: string } {
  const real = join(w.base, 'real');
  const sub = join(real, 'sub');
  mkdirSync(sub, { recursive: true });
  const ln = join(w.base, 'ln');
  symlinkSync(sub, ln);
  const flat = join(w.base, 'kh');
  const kernel = join(real, 'kh');
  for (const d of [flat, kernel]) { mkdirSync(d); chmodSync(d, 0o700); }
  const spelled = `${ln}/../kh`;
  if (statSync(spelled).ino !== statSync(kernel).ino || statSync(spelled).ino === statSync(flat).ino) {
    throw new Error('fixture: the spelled path does not lead to the directory the kernel reaches');
  }
  return { spelled, kernel, flat };
}

export const fifo = (path: string): void => { execFileSync('mkfifo', [path]); };
export const modeOf = (path: string): number => statSync(path).mode & 0o777;
export const sizeOrZero = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };
export function kindOf(path: string): 'absent' | 'fifo' | 'file' | 'dir' | 'link' | 'other' {
  let st: Stats;
  try { st = lstatSync(path); } catch { return 'absent'; }
  return st.isFIFO() ? 'fifo' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'other';
}

/** Every entry below `dir` with its kind, mode and, for a regular file, its sha256; a link by its body. lstat only: a FIFO is
 *  never opened. Two equal digests mean nothing was created, removed, re-moded, rewritten or re-linked in between. */
export function treeDigest(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    out.push(`${rel === '' ? '.' : rel} dir ${(lstatSync(d).mode & 0o7777).toString(8)}`);
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (st.isSymbolicLink()) out.push(`${r} link ${readlinkSync(p)}`);
      else if (st.isFile()) out.push(`${r} file ${(st.mode & 0o7777).toString(8)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      else out.push(`${r} other ${(st.mode & 0o7777).toString(8)}`);
    }
  };
  walk(dir, '');
  return out;
}

export interface Ran { code: number | null; stdout: string; stderr: string; killed: boolean }
/** Runs a command to its end under a deadline and a hard kill: a child that blocks on a FIFO fails its case with `killed: true`,
 *  never the run. `stdin` is written and closed at once. */
export function runCommand(command: string, args: string[], o: { cwd: string; env: Record<string, string>; stdin?: string; deadlineMs?: number }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, o.deadlineMs ?? 20_000);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdin.on('error', () => undefined);        // the child may exit before it reads
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
    child.stdin.end(o.stdin ?? '');
  });
}
export const runNode = (script: string, args: string[], o: { cwd: string; env: Record<string, string>; stdin?: string; deadlineMs?: number }): Promise<Ran> =>
  runCommand(process.execPath, [script, ...args], o);

/** A CLI under a pseudo-terminal (the operator CLIs refuse a piped stdin before they look at anything else). `script` merges the
 *  child's stdout and stderr; carriage returns are dropped. */
export const hasScript = process.platform === 'linux' && spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
const quoted = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
export function viaPty(script: string, args: string[], o: { cwd: string; env: Record<string, string> }): { status: number | null; out: string } {
  const command = [process.execPath, script, ...args].map(quoted).join(' ');
  const r = spawnSync('script', ['-qec', command, '/dev/null'], { cwd: o.cwd, env: o.env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\r/g, '') };
}

export interface Rpc { responses: Map<number, unknown>; stderr: string; timedOut: boolean }
/** The server over raw JSON-RPC: initialize, then every call as a tools/call with ids 2..n+1, written together. Ends when all ids
 *  have answered, the child exits, or the deadline passes (then a hard kill and `timedOut: true`). */
export function rpc(env: Record<string, string>, cwd: string, calls: Array<{ name: string; args: Record<string, unknown> }>, deadlineMs = 20_000): Promise<Rpc> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN.server], { cwd, env });
    child.stdin.on('error', () => undefined);
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
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
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
    child.on('close', () => { clearTimeout(timer); resolve({ responses, stderr, timedOut }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'b2a-home-e2e', version: '0' } } }) + '\n');
  });
}
export const textOf = (r: unknown): string =>
  ((r as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content ?? []).map((c) => c.text ?? '').join('');
export const isErr = (r: unknown): boolean => (r as { result?: { isError?: boolean } } | undefined)?.result?.isError === true;
/** The id out of a `committed {...}` answer. */
export const committedId = (r: unknown): string => (JSON.parse(textOf(r).replace(/^committed /, '')) as { id: string }).id;
