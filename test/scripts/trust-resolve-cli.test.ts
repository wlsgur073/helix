// C1.4-③ TTY resolve ceremony CLI. Verifies the orchestration the thin wrapper adds over the
// already-tested ownership.resolveTrust: argument parsing, the TTY gate, the not-pending refusal,
// the typed confirmation, and that a confirmed run actually flips the scope to active.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/trust-resolve-cli.js';
import { MemoryStore } from '../../src/memory/store.js';
import { trustStateOf } from '../../src/memory/ownership.js';

function pendingScope() {
  const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'helix-proj-'));
  const at = (s: string) => new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: s, project: { root: proj, ledger: join(proj, '.helix', 'memory.jsonl') } });
  const s1 = at('s1'); s1.adopt(proj);
  const rec = s1.commit({ content: 'the db is postgres', source: 'user', scope: 'project' });
  s1.confirm(rec.id);
  unlinkSync(join(proj, '.helix', '.owner'));
  at('s2').adopt(proj); // -> pending
  return { home, proj, id: rec.id };
}
const deps = (home: string, over: Record<string, unknown> = {}) => ({
  env: { HELIX_HOME: home } as NodeJS.ProcessEnv,
  isTTY: true,
  exit: () => {},
  ...over,
});

describe('trust-resolve-cli', () => {
  it('bad usage exits 2 without touching anything', async () => {
    const { home } = pendingScope();
    expect(await main(['--scope'], deps(home))).toBe(2);
    expect(await main(['--scope', 'relative/path', '--repair'], deps(home))).toBe(2);
    expect(await main(['--scope', '/x', '--repair', '--fresh'], deps(home))).toBe(2);
  });

  it('a non-interactive shell is refused (exit 2)', async () => {
    const { home, proj } = pendingScope();
    expect(await main(['--scope', proj, '--repair'], deps(home, { isTTY: false }))).toBe(2);
  });

  it('a scope that is not pending is refused (exit 2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'helix-proj-'));
    new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's', project: { root: proj, ledger: join(proj, '.helix', 'memory.jsonl') } }).adopt(proj);
    expect(await main(['--scope', proj, '--repair'], deps(home, { promptLine: async () => 'repair' }))).toBe(2);
  });

  it('a declined confirmation changes nothing (exit 1)', async () => {
    const { home, proj } = pendingScope();
    const code = await main(['--scope', proj, '--repair'], deps(home, { promptLine: async () => 'no' }));
    expect(code).toBe(1);
    expect(trustStateOf(proj, home)).toBe('pending'); // unchanged
  });

  it('repair, confirmed, flips the scope to active and restores Verified', async () => {
    const { home, proj, id } = pendingScope();
    const code = await main(['--scope', proj, '--repair'], deps(home, { promptLine: async () => 'repair' }));
    expect(code).toBe(0);
    expect(trustStateOf(proj, home)).toBe('active');
    const at = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's3', project: { root: proj, ledger: join(proj, '.helix', 'memory.jsonl') } });
    expect(at.inspect().find((x) => x.record.id === id)?.record.state).toBe('Verified');
  });

  it('fresh, confirmed, flips to active and keeps the old row Fresh', async () => {
    const { home, proj, id } = pendingScope();
    const code = await main(['--scope', proj, '--fresh'], deps(home, { promptLine: async () => 'fresh' }));
    expect(code).toBe(0);
    expect(trustStateOf(proj, home)).toBe('active');
    const at = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's3', project: { root: proj, ledger: join(proj, '.helix', 'memory.jsonl') } });
    expect(at.inspect().find((x) => x.record.id === id)?.record.state).toBe('Fresh');
  });

  it.each([
    ['a pending scope whose memory file links out of the project', (ledger: string): void => {
      const outside = join(mkdtempSync(join(tmpdir(), 'helix-outside-')), 'o.jsonl');
      writeFileSync(outside, '');
      symlinkSync(outside, ledger);
    }],
    ['a pending scope whose memory file cannot be resolved (R-2: it used to show 0 rows and go on)', (ledger: string): void => {
      symlinkSync(Buffer.from([0xff]), ledger);
    }],
  ])('%s is refused (exit 2), still pending', async (_label, swap) => {
    const { home, proj } = pendingScope();
    const ledger = join(proj, '.helix', 'memory.jsonl');
    unlinkSync(ledger);
    swap(ledger);
    let err = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += chunk.toString(); return true; });
    try {
      const code = await main(['--scope', proj, '--repair'], deps(home, { promptLine: async () => { throw new Error('prompted'); } }));
      expect(code).toBe(2);
    } finally { spy.mockRestore(); }
    expect(err).toContain('REFUSING');
    expect(err).toContain("this project's memory file resolves outside this project");
    expect(trustStateOf(proj, home)).toBe('pending');
  });

  it('the global ledger follows HELIX_LEDGER (design 4.10): a memory file that links to it is refused', async () => {
    const { home, proj } = pendingScope();
    const g = join(proj, 'data', 'g.jsonl');
    mkdirSync(join(proj, 'data'));
    writeFileSync(g, '');
    const ledger = join(proj, '.helix', 'memory.jsonl');
    unlinkSync(ledger);
    symlinkSync(g, ledger);
    const code = await main(['--scope', proj, '--repair'], deps(home, {
      env: { HELIX_HOME: home, HELIX_LEDGER: g } as NodeJS.ProcessEnv,
      promptLine: async () => { throw new Error('prompted'); },
    }));
    expect(code).toBe(2);
    expect(trustStateOf(proj, home)).toBe('pending');
  });
});
