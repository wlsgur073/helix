/** Pilot runner (protocol §execution, preregistration §9 item 5). Reads manifest + snapshot
 *  (snapshot/home/memory.jsonl as the GLOBAL ledger, snapshot/proj/.helix/memory.jsonl as the
 *  PROJECT ledger under project root snapshot/proj), probes MemoryStore.recall at the manifest K,
 *  and writes a run artifact split into a deterministic `payload` and volatile `receipts`.
 *
 *  The output FILE is deliberately no longer byte-identical across stability re-runs, and an earlier
 *  version of this comment claiming it was is now wrong in a way worth naming. §9's evidence chain
 *  requires a runner output embedding both the prepare hash and a RUN ID, and a run id differs on
 *  every execution by construction — so demanding whole-file identity would make the Stability
 *  condition (§4) unsatisfiable by an honest run. §4 reconciles the two by splitting the artifact:
 *  the payload is deterministic and is what stability compares (`score-gate.ts` hashes
 *  `payload`, never the file text), while the run id and the real wall clocks live in `receipts`,
 *  are retained, and are hashed into the provenance chain instead.
 *
 *  Adapted to the real MemoryStore.recall return shape (checked against src/memory/store.ts): recall()
 *  returns `RecallResult { items: RecalledItem[]; ... }` where each `RecalledItem` is
 *  `{ record: MemoryRecord; scope; needsReverify; integrity }` — the item id lives at `.record.id`,
 *  NOT `.id` directly. All `.id` accesses below go through `.record.id` accordingly.
 *
 *  Production-faithful dual-scope construction (task-2 review fix): mirrors src/server/index.ts's own
 *  store wiring exactly — globalLedger = <home>/memory.jsonl; project = { ledger:
 *  <projectRoot>/.helix/memory.jsonl, root: projectRoot }. Ranks are measured against the SAME
 *  candidate set production recall serves (global + an OWNED project, merged), not the project ledger
 *  alone. The project scope only participates when `isOwned(projectRoot, home)` is true
 *  (src/memory/ownership.ts) — an un-adopted ledger file reads as 'unadopted-present' and is excluded
 *  from recall entirely — so the real snapshot must copy ~/.helix/projects.json alongside the master
 *  key. A snapshot that did not was once a SILENT degradation to a global-only recall; it is now a
 *  `degraded-run` REFUSAL, checked by this runner itself (see the disposition check in `runPilot`),
 *  because prose documenting a hazard is not a check on it.
 *
 *  `compaction` is deliberately left unset (disabled): compactLedger preserves the live projection by
 *  construction so it can never change a rank, but it WOULD rewrite the snapshot's ledger bytes on
 *  disk — and a frozen snapshot must stay byte-identical across stability re-runs. The RUN artifact
 *  gained volatile receipts; the SNAPSHOT did not, and must not.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { projectDispositionOf, projectLedgerPath } from '../../src/memory/ownership.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import { readLedgerBytesWitnessed } from '../../src/memory/witness-read.js';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, invocationFail, parseJsonInput, readInput,
  refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { expansionAssetPaths, expansionTableSha256, sha256BytesOrAbsent, snapshotTrustPaths } from './pin-hashes.js';
import { RULE, type GateSet, type Manifest, type RunArtifact, type RunPayload, type RunResult } from './gate-set.js';

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Probe the snapshot and produce the run artifact.
 *
 *  The gate set is read for TWO purposes — to bind this run to it, and to check that the manifest
 *  supplied alongside it is the one the freeze pinned — and both bindings are verified before
 *  either is recorded: an artifact whose payload does not hash to the value written beside it is
 *  refused rather than embedded, because embedding it would mint a provenance link to a hash
 *  nothing in the chain actually stands behind.
 *
 *  THE PROBES COME FROM THE MANIFEST, NEVER FROM THE GATE SET. `score-gate.ts`'s `run-probe-mismatch`
 *  refusal cross-checks the run's probe id set against the frozen denominator, and that check has
 *  content only because the two arrive from independent inputs. Sourcing the probes from the gate
 *  set would make the run agree with the denominator by construction and turn that refusal into a
 *  tautology — the same class of silent vacuity the prepare phase's input-hash pins exist to
 *  prevent. Independent inputs are only worth cross-checking if BOTH are pinned, though, which is
 *  what `manifest-not-pinned` below supplies: the ids are checked downstream against the frozen
 *  denominator, and the bytes those ids came from are checked here against the frozen input hash.
 *  Probe ids are precisely the part of a manifest a query swap does not have to touch, so without a
 *  pin on the bytes the id-level cross-check above agrees with any query set at all.
 *
 *  The score phase compares the same two values again (`run-manifest-mismatch`), and the duplication
 *  is deliberate rather than redundant. This check runs at the only stage that READS the manifest,
 *  so a swap is refused before a single rank exists; the score phase's runs on the recorded field,
 *  so it holds for a run artifact however it was produced. Neither subsumes the other.
 *
 *  The manifest arrives as TEXT and is parsed here rather than by the caller, so the hash and the
 *  probes provably come from the same bytes. Handing this function an already-parsed manifest plus
 *  a hash computed elsewhere would leave room for the two to describe different files.
 *
 *  Nondeterminism is injected: `runId` and `now` are supplied by the caller, and only `main()`
 *  supplies real ones. That is what lets a test assert on the payload while the receipts vary. */
export const runPilot = (input: {
  manifestText: string;
  gateSet: GateSet;
  snapshotDir: string;
  ledgerTexts: { global: string; project: string };
  runId: string;
  now: () => string;
}): RunArtifact => {
  const { manifestText, gateSet, snapshotDir, ledgerTexts, runId, now } = input;

  if (sha256(JSON.stringify(gateSet.payload)) !== gateSet.payloadSha256) {
    fail('gate-set-tampered', 'the gate set\'s payload does not hash to the value recorded beside it, so the ' +
      'hash this run would embed as its prepare link names an artifact that no longer exists');
  }

  // Hashed the way `prepare-gate.ts`'s `main` hashes every pinned input — sha256 over the file's
  // utf8 TEXT — or the two values could never agree and this would refuse every honest run.
  const manifestSha256 = sha256(manifestText);
  const pinnedManifest = gateSet.payload.inputs?.manifest;
  if (typeof pinnedManifest !== 'string' || pinnedManifest !== manifestSha256) {
    fail('manifest-not-pinned', `this manifest hashes to ${manifestSha256} and the gate set pins ` +
      `${typeof pinnedManifest === 'string' ? pinnedManifest : 'no manifest hash at all'}. The two are not ` +
      'reconciled because there is nothing to reconcile: the gate set froze a denominator of probe IDS, and ' +
      'the queries those ids stand for live only here. A manifest agreeing on every id while differing in a ' +
      'query measures different questions under the frozen denominator\'s name, so it is refused before any ' +
      'rank is taken rather than after three runs and an adjudication have been built on it. An absent pin ' +
      'is refused too, not skipped — a comparison that holds only when neither side exists checks nothing');
  }
  // Reached only once the bytes have been proved to be the pinned ones, which is what makes an
  // unparsable manifest here a PATH problem rather than a gate refusal: the freeze pinned a file
  // that is not a manifest. A bare `SyntaxError` — exit 1, stack into `JSON.parse` — said neither.
  let manifest: Manifest;
  try { manifest = JSON.parse(manifestText) as Manifest; }
  catch (e) {
    return invocationFail('manifest-unparsable', `--manifest hashes to the value the gate set pins ` +
      `(${manifestSha256}) and is not JSON (${(e as Error).message}). The pin is satisfied and the file ` +
      'is still unusable, so this refuses the invocation rather than reporting a method disagreement ' +
      'that does not exist');
  }

  const home = join(snapshotDir, 'home');
  const globalLedger = join(home, 'memory.jsonl');
  const projectRoot = join(snapshotDir, 'proj');
  const projectLedger = projectLedgerPath(projectRoot);

  // The CORPUS, checked the same way the manifest is: sha256 over each ledger file's utf8 text —
  // byte-agreeing with the values `prepare-gate.ts`'s `main` pins as `ledger:global` /
  // `ledger:project` — compared against the gate set's pins before a single rank is taken. Without
  // this the pins sat unread in the same object as `inputs.manifest`, and preparing against
  // snapshot A then running against snapshot B (= A minus a decoy row) passed every check green.
  // An absent pin is refused too, for the reason `manifest-not-pinned` states.
  //
  // The window, stated rather than hidden: these hashes cover the bytes THIS function was handed,
  // while MemoryStore below re-reads the same paths itself. One invocation, same files — but a
  // write landing between the hash and the store's read is not detected here, and nothing in this
  // process can attest that it did not happen.
  const ledgers: RunPayload['ledgers'] = {
    'ledger:global': sha256(ledgerTexts.global),
    'ledger:project': sha256(ledgerTexts.project),
  };
  // The TRUST surface rides in the same comparison: the ledger pins prove the rows, but round 3
  // proved the rows are not what decides a rank on their own — a macNonce swapped inside
  // `projects.json` re-scores every signed verify row under the wrong subkey, and a witness
  // journal removes a whole scope — so the four files those substitutions live in are hashed
  // exactly as `input-pins` pins them (raw bytes, or the literal 'absent') and checked here.
  const trustPaths = snapshotTrustPaths(snapshotDir);
  const trust: RunPayload['trust'] = {
    'ownership:registry': sha256BytesOrAbsent('--snapshot', trustPaths['ownership:registry']!),
    'ownership:owner': sha256BytesOrAbsent('--snapshot', trustPaths['ownership:owner']!),
    'trust:master-key': sha256BytesOrAbsent('--snapshot', trustPaths['trust:master-key']!),
    'trust:witness': sha256BytesOrAbsent('--snapshot', trustPaths['trust:witness']!),
  };
  const snapshotPins: Record<string, string> = { ...ledgers, ...trust };
  for (const name of Object.keys(snapshotPins)) {
    const pin = gateSet.payload.inputs?.[name];
    if (typeof pin !== 'string' || pin !== snapshotPins[name]) {
      fail('snapshot-not-pinned', `${name} hashes to ${snapshotPins[name]} and the gate set pins ` +
        `${typeof pin === 'string' ? pin : 'no hash for it at all'}. The frozen denominator was prepared ` +
        'against specific corpus bytes AND a specific trust surface, and a run against any other measures ' +
        'a different question under the frozen denominator\'s name — the decoy that outranked a target at ' +
        'prepare time can be absent at run time, and a swapped registry nonce re-scores the same rows. ' +
        'Refused before any rank exists');
    }
  }

  // The OWNERSHIP SURFACE, resolved through the same predicate MemoryStore's read paths use
  // (projectDispositionOf — see src/memory/store.ts `projectDisposition()`): the ledger pins above
  // prove the ledger BYTES, but whether the project scope PARTICIPATES is decided by
  // home/projects.json + proj/.helix/.owner, which no ledger hash covers. A snapshot missing the
  // registry silently degraded every project-scope probe to a global-only recall with both ledger
  // pins still matching. The mirror of prepare-gate's `degraded-run` refusal: rows present but the
  // scope would serve none of them is a gate failure, not a smaller corpus.
  const projectDisposition = projectDispositionOf({ root: projectRoot, ledger: projectLedger, home });
  const projectRows = ledgerTexts.project.split('\n').filter((l) => l.trim().length > 0).length;
  if (projectRows > 0 && projectDisposition !== 'owned') {
    fail('degraded-run', `the project ledger contributes ${projectRows} row(s) but its disposition is ` +
      `'${projectDisposition}', so recall would serve none of them. The snapshot must carry the ownership ` +
      'registry (home/projects.json) and the repo-side .owner stamp alongside the ledger bytes');
  }

  // The EXPANSION, resolved HERE and injected below, so the object this check proved present is
  // provably the one the store ranks with: MemoryStore.recall uses `opts.expansion ??
  // defaultExpansion()`, and both this call and the store's fallback resolve from
  // src/memory/expansion.ts's module URL. `defaultExpansion()` returns undefined when
  // `data/semantic-neighbors.json` is missing beside the deployed bundle — a third, argument-less
  // substitution: same gate set, manifest, snapshot and argv, different ranks, and the verdicts
  // cannot detect it because semantically-rescued records carry no lexical evidence.
  const expansion = defaultExpansion();
  if (expansion === undefined) {
    fail('degraded-run', 'the semantic-neighbor asset (data/semantic-neighbors.json) did not resolve ' +
      'beside this executable, so recall would run without query expansion. The absence is invisible in ' +
      'the output — ranks simply differ — which is why it is refused rather than disclosed');
  }
  // Resolvability is not identity: `{"neighbors":{}}` resolves cleanly and removes all query
  // expansion (the round-3 attack a mere availability boolean waved through). The pin hashes the
  // resolved table's CONTENT, so the ranked-with object itself is what is compared.
  const expansionSha256 = expansionTableSha256(expansion);
  const expansionPin = gateSet.payload.inputs?.['expansion:semantic-neighbors'];
  if (typeof expansionPin !== 'string' || expansionPin !== expansionSha256) {
    fail('expansion-not-pinned', `the resolved semantic-neighbor table hashes to ${expansionSha256} and the ` +
      `gate set pins ${typeof expansionPin === 'string' ? expansionPin : 'no expansion hash at all'}. Ranks ` +
      'taken under a different table — an emptied one included — are a different method wearing the frozen ' +
      'denominator\'s name');
  }

  // The REGISTRY must arrive complete. The store MINTS a global scope nonce into
  // `home/projects.json` on first recall when the '@global' entry is missing
  // (ownership.ts globalScopeNonce) — a WRITE into the frozen snapshot: run 1 would mutate an
  // input runs 2 and 3 then read, and any §9 item-2 snapshot hash taken beforehand would no
  // longer match. The runner must not let the store complete a snapshot; it refuses the snapshot
  // as incomplete, and the producer supplies a registry that already carries '@global'.
  let registryComplete = false;
  try {
    const registry = JSON.parse(readFileSync(trustPaths['ownership:registry']!, 'utf8')) as Record<string, unknown>;
    registryComplete = registry !== null && typeof registry === 'object' && Object.hasOwn(registry, '@global');
  } catch { registryComplete = false; }
  if (!registryComplete) {
    fail('snapshot-registry-incomplete', `${trustPaths['ownership:registry']} is absent, unreadable, or has no ` +
      "'@global' entry. The store mints one on first recall — a write into the frozen snapshot — so the " +
      'snapshot must be produced with a complete registry rather than completed by the program measuring it');
  }

  // The WITNESS state, read for each participating scope through the same witness-first reader the
  // store's recall uses (readLedgerBytesWitnessed), BEFORE any rank is taken. A pending journal or
  // a rollback verdict does not fail recall — the store silently EXCLUDES an interrupted scope and
  // CLAMPS a mismatched one's grades — so a run over such a snapshot scores end to end with a
  // scope missing or re-scored and `protocol-population-integrity` reporting PASS (round-3
  // finding 1). The direct pre-check is chosen over inspecting recall()'s witnessNotes because it
  // refuses before the first rank exists and does not depend on note wording.
  const witnessScopes: { scope: string; ledger: string; root?: string }[] = [
    { scope: 'global', ledger: globalLedger },
    ...(projectDisposition === 'owned' ? [{ scope: 'project', ledger: projectLedger, root: projectRoot }] : []),
  ];
  for (const s of witnessScopes) {
    const w = readLedgerBytesWitnessed(s.ledger, home, s.root);
    if (w.journalPending || w.verdict.kind === 'transition-interrupted' || w.verdict.kind === 'mismatch') {
      fail('degraded-run', `the ${s.scope} scope's witness state is '${w.verdict.kind}'` +
        `${w.journalPending ? ' with a pending rewrite journal' : ''}: recall would ` +
        `${w.verdict.kind === 'mismatch' ? 'clamp its grades' : 'exclude the scope entirely'}, so the run ` +
        'would measure a corpus the frozen denominator was not prepared against. A snapshot mid-transition ' +
        'is not a frozen corpus');
    }
  }

  const store = new MemoryStore(globalLedger, {
    home, sessionId: 'pilot', now: () => '2026-01-01T00:00:00.000Z',
    project: { ledger: projectLedger, root: projectRoot },
    expansion,
  });

  const startedAt = now();
  const results: RunResult[] = manifest.probes.map((p) => {
    const items = store.recall(p.query, { maxItems: manifest.k }).items;
    const ranks = p.relevant.map((rid) => items.findIndex((it) => it.record.id === rid) + 1).filter((r) => r > 0);
    const bestRank = ranks.length ? Math.min(...ranks) : null;
    return { id: p.id, query: p.query, unambiguous: p.unambiguous, bestRank,
      hitAtK: bestRank !== null && bestRank <= manifest.k, hitAt1: bestRank === 1,
      returned: items.map((it) => it.record.id) };
  });
  const finishedAt = now();

  // Key order is fixed by construction because this object is hashed.
  const payload: RunPayload = { rule: RULE, k: manifest.k, prepareSha256: gateSet.payloadSha256,
    manifestSha256, ledgers, trust, projectDisposition, expansionSha256, results };
  return {
    artifact: 'run',
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    receipts: {
      runId, startedAt, finishedAt,
      attestation: 'self-reported wall clocks and a run id minted by this process; they show neither that ' +
        'this was the first run nor that preparation finished before it started. §9 item 4 requires an ' +
        'append-only or externally attested receipt for that, which no field a program writes about ' +
        'itself supplies',
    },
  };
};

/** Named flags only, no positionals — the same contract as both gate phases, for the reason
 *  `prepare-gate.ts` records: overlapping positional shapes in `generate-manifest` once lined an
 *  oracle path up with an output slot. An unknown flag is REFUSED rather than ignored, so a
 *  mistyped input can never leave an operator believing a file was taken into account when it was
 *  silently dropped.
 *
 *  What named flags do NOT close, and what an earlier version of this comment wrongly said they
 *  did: an `--out` pointed AT an input. `run-pilot --out <the gate-set path>` exited 0 and left the
 *  gate set replaced by a run artifact, so the frozen denominator this run claims to have been
 *  measured against no longer existed. Slot confusion and destination reuse are different holes;
 *  the second is closed by `refuseOutputCollisions` in `main` (§9 line 376). */
const INPUTS = ['manifest', 'snapshot', 'gate-set', 'out'] as const;
const USAGE = `usage: run-pilot ${INPUTS.map((n) => `--${n} <${n === 'snapshot' ? 'dir' : 'path'}>`).join(' ')}`;

const parseFlags = (argv: string[]): Record<string, string> => {
  const out = flagAccumulator();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      fail('bad-arguments', `expected --name <value> pairs, got '${String(flag)}'`);
    }
    const name = flag!.slice(2);
    if (!(INPUTS as readonly string[]).includes(name)) fail('unknown-input', `--${name} is not an input of the runner`);
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
    const manifest = { arg: '--manifest', path: flags.manifest! };
    const gateSetPath = { arg: '--gate-set', path: flags['gate-set']! };
    // Every path this invocation READS is an input, including the ones no flag names: the two
    // ledgers the run is measured against, the four trust files the pins cover (registry, .owner
    // stamp, master key, witness journal — recall's read path opens each), and the semantic-
    // neighbor asset that resolves module-relative. Round 3 proved the cost of a narrower list on
    // classify-o67: an --out aimed at the absent registry was silently CREATED inside the frozen
    // snapshot, and a present one drew a refusal whose remedy text could not know the file is
    // load-bearing.
    const globalLedger = { arg: '--snapshot', path: join(flags.snapshot!, 'home', 'memory.jsonl') };
    const projectLedger = { arg: '--snapshot', path: projectLedgerPath(join(flags.snapshot!, 'proj')) };
    refuseOutputCollisions(out, [manifest, gateSetPath, globalLedger, projectLedger,
      ...Object.values(snapshotTrustPaths(flags.snapshot!)).map((path) => ({ arg: '--snapshot', path })),
      ...expansionAssetPaths().map((path) => ({ arg: '(semantic-neighbor asset, resolved module-relative)', path }))]);

    // The manifest and both ledgers are handed over as TEXT: the hashes that get checked against the
    // gate set's pins and embedded in the payload, and the probes that get measured, must come from
    // the same bytes, and only the unparsed text can guarantee that.
    const run = runPilot({
      manifestText: readInput(manifest),
      gateSet: parseJsonInput(gateSetPath, readInput(gateSetPath)) as GateSet,
      snapshotDir: flags.snapshot!,
      ledgerTexts: { global: readInput(globalLedger), project: readInput(projectLedger) },
      runId: randomUUID(),
      now: () => new Date().toISOString(),
    });
    writeArtifact(out, JSON.stringify(run, null, 1) + '\n');
    console.log(`run ${run.receipts.runId} over ${run.payload.results.length} probe(s) at K=${run.payload.k}\n` +
      `prepare sha256: ${run.payload.prepareSha256}\nmanifest sha256: ${run.payload.manifestSha256}\n` +
      `payload sha256: ${run.payloadSha256}`);
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
