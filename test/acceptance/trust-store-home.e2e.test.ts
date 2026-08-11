// Acceptance: the trust store follows HELIX_HOME, never the ledger's directory.
//
// SECURITY.md's promise is that the ledger-MAC master key lives only under the user's home and is
// never written into a repo ledger. HELIX_LEDGER is documented as pointing "the memory ledger"
// elsewhere — a DATA-file knob. But the store derived its home as `opts.home ?? dirname(global)`,
// and the server passed no top-level `home`, so repointing HELIX_LEDGER silently relocated the
// signing key, the ownership registry and the rollback witness alongside it. Point it into a
// git-tracked tree and commit, and anyone with the repo can mint valid MACs while the witness —
// whose whole premise is living on the trusted side of the boundary — sits on the untrusted side.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryStore } from '../../src/memory/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(root, 'bin', 'helix-mcp.mjs');

/**
 * Cases below that drive the SHIPPED BUNDLE for behaviour added after the frozen candidate cannot
 * pass while the v2 pilot window is open, because the window forbids rebuilding `bin/` — the
 * marketplace clone fast-forwards uncontrollably, so a rebuilt bundle reaches the running runtime.
 * They are skipped for the duration and run again by themselves once it closes.
 *
 * This suspends BUNDLE-level re-verification only. The behaviour itself stays under test the whole
 * time: `test/memory/trust-store-layout.test.ts` carries the source-level cases, including the
 * five plantable startup-DoS states and the reverse-direction lock that keeps the tightened
 * predicates from blinding the detector to the genuine article. Nothing here is the only guard for
 * anything.
 *
 * The instant comes from the signed receipt's own payload rather than a literal, exactly as the
 * private-path allowlist expiry does, so it cannot drift from the governance record — and the fix
 * when it fires is to rebuild `bin/`, never to move the date.
 */
function frozenBundleWindowOpen(): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(root, 'docs/release/v2-freeze-receipt-2026-08.json'), 'utf8')) as
      { payload: { txClose: string } };
    return Date.now() <= Date.parse(receipt.payload.txClose);
  } catch { return false; }   // no receipt => no freeze => run everything
}
const itUnlessFrozenBundle = frozenBundleWindowOpen() ? it.skip : it;

// Strip every HELIX_* so a developer's exported vars cannot reach these processes; the test sets
// exactly the two it is about.
const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('HELIX_')),
  ) as Record<string, string>;

/** A split layout: HELIX_HOME and the HELIX_LEDGER directory are different places. */
function splitLayout(): { home: string; ledgerDir: string; ledger: string } {
  const base = mkdtempSync(join(tmpdir(), 'helix-split-'));
  const home = join(base, 'dot-helix');
  const ledgerDir = join(base, 'a-git-repo');
  mkdirSync(home);
  mkdirSync(ledgerDir);
  return { home, ledgerDir, ledger: join(ledgerDir, 'memory.jsonl') };
}

let open: Client[] = [];
afterEach(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  open = [];
});

async function connect(home: string, ledger: string, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd,
    env: { ...cleanEnv(), HELIX_HOME: home, HELIX_LEDGER: ledger },
  });
  const client = new Client({ name: 'helix-trust-store-acceptance', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

/** Spawn the bundle directly and report how it exited — for the cases where it must REFUSE. */
function startAndWait(home: string, ledger: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { cwd, env: { ...cleanEnv(), HELIX_HOME: home, HELIX_LEDGER: ledger } });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    // The server reads MCP framing from stdin; closing it lets a healthy server shut down cleanly
    // instead of hanging this test, while a refusing server has already exited.
    child.stdin.end();
  });
}

const TRUST_FILES = ['ledger-mac-master.key', 'projects.json', 'witness.json'];

describe('trust store location vs HELIX_LEDGER', () => {
  it('mints the signing key under HELIX_HOME, never beside a relocated ledger', async () => {
    const { home, ledgerDir, ledger } = splitLayout();
    const client = await connect(home, ledger, home);
    await client.callTool({ name: 'helix_memory_commit', arguments: { content: 'staging uses port five four three three', source: 'user' } });
    await client.close();

    // The ledger itself SHOULD be where HELIX_LEDGER points — that is the knob's documented job.
    expect(existsSync(ledger), 'the ledger should follow HELIX_LEDGER').toBe(true);
    // The trust store should not have followed it.
    const strayed = TRUST_FILES.filter((f) => existsSync(join(ledgerDir, f)));
    expect(strayed, `trust files were written beside the ledger: ${readdirSync(ledgerDir).join(', ')}`).toEqual([]);
    expect(existsSync(join(home, 'ledger-mac-master.key')), 'the master key belongs under HELIX_HOME').toBe(true);
  }, 30_000);

  it('refuses to start when a previous run left an ELEVATED grade beside the ledger', async () => {
    const { home, ledgerDir, ledger } = splitLayout();
    // Exactly what the old behaviour produced: home derived from the LEDGER's own directory, so a
    // commit+confirm there mints its own key and signs a genuine `verify` under it -- a real elevated
    // grade, not just a bare key file. Silently pinning HOME now (which has no key of its own yet)
    // would mint a SECOND, unrelated key and read this ledger through it: the confirm never
    // validates, so the grade the user took the trouble to earn silently vanishes on replay (F1B's
    // path a). This state has to be reported, not stepped over.
    let n = 0;
    const old = new MemoryStore(ledger, { home: ledgerDir, sessionId: 'old', genId: () => `m_${++n}` });
    const rec = old.commit({ content: 'a fact the user took the trouble to confirm', source: 'user' });
    old.confirm(rec.id);
    expect(old.inspect().map((r) => r.record.state)).toContain('Verified'); // fixture sanity

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'the server should refuse to start on a split trust store with a real grade at risk').not.toBe(0);
    expect(stderr).toContain('REFUSING TO START');
    expect(stderr).toMatch(/ledger-mac-master\.key/);
    expect(stderr, 'the operator needs both directories named to act on this').toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  itUnlessFrozenBundle('warns but does NOT refuse when the stray key is byte-identical to HELIX_HOME\'s own and nothing is at risk (F1B-DETECTOR-DOS)', async () => {
    // The stray key is the SAME key as HOME's and the ledger carries nothing elevated -- a genuine,
    // inert leftover with nothing whatsoever to lose. Blocking startup forever over it would itself
    // be the startup denial of service the detector must not become
    // (docs/issues/repros/f1-detector-startup-dos.ts).
    const { home, ledgerDir, ledger } = splitLayout();
    const key = randomBytes(32);
    writeFileSync(join(home, 'ledger-mac-master.key'), key, { mode: 0o600 });
    writeFileSync(join(ledgerDir, 'ledger-mac-master.key'), key, { mode: 0o600 });
    writeFileSync(ledger, '');

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'a HELIX_HOME whose key matches the stray leftover, with nothing at risk, must not be blocked').toBe(0);
    expect(stderr).not.toContain('REFUSING TO START');
    expect(stderr).toMatch(/NOTE/);
    expect(stderr).toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  it('(A) refuses when a normal-use HOME later meets a second, pre-pin-style store beside a relocated ledger', async () => {
    // The Critical round 2 closes: it is not enough for HOME to merely HAVE a key (round 1's
    // presence proxy) or for the keys to differ (round 1's identity proxy) -- the refusal must be
    // grounded in an actual grade at risk. Here HOME has its OWN real, prior, normal usage (its own
    // key, its own witness history, from ITS OWN earlier ledger) before the user ever sets
    // HELIX_LEDGER on a pre-pin version that builds a second store beside a DIFFERENT, relocated
    // ledger. Reading that second ledger under HOME's (unrelated) key must still refuse.
    const { home, ledgerDir, ledger } = splitLayout();
    let n = 0;
    const homeLedger = join(home, 'memory.jsonl');
    const normalUse = new MemoryStore(homeLedger, { home, sessionId: 'normal', genId: () => `h_${++n}` });
    const homeRec = normalUse.commit({ content: 'normal use establishes HOME\'s own trust state', source: 'user' });
    normalUse.confirm(homeRec.id);

    const old = new MemoryStore(ledger, { home: ledgerDir, sessionId: 'old', genId: () => `m_${++n}` });
    const rec = old.commit({ content: 'a fact the user took the trouble to confirm', source: 'user' });
    old.confirm(rec.id);
    expect(old.inspect().map((r) => r.record.state)).toContain('Verified'); // fixture sanity

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(code, 'a real grade behind a relocated second store must still refuse, even with HOME already established').not.toBe(0);
    expect(stderr).toContain('REFUSING TO START');
    expect(stderr).toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  itUnlessFrozenBundle('(C) refuses with its remedies, rather than crashing, when HELIX_HOME\'s own master key is corrupt', async () => {
    // Deliberately routed through the SPAWNED SERVER and asserted on its observable contract (exit
    // 78 + the two documented remedies), naming no decider function on purpose. This exact defect --
    // a wrong-sized HOME key throwing LedgerMacError instead of deciding -- was closed once in round
    // 1 and silently REOPENED in round 2, because the test guarding it pinned compareStrayMasterKey,
    // which was retained but stopped being the gate. A test that names the decider dies quietly when
    // the decider moves; this one has to keep passing through whatever decides next, or break loudly.
    const { home, ledgerDir, ledger } = splitLayout();
    writeFileSync(join(home, 'ledger-mac-master.key'), 'x', { mode: 0o600 });          // 1 byte, want 32
    writeFileSync(join(ledgerDir, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(ledger, '');

    const { code, stderr } = await startAndWait(home, ledger, home);
    expect(stderr, 'an unreadable HOME trust store must not surface as a stack trace').not.toContain('LedgerMacError');
    expect(code, 'refusal is EX_CONFIG(78), not an uncaught-exception exit').toBe(78);
    expect(stderr).toContain('REFUSING TO START');
    expect(stderr, 'the operator must be told the key itself is the problem').toMatch(/corrupt master key|could not be read/i);
    expect(stderr, 'the remedies are the whole point of exiting 78 instead of crashing').toContain('helix-rebaseline.mjs');
    expect(stderr).toContain(ledgerDir);
    expect(stderr).toContain(home);
  }, 30_000);

  const shapeValidPlant: Record<string, () => string | Buffer> = {
    'witness.json': () => JSON.stringify({ v: 1, scopes: {} }),
    'projects.json': () => JSON.stringify({ '/some/project': { stamp: 'x', adoptedAt: '2026-01-01T00:00:00.000Z', macNonce: 'n' } }),
    'witness-log.jsonl': () => '{"v":1}\n',
  };
  for (const [name, content] of Object.entries(shapeValidPlant)) {
    itUnlessFrozenBundle(`(B) starts when a healthy install meets ONE adversary-planted ${name} beside the ledger`, async () => {
      // The DoS round 2 reopened: a HEALTHY install (HOME has its own key already) refused the
      // instant an adversary planted a single shape-valid stray file with no master key alongside it
      // -- there was no stray key to compare against, so the identity proxy fell back to refuse.
      // Nothing here is actually at risk: the planted file never touches the ledger's own bytes or
      // HOME's own key/witness, so the ledger the server actually reads carries nothing elevated (in
      // fact nothing at all) and nothing HOME's witness would call a mismatch. Must start.
      const { home, ledgerDir, ledger } = splitLayout();
      writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
      writeFileSync(join(ledgerDir, name), content(), { mode: 0o600 });

      const { code, stderr } = await startAndWait(home, ledger, home);
      expect(code, `a healthy install must not refuse over a lone stray ${name}`).toBe(0);
      expect(stderr).not.toContain('REFUSING TO START');
      expect(stderr).toMatch(/NOTE/);
      expect(stderr).toContain(ledgerDir);
      expect(stderr).toContain(home);
    }, 30_000);
  }
});
