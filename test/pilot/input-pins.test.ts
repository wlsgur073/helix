import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleCli } from '../helpers/bundle-cli.js';
import { FIXTURE_CUTOFF, freezeFixtureRepo } from '../helpers/freeze-fixture-repo.js';
import { inputPins } from '../../scripts/pilot/input-pins.js';
import {
  expansionTableSha256, hashMethodDocs, hashPinnedInputs, hashTools, sha256Bytes, sha256Hex,
} from '../../scripts/pilot/pin-hashes.js';
import { prepareGateSet } from '../../scripts/pilot/prepare-gate.js';
import { readSnapshot } from '../../scripts/pilot/snapshot.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import type { Manifest, ClassifierOutput, UniverseArtifact, Pins } from '../../scripts/pilot/gate-set.js';

let cli: string;
let freezeCli: string;
beforeAll(async () => {
  cli = await bundleCli('scripts/pilot/input-pins.ts');
  freezeCli = await bundleCli('scripts/pilot/freeze-receipt.ts');
}, 60_000);

const CUTOFF = '2026-07-21T00:00:00.000Z';
const CLOSE = '2026-08-18T00:00:00.000Z';
/** The frozen config's BYTES, and hashes derived from bytes — never the reverse, because a hash
 *  cannot be inverted into a fixture. The unit tests' `current` view is built from these same
 *  values, so freeze-time and close-time agree BY CONSTRUCTION and the drift tests perturb
 *  exactly one side. */
const CONFIG_BYTES = Buffer.from('{"dualVerify":{"mode":"compare"}}\n', 'utf8');
const FAKE_TOOLS = { 'scripts/pilot/derive.ts': 'd'.repeat(40) };
const FAKE_DOCS = { 'docs/release/o67-class-rule-2026-07.md': 'e'.repeat(64) };
const currentView = (): { tools: Record<string, string>; methodDocs: Record<string, string>;
  configBytesAt: (path: string) => Buffer } => ({
  tools: { ...FAKE_TOOLS },
  methodDocs: { ...FAKE_DOCS },
  configBytesAt: (_path: string) => CONFIG_BYTES,
});

/** A freeze receipt written the way the freeze CLI writes one: a deterministic payload, its
 *  sha256 beside it, and volatile receipts outside the hash. Built here rather than by calling
 *  `freezeReceipt` so that this file tests the CONSUMER against the shape on disk — the tamper
 *  cases below could not be expressed at all through the producer. */
const receiptFile = (over: Partial<Record<string, unknown>> = {}, tamper?: (p: Record<string, unknown>) => void) => {
  const payload: Record<string, unknown> = {
    rule: 'v2-gate-composition-2026-07-29',
    artifactKind: 'freeze-receipt',
    candidateCommit: 'a'.repeat(40),
    runtime: { gitCommitSha: 'b'.repeat(40), loadPaths: [{ path: '/cache/bin/helix-mcp.mjs', gitCommitSha: 'b'.repeat(40) }] },
    config: { path: '~/.helix/config.json', sha256: sha256Bytes(CONFIG_BYTES), redactionAcknowledged: true },
    k: 20,
    txAfter: CUTOFF,
    txClose: CLOSE,
    windowDays: 28,
    tools: { ...FAKE_TOOLS },
    methodDocs: { ...FAKE_DOCS },
    ...over,
  };
  const envelope: Record<string, unknown> = {
    artifact: 'freeze-receipt',
    payloadSha256: sha256Hex(JSON.stringify(payload)),
    payload,
    receipts: { issuedAt: '2026-08-01T09:00:00.000Z', attestation: 'self-reported wall clock' },
  };
  // Applied AFTER the hash is taken, which is the whole point: an edited payload beside its
  // original hash is exactly what `payloadSha256` exists to expose.
  if (tamper) tamper(payload);
  return JSON.stringify(envelope, null, 1) + '\n';
};

const manifestBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  k: 20, txAfter: CUTOFF, txClose: CLOSE, ...over,
  probes: [{ id: 'L_m_a', query: 'query m_a', relevant: ['m_a'], unambiguous: true, side: 'ledger' }],
}, null, 1) + '\n';

const fiveInputs = (manifestText: string) => ({
  manifest: sha256Hex(manifestText),
  classifier: 'f'.repeat(64),
  universe: '0'.repeat(64),
  'ledger:global': '1'.repeat(64),
  'ledger:project': '2'.repeat(64),
});

const call = (over: { freezeText?: string; manifestText?: string; inputs?: Record<string, string>;
  current?: ReturnType<typeof currentView> } = {}) => {
  const manifestText = over.manifestText ?? manifestBody();
  return inputPins({
    freezeText: over.freezeText ?? receiptFile(),
    manifestText,
    inputs: over.inputs ?? fiveInputs(manifestText),
    current: over.current ?? currentView(),
  });
};

describe('inputPins — what it copies and what it derives', () => {
  /** §9 orders the freeze receipt FIRST and the manifest, universe and classifier three steps
   *  later, so the close-time input hashes cannot exist at the freeze instant. They are a
   *  separate artifact for that reason. What must not be separate is the METHOD: `k` and the
   *  window bounds are copied out of the receipt, never re-supplied, because a value typed twice
   *  can disagree and a value copied cannot. */
  it('COPIES k and the window from the freeze receipt and emits exactly the pins shape', () => {
    const { pins, bytes } = call();
    expect(Object.keys(pins)).toEqual(['k', 'txAfter', 'txClose', 'inputs', 'freezeSha256', 'attestation']);
    expect(pins.k).toBe(20);
    expect(pins.txAfter).toBe(CUTOFF);
    expect(pins.txClose).toBe(CLOSE);
    expect(bytes).toBe(JSON.stringify(pins, null, 1) + '\n');
  });

  it('states in its attestation what was re-verified at the close, and what was NOT', () => {
    // §9a requires "the pins re-verified at the close". Tools, method documents and the
    // configuration ARE re-verified below; the runtime identity is a DECLARED pair of load paths
    // and cannot be re-derived from bytes here, so an attestation that stayed silent about it
    // would let the file imply a full re-verification it never performed.
    const { pins } = call();
    expect(pins.attestation).toMatch(/runtime/i);
    expect(pins.attestation).toMatch(/not re-verified/i);
  });

  it('binds the pins to the method freeze by the receipt payload hash', () => {
    // The four `Pins` fields say what was measured; `freezeSha256` says under which frozen method.
    // Without it the pins are an orphan file that any freeze — or none — could have produced.
    const freezeText = receiptFile();
    const { pins } = call({ freezeText });
    expect(pins.freezeSha256).toBe((JSON.parse(freezeText) as { payloadSha256: string }).payloadSha256);
    expect(pins.freezeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the five input hashes through unchanged', () => {
    const manifestText = manifestBody();
    const inputs = fiveInputs(manifestText);
    expect(call({ manifestText, inputs }).pins.inputs).toEqual(inputs);
  });
});

describe('inputPins — refusals', () => {
  it('verifies the receipt payload hash BEFORE trusting anything in it', () => {
    // A receipt whose k was edited after issue would otherwise silently redefine the method the
    // pins pin — and every artifact downstream compares against these pins, not against it.
    const freezeText = receiptFile({}, (p) => { p.k = 1; });
    expect(() => call({ freezeText })).toThrow(/freeze-receipt-tampered/);
  });

  it('refuses a file that is not a freeze receipt, and one that is not JSON at all', () => {
    expect(() => call({ freezeText: JSON.stringify({ artifact: 'gate-set', payload: {}, payloadSha256: 'x' }) }))
      .toThrow(/not-a-freeze-receipt/);
    expect(() => call({ freezeText: 'not json{' })).toThrow(/freeze-receipt-unreadable/);
  });

  it('refuses a receipt missing any part of the method it is supposed to supply', () => {
    for (const missing of ['k', 'txAfter', 'txClose', 'tools', 'methodDocs', 'config']) {
      const freezeText = receiptFile({ [missing]: undefined });
      expect(() => call({ freezeText }), missing).toThrow(/freeze-receipt-incomplete/);
    }
  });

  it('refuses a manifest that is not the file whose hash it is about to pin', () => {
    // The cross-check below reads the manifest's own k and window. Reading them from a different
    // file than the one being hashed would check nothing: the pins would be derived from one
    // manifest and validated against another.
    const manifestText = manifestBody();
    expect(() => call({ manifestText, inputs: { ...fiveInputs(manifestText), manifest: '9'.repeat(64) } }))
      .toThrow(/manifest-not-the-pinned-file/);
  });

  /** `prepare-gate.ts` catches this too, at the far end of the chain. The duplication buys
   *  ATTRIBUTION, not recoverability: both programs run at the close and a mis-generated manifest
   *  is equally regenerable at either refusal — but a `pin-mismatch` at prepare arrives wearing
   *  the pins' name, and the operator's first suspect would be the pins this program derived
   *  rather than the manifest that actually disagrees. */
  it('refuses a manifest whose own k or window disagrees with the freeze', () => {
    for (const over of [{ k: 19 }, { txAfter: '2026-07-20T00:00:00.000Z' }, { txClose: '2026-08-19T00:00:00.000Z' }]) {
      const manifestText = manifestBody(over);
      expect(() => call({ manifestText }), JSON.stringify(over)).toThrow(/manifest-method-mismatch/);
    }
    // An ABSENT bound is a disagreement too: a manifest that never declared a window cannot be
    // the manifest this frozen window was generated for.
    const noWindow = JSON.stringify({ k: 20, probes: [] }, null, 1) + '\n';
    expect(() => call({ manifestText: noWindow })).toThrow(/manifest-method-mismatch/);
  });

  it('refuses a manifest that hashes right but is not readable as JSON', () => {
    const manifestText = 'not json{';
    expect(() => call({ manifestText })).toThrow(/manifest-unreadable/);
  });
});

describe('inputPins — §9a\'s re-verification at the close', () => {
  /** §9a: "the pins re-verified at the close"; §10: "Both are verified again at the close". Round
   *  3 proved nothing did it: a pinned tool edited after the freeze, a BINDING method document
   *  amended, and the config swapped to critique all sailed through input-pins and prepare
   *  untouched — a §8-resetting method change, invisible to the whole chain. This program is the
   *  close-time artifact that holds the full receipt, so it is where the re-verification lives. */
  it('refuses a pinned TOOL whose close-time hash differs from the freeze, naming the path', () => {
    const drifted = currentView();
    drifted.tools['scripts/pilot/derive.ts'] = '0'.repeat(40);
    expect(() => call({ current: drifted })).toThrow(/method-drift/);
    expect(() => call({ current: drifted })).toThrow(/scripts\/pilot\/derive\.ts/);
  });

  it('refuses a BINDING method document that was amended after the freeze', () => {
    const drifted = currentView();
    drifted.methodDocs['docs/release/o67-class-rule-2026-07.md'] = '1'.repeat(64);
    expect(() => call({ current: drifted })).toThrow(/method-drift/);
  });

  it('refuses a tool the close-time tree no longer has, or has grown, as drift — not as a skip', () => {
    const missing = currentView();
    delete missing.tools['scripts/pilot/derive.ts'];
    expect(() => call({ current: missing })).toThrow(/method-drift/);
    const extra = currentView();
    extra.tools['scripts/pilot/new-tool.ts'] = '2'.repeat(40);
    expect(() => call({ current: extra })).toThrow(/method-drift/);
  });

  it('re-reads the CONFIG at the path the receipt recorded and refuses drifted bytes', () => {
    const asked: string[] = [];
    const drifted = currentView();
    drifted.configBytesAt = (path: string) => { asked.push(path); return Buffer.from('{"dualVerify":{"mode":"critique"}}\n'); };
    expect(() => call({ current: drifted })).toThrow(/method-drift/);
    expect(asked).toContain('~/.helix/config.json');
  });
});

/** The fixture the CLI reads: a freeze receipt plus the four close-time artifacts.
 *
 *  The receipt's tools and method documents are the REAL working tree's hashes and its config is a
 *  live file in the fixture, because the CLI now RE-VERIFIES all three at the close (§9a) against
 *  its own working directory — a receipt of fakes would refuse every invocation as method-drift.
 *  The drift tests then perturb exactly one side. */
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'inputpins-'));
  mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const row = (id: string) => JSON.stringify({
    id, tx: '2026-08-01T00:00:00.000Z', type: 'assert', content: `content ${id}`, supersedes: null });
  writeFileSync(join(dir, 'home', 'memory.jsonl'), row('m_g') + '\n');
  writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), row('m_a') + '\n');

  const liveConfig = join(dir, 'live-config.json');
  writeFileSync(liveConfig, CONFIG_BYTES);
  const paths: Record<string, string> = {
    freeze: join(dir, 'freeze-receipt.json'),
    manifest: join(dir, 'manifest.json'),
    classifier: join(dir, 'classifier.json'),
    universe: join(dir, 'universe.json'),
  };
  const realMethod = () => ({
    tools: hashTools(process.cwd()),
    methodDocs: hashMethodDocs(process.cwd()),
    config: { path: liveConfig, sha256: sha256Bytes(CONFIG_BYTES), redactionAcknowledged: true },
  });
  writeFileSync(paths.freeze!, receiptFile(realMethod()));
  writeFileSync(paths.manifest!, manifestBody());
  writeFileSync(paths.classifier!, JSON.stringify({ rule: 'o67-class-rule-2026-07', probes: [] }, null, 1) + '\n');
  writeFileSync(paths.universe!, JSON.stringify({ artifact: 'candidate-universe', probes: [] }, null, 1) + '\n');
  return { dir, paths, liveConfig, realMethod, out: join(dir, 'pins.json') };
};

const args = (f: ReturnType<typeof fixture>) => [
  '--freeze', f.paths.freeze!, '--manifest', f.paths.manifest!, '--classifier', f.paths.classifier!,
  '--universe', f.paths.universe!, '--snapshot', f.dir, '--out', f.out];

const run = (a: string[]) => execFileSync(process.execPath, [cli, ...a], { cwd: process.cwd(), stdio: 'pipe' });
const status = (a: string[]): number => {
  try { run(a); return 0; } catch (e) { return (e as { status?: number }).status ?? -1; }
};

describe('input-pins CLI', () => {
  it('derives the TEN pin hashes from the same bytes the prepare phase will read', () => {
    const f = fixture();
    try {
      run(args(f));
      const pins = JSON.parse(readFileSync(f.out, 'utf8')) as { inputs: Record<string, string>; k: number };
      expect(pins.inputs).toEqual(hashPinnedInputs(f.dir, {
        manifest: f.paths.manifest!, classifier: f.paths.classifier!, universe: f.paths.universe!,
      }, defaultExpansion()!));
      expect(Object.keys(pins.inputs).sort()).toEqual([
        'classifier', 'expansion:semantic-neighbors', 'ledger:global', 'ledger:project', 'manifest',
        'ownership:owner', 'ownership:registry', 'trust:master-key', 'trust:witness', 'universe',
      ]);
      expect(pins.k).toBe(20);
      expect(readFileSync(f.out, 'utf8')).toBe(JSON.stringify(pins, null, 1) + '\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses at the close a pinned tool that drifted since the freeze — the §8 reset trigger', () => {
    const f = fixture();
    try {
      const method = f.realMethod();
      method.tools['scripts/pilot/derive.ts'] = '0'.repeat(40);
      writeFileSync(f.paths.freeze!, receiptFile(method));
      expect(status(args(f))).toBe(1);
      expect(() => run(args(f))).toThrow(/method-drift/);
      expect(() => run(args(f))).toThrow(/scripts\/pilot\/derive\.ts/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('re-reads the config at its recorded path and refuses drifted bytes', () => {
    const f = fixture();
    try {
      writeFileSync(f.liveConfig, '{"dualVerify":{"mode":"critique"}}\n');
      expect(status(args(f))).toBe(1);
      expect(() => run(args(f))).toThrow(/method-drift/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('refuses to derive pins when the semantic-neighbor asset does not resolve beside it', () => {
    // Round 3: an absent asset silently removes all query expansion and every then-current pin
    // stayed green. The expansion pin is derived FROM the resolved table, so an unresolvable table
    // must refuse the derivation rather than pin a degraded method.
    const f = fixture();
    const bare = mkdtempSync(join(tmpdir(), 'noasset-'));
    try {
      const stripped = join(bare, 'input-pins.mjs');
      copyFileSync(cli, stripped);
      let thrown: Error | undefined;
      try {
        execFileSync(process.execPath, [stripped, ...args(f)], { cwd: process.cwd(), stdio: 'pipe' });
      } catch (e) { thrown = e as Error; }
      expect(thrown, 'a bundle with no data/ beside it must refuse').toBeDefined();
      expect((thrown as unknown as { status?: number }).status).toBe(1);
      expect(String((thrown as unknown as { stderr?: Buffer }).stderr)).toMatch(/expansion-unavailable/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  /** The design property, stated as a refusal. `k` and the window bounds exist in exactly one
   *  place — the freeze receipt — and there is no flag to state them a second time, because a
   *  second statement is a second chance to disagree. */
  it('offers NO flag for k or either window bound', () => {
    const f = fixture();
    try {
      for (const extra of [['--k', '20'], ['--cutoff', CUTOFF], ['--close', CLOSE], ['--tx-after', CUTOFF]]) {
        expect(status([...args(f), ...extra]), extra.join(' ')).toBe(2);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 2 on an unknown, missing or repeated flag', () => {
    const f = fixture();
    try {
      expect(status([...args(f), '--results', join(f.dir, 'r.json')])).toBe(2);
      expect(status(args(f).slice(2))).toBe(2);                     // no --freeze
      expect(status([...args(f), '--out', f.out])).toBe(2);         // repeated
      expect(status([...args(f), '--out'])).toBe(2);                // dangling value
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('exits 1 and writes nothing when the freeze receipt does not vouch for the manifest', () => {
    const f = fixture();
    try {
      writeFileSync(f.paths.manifest!, manifestBody({ k: 19 }));
      expect(status(args(f))).toBe(1);
      expect(() => run(args(f))).toThrow(/manifest-method-mismatch/);
      expect(() => readFileSync(f.out, 'utf8')).toThrow(/ENOENT/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

/** The whole two-CLI arrangement, end to end, through the REAL programs and the REAL prepare
 *  phase. Relocated here rather than rewritten: it was the freeze CLI's test until the artifact
 *  split, and the property it holds is the reason the pins exist at all. `prepare-gate` refuses any
 *  input whose hash disagrees with the pins, so a pins file that is merely well-formed is
 *  worthless — it has to be byte-compatible with what the prepare phase independently computes
 *  over the same inputs.
 *
 *  Both CLIs run inside a THROWAWAY fixture repository (test/helpers/freeze-fixture-repo.ts):
 *  the freeze now refuses a working tree that diverges from `--commit` for any pinned path, and
 *  this development repository is dirty in exactly those files whenever the pilot is being worked
 *  on. The fixture's tree/commit agreement — and its authored time, which `--cutoff` is verified
 *  against — are constructed, not inherited from whatever HEAD happens to be. */
describe('freeze → input-pins → the real prepare phase', () => {
  const chain = () => {
    const frepo = freezeFixtureRepo();
    const commit = frepo.commit;
    const cutoff = FIXTURE_CUTOFF;
    const close = new Date(new Date(cutoff).getTime() + 28 * 86_400_000).toISOString();
    const dir = mkdtempSync(join(tmpdir(), 'chain-'));
    mkdirSync(join(dir, 'proj', '.helix'), { recursive: true });
    mkdirSync(join(dir, 'home'), { recursive: true });
    const row = (id: string) => JSON.stringify({
      id, tx: '2026-08-01T00:00:00.000Z', type: 'assert', content: `content ${id}`, supersedes: null });
    writeFileSync(join(dir, 'home', 'memory.jsonl'), row('m_g') + '\n');
    writeFileSync(join(dir, 'proj', '.helix', 'memory.jsonl'), row('m_a') + '\n' + row('m_b') + '\n');

    const probe = (t: string) => ({ id: `L_${t}`, query: `query ${t}`, relevant: [t], unambiguous: true, side: 'ledger' });
    const verdict = (t: string) => ({ id: `L_${t}`, status: 'not-in-class', targetId: t, targetScope: 'project', hit1Eligible: true });
    const bodies: Record<string, unknown> = {
      manifest: { k: 20, txAfter: cutoff, txClose: close, probes: [probe('m_a'), probe('m_b')] },
      classifier: { rule: 'o67-class-rule-2026-07', manifest: 'holdout.json', probes: [verdict('m_a'), verdict('m_b')] },
      universe: {
        rule: 'o67-class-rule-2026-07', artifact: 'candidate-universe', manifest: 'holdout.json', recallBound: 3,
        disclosure: { rowsByScope: { global: 1, project: 2 }, projectDisposition: 'owned',
          integrityAvailable: true, witnessNotes: [], expansionAvailable: true },
        probes: [{ id: 'L_m_a', candidates: ['project:m_a'] }, { id: 'L_m_b', candidates: ['project:m_b'] }],
      },
    };
    const paths: Record<string, string> = {};
    for (const [name, body] of Object.entries(bodies)) {
      paths[name] = join(dir, `${name}.json`);
      writeFileSync(paths[name]!, JSON.stringify(body, null, 1) + '\n');
    }
    const runtimeSha = '0123456789abcdef0123456789abcdef01234567';
    paths.config = join(dir, 'config.json');
    writeFileSync(paths.config, JSON.stringify({ dualVerify: { mode: 'compare' }, apiKey: '[REDACTED]' }, null, 1) + '\n');
    paths.runtime = join(dir, 'runtime.json');
    writeFileSync(paths.runtime, JSON.stringify({ gitCommitSha: runtimeSha, loadPaths: [
      { path: '/cache/helix/bin/helix-mcp.mjs', gitCommitSha: runtimeSha },
      { path: '/marketplaces/helix/bin/helix-mcp.mjs', gitCommitSha: runtimeSha }] }, null, 1) + '\n');
    const freeze = join(dir, 'freeze-receipt.json');
    const pins = join(dir, 'pins.json');

    // Both CLIs run FROM the fixture repo: the freeze hashes §10's pinned paths out of its working
    // directory and verifies them against --commit; input-pins re-verifies the same paths at the
    // close, so the two must look at the same tree.
    const exec = (bin: string, a: string[]) =>
      execFileSync(process.execPath, [bin, ...a], { cwd: frepo.root, stdio: 'pipe' });
    exec(freezeCli, ['--commit', commit, '--runtime', paths.runtime!, '--config', paths.config!,
      '--cutoff', cutoff, '--k', '20', '--out', freeze]);
    exec(cli, ['--freeze', freeze, '--manifest', paths.manifest!, '--classifier', paths.classifier!,
      '--universe', paths.universe!, '--snapshot', dir, '--out', pins]);
    return { dir, frepo, paths, freeze, pins, cutoff, close };
  };
  const teardown = (c: ReturnType<typeof chain>) => {
    rmSync(c.dir, { recursive: true, force: true });
    rmSync(c.frepo.root, { recursive: true, force: true });
  };

  /** Recomputed the way `prepare-gate`'s main does, NOT by calling `hashPinnedInputs`, or this
   *  would only prove that one function agrees with itself. The four trust files do not exist in
   *  this fixture and are therefore the LITERAL sentinel — spelled out here rather than derived,
   *  because the sentinel's exact spelling is part of the pin contract. The expansion pin is the
   *  one shared-discipline exception: the content hash has a single definition on purpose (both
   *  sides must hash the RESOLVED table identically), so there is no second implementation to
   *  recompute it with. */
  const independentHashes = (c: ReturnType<typeof chain>) => ({
    manifest: sha256Hex(readFileSync(c.paths.manifest!, 'utf8')),
    classifier: sha256Hex(readFileSync(c.paths.classifier!, 'utf8')),
    universe: sha256Hex(readFileSync(c.paths.universe!, 'utf8')),
    'ledger:global': sha256Hex(readFileSync(join(c.dir, 'home', 'memory.jsonl'), 'utf8')),
    'ledger:project': sha256Hex(readFileSync(join(c.dir, 'proj', '.helix', 'memory.jsonl'), 'utf8')),
    'ownership:registry': 'absent',
    'ownership:owner': 'absent',
    'trust:master-key': 'absent',
    'trust:witness': 'absent',
    'expansion:semantic-neighbors': expansionTableSha256(defaultExpansion()!),
  });
  const prepare = (c: ReturnType<typeof chain>, manifest?: Manifest) => prepareGateSet({
    manifest: manifest ?? JSON.parse(readFileSync(c.paths.manifest!, 'utf8')) as Manifest,
    classifier: JSON.parse(readFileSync(c.paths.classifier!, 'utf8')) as ClassifierOutput,
    universe: JSON.parse(readFileSync(c.paths.universe!, 'utf8')) as UniverseArtifact,
    ledgers: readSnapshot(c.dir),
    pins: JSON.parse(readFileSync(c.pins, 'utf8')) as Pins,
    inputHashes: independentHashes(c),
    now: () => '2026-08-01T09:00:00.000Z',
  });

  it('is ACCEPTED end to end, and prepares a gate set under the frozen window', () => {
    const c = chain();
    try {
      const gateSet = prepare(c);
      expect(gateSet.payload.window).toEqual({ txAfter: c.cutoff, txClose: c.close });
      expect(gateSet.payload.eligible.label).toBe('EXERCISED — 2/2');
      expect(Object.keys(gateSet.payload.inputs).sort()).toEqual([
        'classifier', 'expansion:semantic-neighbors', 'ledger:global', 'ledger:project', 'manifest',
        'ownership:owner', 'ownership:registry', 'trust:master-key', 'trust:witness', 'universe',
      ]);
      // The pins name the freeze they were derived under, and it is the receipt on disk.
      const pins = JSON.parse(readFileSync(c.pins, 'utf8')) as { freezeSha256: string };
      expect(pins.freezeSha256).toBe((JSON.parse(readFileSync(c.freeze, 'utf8')) as { payloadSha256: string }).payloadSha256);
    } finally { teardown(c); }
  });

  it('makes the derived pins BITE — an input edited after the pins are taken is refused', () => {
    // Without this the acceptance above would be equally satisfied by pins full of the wrong
    // hashes, since nothing else in the chain reads them.
    const c = chain();
    try {
      const m = JSON.parse(readFileSync(c.paths.manifest!, 'utf8')) as Manifest;
      m.probes[1]!.unambiguous = false;
      writeFileSync(c.paths.manifest!, JSON.stringify(m, null, 1) + '\n');
      expect(() => prepare(c, m)).toThrow(/input-hash-mismatch/);
    } finally { teardown(c); }
  });
});
