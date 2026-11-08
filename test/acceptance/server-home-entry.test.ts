// Third fix batch B2a, task A3 (design 4.1; rulings C and D): the server entry resolves HELIX_HOME and HELIX_LEDGER through
// resolveHelixPaths. A relative value, or a HELIX_HOME that cannot be resolved, stops the start with one constant line and exit
// 78 before anything is read or written; an empty value is taken as unset; a home spelled <link>/../name is the directory the
// kernel reaches. Measured through a server bundle built FROM SOURCE (the entry-point-startup.test.ts discipline), spawned with
// cwd outside the repository.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, symlinkSync, existsSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundleCli } from '../helpers/bundle-cli.js';

// FIXED AT THE TEXT REVIEW (plan A3): the one line the server prints when it refuses to start on its home variables.
const REFUSAL_LINE = 'helix: REFUSING TO START - HELIX_HOME or HELIX_LEDGER is a relative path or a path that cannot be resolved; only an absolute path is accepted, and an empty value counts as unset';
const FACT = 'the blue cluster is the deploy target';

let server: string;
beforeAll(async () => { server = await bundleCli('src/server/index.ts'); }, 120_000);

let made: string[] = [];
let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
  for (const d of made) rmSync(d, { recursive: true, force: true });
  made = [];
});

interface Ws { base: string; cwd: string; userHome: string; home: string }

/** <base>/cwd (0755, holding a decoy config.json with an invalid value and an empty memory.jsonl, both 0644),
 *  <base>/uh (the fake user home, so os.homedir() is somewhere that can be inspected) and <base>/home (an absolute home). */
function workspace(): Ws {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a3-')));
  made.push(base);
  const w: Ws = { base, cwd: join(base, 'cwd'), userHome: join(base, 'uh'), home: join(base, 'home') };
  for (const d of [w.cwd, w.userHome, w.home]) mkdirSync(d);
  chmodSync(w.cwd, 0o755);
  writeFileSync(join(w.cwd, 'config.json'), JSON.stringify({ dualVerify: { mode: 'nonsense-not-a-mode' } }), { mode: 0o644 });
  writeFileSync(join(w.cwd, 'memory.jsonl'), '', { mode: 0o644 });
  return w;
}

/** The directory's own mode plus, for each entry, its name, mode and sha256 (or "dir"): equal before and after means nothing was created, changed or chmod-ed. */
function snap(dir: string): string {
  const rows = readdirSync(dir).sort().map((n) => {
    const p = join(dir, n);
    const st = lstatSync(p);
    const body = st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : st.isDirectory() ? 'dir' : 'other';
    return `${n} ${(st.mode & 0o7777).toString(8)} ${body}`;
  });
  return [(statSync(dir).mode & 0o7777).toString(8), ...rows].join('\n');
}

/** Every inherited HELIX_* is stripped, HOME is the fake user home, and `extra` sets the case's own variables. */
const envOf = (userHome: string, extra: Record<string, string>): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_'))) as Record<string, string>),
  HOME: userHome,
  ...extra,
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Spawn the server with stdin closed and wait for it to exit (a server that starts self-terminates at stdin end); killed at 10 s. */
async function runServer(env: Record<string, string>, cwd: string): Promise<Run> {
  const child = spawn(process.execPath, [server], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const { code, signal } = await closed;
  clearTimeout(timer);
  return { code, signal, stdout, stderr };
}

interface Answer { isError: boolean; text: string }

/** Tool calls in order over one server started with `extra`; the client is closed (and the server ends) before it returns. */
async function callsThrough(w: Ws, extra: Record<string, string>, calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<Answer[]> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: w.cwd, env: envOf(w.userHome, extra) });
  const client = new Client({ name: 'helix-a3', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  const out: Answer[] = [];
  try {
    for (const c of calls) {
      const res = await client.callTool({ name: c.name, arguments: c.args }) as { isError?: boolean; content?: Array<{ text?: string }> };
      out.push({ isError: res.isError === true, text: (res.content ?? []).map((x) => x.text ?? '').join('') });
    }
  } finally {
    open = open.filter((o) => o !== client);
    try { await client.close(); } catch { /* already closed */ }
  }
  return out;
}

/** One global commit over stdio against the server started with `extra`. */
async function commitThrough(w: Ws, extra: Record<string, string>): Promise<Answer> {
  const [res] = await callsThrough(w, extra, [{ name: 'helix_memory_commit', args: { content: FACT, source: 'user' } }]);
  return res!;
}

describe('a HELIX_HOME or HELIX_LEDGER the server cannot accept: one line, exit 78, nothing read or written', () => {
  it('control: an absolute home starts, serves until stdin ends and exits 0 without the refusal line', async () => {
    const w = workspace();
    const r = await runServer(envOf(w.userHome, { HELIX_HOME: w.home }), w.cwd);
    expect(r.stderr).not.toContain(REFUSAL_LINE);
    expect(r.stderr, 'the run reached its serving state').toContain('self-terminating');
    expect(r.code).toBe(0);
  }, 60_000);

  it('control: a relative HELIX_SESSIONS, which the server does not read, does not stop the start (segment A decision S1)', async () => {
    const w = workspace();
    const r = await runServer(envOf(w.userHome, { HELIX_HOME: w.home, HELIX_SESSIONS: 'rel-sessions.jsonl' }), w.cwd);
    expect(r.stderr).not.toContain(REFUSAL_LINE);
    expect(r.stderr, 'the run reached its serving state').toContain('self-terminating');
    expect(r.code).toBe(0);
    expect(existsSync(join(w.cwd, 'rel-sessions.jsonl'))).toBe(false);
  }, 60_000);

  const REFUSED: Array<[string, (w: Ws) => Record<string, string>]> = [
    ['HELIX_HOME=. (relative)', () => ({ HELIX_HOME: '.' })],
    ['HELIX_HOME=rel/home (relative, with a separator)', () => ({ HELIX_HOME: 'rel/home' })],
    ['HELIX_LEDGER=rel.jsonl beside an absolute HELIX_HOME', (w) => ({ HELIX_HOME: w.home, HELIX_LEDGER: 'rel.jsonl' })],
    ['HELIX_HOME below a link loop (unresolvable: ELOOP)', (w) => {
      symlinkSync('lb', join(w.base, 'la'));
      symlinkSync('la', join(w.base, 'lb'));
      const home = join(w.base, 'la', 'home');
      expect(() => statSync(home), 'precondition: the kernel answers ELOOP on the way to the home').toThrow(/ELOOP/);
      return { HELIX_HOME: home };
    }],
    ['HELIX_HOME with a 256-byte name component (unresolvable: ENAMETOOLONG)', (w) => {
      const home = join(w.base, 'n'.repeat(256), 'home');
      expect(() => statSync(home), 'precondition: the kernel answers ENAMETOOLONG').toThrow(/ENAMETOOLONG/);
      return { HELIX_HOME: home };
    }],
  ];

  it.each(REFUSED)('%s', async (_name, extraOf) => {
    const w = workspace();
    const extra = extraOf(w);
    const before = { cwd: snap(w.cwd), userHome: snap(w.userHome), home: snap(w.home) };
    const r = await runServer(envOf(w.userHome, extra), w.cwd);
    expect(r.signal, 'the server must exit by itself').toBeNull();
    expect(r.code).toBe(78);
    expect(r.stderr, 'exactly the one constant line, ASCII, no path').toBe(`${REFUSAL_LINE}\n`);
    expect(r.stderr).toMatch(/^[\x20-\x7e]+\n$/);
    expect(r.stdout).toBe('');
    expect(snap(w.cwd), 'the working directory (decoy files, modes) is untouched').toBe(before.cwd);
    expect(snap(w.userHome), 'nothing was created under the user home').toBe(before.userHome);
    expect(snap(w.home)).toBe(before.home);
  }, 60_000);
});

describe('an empty value is an unset value, and a home spelled <link>/../name is the directory the kernel reaches', () => {
  it('control: an unset HELIX_HOME takes <user home>/.helix', async () => {
    const w = workspace();
    const res = await commitThrough(w, {});
    expect(res.isError, res.text).toBe(false);
    expect(readFileSync(join(w.userHome, '.helix', 'memory.jsonl'), 'utf8')).toContain(FACT);
  }, 60_000);

  it('HELIX_HOME="" takes <user home>/.helix, and the working directory is not the home', async () => {
    const w = workspace();
    const before = snap(w.cwd);
    const res = await commitThrough(w, { HELIX_HOME: '' });
    expect(res.isError, res.text).toBe(false);
    expect(readFileSync(join(w.userHome, '.helix', 'memory.jsonl'), 'utf8')).toContain(FACT);
    expect(snap(w.cwd), 'the decoy config.json and memory.jsonl in the cwd were neither read as global nor changed').toBe(before);
  }, 60_000);

  it('HELIX_LEDGER="" takes <home>/memory.jsonl', async () => {
    const w = workspace();
    const before = snap(w.cwd);
    const res = await commitThrough(w, { HELIX_HOME: w.home, HELIX_LEDGER: '' });
    expect(res.isError, res.text).toBe(false);
    expect(readFileSync(join(w.home, 'memory.jsonl'), 'utf8')).toContain(FACT);
    expect(snap(w.cwd)).toBe(before);
  }, 60_000);

  it('HELIX_HOME=<link>/../kh writes where the kernel reaches, never at the text-collapsed name', async () => {
    const w = workspace();
    const real = join(w.base, 'real');
    mkdirSync(join(real, 'sub'), { recursive: true });
    mkdirSync(join(real, 'kh'));                       // where the kernel goes
    mkdirSync(join(w.base, 'kh'));                     // where a text fold of `ln/..` goes
    const ln = join(w.base, 'ln');
    symlinkSync(join(real, 'sub'), ln);
    const spelled = `${ln}/../kh`;                     // concatenation: path.join would fold the `..`
    expect(realpathSync.native(spelled), 'precondition: the kernel reaches <base>/real/kh').toBe(join(real, 'kh'));
    expect(realpathSync.native(spelled)).not.toBe(join(w.base, 'kh'));
    const res = await commitThrough(w, { HELIX_HOME: spelled });
    expect(res.isError, res.text).toBe(false);
    expect(readFileSync(join(real, 'kh', 'memory.jsonl'), 'utf8')).toContain(FACT);
    expect(existsSync(join(real, 'kh', 'ledger-mac-master.key')), 'the trust store is in the same directory').toBe(true);
    expect(readdirSync(join(w.base, 'kh')), 'nothing was written at the text-collapsed name').toEqual([]);
  }, 60_000);
});

// Review Focus 2 at the server level (fix pass 2026-11-08): the resolver resolves the directory part only, so a home whose
// FINAL component is a link stays that link; the writes stay refused as today and the reads are still served
// (SEC-STARTUP-PASS: "A symlinked home that has had one verified read still serves reads; only writes are refused").
describe('a home whose final component is a symlink: writes refused as today, reads served (Review Focus 2)', () => {
  it.skipIf(process.platform === 'win32')('HELIX_HOME=<link> and <link>/: the seeded row is read, a commit is refused, the ledger behind the link is byte-identical', async () => {
    const w = workspace();
    const real = join(w.base, 'hreal');
    mkdirSync(real, { mode: 0o700 });
    const link = join(w.base, 'hlink');
    symlinkSync(real, link);
    expect(lstatSync(link).isSymbolicLink(), 'precondition: the final component of the home is a link').toBe(true);
    // Seed through the real path, then read once there, so the master key and the global nonce exist (the state a home
    // replaced by a link is normally in; symlinked-home.test.ts `seeded`).
    const [seed, seedRead] = await callsThrough(w, { HELIX_HOME: real }, [
      { name: 'helix_memory_commit', args: { content: FACT, source: 'user' } },
      { name: 'helix_memory_inspect', args: {} },
    ]);
    expect(seed!.isError, seed!.text).toBe(false);
    expect(seedRead!.text, 'precondition: the seeded row reads back through the real path').toContain(FACT);
    const before = readFileSync(join(real, 'memory.jsonl'));
    for (const spelled of [link, `${link}/`]) {
      const [read, write] = await callsThrough(w, { HELIX_HOME: spelled }, [
        { name: 'helix_memory_inspect', args: {} },
        { name: 'helix_memory_commit', args: { content: 'the green cluster is the fallback', source: 'user' } },
      ]);
      expect(read!.isError, `${spelled}: ${read!.text}`).toBe(false);
      expect(read!.text, `${spelled}: the read through the link is served`).toContain(FACT);
      expect(write!.isError, `${spelled}: the write through the link is refused as today`).toBe(true);
      expect(write!.text).toContain('symlink');
      expect(readFileSync(join(real, 'memory.jsonl')).equals(before), `${spelled}: the ledger behind the link is byte-identical`).toBe(true);
    }
  }, 90_000);
});
