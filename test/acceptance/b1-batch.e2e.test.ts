// Third fix batch B1, task B10: the committed bundles, spawned as Claude Code spawns them, in the scenarios the batch changed
// (design sections 6 and 7 commit 10; outline Review Focus 1 and 5). Every scenario but two fails against the pre-batch
// bundle whatever the timing; the racing commits fail there only when they overlap, so that case can be a green control,
// and the commit to a read-only memory file passes there (the pre-batch bundle named the file; design 14 item 21).
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync, lstatSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UNUSABLE_LEDGER_NOTE, GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import { LOCK_FOREIGN_OBJECT_REFUSAL } from '../../src/memory/lock.js';
import { GLOBAL_WRITE_REFUSAL, GLOBAL_READ_ONLY_STARTUP_LINE } from '../../src/memory/global-ledger.js';
import { PROJECT_WRITE_REFUSAL, ADOPT_NOT_LEDGER_CONTENT } from '../../src/memory/store.js';
import { buildGlobalLayout, cleanupLayouts, snapshotTree } from '../helpers/global-layouts.js';
import { rowsIn, registryKeys } from '../helpers/first-write-fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(root, 'bin', 'helix-mcp.mjs');
const START = join(root, 'bin', 'hooks', 'session-start.mjs');
const REBASELINE = join(root, 'bin', 'helix-rebaseline.mjs');

const posixOnly = describe.skipIf(process.platform === 'win32');

// Strip ALL HELIX_* (see bundle.e2e.test.ts): only what a scenario sets may reach a child.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

/** Every temporary folder a case makes, removed after the case once its clients are closed; and every mode a case narrowed
 *  under one of them, restored before the removal. */
let made: string[] = [];
let narrowed: Array<{ path: string; mode: number }> = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** A throwaway user HOME and a HELIX_HOME (0700) under one base directory, and the env naming both. */
function homes(prefix: string): { userHome: string; hh: string; env: Record<string, string> } {
  const base = tmp(prefix);
  const userHome = join(base, 'home');
  mkdirSync(userHome);
  const hh = join(base, 'hh');
  mkdirSync(hh, { mode: 0o700 });
  return { userHome, hh, env: { ...cleanEnv(), HOME: userHome, HELIX_HOME: hh } };
}

let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
  for (const n of narrowed) { try { chmodSync(n.path, n.mode); } catch { /* already gone */ } }
  narrowed = [];
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made = [];
  cleanupLayouts();
});

async function connect(env: Record<string, string>, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd, env });
  const client = new Client({ name: 'b1-batch-e2e', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

/** Spawn the committed server, complete the initialize handshake, and return its stderr. A deadline and a hard kill keep a
 *  hung child from hanging the run; `answered` says whether the initialize response came. */
function startupStderr(env: Record<string, string>, cwd: string, deadlineMs = 15_000): Promise<{ stderr: string; answered: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd, env });
    child.stdin.on('error', () => { /* the child exited first; its exit is observed through 'close' */ });
    let stderr = '';
    let buf = '';
    let answered = false;
    const finish = (): void => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already gone */ }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(finish, deadlineMs);
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.stdout.on('data', (d: Buffer) => {
      buf += String(d);
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { if ((JSON.parse(line) as { id?: unknown }).id === 1) { answered = true; finish(); } } catch { /* not a JSON-RPC line */ }
      }
    });
    child.on('close', () => resolve({ stderr, answered }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'b1-batch-e2e', version: '0' } } }) + '\n');
  });
}

/** Run a hook bundle as Claude Code does (node <bundle>, JSON on stdin) with a deadline; `ms` is a monotonic duration
 *  (Date.now() steps back about 0.78 s every ~32 s on the WSL2 box, CLAUDE.md). */
function runHook(script: string, env: Record<string, string>, cwd: string, stdin: string, deadlineMs: number): Promise<{ code: number | null; stdout: string; ms: number; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [script], { env, cwd });
    let stdout = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, deadlineMs);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, ms: performance.now() - t0, killed }); });
    child.stdin.on('error', () => { /* the hook may exit before it reads */ });
    child.stdin.end(stdin);
  });
}

const text = (r: unknown): string =>
  ((r as { content?: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

/** What a snapshot compares: audit.jsonl and metrics.jsonl legitimately grow with every tool call. */
const stable = (lines: string[]): string[] => lines.filter((l) => !/\/(audit|metrics)\.jsonl\|/.test(l));

/** The `compaction` rows of a home's metrics.jsonl (src/metrics.ts `emitCompaction`). */
const compactionRows = (home: string): unknown[] => {
  const p = join(home, 'metrics.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((x) => x !== '').map((x) => JSON.parse(x) as { kind?: string }).filter((x) => x.kind === 'compaction');
};

const record = (content: string): string => JSON.stringify({
  id: `m_${content.slice(0, 6)}`, tx: '2026-06-10T00:00:00.000Z', validFrom: '2026-06-10T00:00:00.000Z', validTo: null,
  type: 'assert', state: 'Fresh', content, provenance: { source: 'user', sessionId: 'seed' },
  supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

posixOnly('IT-M5 over the shipped server (Review Focus 5): racing first commits', () => {
  it.each([1, 2, 3])('round %i: four servers commit first to one unadopted project at once; every commit is stored, none answers foreign-file, one registry entry', async (round) => {
    const h = homes(`helix-b1-race${round}-`);
    const proj = join(h.userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const clients = await Promise.all([0, 1, 2, 3].map(() => connect(h.env, proj)));
    const facts = [0, 1, 2, 3].map((i) => `racing fact ${round} ${i}`);
    const results = await Promise.all(clients.map((c, i) =>
      c.callTool({ name: 'helix_memory_commit', arguments: { content: facts[i]!, source: 'user' } })));
    results.forEach((r, i) => {
      expect(isError(r), `server ${i}: ${text(r)}`).toBe(false);
      expect(text(r)).toMatch(/^committed \{/);
    });
    expect(rowsIn(join(proj, '.helix', 'memory.jsonl')).sort()).toEqual([...facts].sort());
    expect(registryKeys(h.hh)).toEqual([realpathSync(proj)]);
  }, 120_000);
});

posixOnly('lock objects over the shipped server (design 4.5)', () => {
  it('a FIFO at the global ledger lock path does not keep the server from answering initialize', async () => {
    const h = homes('helix-b1-fifo-');
    execFileSync('mkfifo', [join(h.hh, 'memory.jsonl.lock')]);
    const r = await startupStderr(h.env, h.userHome, 15_000);
    expect(r.answered, r.stderr).toBe(true);
  }, 45_000);

  it('a link at a project ledger lock path is refused at once with the fixed text, and nothing is recorded', async () => {
    const h = homes('helix-b1-locklink-');
    const proj = join(h.userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const target = join(h.userHome, 'payload.txt');
    writeFileSync(target, '{"not":"a lock"}');
    symlinkSync(target, join(proj, '.helix', 'memory.jsonl.lock'));
    const client = await connect(h.env, proj);
    const t0 = performance.now();
    const refused = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the build uses node 24', source: 'user' } });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain(LOCK_FOREIGN_OBJECT_REFUSAL);
    expect(performance.now() - t0, 'the refusal waited instead of coming at once').toBeLessThan(3_000);
    expect(existsSync(join(proj, '.helix', '.owner'))).toBe(false);
    expect(registryKeys(h.hh)).toEqual([]);
    expect(existsSync(join(proj, '.helix', 'memory.jsonl'))).toBe(false);
  }, 45_000);
});

posixOnly('an unresolvable global ledger over the shipped bundles (design 4.7)', () => {
  it('startup prints the one line, reads carry the note, writes are refused, the home is untouched, and a refused erase is audited as rejected', async () => {
    const l = buildGlobalLayout('nonutf8-link-body');            // two rows behind a link whose body is not valid UTF-8
    expect(l.ledger).toBe(join(l.home, 'memory.jsonl'));         // no HELIX_LEDGER needed for this layout
    const cwd = tmp('helix-b1-cwd-');                            // no .helix here: global-only mode
    const env = { ...cleanEnv(), HOME: cwd, HELIX_HOME: l.home };

    const started = await startupStderr(env, cwd);
    expect(started.answered, started.stderr).toBe(true);
    expect(started.stderr).toContain(GLOBAL_READ_ONLY_STARTUP_LINE);

    const client = await connect(env, cwd);
    const before = stable(snapshotTree(l.base));

    const recalled = text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'alpha deploy fact' } }));
    expect(recalled).toContain('alpha deploy fact');
    expect(recalled).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(text(await client.callTool({ name: 'helix_memory_inspect', arguments: {} }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);

    const id = l.ids[0]!;
    const committed = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'a new global fact', source: 'user' } });
    expect(isError(committed)).toBe(true);
    expect(text(committed)).toContain(GLOBAL_WRITE_REFUSAL.commit);
    const erased = await client.callTool({ name: 'helix_memory_erase', arguments: { id } });
    expect(isError(erased)).toBe(true);
    expect(text(erased)).toContain(GLOBAL_WRITE_REFUSAL.erase);
    const confirmed = await client.callTool({ name: 'helix_memory_confirm', arguments: { id } });
    expect(isError(confirmed)).toBe(true);
    expect(text(confirmed)).toContain(GLOBAL_WRITE_REFUSAL.confirm);

    expect(stable(snapshotTree(l.base)), 'a refusal created, removed or re-moded something in the home').toEqual(before);
    const audit = readFileSync(join(l.home, 'audit.jsonl'), 'utf8').split('\n').filter((x) => x !== '')
      .map((x) => JSON.parse(x) as { kind?: string; id?: string; outcome?: string });
    expect(audit.filter((a) => a.kind === 'erase' && a.id === id).map((a) => a.outcome)).toEqual(['rejected']);
  }, 90_000);

  it('the startup heal leaves that scope alone: a FIFO at the lock name beside the link does not keep the server from answering', async () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    execFileSync('mkfifo', [join(l.home, 'memory.jsonl.lock')]);         // where the pre-batch heal locked this ledger
    const cwd = tmp('helix-b1-cwd-');
    const r = await startupStderr({ ...cleanEnv(), HOME: cwd, HELIX_HOME: l.home }, cwd);
    expect(r.answered, r.stderr).toBe(true);
    expect(r.stderr).toContain(GLOBAL_READ_ONLY_STARTUP_LINE);
  }, 45_000);

  it('automatic compaction is not attempted: the link stays, its target keeps its bytes, and no compaction row is written; the same settings compact a plain ledger', async () => {
    const armed = JSON.stringify({ compaction: { auto: true, minRows: 3, minDirtyBytes: 1, graceMs: 0 } });

    // The control: these settings do arm the compaction in this bundle, so the absence below says something.
    const plain = buildGlobalLayout('plain', { dirty: true });
    writeFileSync(join(plain.home, 'config.json'), armed);
    const cwdPlain = tmp('helix-b1-cwd-');
    const control = await connect({ ...cleanEnv(), HOME: cwdPlain, HELIX_HOME: plain.home }, cwdPlain);
    await control.callTool({ name: 'helix_memory_recall', arguments: { query: 'deploy' } });
    expect(compactionRows(plain.home)).toHaveLength(1);

    const l = buildGlobalLayout('nonutf8-link-body', { dirty: true });
    writeFileSync(join(l.home, 'config.json'), armed);
    const bytes = readFileSync(l.kernelFile as Buffer);
    const cwd = tmp('helix-b1-cwd-');
    const client = await connect({ ...cleanEnv(), HOME: cwd, HELIX_HOME: l.home }, cwd);
    expect(text(await client.callTool({ name: 'helix_memory_recall', arguments: { query: 'deploy' } }))).toContain(GLOBAL_LEDGER_READ_ONLY_NOTE);
    expect(compactionRows(l.home)).toEqual([]);
    expect(lstatSync(l.ledger).isSymbolicLink()).toBe(true);
    expect(readFileSync(l.kernelFile as Buffer).equals(bytes)).toBe(true);
  }, 60_000);

  const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(process.platform !== 'linux' || !hasScript)('helix-rebaseline --scope global refuses with exit 2, under a terminal, and writes nothing', () => {
    const l = buildGlobalLayout('nonutf8-link-body');
    const before = stable(snapshotTree(l.base));
    // `script` gives the child a pseudo-terminal (the CLI refuses a piped stdin before it looks at the ledger) and returns its exit status.
    const res = spawnSync('script', ['-qec', `'${process.execPath}' '${REBASELINE}' --scope global`, '/dev/null'], {
      cwd: l.base, env: { ...cleanEnv(), HOME: l.base, HELIX_HOME: l.home }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(2);
    expect(res.stdout).toContain("helix-rebaseline: REFUSING - the global memory file's path cannot be resolved");
    expect(stable(snapshotTree(l.base))).toEqual(before);
  }, 45_000);
});

posixOnly('SessionStart over a large link target (Review Focus 1)', () => {
  const MIB = 1024 * 1024;
  // The "{" lines never reach JSON.parse (the form check rejects a line whose last byte is not "}"), so that case pins the
  // form check's speed only. The crafted lines do reach JSON.parse: at 32 MiB an unbounded read takes about four times the
  // 9 s threshold, while the bounded read reads the first MiB whatever the size, so that case guards the 1 MiB read bound.
  it.each([
    ['8 MiB of "{" lines (the form check\'s speed)', '{\n', 8 * MIB],
    ['32 MiB of crafted "{\\}" lines (the 1 MiB read bound)', '{\\}\n', 32 * MIB],
  ] as const)('%s behind an unadopted project\'s memory link: the hook answers inside the host\'s 10 s and names the unusable layer', async (_label, unit, size) => {
    const hh = tmp('helix-b1-hook-hh-');
    writeFileSync(join(hh, 'memory.jsonl'), record('global fact survives') + '\n');
    const proj = tmp('helix-b1-hook-proj-');
    mkdirSync(join(proj, '.helix'));
    writeFileSync(join(proj, 'big.txt'), unit.repeat(size / unit.length));
    symlinkSync('../big.txt', join(proj, '.helix', 'memory.jsonl'));
    const cwd = tmp('helix-b1-hook-cwd-');
    const r = await runHook(START, { ...cleanEnv(), HOME: cwd, HELIX_HOME: hh }, cwd, JSON.stringify({ cwd: proj }), 20_000);
    expect(r.killed, 'the hook was still running at the deadline').toBe(false);
    expect(r.code).toBe(0);
    expect(r.ms, `the hook took ${Math.round(r.ms)} ms (the host allows 10 000)`).toBeLessThan(9_000);
    expect(r.stdout).toContain('global fact survives');
    expect(r.stdout).toContain(UNUSABLE_LEDGER_NOTE);
  }, 60_000);
});

posixOnly('adopt over the shipped server (design 4.4)', () => {
  it('a memory file that holds no Helix record is refused, and nothing is recorded', async () => {
    const h = homes('helix-b1-adopt1-');
    const proj = join(h.userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    writeFileSync(join(proj, '.helix', 'memory.jsonl'), '# notes\nnot a ledger\n');
    const client = await connect(h.env, proj);
    const res = await client.callTool({ name: 'helix_memory_adopt', arguments: { projectRoot: proj } });
    expect(isError(res), text(res)).toBe(true);
    expect(text(res)).toContain(ADOPT_NOT_LEDGER_CONTENT);
    expect(existsSync(join(proj, '.helix', '.owner'))).toBe(false);
    expect(registryKeys(h.hh)).toEqual([]);
  }, 45_000);

  it('a memory file that is a link to such a file is refused as an unusable layer, and nothing is recorded', async () => {
    const h = homes('helix-b1-adopt2-');
    const proj = join(h.userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    writeFileSync(join(proj, 'notes.txt'), '# notes\nnot a ledger\n');
    symlinkSync('../notes.txt', join(proj, '.helix', 'memory.jsonl'));
    const client = await connect(h.env, proj);
    const res = await client.callTool({ name: 'helix_memory_adopt', arguments: { projectRoot: proj } });
    expect(isError(res), text(res)).toBe(true);
    expect(text(res)).toContain(PROJECT_WRITE_REFUSAL.adopt.unusable);
    expect(existsSync(join(proj, '.helix', '.owner'))).toBe(false);
    expect(registryKeys(h.hh)).toEqual([]);
  }, 45_000);
});

posixOnly('a commit to a read-only memory file over the shipped server (design 14 item 21)', () => {
  it.skipIf(process.getuid?.() === 0)('the raw error names the memory file, not the held folder\'s descriptor path, and the file keeps its bytes', async () => {
    const h = homes('helix-b1-ro-');
    const proj = join(h.userHome, 'proj');
    mkdirSync(join(proj, '.helix'), { recursive: true });
    const client = await connect(h.env, proj);
    const first = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the build uses node 24', source: 'user' } });
    expect(isError(first), text(first)).toBe(false);
    expect(registryKeys(h.hh)).toEqual([realpathSync(proj)]);   // adopted by its first commit
    const file = realpathSync(join(proj, '.helix', 'memory.jsonl'));
    const bytes = readFileSync(file);
    narrowed.push({ path: file, mode: lstatSync(file).mode & 0o777 });
    chmodSync(file, 0o444);
    const second = await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'the tests run with vitest', source: 'user' } });
    expect(isError(second), text(second)).toBe(true);
    expect(text(second)).toContain(file);
    expect(text(second)).not.toContain('/proc/self/fd');
    expect(readFileSync(file).equals(bytes)).toBe(true);
  }, 45_000);
});
