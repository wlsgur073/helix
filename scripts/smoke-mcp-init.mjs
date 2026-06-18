// Config-independent liveness smoke: spawn the committed MCP server bundle,
// perform the JSON-RPC initialize handshake over stdio (newline-delimited),
// and assert it lists its tools. Exits 0 on success, 1 on failure.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'bin', 'helix-mcp.mjs');

const child = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let stderr = '';
const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  pending.set(id, method);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

child.stderr.on('data', (d) => { stderr += d.toString(); });

const results = {};
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      results[pending.get(msg.id)] = msg;
      pending.delete(msg.id);
    }
  }
});

function fail(why) {
  console.error('SMOKE FAIL:', why);
  if (stderr) console.error('--- server stderr ---\n' + stderr.trim());
  try { child.kill(); } catch {}
  process.exit(1);
}

const timer = setTimeout(() => fail('timeout waiting for responses'), 8000);

send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.0' },
});

const poll = setInterval(() => {
  if (results.initialize && !results['tools/list']) {
    notify('notifications/initialized', {});
    send('tools/list', {});
  }
  if (results['tools/list']) {
    clearInterval(poll);
    clearTimeout(timer);
    const init = results.initialize;
    const tools = results['tools/list']?.result?.tools ?? [];
    if (init.error) fail('initialize returned error: ' + JSON.stringify(init.error));
    console.log('initialize OK — server:', JSON.stringify(init.result?.serverInfo ?? {}));
    console.log('tools/list OK — count:', tools.length);
    console.log('tools:', tools.map((t) => t.name).join(', '));
    try { child.kill(); } catch {}
    process.exit(tools.length > 0 ? 0 : 1);
  }
}, 100);
