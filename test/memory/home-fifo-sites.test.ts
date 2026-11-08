// B2a task A8 (J2, P3): every home file Helix opens answers a FIFO inside a deadline, and a regular file still works.
// A site that still opens with a plain open(2) blocks a synchronous call that no vitest timeout can interrupt, so each
// case runs in a child (test/helpers/home-open-child.ts, bundled with the pinned esbuild and run as plain node) that
// the test kills at DEADLINE_MS. A hung site therefore fails its case with a timeout message instead of freezing the run.
// Every child and hook runs with a working directory outside the repository and with every HELIX_* variable removed.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleCli } from '../helpers/bundle-cli.js';

const DEADLINE_MS = 3_000;
const CHILD = join(process.cwd(), 'test/helpers/home-open-child.ts');
const SESSION_END = join(process.cwd(), 'src/hooks/session-end.ts');
const posixOnly = describe.skipIf(process.platform === 'win32');

const tmp = (label: string): string => mkdtempSync(join(tmpdir(), `helix-${label}-`));
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HELIX_')) env[k] = v;
  return { ...env, ...extra };
};

/** The precondition of every FIFO case: the name really is a FIFO. */
function mkfifo(p: string): string {
  execFileSync('mkfifo', [p]);
  expect(lstatSync(p).isFIFO(), 'fixture: the name is a FIFO').toBe(true);
  return p;
}

interface Answer { outcome: string; journal?: boolean }

function runSite(child: string, site: string, home: string, outside: string): Answer {
  const r = spawnSync(process.execPath, [child, site, home], {
    timeout: DEADLINE_MS, killSignal: 'SIGKILL', encoding: 'utf8', cwd: outside, env: cleanEnv(),
  });
  expect(r.error, `${site}: no answer within ${DEADLINE_MS} ms (the open blocked)`).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim()) as Answer;
}

const lineCount = (p: string): number => readFileSync(p, 'utf8').split('\n').filter((l) => l !== '').length;

interface Site {
  site: string;
  name: string;                    // the home file the site opens
  onFifo: string;                  // the outcome when a FIFO stands at the name
  pureRead?: boolean;              // the site must leave the home holding nothing but the FIFO
  control: { prepare?: (home: string) => void; outcome: string; lines?: boolean };   // the same site over a regular or absent file
}

const SITES: Site[] = [
  { site: 'key', name: 'ledger-mac-master.key', onFifo: 'not-regular', pureRead: true,
    control: { prepare: (h) => writeFileSync(join(h, 'ledger-mac-master.key'), Buffer.alloc(32, 7), { mode: 0o600 }), outcome: 'ok' } },
  { site: 'registry', name: 'projects.json', onFifo: 'null', pureRead: true, control: { outcome: 'nonce' } },
  { site: 'metrics', name: 'metrics.jsonl', onFifo: 'ok', control: { outcome: 'ok', lines: true } },
  { site: 'audit', name: 'audit.jsonl', onFifo: 'not-regular', control: { outcome: 'ok', lines: true } },
  { site: 'codex-log', name: 'codex-log.jsonl', onFifo: 'ok', control: { outcome: 'ok', lines: true } },
  { site: 'codex-status', name: 'codex-log.jsonl', onFifo: 'entries=0', pureRead: true,
    control: { prepare: (h) => writeFileSync(join(h, 'codex-log.jsonl'), '{"a":1}\n{"a":2}\n'), outcome: 'entries=2' } },
  { site: 'witness-log', name: 'witness-log.jsonl', onFifo: 'not-regular', control: { outcome: 'ok', lines: true } },
  // Disposition 6: the same file through the erase and recall handlers. The control proves the fixture really compacts.
  { site: 'erase-compact', name: 'witness-log.jsonl', onFifo: 'served compaction=failed ledger=unchanged',
    control: { outcome: 'served compaction=ok ledger=rewritten' } },
];

posixOnly('a FIFO at a home file is answered inside the deadline (J2, P3)', () => {
  for (const s of SITES) {
    it(`${s.site}: a FIFO at ${s.name} is skipped or refused, the FIFO stays`, async () => {
      const child = await bundleCli(CHILD);
      const home = tmp('hfifo');
      const outside = tmp('hout');
      try {
        const fifo = mkfifo(join(home, s.name));
        const answer = runSite(child, s.site, home, outside);
        expect(answer.outcome).toBe(s.onFifo);
        if (s.site === 'witness-log' || s.site === 'erase-compact') expect(answer.journal, 'no journal is written when the log line cannot be').toBe(false);
        expect(lstatSync(fifo).isFIFO(), 'the object at the name is still the FIFO').toBe(true);
        if (s.pureRead) expect(readdirSync(home), 'a read leaves nothing else behind').toEqual([s.name]);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }, 30_000);

    it(`${s.site}: the same site over a regular or absent ${s.name} still does its work`, async () => {
      const child = await bundleCli(CHILD);
      const home = tmp('hctl');
      const outside = tmp('hout');
      try {
        s.control.prepare?.(home);
        const answer = runSite(child, s.site, home, outside);
        expect(answer.outcome).toBe(s.control.outcome);
        if (s.control.lines) expect(lineCount(join(home, s.name)), 'exactly one line was appended').toBe(1);
        expect(lstatSync(join(home, s.name)).isFile()).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }, 30_000);
  }
});

posixOnly('SessionEnd: a FIFO at the sessions file does not stall the hook (J2, P3)', () => {
  const RECORD = JSON.stringify({ session_id: 's-a8', reason: 'clear' });

  function runHook(bundle: string, env: Record<string, string>, outside: string) {
    return spawnSync(process.execPath, [bundle], {
      input: RECORD, timeout: DEADLINE_MS, killSignal: 'SIGKILL', encoding: 'utf8', cwd: outside, env: cleanEnv(env),
    });
  }

  it('a FIFO at <home>/sessions.jsonl: exit 0 inside the deadline, nothing written, the FIFO stays', async () => {
    const hook = await bundleCli(SESSION_END);
    const home = tmp('hsess');
    const outside = tmp('hout');
    try {
      const fifo = mkfifo(join(home, 'sessions.jsonl'));
      const r = runHook(hook, { HELIX_HOME: home }, outside);
      expect(r.error, `no exit within ${DEADLINE_MS} ms (the append blocked)`).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(readdirSync(home)).toEqual(['sessions.jsonl']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it('a FIFO at HELIX_SESSIONS outside the home: exit 0 inside the deadline, the FIFO stays', async () => {
    const hook = await bundleCli(SESSION_END);
    const home = tmp('hsess');
    const elsewhere = tmp('hsel');
    const outside = tmp('hout');
    try {
      const fifo = mkfifo(join(elsewhere, 'sessions.jsonl'));
      const r = runHook(hook, { HELIX_HOME: home, HELIX_SESSIONS: fifo }, outside);
      expect(r.error, `no exit within ${DEADLINE_MS} ms (the append blocked)`).toBeUndefined();
      expect(r.status).toBe(0);
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(readdirSync(home), 'the home was not given a sessions file in its place').toEqual([]);
    } finally {
      for (const d of [home, elsewhere, outside]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it('control: an existing regular sessions file receives the record, its earlier line and its mode kept', async () => {
    const hook = await bundleCli(SESSION_END);
    const home = tmp('hsess');
    const outside = tmp('hout');
    try {
      const file = join(home, 'sessions.jsonl');
      writeFileSync(file, '{"earlier":true}\n');
      chmodSync(file, 0o644);
      const r = runHook(hook, { HELIX_HOME: home }, outside);
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('{"earlier":true}');
      expect(JSON.parse(lines[1]!)).toMatchObject({ kind: 'session-end', sessionId: 's-a8', reason: 'clear' });
      expect(statSync(file).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
