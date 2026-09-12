#!/usr/bin/env node
// Runtime-floor smoke for the SHIPPED bundles. Deliberately dependency-free and run with no
// `npm install`: that is exactly the condition a cloned plugin is in, and it is what makes this
// evidence for README's "Node >= 20" claim rather than a test of the dev toolchain.
//
// It drives all six bundles the candidate receipt pins: three CLIs (usage exit), two hooks (a stdin
// payload), and the MCP server (initialize + tools/list over stdio). HELIX_HOME is redirected to a
// temporary directory, because both hooks write state and a smoke test must not touch the real one.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'helix-smoke-'));
const env = { ...process.env, HELIX_HOME: HOME, HELIX_SESSIONS: join(HOME, 'sessions.jsonl') };
const failures = [];
const ok = (m) => console.log(`ok   ${m}`);
const bad = (m) => { failures.push(m); console.log(`FAIL ${m}`); };

function run(bundle, { args = [], stdin = '' } = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, bundle), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ code, out, err }));
    p.stdin.end(stdin);
  });
}

// The MCP server speaks newline-delimited JSON-RPC on stdio and self-terminates when stdin closes.
function mcp(lines) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, 'bin/helix-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ code, out, err }));
    p.stdin.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    setTimeout(() => p.stdin.end(), 2000);
  });
}

const CLIS = ['bin/helix-rebaseline.mjs', 'bin/helix-trigger.mjs', 'bin/helix-trust-resolve.mjs'];
const HOOKS = [
  ['bin/hooks/session-start.mjs', { session_id: 'smoke', cwd: HOME, hook_event_name: 'SessionStart', source: 'startup' }],
  ['bin/hooks/session-end.mjs', { session_id: 'smoke', cwd: HOME, hook_event_name: 'SessionEnd', reason: 'other' }],
];

try {
  console.log(`node ${process.version}`);

  for (const cli of CLIS) {
    const r = await run(cli);
    if (r.code === 2 && /usage/i.test(r.err + r.out)) ok(`${cli} refuses an empty invocation with usage (exit 2)`);
    else bad(`${cli} exit ${r.code}, stderr: ${JSON.stringify(r.err.slice(0, 160))}`);
  }

  for (const [hook, payload] of HOOKS) {
    const r = await run(hook, { stdin: JSON.stringify(payload) });
    if (r.code === 0) ok(`${hook} accepts a payload and exits 0`);
    else bad(`${hook} exit ${r.code}, stderr: ${JSON.stringify(r.err.slice(0, 160))}`);
  }

  const r = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const msgs = r.out.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = msgs.find((m) => m.id === 1);
  const tools = msgs.find((m) => m.id === 2);
  if (init?.result?.serverInfo?.name) {
    ok(`bin/helix-mcp.mjs initializes as ${init.result.serverInfo.name} ${init.result.serverInfo.version ?? ''}`.trim());
  } else {
    bad(`bin/helix-mcp.mjs did not answer initialize (exit ${r.code}, stderr ${JSON.stringify(r.err.slice(0, 200))})`);
  }
  const n = tools?.result?.tools?.length ?? -1;
  if (n === 9) ok('bin/helix-mcp.mjs lists 9 tools');
  else bad(`bin/helix-mcp.mjs listed ${n} tools, expected 9`);
  if (r.code === 0) ok('bin/helix-mcp.mjs exits 0 when stdin closes');
  else bad(`bin/helix-mcp.mjs exit ${r.code}`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures.length === 0
  ? 'smoke-runtime-floor: all six shipped bundles run on this Node'
  : `smoke-runtime-floor: ${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
