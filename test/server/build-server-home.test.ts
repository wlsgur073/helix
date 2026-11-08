// Third fix batch B2a, task A3 (design 4.1): buildServer's no-deps fallback reads HELIX_HOME through resolveHelixPaths like
// every entry point: an empty value is unset (the default under the user home, not the working directory), a relative value is
// refused with the typed error.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../../src/memory/store.js';
import { buildServer } from '../../src/server/helix-server.js';
import { isHomeRefusalError } from '../../src/memory/home-env.js';

const saved = { cwd: process.cwd(), helixHome: process.env.HELIX_HOME, userHome: process.env.HOME };
let made: string[] = [];
afterEach(() => {
  process.chdir(saved.cwd);
  if (saved.helixHome === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = saved.helixHome;
  if (saved.userHome === undefined) delete process.env.HOME; else process.env.HOME = saved.userHome;
  for (const d of made) rmSync(d, { recursive: true, force: true });
  made = [];
});

function layout(): { base: string; storeHome: string; proj: string; userHome: string; store: MemoryStore } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a3f-')));
  made.push(base);
  const l = { base, storeHome: join(base, 'sh'), proj: join(base, 'proj'), userHome: join(base, 'uh') };
  for (const d of [l.storeHome, l.proj, l.userHome]) mkdirSync(d);
  const store = new MemoryStore(join(l.storeHome, 'm.jsonl'), { home: l.storeHome, sessionId: 's1' });
  return { ...l, store };
}

describe("buildServer's no-deps fallback resolves HELIX_HOME like the server entry (A3)", () => {
  it.each([
    ['control: HELIX_HOME unset', undefined],
    ['HELIX_HOME empty', ''],
  ] as Array<[string, string | undefined]>)('%s: the audit row lands under <user home>/.helix, not in the working directory', async (_name, value) => {
    const l = layout();
    if (value === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = value;
    process.env.HOME = l.userHome;
    process.chdir(l.proj);
    const server = buildServer(l.store);                       // NO deps: the branch under test
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'a3f', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    await client.callTool({ name: 'helix_dual_verify', arguments: { question: 'q', helixAnswer: 'a', stakes: 'low' } });
    expect(existsSync(join(l.userHome, '.helix', 'audit.jsonl'))).toBe(true);
    expect(existsSync(join(l.proj, 'audit.jsonl')), 'the working directory stood in for the home').toBe(false);
    expect(existsSync(join(l.storeHome, 'audit.jsonl')), 'the store home is not the fallback home').toBe(false);
  }, 30_000);

  it('a relative HELIX_HOME makes buildServer throw the typed home refusal', () => {
    const l = layout();
    process.env.HELIX_HOME = 'rel/home';
    process.env.HOME = l.userHome;
    process.chdir(l.proj);
    let thrown: unknown;
    try { buildServer(l.store); } catch (e) { thrown = e; }
    expect(isHomeRefusalError(thrown)).toBe(true);
    expect((thrown as { homeRefusalCause?: string }).homeRefusalCause).toBe('relative-value');
    expect(existsSync(join(l.proj, 'rel')), 'nothing was created at the relative name').toBe(false);
  });
});
