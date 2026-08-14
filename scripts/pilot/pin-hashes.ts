/** The hashing the freeze pins with — and an UNGUARDED module on purpose, so both a CLI and the
 *  tests can import it (`snapshot.ts` records why a guarded module may never be imported by another
 *  `scripts/pilot/*.ts`, and `test/pilot/entry-point-isolation.test.ts` holds that rule in place).
 *
 *  It exists because `prepare-gate.ts` consumes a pins file it cannot produce. That file is the
 *  method identity a run is compared against — `k`, the window bounds, and a hash per input — and
 *  until now it was TYPED BY HAND. An artifact whose whole purpose is to catch the operator's
 *  mistakes, authored by the same operator, catches nothing: a mistyped hash is refused (loudly,
 *  which is fine), but a pin copied from the wrong file, or from a file edited afterwards, is
 *  accepted and silently redefines what was measured. Deriving the pins from the same bytes the
 *  prepare phase will read removes the transcription step entirely.
 *
 *  Three hash functions, and they are not interchangeable. `sha256Hex` covers CONTENT the pipeline
 *  compares and must therefore reproduce the pipeline's own utf8 decode; `sha256Bytes` covers
 *  content with no such counterparty, where decoding first would only discard distinctions;
 *  `gitHashObject` covers TOOLING, because §10 pins the pilot scripts by `git hash-object` so that
 *  any reader can reproduce a pin with a command they already have. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectLedgerPath } from '../../src/memory/ownership.js';
import type { Expansion } from '../../src/memory/retrieval.js';
import { invocationFail, readInput } from './artifact-io.js';

/** Everything this module refuses is a file it could not READ, and every one of them is an
 *  INVOCATION error (exit 2), never a gate refusal (exit 1). A missing tool means the CLI was run
 *  from somewhere other than the repository root; a missing ledger means `--snapshot` names the
 *  wrong directory. Both are arguments the operator retypes, and both used to come back with the
 *  gate's own exit code (finding X3). */
const fail = invocationFail;

/** UTF-8 sha256, matching `prepare-gate.ts:298` exactly. The encoding is part of the contract: the
 *  prepare phase reads its inputs as utf8 text and hashes the string, so hashing the raw buffer
 *  here would disagree on any file carrying a BOM or a lone surrogate and refuse a healthy run. */
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 of the RAW BYTES — for the pins that have no counterparty reproducing a decode.
 *
 *  Not a stylistic variant of the above. A utf8 decode maps every ill-formed byte sequence to
 *  U+FFFD, so two files differing only in an invalid byte decode to the same string and hash
 *  identically. That is acceptable for the five `inputs`, where matching `prepare-gate`'s decode
 *  is the actual contract; it is not acceptable for the configuration and the rule documents,
 *  where the hash's only job is to identify the file, and where an outside reader reproduces it
 *  with `sha256sum` — which hashes bytes. */
export const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** RAW-BYTES pin for a file whose ABSENCE is itself a pinnable state: the literal string 'absent'
 *  when the file does not exist (ENOENT only), the byte hash otherwise.
 *
 *  The sentinel is not a convenience. The four trust files are legitimately optional — a snapshot
 *  taken before any key was minted carries none of them — so a pin that refused an absent file
 *  would refuse honest corpora, while a pin that silently skipped it would let a file APPEAR
 *  between pinning and scoring with nothing recording the change. Producer and every verifier
 *  apply the same rule, so present-vs-absent is compared exactly like any two hashes.
 *
 *  ENOENT is the ONLY spelling of absent. A directory at the path, EACCES, an I/O error — none of
 *  those says "this deployment has no such file"; they say the snapshot is broken, which is an
 *  invocation error, never a sentinel that would pin a broken snapshot as a keyless one. */
export const sha256BytesOrAbsent = (arg: string, path: string): string => {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return invocationFail('input-unreadable', `${arg} ${path} exists but could not be read as bytes ` +
      `(${(e as Error).message}). Only a genuinely missing file (ENOENT) pins as 'absent'; anything else is ` +
      'a broken snapshot, and pinning it as absent would record a state the corpus is not in');
  }
  return sha256Bytes(bytes);
};

/** Content hash of the RESOLVED semantic-neighbor table — the `expansion:semantic-neighbors` pin.
 *
 *  It hashes the TABLE, not the asset file, because the table is what recall ranks with: two asset
 *  spellings that resolve to one table are one method, and — the round-3 finding — an asset swapped
 *  for `{"neighbors":{}}` resolves cleanly, removes all query expansion, and left every
 *  then-current pin green. Under a content hash the empty table pins to a value no non-empty table
 *  can produce, so that substitution is a pin mismatch like any other.
 *
 *  Serialization: `JSON.stringify(['helix-expansion-table-v1', entries])` where `entries` is the
 *  table as `[token, [[neighborToken, weight], ...]][]`, tokens sorted by code unit and each
 *  neighbor list sorted by (neighborToken, weight). Every level is sorted so identical CONTENT
 *  hashes identically across processes regardless of Map insertion order or the asset's list
 *  order; the version marker keeps the empty table's hash distinct from the hash of any other
 *  degenerate serialization this function might ever be compared against. */
export const expansionTableSha256 = (table: Expansion): string => {
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...table.keys()].sort(byCodeUnit).map((token) => [
    token,
    [...(table.get(token) ?? [])]
      .map((e) => [e.token, e.w] as [string, number])
      .sort((a, b) => byCodeUnit(a[0], b[0]) || a[1] - b[1]),
  ]);
  return sha256Hex(JSON.stringify(['helix-expansion-table-v1', entries]));
};

/** The four snapshot files pinned by RAW BYTES, at the exact paths the runtime reads them from —
 *  `projects.json` / `ledger-mac-master.key` / `witness.json` under the snapshot's home (the
 *  TRUST_FILE_NAMES layout, src/memory/trust-store-layout.ts), and the `.owner` stamp under
 *  `<projectRoot>/.helix` exactly as ownership.ts's (private) ownerFile helper spells it
 *  (src/memory/ownership.ts:27).
 *
 *  WHY these are pinned at all: the ledger hashes cover the rows but not the trust surface that
 *  decides how the rows are SCORED. Round 3 proved both halves live: a macNonce swapped inside
 *  projects.json flips a rank with every then-current pin green, because TRUST_PENALTY replays the
 *  signed verify rows under a subkey derived from the master key + macNonce — wrong nonce, no
 *  verify, penalized rank; and a planted witness journal removes a whole scope from recall. Every
 *  such substitution is a byte change in one of these four files, so pinning the bytes makes it a
 *  pin mismatch instead of a silent re-scoring. */
export const snapshotTrustPaths = (snapshotDir: string): Record<string, string> => ({
  'ownership:registry': join(snapshotDir, 'home', 'projects.json'),
  'ownership:owner': join(snapshotDir, 'proj', '.helix', '.owner'),
  'trust:master-key': join(snapshotDir, 'home', 'ledger-mac-master.key'),
  'trust:witness': join(snapshotDir, 'home', 'witness.json'),
});

/** The filesystem paths the semantic-neighbor asset MAY resolve from — mirroring the candidate
 *  list inside `src/memory/expansion.ts`'s `defaultExpansion` (source-tree spelling first, then
 *  the beside-the-bundle spelling), which does not export its resolution. The mirror is safe in
 *  both layouts: in the source tree this module and expansion.ts sit two directories under the
 *  repo root, so `../../data` names the same directory from either; in a bundle the two modules
 *  are one file with one URL. Used for collision INPUT LISTS — the asset is an ambient input no
 *  argument names, and a CLI whose recall reads it must refuse an --out aimed at it. Entries may
 *  not exist; an input list tolerates absent paths. */
export const expansionAssetPaths = (): string[] => [
  new URL('../../data/semantic-neighbors.json', import.meta.url),
  new URL('../data/semantic-neighbors.json', import.meta.url),
].map((u) => fileURLToPath(u));

/** The git blob id — `sha1("blob " + byteLength + "\0" + content)`.
 *
 *  Computed in process rather than by shelling out to `git hash-object`, because the freeze receipt
 *  must be producible from the bytes on disk without depending on a repository being present, a
 *  working tree being clean, or `core.autocrlf` rewriting the content on the way past. The length
 *  is the BYTE length, not the character count, which is why this takes a Buffer: hashing
 *  `text.length` would silently produce a wrong-but-well-formed id for any non-ASCII file.
 *
 *  `test/pilot/freeze-receipt.test.ts` pins the equivalence against the real command. A blob id
 *  that only this program can reproduce would pin nothing an outside reader could check. */
export const gitHashObject = (bytes: Buffer | string): string => {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return createHash('sha1').update(Buffer.from(`blob ${body.length}\0`, 'utf8')).update(body).digest('hex');
};

/** Every program the measured method runs, pinned by `git hash-object`. Repo-relative, and the
 *  first ten plus `src/memory/retrieval.ts` are §10's own rows in the table's order, so a reader
 *  can walk the receipt against the document row by row.
 *
 *  The rows after `run-pilot.ts` are NOT in §10's table, which predates them, and they fall in
 *  two groups. The six pilot files are the producers §9b records as having none — the freeze
 *  receipt, the input pins, the ordering receipt and the release record — plus the hashing and the
 *  artifact IO all of them share: a pin table that covers the measured pipeline but not the
 *  programs that ISSUE its evidence would leave the chain's own tooling free to change without any
 *  receipt showing it. The eight `src/memory` modules after `retrieval.ts` are the rank path the
 *  round-3 verifier enumerated — every module between the ledger bytes and a rank: the store, the
 *  expansion loader, the ownership predicate, the verified-read/projection trust layer, and the
 *  witness classification. §10's original row pinned the ranking ALGORITHM and left the modules
 *  the ranks flow THROUGH unpinned, which is the structural reason the witness/macNonce/expansion
 *  substitutions existed at all — and the tree-vs-commit divergence check covers exactly the paths
 *  in this list, so a module absent from it can diverge from the candidate commit unnoticed.
 *  Deeper imports (types, locks, framing) carry no rank-deciding behaviour and stay out; the
 *  boundary is "decides a rank or issues the evidence".
 *
 *  `segment-oracle.ts` is absent because v2 has no oracle side (§1), and adding it would pin a
 *  program the measured method never runs. The order is fixed by construction: it is the key order
 *  of the `tools` map, and that map is inside a hashed payload.
 *
 *  The last row is the only entry outside `scripts/pilot/` and `src/memory/`, and it was added at
 *  the SECOND freeze rather than the first. `scripts/close/adjudication-skeleton.ts` writes the
 *  `--adjudication` input `score-gate.ts` requires, which puts it squarely inside this list's
 *  boundary — it issues evidence the gate then reads. It is pinned for a second reason the other
 *  rows did not need: writing it inside the first window is what RESET that window under the
 *  preregistration's Reset clause, and the clause is about the ACT of building method tooling, not
 *  about where the file sits. Leaving it unpinned would have left the mechanical check (which
 *  covers exactly the paths in this list) blind to the one edit class that has already voided a
 *  window once. Its TEST is deliberately NOT pinned: the list pins no test file, for any of the
 *  sixteen pilot tools either, and a test neither decides a rank nor issues evidence — pinning it
 *  would criminalise ordinary in-window test work while protecting nothing, since the program it
 *  covers is already sealed by the row above. */
export const PINNED_TOOL_PATHS = [
  'scripts/pilot/derive.ts',
  'scripts/pilot/generate-manifest.ts',
  'scripts/pilot/snapshot.ts',
  'scripts/pilot/classify-o67.ts',
  'scripts/pilot/candidate-universe.ts',
  'scripts/pilot/gate-set.ts',
  'scripts/pilot/prepare-gate.ts',
  'scripts/pilot/score-gate.ts',
  'scripts/pilot/binomial.ts',
  'scripts/pilot/run-pilot.ts',
  'scripts/pilot/freeze-receipt.ts',
  'scripts/pilot/input-pins.ts',
  'scripts/pilot/ordering-receipt.ts',
  'scripts/pilot/release-record.ts',
  'scripts/pilot/pin-hashes.ts',
  'scripts/pilot/artifact-io.ts',
  'src/memory/retrieval.ts',
  'src/memory/store.ts',
  'src/memory/expansion.ts',
  'src/memory/ownership.ts',
  'src/memory/verified-read.ts',
  'src/memory/verified-projection.ts',
  'src/memory/witness-store.ts',
  'src/memory/witness-read.ts',
  'src/memory/witness-core.ts',
  'scripts/close/adjudication-skeleton.ts',
] as const;

/** The BINDING rule documents, pinned by sha256 of their bytes.
 *
 *  §10 line 452 asks for `o67-class-rule-2026-07.md` explicitly, and the preregistration's
 *  governing-texts line names both of these BINDING. §9's element 1 wants "the method and tool
 *  hashes": these documents ARE the method. Nothing else in the receipt covers them —
 *  `inputs.classifier` hashes the classifier's OUTPUT, which is what the rule produced, not the
 *  rule it applied, so the class rule could be amended and every other pin would still match.
 *
 *  The preregistration itself is deliberately absent: §10 says it cannot pin its own hash, and
 *  what binds it is the freeze commit id that this receipt already carries. */
export const PINNED_METHOD_DOCS = [
  'docs/release/o67-class-rule-2026-07.md',
  'docs/release/gate-decision-2026-07-22.md',
] as const;

/** sha256 of each rule document, read as BYTES from the working tree.
 *
 *  Unreadable is fatal for the same reason a missing tool is: there is no "not applicable"
 *  spelling for a binding method document, and a smaller map still hashes to a valid payload, so
 *  the gap would be invisible afterwards. */
export const hashMethodDocs = (repoRoot: string): Record<string, string> => {
  const docs: Record<string, string> = {};
  for (const rel of PINNED_METHOD_DOCS) {
    try { docs[rel] = sha256Bytes(readFileSync(join(repoRoot, rel))); }
    catch (e) {
      fail('method-doc-unreadable', `${rel} could not be read under ${repoRoot} (${(e as Error).message}). It is ` +
        'BINDING under the preregistration\'s governing-texts line, and a freeze receipt that skipped it ' +
        'would pin the pipeline while leaving the rule the pipeline applies unpinned');
    }
  }
  return docs;
};

/** Blob ids for all of them, read as BYTES from the working tree.
 *
 *  Unreadable is fatal rather than omitted. §10's tooling rows have no "not applicable" spelling,
 *  so a receipt missing one would pin a method whose implementation it never saw — and the gap
 *  would be invisible afterwards, because a smaller `tools` map still hashes to a valid payload. */
export const hashTools = (repoRoot: string): Record<string, string> => {
  const tools: Record<string, string> = {};
  for (const rel of PINNED_TOOL_PATHS) {
    try { tools[rel] = gitHashObject(readFileSync(join(repoRoot, rel))); }
    catch (e) {
      fail('tool-unreadable', `${rel} could not be read under ${repoRoot} (${(e as Error).message}). §10 pins ` +
        'every one of these by git hash-object, and a receipt that skipped one would pin a method whose ' +
        'implementation it never read');
    }
  }
  return tools;
};

/** The TEN pinned inputs, named and hashed EXACTLY as `prepare-gate.ts`'s main supplies them.
 *
 *  This coupling is load-bearing and deliberately duplicated rather than shared: the prepare phase
 *  must be able to refuse a pins file, which means it has to compute its own hashes independently
 *  instead of importing them from whatever produced the pins. So the two agree by TEST, not by
 *  construction. A drift in a name trips `input-set-mismatch`; a drift in the hashing trips
 *  `input-hash-mismatch`. Either way the freeze receipt would emit pins the prepare phase rejects,
 *  which is a safe failure but a useless artifact.
 *
 *  Three hashing disciplines in one map, each stated where it is defined: the five TEXT inputs
 *  keep the utf8 decode the prepare phase reproduces (`sha256Hex`); the four TRUST files are
 *  pinned by raw bytes with the 'absent' sentinel (`sha256BytesOrAbsent`), because their absence
 *  is itself a pinnable deployment state; the expansion pin hashes the RESOLVED table
 *  (`expansionTableSha256`), because the table is what recall ranks with. The caller supplies the
 *  table it resolved rather than a path, so the pin describes the object that will actually rank —
 *  not whichever asset file happened to sit beside some bundle.
 *
 *  The ledger paths are resolved the same way the runtime resolves them — `<snapshot>/home/
 *  memory.jsonl` for the global scope and `projectLedgerPath(<snapshot>/proj)` for the project
 *  one, the latter through `ownership.ts` rather than a second literal `.helix/memory.jsonl`
 *  spelling — and the four trust paths come from `snapshotTrustPaths` above for the same reason. */
export const hashPinnedInputs = (
  snapshotDir: string,
  paths: { manifest: string; classifier: string; universe: string },
  expansion: Expansion,
): Record<string, string> => {
  // Through `readInput`, so an absent file is `input-unreadable` on the flag that named it rather
  // than a raw `node:fs` stack. The two ledgers carry `--snapshot` as their flag: no flag names
  // them directly, and the directory that does is the argument an operator would correct.
  const h = (arg: string, path: string) => sha256Hex(readInput({ arg, path }));
  const trust = snapshotTrustPaths(snapshotDir);
  return {
    manifest: h('--manifest', paths.manifest),
    classifier: h('--classifier', paths.classifier),
    universe: h('--universe', paths.universe),
    'ledger:global': h('--snapshot', join(snapshotDir, 'home', 'memory.jsonl')),
    'ledger:project': h('--snapshot', projectLedgerPath(join(snapshotDir, 'proj'))),
    'ownership:registry': sha256BytesOrAbsent('--snapshot', trust['ownership:registry']!),
    'ownership:owner': sha256BytesOrAbsent('--snapshot', trust['ownership:owner']!),
    'trust:master-key': sha256BytesOrAbsent('--snapshot', trust['trust:master-key']!),
    'trust:witness': sha256BytesOrAbsent('--snapshot', trust['trust:witness']!),
    'expansion:semantic-neighbors': expansionTableSha256(expansion),
  };
};
