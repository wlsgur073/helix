import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bundleCli } from '../helpers/bundle-cli.js';

let cli: string;
beforeAll(async () => { cli = await bundleCli('scripts/pilot/prepare-gate.ts'); }, 30_000);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TX_AFTER = '2026-07-21T00:00:00.000Z';
const TX_CLOSE = '2026-08-18T00:00:00.000Z';

/** A complete, healthy input set on disk. Every file is written through here so a test can perturb
 *  exactly one of them and leave the pins describing the others correctly. */
const fixture = (perturb: (f: Record<string, unknown>) => void = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'prepgate-'));
  mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const row = (id: string) => JSON.stringify({
    id, tx: '2026-08-01T00:00:00.000Z', type: 'assert', content: `content ${id}`, supersedes: null });
  writeFileSync(join(dir, 'home', 'memory.jsonl'), row('m_g') + '\n');
  writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), row('m_a') + '\n' + row('m_b') + '\n');

  const probe = (t: string) => ({ id: `L_${t}`, query: `query ${t}`, relevant: [t], unambiguous: true, side: 'ledger' });
  const verdict = (t: string) => ({ id: `L_${t}`, status: 'not-in-class', targetId: t, targetScope: 'project', hit1Eligible: true });
  const files: Record<string, unknown> = {
    manifest: { k: 20, txAfter: TX_AFTER, txClose: TX_CLOSE, probes: [probe('m_a'), probe('m_b')] },
    classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', probes: [verdict('m_a'), verdict('m_b')] },
    universe: {
      rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json', recallBound: 3,
      disclosure: { rowsByScope: { global: 1, project: 2 }, projectDisposition: 'owned',
        integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
      probes: [{ id: 'L_m_a', candidates: ['project:m_a'] }, { id: 'L_m_b', candidates: ['project:m_b'] }],
    },
  };
  perturb(files);
  const paths: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    paths[name] = join(dir, `${name}.json`);
    writeFileSync(paths[name]!, JSON.stringify(body, null, 1) + '\n');
  }
  const h = (p: string) => sha256(readFileSync(p, 'utf8'));
  paths.pins = join(dir, 'pins.json');
  writeFileSync(paths.pins, JSON.stringify({
    k: 20, txAfter: TX_AFTER, txClose: TX_CLOSE,
    inputs: {
      manifest: h(paths.manifest!), classifier: h(paths.classifier!), universe: h(paths.universe!),
      'ledger:global': h(join(dir, 'home', 'memory.jsonl')),
      'ledger:project': h(join(dir, 'proj', '.helix', 'memory.jsonl')),
    },
  }, null, 1) + '\n');
  return { dir, paths, out: join(dir, 'gate-set.json') };
};

const status = (args: string[]): number => {
  try { execFileSync(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: 'pipe' }); return 0; }
  catch (e) { return (e as { status?: number }).status ?? -1; }
};

describe('prepare-gate CLI', () => {
  const args = (f: ReturnType<typeof fixture>) => [
    '--manifest', f.paths.manifest!, '--classifier', f.paths.classifier!, '--universe', f.paths.universe!,
    '--snapshot', f.dir, '--pins', f.paths.pins!, '--out', f.out];

  it('writes the prepared gate set with its payload hash', () => {
    const f = fixture();
    try {
      execFileSync(process.execPath, [cli, ...args(f)], { cwd: process.cwd(), stdio: 'pipe' });
      const g = JSON.parse(readFileSync(f.out, 'utf8'));
      expect(g.artifact).toBe('gate-set');
      expect(g.payload.eligible.probeIds).toEqual(['L_m_a', 'L_m_b']);
      expect(g.payload.eligible.label).toBe('EXERCISED — 2/2');
      expect(g.payload.stale.label).toBe('UNEXPOSED — no temporal evidence');
      expect(g.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      // The corpus is hashed as an input in its own right: §5's chain binds an as-of-close
      // snapshot hash, and the ledgers are as much what was measured as the manifest is.
      expect(Object.keys(g.payload.inputs).sort())
        .toEqual(['classifier', 'ledger:global', 'ledger:project', 'manifest', 'universe']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('REFUSES a runner-output flag instead of ignoring it', () => {
    // This is what makes outcome-blindness structural rather than a promise in a comment. An
    // ignored unknown flag would leave an operator believing results had been taken into account;
    // a refusal makes "this phase cannot see outcomes" a property of the interface.
    const f = fixture();
    try {
      expect(status([...args(f), '--results', join(f.dir, 'anything.json')])).toBe(2);
      expect(status([...args(f), '--bestRank', '1'])).toBe(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a missing or repeated input rather than defaulting one', () => {
    const f = fixture();
    try {
      expect(status(args(f).slice(2))).toBe(2);                       // no --manifest
      expect(status([...args(f), '--out', join(f.dir, 'other.json')])).toBe(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('hashes the bytes it actually read, so a file edited after pinning is refused', () => {
    // The pins are written from the real files, then one is rewritten. Nothing about the JSON is
    // invalid — only its bytes changed — so the pin check is the only thing standing between this
    // run and a gate set prepared from an input the freeze never saw.
    const f = fixture();
    try {
      const m = JSON.parse(readFileSync(f.paths.manifest!, 'utf8'));
      m.probes[1].unambiguous = false;
      writeFileSync(f.paths.manifest!, JSON.stringify(m, null, 1) + '\n');
      expect(status(args(f))).toBe(1);
      expect(() => execFileSync(process.execPath, [cli, ...args(f)], { cwd: process.cwd(), stdio: 'pipe' }))
        .toThrow(/input-hash-mismatch/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses a snapshot missing a scope rather than preparing from a narrower corpus', () => {
    const f = fixture();
    try {
      rmSync(join(f.dir, 'home', 'memory.jsonl'));
      expect(status(args(f))).not.toBe(0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
