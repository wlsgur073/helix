/** Gate-set preparation — phase 1 of the two-phase reducer (C5.1 closure item 3).
 *
 *  The v2 gate is scored by two executables, not one, and the split is the point. This phase joins
 *  the manifest to the classifier's verdicts, freezes the denominator, and hashes it. It is
 *  OUTCOME-BLIND: it never sees a rank, a hit, a returned list, or any other runner output. Phase 2
 *  (`score-gate.ts`) reads outcomes and may not alter what this phase froze.
 *
 *  That property is enforced structurally rather than promised in prose — this file takes no runner
 *  output as an input, so there is nothing here to read one from. A single reducer that computed
 *  both halves could always be edited into reading ranks before deciding a denominator, and no
 *  review of its output could tell afterwards.
 *
 *  Everything it computes is a JOIN or a REFUSAL. It invents no policy: the eligible set is the
 *  manifest's own `unambiguous` flag, cross-checked against the classifier's echo of it, and every
 *  check below turns a disagreement between two independently produced inputs into a gate failure
 *  instead of a silent reconciliation.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { projectLedgerPath } from '../../src/memory/ownership.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, parseJsonInput, readInput, refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { expansionTableSha256, sha256BytesOrAbsent, snapshotTrustPaths } from './pin-hashes.js';
import { parseLedgerText, type ScopedLedger } from './snapshot.js';
import {
  HIT1_MINIMUM, RULE,
  type ClassifierOutput, type ClassifierVerdict, type EligibleSet, type GateSet, type GateSetPayload,
  type Manifest, type ManifestProbe, type O67Census, type Pins, type StaleExposure, type UniverseArtifact,
} from './gate-set.js';

// Re-exported so importers of this module keep working. The declarations live in `gate-set.ts`
// because the score phase needs them too, and neither guarded CLI may import the other.
export * from './gate-set.js';




/** The two statuses that mean the classifier reached a verdict. Everything else — `unscorable`,
 *  `target-zero-evidence`, `out-of-domain`, and anything the classifier grows later — is refused.
 *  Stated as an allow-list on purpose: §5a widens errors/unscorable to the whole pipeline, so an
 *  unrecognised status must fail the gate rather than quietly leave a row out of the denominator. */
const CLASSIFIED = new Set(['in-class', 'not-in-class']);

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };

/** Join the manifest to the classifier's verdicts and freeze the eligible set.
 *
 *  Ineligible probes are validated just as strictly as eligible ones. They still carry the
 *  Recall@20 condition (§5a), so an error on one of them is exactly as disqualifying — dropping
 *  the check there would make "errors = 0" mean "errors = 0 among the rows we chose to grade". */
export const frozenEligibleSet = (probes: ManifestProbe[], verdicts: ClassifierVerdict[]): EligibleSet => {
  for (const list of [probes, verdicts]) {
    const ids = new Set<string>();
    for (const r of list) {
      if (ids.has(r.id)) fail('duplicate-probe-id', `${r.id} appears more than once in one input`);
      ids.add(r.id);
    }
  }
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  if (byId.size !== probes.length || probes.some((p) => !byId.has(p.id))) {
    fail('probe-set-mismatch', `the manifest has ${probes.length} probe id(s) and the classifier ${byId.size}; ` +
      'they must be the same set, or the two inputs describe different runs');
  }

  const identities: string[] = [];
  const owner = new Map<string, string>();   // identity -> probe id that claimed it
  const probeIds: string[] = [];
  for (const p of probes) {
    const v = byId.get(p.id)!;
    if (p.relevant.length !== 1) {
      fail('not-single-target', `probe ${p.id} names ${p.relevant.length} targets; the v2 population is ` +
        'ledger-only under mechanical identity mapping, so every probe has exactly one');
    }
    if (!CLASSIFIED.has(v.status)) {
      fail('probe-not-classified', `probe ${p.id} has status '${v.status}'` +
        `${v.reason ? ` (${v.reason})` : ''}; only in-class and not-in-class are verdicts, and §5a makes ` +
        'any other outcome an errors/unscorable gate failure rather than a row to skip');
    }
    if (v.hit1Eligible !== p.unambiguous) {
      fail('eligibility-disagreement', `probe ${p.id} is unambiguous=${p.unambiguous} in the manifest but ` +
        `hit1Eligible=${v.hit1Eligible} in the classifier; the classifier echoes that flag, so a ` +
        'disagreement means the two inputs were produced from different manifests');
    }
    if (v.targetId !== p.relevant[0]) {
      fail('target-disagreement', `probe ${p.id} targets ${p.relevant[0]} in the manifest and ` +
        `${String(v.targetId)} in the classifier`);
    }
    if (v.targetScope === undefined) {
      fail('missing-target-scope', `probe ${p.id} has no resolved target scope; an identity is the PAIR ` +
        '(scope, record-id), and an absent scope would format into a well-formed identity that dedups ' +
        'and sorts like any real one');
    }
    if (!p.unambiguous) continue;
    const identity = `${v.targetScope}:${v.targetId}`;
    const prior = owner.get(identity);
    if (prior !== undefined) {
      fail('duplicate-target-identity', `probes ${prior} and ${p.id} both name ${identity}; §3a freezes ` +
        'one probe per identity as an invariant, because paraphrase probes sharing an identity inflate ' +
        'the nominal sample and break the independence the reported bound rests on');
    }
    owner.set(identity, p.id);
    identities.push(identity);
    probeIds.push(p.id);
  }

  const exposure = identities.length;
  const label = exposure === 0 ? `UNEXERCISED — 0/${HIT1_MINIMUM}`
    : exposure < HIT1_MINIMUM ? `PARTIALLY EXERCISED — ${exposure}/${HIT1_MINIMUM} (minimum not met)`
      : `EXERCISED — ${exposure}/${HIT1_MINIMUM}`;
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { probeIds: [...probeIds].sort(byCodeUnit), identities: [...identities].sort(byCodeUnit), exposure, label };
};


export const o67Census = (probes: ManifestProbe[], verdicts: ClassifierVerdict[]): O67Census => {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const cases: O67Census['cases'] = [];
  for (const p of probes) {
    const v = byId.get(p.id);
    if (v === undefined || v.status !== 'in-class') continue;
    cases.push({ probeId: p.id, identity: `${v.targetScope}:${v.targetId}`,
      hit1Eligible: v.hit1Eligible, witnesses: v.witnesses ?? [] });
  }
  cases.sort((a, b) => (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0));
  const distinct = new Set(cases.map((c) => c.identity));
  const eligible = new Set(cases.filter((c) => c.hit1Eligible).map((c) => c.identity));
  const n = distinct.size;
  return {
    census: probes.length,
    cases,
    distinctInClassIdentities: n,
    eligibleInClass: eligible.size,
    label: `${n === 0 ? 'UNEXERCISED' : 'EXERCISED'} — ${n} distinct cases observed (reporting only, non-blocking)`,
    blocking: false,
  };
};

/** §5a — stale-served-as-live EXPOSURE, which is a property of the corpus, not of any output.
 *
 *  `Es` is the number of valid closer relationships in the as-of-close snapshot: one per
 *  `supersede` / `invalidate` / `erase` row that actually closes something. It is emphatically NOT
 *  the number of closed records that happen to be returned — an earlier draft of the design named
 *  those two denominators in the same breath. Violations are sought later, by the score phase, in
 *  the top-K outputs; this phase only says whether the hazard could arise at all.
 *
 *  `Es = 0` is the expected state and reports honestly without blocking: no minimum stale fixture
 *  is preregistered, so an absence of churn must not convert into a release failure. The release
 *  is not untested on stale handling either — `test/memory/projection.test.ts` verifies closure
 *  deterministically — so the pilot's contribution here is temporal evidence on top of a fixture
 *  that already exists, which is why its absence is disclosable rather than disqualifying. */

const CLOSERS = new Set(['supersede', 'invalidate', 'erase']);

export const staleExposure = (ledgers: ScopedLedger[]): StaleExposure => {
  let count = 0;
  for (const { scope, rows } of ledgers) {
    // Resolution is WITHIN a scope, matching liveness: each scope is its own ledger file and a
    // closer never reaches across them, so resolving cross-scope would invent a relationship the
    // live projection does not have.
    const present = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      if (!CLOSERS.has(r.type)) continue;
      if (r.supersedes === null || r.supersedes === undefined || !present.has(r.supersedes)) {
        fail('dangling-closer', `${scope} row ${r.id} is a ${r.type} naming ${String(r.supersedes)}, which is ` +
          'not present in that scope. The ledger is not self-consistent, so counting the relationship would ' +
          'overstate exposure and skipping it would understate it — neither is a number worth reporting');
      }
      count++;
    }
  }
  return {
    closerRelationships: count,
    label: count === 0 ? 'UNEXPOSED — no temporal evidence'
      : `EXPOSED — ${count} closer relationship${count === 1 ? '' : 's'}`,
    blocking: count > 0,
  };
};





const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** INVARIANT OWNED BY THE CALLER — this function cannot check it. `inputHashes` arrives beside
 *  ALREADY-PARSED objects, and nothing here reads the bytes those hashes claim to describe: the
 *  pin comparison below establishes only that the SUPPLIED hashes match the freeze, not that the
 *  supplied objects came from the hashed bytes. Every hash and its object must therefore derive
 *  from ONE read of the same text, which is exactly what `main()` does — `readInput` once per
 *  file, then parse AND hash over that same string, the ledgers included (`parseLedgerText` over
 *  the string the `ledger:*` hashes are computed from; an earlier main re-read them through
 *  `readSnapshot`, so its stale-exposure count derived from a second read the pins did not
 *  describe). The CLI is the guarded path. A library caller who reads a file twice, or parses one
 *  buffer and hashes another, re-opens the gap `runPilot` closed for the manifest by taking TEXT
 *  instead (`run-pilot.ts`, `manifestText`): an artifact pinning hashes of bytes that are not the
 *  bytes it measured. Today the only callers are `main()` and tests; a new caller inherits this
 *  obligation with the signature. */
export const prepareGateSet = (input: {
  manifest: Manifest;
  classifier: ClassifierOutput;
  universe: UniverseArtifact;
  ledgers: ScopedLedger[];
  pins: Pins;
  inputHashes: Record<string, string>;
  now: () => string;
}): GateSet => {
  const { manifest, classifier, universe, ledgers, pins, inputHashes, now } = input;

  if (manifest.k !== pins.k || manifest.txAfter !== pins.txAfter || manifest.txClose !== pins.txClose) {
    fail('pin-mismatch', `the manifest declares k=${manifest.k}, window ${String(manifest.txAfter)}..` +
      `${String(manifest.txClose)}; the freeze pins k=${pins.k}, window ${pins.txAfter}..${pins.txClose}. ` +
      'The run would be scored under a method other than the one that was frozen');
  }

  const pinnedNames = Object.keys(pins.inputs).sort(byCodeUnit);
  const suppliedNames = Object.keys(inputHashes).sort(byCodeUnit);
  if (!sameSet(pinnedNames, suppliedNames)) {
    fail('input-set-mismatch', `pinned inputs [${pinnedNames}] but supplied [${suppliedNames}]. Comparing only ` +
      'the hashes of shared names would let an unpinned input in silently, and let a pinned one go unsupplied');
  }
  for (const name of pinnedNames) {
    if (inputHashes[name] !== pins.inputs[name]) {
      fail('input-hash-mismatch', `input '${name}' hashes to ${String(inputHashes[name])} but the freeze pins ` +
        `${String(pins.inputs[name])}`);
    }
  }

  const probeIds = manifest.probes.map((p) => p.id).sort(byCodeUnit);
  if (!sameSet(probeIds, universe.probes.map((p) => p.id).sort(byCodeUnit))) {
    fail('universe-probe-mismatch', 'the candidate-universe artifact does not cover exactly the manifest\'s ' +
      'probes, so it is not the universe this run competed in');
  }

  // Each of these yields a well-formed, correctly-hashed artifact indistinguishable afterwards
  // from a healthy small run — which is why they are refused up front rather than disclosed.
  // Witness notes are NOT in this list: the real frozen snapshot carries a benign
  // trust-on-first-use note, so failing on any note would refuse the actual corpus. They are
  // recorded as disclosure instead.
  const d = universe.disclosure;
  if (!d.integrityAvailable) fail('degraded-run', 'ledger integrity verification was unavailable for this recall');
  if (!d.expansionAvailable) fail('degraded-run', 'the semantic-neighbor asset was missing, so recall ran without ' +
    'query expansion; the verdicts cannot detect its absence because semantically-rescued records carry no ' +
    'lexical evidence, which is what makes this check the only signal');
  if ((d.rowsByScope.project ?? 0) > 0 && d.projectDisposition !== 'owned') {
    fail('degraded-run', `the project ledger contributed ${d.rowsByScope.project} rows but its disposition is ` +
      `'${d.projectDisposition}', so recall served none of them`);
  }

  // §2 bounds the ENTIRE corpus at the close, and §9 item 2's snapshot hash is supposed to
  // DEMONSTRATE `cutoff < tx ≤ close` — a demonstration that had no implementer until round 3
  // proved it: a row minted six weeks after the close competed for rank, and a post-close
  // `supersede` was COUNTED into `Es`, flipping the stale condition binding for a hazard the
  // as-of-close corpus never held. Rows at or before the CUTOFF are legitimate (they are the
  // competitor corpus), so only the close edge is enforced, inclusively, by the same strict
  // string comparison the window bounds use — which is also why a missing or non-canonical `tx`
  // is refused rather than compared: '…T00:00:00Z' sorts below the close for reasons that have
  // nothing to do with time.
  const CANONICAL_TX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  for (const { scope, rows } of ledgers) {
    for (const r of rows) {
      // The ternary keeps `fail`'s `never` in expression position — control-flow analysis only
      // credits a never-returning call there — so `tx` is a plain string below.
      const tx: string = (typeof r.tx === 'string' && CANONICAL_TX.test(r.tx) &&
        !Number.isNaN(new Date(r.tx).getTime()) && new Date(r.tx).toISOString() === r.tx)
        ? r.tx
        : fail('ledger-tx-non-canonical', `${scope} row ${r.id} has tx ${JSON.stringify(r.tx)}, which is not ` +
          'the canonical UTC spelling §2 compares window bounds with; a row that cannot be compared against ' +
          'the close cannot be shown to belong to the as-of-close snapshot');
      if (tx > pins.txClose) {
        fail('snapshot-after-close', `${scope} row ${r.id} has tx ${tx}, after the pinned close ` +
          `${pins.txClose}. The snapshot is supposed to stand in for one taken AT the close (§2); a later row ` +
          'competes for rank — or closes an in-window record — from outside the measured window');
      }
    }
  }

  const payload: GateSetPayload = {
    rule: RULE,
    k: manifest.k,
    window: { txAfter: pins.txAfter, txClose: pins.txClose },
    eligible: frozenEligibleSet(manifest.probes, classifier.probes),
    recallDenominator: probeIds,
    o67: o67Census(manifest.probes, classifier.probes),
    stale: staleExposure(ledgers),
    disclosure: d,
    inputs: Object.fromEntries(pinnedNames.map((n) => [n, inputHashes[n]!])),
  };
  return {
    artifact: 'gate-set',
    payloadSha256: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
    payload,
    receipts: {
      preparedAt: now(),
      attestation: 'self-reported wall clock; §9 item 4 requires an append-only or externally attested ' +
        'receipt showing prepare-finished before runner-started, which this field alone does not provide',
    },
  };
};

/** Every input is a NAMED flag and there are no positionals at all.
 *
 *  Two reasons, both learned here. Overlapping positional shapes in `generate-manifest` once lined
 *  an oracle path up with an output SLOT; with named flags no slot is decided by position, so that
 *  particular confusion cannot arise. And an unknown flag is REFUSED rather than ignored, which is
 *  what keeps this phase outcome-blind in practice: `--results` is not an input of this phase, so
 *  passing one is an error instead of a silently dropped argument that leaves the operator
 *  believing it was used.
 *
 *  What they do NOT do — and an earlier version of this comment claimed they did — is stop a
 *  hash-pinned artifact being overwritten. Naming the slots does not constrain the VALUE handed to
 *  `--out`, and `--out <the manifest path>` destroyed a pinned input after the input had been
 *  hashed. That needs a check on the destination: `refuseOutputCollisions` in `main`, §9 line 376. */
const INPUTS = ['manifest', 'classifier', 'universe', 'snapshot', 'pins', 'out'] as const;
const USAGE = `usage: prepare-gate ${INPUTS.map((n) => `--${n} <path>`).join(' ')}\n` +
  '  This phase is OUTCOME-BLIND: it takes no runner output, and never will.';

const parseFlags = (argv: string[]): Record<string, string> => {
  const out = flagAccumulator();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (!(INPUTS as readonly string[]).includes(name)) {
      fail('unknown-input', `--${name} is not an input of the prepare phase. This phase is outcome-blind: ` +
        'it joins the manifest, the classifier verdicts and the snapshot, and it must never be handed ' +
        'a runner result, a score, or a prior report');
    }
    // `Object.hasOwn`, never `in`: `in` walks Object.prototype (finding X2).
    if (Object.hasOwn(out, name)) fail('duplicate-input', `--${name} given more than once`);
    out[name] = value!;
  }
  for (const name of INPUTS) if (!Object.hasOwn(out, name)) fail('missing-input', `--${name} is required`);
  return out;
};

const main = (): void => {
  let flags: Record<string, string>;
  try { flags = parseFlags(process.argv.slice(2)); }
  catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); return; }

  try {
    const out = { arg: '--out', path: flags.out! };
    const manifestPath = { arg: '--manifest', path: flags.manifest! };
    const classifierPath = { arg: '--classifier', path: flags.classifier! };
    const universePath = { arg: '--universe', path: flags.universe! };
    const pinsPath = { arg: '--pins', path: flags.pins! };
    // The ledgers are hashed as inputs too. The corpus is as much a part of what was measured as
    // the manifest is, and §9 item 2 binds an as-of-close snapshot hash for exactly that reason —
    // which is also why an --out inside the snapshot is refused below even though no flag names
    // these two files directly. The four TRUST files ride in the same list: they are read (or
    // found absent, which is itself pinned) by the hashing below, and an --out aimed at one would
    // overwrite the trust surface after it had been pinned.
    const globalLedger = { arg: '--snapshot', path: join(flags.snapshot!, 'home', 'memory.jsonl') };
    const projectLedger = { arg: '--snapshot', path: projectLedgerPath(join(flags.snapshot!, 'proj')) };
    const trustPaths = snapshotTrustPaths(flags.snapshot!);
    refuseOutputCollisions(out,
      [manifestPath, classifierPath, universePath, pinsPath, globalLedger, projectLedger,
        ...Object.values(trustPaths).map((path) => ({ arg: '--snapshot', path }))]);

    // The expansion pin hashes the RESOLVED table — the object recall ranks with — so it must
    // resolve HERE. Refusing `undefined` mirrors the disclosure-side degraded-run refusal inside
    // prepareGateSet: pins compared against a table this process cannot even resolve would make
    // the comparison a statement about some other deployment.
    // `?? fail(...)` rather than a guarding if: `fail` returns `never`, but control-flow analysis
    // only credits that in expression position, so this is what leaves `expansion` non-optional.
    const expansion = defaultExpansion() ??
      fail('expansion-unavailable', 'the semantic-neighbor asset did not resolve beside this executable, so the ' +
        'expansion:semantic-neighbors pin cannot be verified — and a prepare that skipped it would freeze a ' +
        'denominator under a method this process cannot reproduce');

    const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const manifestText = readInput(manifestPath);
    const classifierText = readInput(classifierPath);
    const universeText = readInput(universePath);
    const globalText = readInput(globalLedger);
    const projectText = readInput(projectLedger);

    const gateSet = prepareGateSet({
      manifest: parseJsonInput(manifestPath, manifestText) as Manifest,
      classifier: parseJsonInput(classifierPath, classifierText) as ClassifierOutput,
      universe: parseJsonInput(universePath, universeText) as UniverseArtifact,
      // Parsed from the SAME strings the ledger hashes are computed over — one read per file. A
      // second read of the same path could see different bytes, and the stale-exposure count
      // inside the hashed payload would then derive from bytes the pins do not describe.
      ledgers: [
        { scope: 'global', rows: parseLedgerText(globalLedger.path, globalText) },
        { scope: 'project', rows: parseLedgerText(projectLedger.path, projectText) },
      ],
      pins: parseJsonInput(pinsPath, readInput(pinsPath)) as Pins,
      inputHashes: {
        manifest: hash(manifestText), classifier: hash(classifierText), universe: hash(universeText),
        'ledger:global': hash(globalText), 'ledger:project': hash(projectText),
        'ownership:registry': sha256BytesOrAbsent('--snapshot', trustPaths['ownership:registry']!),
        'ownership:owner': sha256BytesOrAbsent('--snapshot', trustPaths['ownership:owner']!),
        'trust:master-key': sha256BytesOrAbsent('--snapshot', trustPaths['trust:master-key']!),
        'trust:witness': sha256BytesOrAbsent('--snapshot', trustPaths['trust:witness']!),
        'expansion:semantic-neighbors': expansionTableSha256(expansion),
      },
      now: () => new Date().toISOString(),
    });
    writeArtifact(out, JSON.stringify(gateSet, null, 1) + '\n');
    console.log(`gate-set prepared: ${gateSet.payload.eligible.label}; O_67 ${gateSet.payload.o67.label}; ` +
      `stale ${gateSet.payload.stale.label}\npayload sha256: ${gateSet.payloadSha256}`);
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
