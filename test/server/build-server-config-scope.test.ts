// F3.c — buildServer's no-deps fallback is a SECOND, independent config reader.
//
// The finding was that a cloned repo's `<cwd>/.helix/config.json` could override global dual-verify
// settings. index.ts was fixed by passing only `globalPath`, and that site is covered. This one is
// not the same site: `buildServer(store)` called WITHOUT deps builds its own DualVerifyHandlerDeps
// and resolves config itself. index.ts always passes explicit deps, so this branch is the one a
// future non-index caller would take — and nothing measured it.
//
// The observable is the audit row rather than the internal deps object: handleDualVerify records
// `enabled: deps.config.dualVerify.enabled` on every call, and the audit path is derived from
// HELIX_HOME by the same fallback, so the whole thing stays inside the temp home. A disabled
// dual-verify returns without spawning, so this never reaches the real codex CLI.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';

const savedCwd = process.cwd();
const savedHome = process.env.HELIX_HOME;
afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = savedHome;
});

/** Build a no-deps server under a temp home + temp cwd, call dual-verify once, and read back the
 *  `enabled` the fallback actually resolved.
 *
 *  Every enabling config also sets `stakesFloor: 'xhigh'`, and the call always passes `stakes: 'low'`.
 *  dualVerify then refuses at the floor gate — before the egress guard and before any spawn — so an
 *  ENABLED config is observable without the test ever reaching the real Codex CLI. Enabling without
 *  that floor made the first draft of this file sit for 30 s and time out, which is how the
 *  interaction was found.
 */
type Cfg = { enabled: boolean } | undefined;
const withFloor = (c: Cfg): unknown => (c === undefined ? undefined : { dualVerify: { ...c, stakesFloor: 'xhigh' } });

async function resolvedEnabled(globalCfg: Cfg, projectCfg: Cfg): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), 'helix-f3c-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'helix-f3c-proj-'));
  const g = withFloor(globalCfg);
  const p = withFloor(projectCfg);
  if (g !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify(g));
  if (p !== undefined) {
    mkdirSync(join(proj, '.helix'), { recursive: true });
    writeFileSync(join(proj, '.helix', 'config.json'), JSON.stringify(p));
  }

  process.env.HELIX_HOME = home;
  process.chdir(proj);

  const store = new MemoryStore(join(home, 'm.jsonl'), { home, sessionId: 's1' });
  const server = buildServer(store);                       // NO deps — the branch under test
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'f3c', version: '0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  await client.callTool({ name: 'helix_dual_verify', arguments: { question: 'q', helixAnswer: 'a', stakes: 'low' } });

  const rows = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; enabled?: boolean; spawned?: boolean });
  const row = rows.find((r) => r.kind === 'dual-verify');
  expect(row, 'no dual-verify audit row was written, so nothing was observed').toBeDefined();
  expect(row!.spawned, 'the floor gate should have refused before any spawn').toBe(false);
  return row!.enabled!;
}

describe("buildServer's no-deps fallback resolves config global-only (F3.c)", () => {
  // Non-vacuity first: the observable has to move at all, or the negative case below proves nothing.
  it('reads the GLOBAL config under HELIX_HOME', async () => {
    expect(await resolvedEnabled({ enabled: true }, undefined)).toBe(true);
    expect(await resolvedEnabled({ enabled: false }, undefined)).toBe(false);
  }, 30_000);

  it('ignores <cwd>/.helix/config.json, even when it is the only file that sets the flag', async () => {
    // The project file says true and there is no global file at all. If the fallback grew a
    // projectPath, this would come back true — which is the finding, in the one branch index.ts's
    // fix does not cover.
    expect(await resolvedEnabled(undefined, { enabled: true })).toBe(false);
  }, 30_000);

  it('lets the global config win over a project file that disagrees', async () => {
    expect(await resolvedEnabled({ enabled: false }, { enabled: true })).toBe(false);
  }, 30_000);
});
