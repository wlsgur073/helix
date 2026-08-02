import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  expansionTableSha256, hashPinnedInputs, sha256Bytes, sha256BytesOrAbsent, sha256Hex,
} from '../../scripts/pilot/pin-hashes.js';
import { isInvocationError } from '../../scripts/pilot/artifact-io.js';
import { defaultExpansion, loadExpansion, EXP_THETA, EXP_K } from '../../src/memory/expansion.js';
import type { Expansion, ExpansionEntry } from '../../src/memory/retrieval.js';

/** The TEN pinned inputs and their hashing discipline. The five text inputs keep the utf8 decode
 *  `prepare-gate` reproduces; the four trust files are pinned by RAW BYTES with the literal
 *  sentinel 'absent' when the file does not exist; the expansion table is pinned by a
 *  deterministic content hash of the RESOLVED table, because what recall actually ranks with is
 *  the parsed table, not whichever asset file happened to parse into it. */

const table = (entries: [string, ExpansionEntry[]][]): Expansion => new Map(entries);

describe('expansionTableSha256', () => {
  const base: [string, ExpansionEntry[]][] = [
    ['failure', [{ token: 'error', w: 0.525 }, { token: 'crash', w: 0.51 }]],
    ['deploy', [{ token: 'release', w: 0.6 }]],
  ];

  it('hashes identical content identically regardless of Map insertion order', () => {
    const forward = table(base);
    const backward = table([...base].reverse());
    expect(expansionTableSha256(forward)).toBe(expansionTableSha256(backward));
  });

  it('hashes identical content identically regardless of neighbor-list order (every level sorted)', () => {
    const a = table([['failure', [{ token: 'error', w: 0.525 }, { token: 'crash', w: 0.51 }]]]);
    const b = table([['failure', [{ token: 'crash', w: 0.51 }, { token: 'error', w: 0.525 }]]]);
    expect(expansionTableSha256(a)).toBe(expansionTableSha256(b));
  });

  it('changes when a weight, a neighbor, or a token changes', () => {
    const h = expansionTableSha256(table(base));
    expect(expansionTableSha256(table([['failure', [{ token: 'error', w: 0.526 }, { token: 'crash', w: 0.51 }]],
      ['deploy', [{ token: 'release', w: 0.6 }]]]))).not.toBe(h);
    expect(expansionTableSha256(table([['failure', [{ token: 'fault', w: 0.525 }, { token: 'crash', w: 0.51 }]],
      ['deploy', [{ token: 'release', w: 0.6 }]]]))).not.toBe(h);
    expect(expansionTableSha256(table([['failures', [{ token: 'error', w: 0.525 }, { token: 'crash', w: 0.51 }]],
      ['deploy', [{ token: 'release', w: 0.6 }]]]))).not.toBe(h);
  });

  it('hashes the EMPTY table differently from any non-empty one — the round-3 finding', () => {
    // Round 3 proved that swapping the asset for `{"neighbors":{}}` passes every existing check
    // and silently removes all query expansion. The empty RESOLVED table must therefore pin to a
    // value no healthy table can produce.
    const empty = loadExpansion('{"neighbors":{}}', EXP_THETA, EXP_K);
    expect(empty.size).toBe(0);
    expect(expansionTableSha256(empty)).toMatch(/^[0-9a-f]{64}$/);
    expect(expansionTableSha256(empty)).not.toBe(expansionTableSha256(table(base)));
    const real = defaultExpansion();
    expect(real, 'the repo asset must resolve under vitest').toBeDefined();
    expect(expansionTableSha256(empty)).not.toBe(expansionTableSha256(real!));
  });

  it('is stable across two independent resolutions of the same asset', () => {
    const text = readFileSync(join(process.cwd(), 'data', 'semantic-neighbors.json'), 'utf8');
    const once = loadExpansion(text, EXP_THETA, EXP_K);
    const twice = loadExpansion(text, EXP_THETA, EXP_K);
    expect(expansionTableSha256(once)).toBe(expansionTableSha256(twice));
    expect(expansionTableSha256(once)).toBe(expansionTableSha256(defaultExpansion()!));
  });
});

describe('sha256BytesOrAbsent', () => {
  it('pins a present file by its RAW BYTES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinabsent-'));
    try {
      // Two byte sequences a utf8 decode collapses into the same string: the raw-bytes hash is
      // what keeps them distinct, which is the whole reason these pins do not decode first.
      const a = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
      const b = Buffer.from([0x7b, 0x22, 0xfe, 0x22, 0x7d]);
      writeFileSync(join(dir, 'a.bin'), a);
      writeFileSync(join(dir, 'b.bin'), b);
      expect(sha256BytesOrAbsent('--snapshot', join(dir, 'a.bin')))
        .toBe(createHash('sha256').update(a).digest('hex'));
      expect(sha256BytesOrAbsent('--snapshot', join(dir, 'a.bin')))
        .not.toBe(sha256BytesOrAbsent('--snapshot', join(dir, 'b.bin')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('pins an ABSENT file as the literal string absent, so present-vs-absent is itself pinned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinabsent-'));
    try {
      expect(sha256BytesOrAbsent('--snapshot', join(dir, 'no-such-file'))).toBe('absent');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats any NON-ENOENT read failure as an invocation error, never as absent', () => {
    // 'absent' is a statement about the snapshot — "this deployment has no witness journal" — and
    // a directory sitting at the path, or an unreadable file, is not that statement. Collapsing
    // them would pin a broken snapshot as a legitimately keyless one.
    const dir = mkdtempSync(join(tmpdir(), 'pinabsent-'));
    try {
      mkdirSync(join(dir, 'a-directory'));
      let thrown: unknown;
      try { sha256BytesOrAbsent('--snapshot', join(dir, 'a-directory')); }
      catch (e) { thrown = e; }
      expect(thrown, 'a directory at the path must throw').toBeDefined();
      expect(isInvocationError(thrown)).toBe(true);
      expect(String((thrown as Error).message)).not.toBe('absent');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** A snapshot laid out the way `readSnapshot` and both close-time CLIs expect it. */
const snapshotFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinhash-'));
  mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'home', 'memory.jsonl'), '{"id":"m_g"}\n');
  writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), '{"id":"m_a"}\n');
  const paths = { manifest: join(dir, 'manifest.json'), classifier: join(dir, 'classifier.json'), universe: join(dir, 'universe.json') };
  for (const [name, p] of Object.entries(paths)) writeFileSync(p, `{"file":"${name}"}\n`);
  return { dir, paths };
};

const EXPANSION = table([['failure', [{ token: 'error', w: 0.525 }]]]);

describe('hashPinnedInputs — the ten-name pin surface', () => {
  it('names and hashes exactly the ten pinned inputs', () => {
    const f = snapshotFixture();
    try {
      const inputs = hashPinnedInputs(f.dir, f.paths, EXPANSION);
      expect(Object.keys(inputs).sort()).toEqual([
        'classifier', 'expansion:semantic-neighbors', 'ledger:global', 'ledger:project', 'manifest',
        'ownership:owner', 'ownership:registry', 'trust:master-key', 'trust:witness', 'universe',
      ]);
      // The five text inputs keep the utf8 decode `prepare-gate`'s main reproduces.
      const h = (p: string) => sha256Hex(readFileSync(p, 'utf8'));
      expect(inputs.manifest).toBe(h(f.paths.manifest));
      expect(inputs.classifier).toBe(h(f.paths.classifier));
      expect(inputs.universe).toBe(h(f.paths.universe));
      expect(inputs['ledger:global']).toBe(h(join(f.dir, 'home', 'memory.jsonl')));
      expect(inputs['ledger:project']).toBe(h(join(f.dir, 'proj', '.helix', 'memory.jsonl')));
      // None of the four trust files exists in this fixture, and that state is itself pinned.
      for (const name of ['ownership:registry', 'ownership:owner', 'trust:master-key', 'trust:witness']) {
        expect(inputs[name], name).toBe('absent');
      }
      expect(inputs['expansion:semantic-neighbors']).toBe(expansionTableSha256(EXPANSION));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('pins the four trust files by RAW BYTES from their exact snapshot locations', () => {
    // ownership:registry = home/projects.json; ownership:owner = the .owner stamp ownership.ts
    // writes under <projectRoot>/.helix; trust:master-key and trust:witness live beside the
    // registry in home. Round 3 proved a macNonce swap in projects.json flips a rank with every
    // then-current pin green, and a planted witness journal removes a whole scope — these pins are
    // what turn either substitution into a visible mismatch.
    const f = snapshotFixture();
    try {
      const files: [string, string][] = [
        ['ownership:registry', join(f.dir, 'home', 'projects.json')],
        ['ownership:owner', join(f.dir, 'proj', '.helix', '.owner')],
        ['trust:master-key', join(f.dir, 'home', 'ledger-mac-master.key')],
        ['trust:witness', join(f.dir, 'home', 'witness.json')],
      ];
      for (const [name, path] of files) writeFileSync(path, `bytes of ${name}`);
      const inputs = hashPinnedInputs(f.dir, f.paths, EXPANSION);
      for (const [name, path] of files) {
        expect(inputs[name], name).toBe(sha256Bytes(readFileSync(path)));
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
