/** The freeze receipt — the METHOD half of element 1 of §9's evidence chain.
 *
 *  §9 requires "a freeze receipt binding the candidate commit, the configuration, the method and
 *  tool hashes, the cutoff and the close instant", and §9b records that absence as a PRE-FREEZE
 *  obligation rather than something to build afterwards: tooling written after the fact resolves a
 *  method choice with the outcome already visible, which resets the window (§8).
 *
 *  It carries only what is knowable at the freeze instant T, and that restriction is forced by
 *  §9's own ordering — `freeze receipt → close-bounded snapshot → manifest / candidate universe /
 *  classifier → prepare`. A receipt that also pinned the input hashes would be unissuable at its
 *  own ordered position, because none of those four artifacts exists yet at T. Nor could such pins
 *  survive the window: §2 makes the snapshot CLOSE-bounded and §5 recomputes eligibility at the
 *  close, so a hash pinned at the freeze is stale as soon as one row accrues, and a window that
 *  accrued none fails the minimum of 2 anyway. The close-time pins are therefore a second
 *  artifact, `input-pins.ts`, bound back to this one by its payload hash.
 *
 *  What stays here is the method: the candidate commit, the installed runtime, the configuration,
 *  K, the window, the tool hashes and the BINDING rule documents. Every one of them is knowable at
 *  T, and none of them may change during the window without resetting it (§8).
 */
import { execFileSync } from 'node:child_process';
import { join, normalize } from 'node:path';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, parseJsonInput, readInput, readInputBytes,
  refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { RULE } from './gate-set.js';
import {
  PINNED_METHOD_DOCS, PINNED_TOOL_PATHS, gitHashObject, hashMethodDocs, hashTools, sha256Bytes, sha256Hex,
} from './pin-hashes.js';

/** §10 line 436: "runtime bytes actually serving recall — installed plugin `gitCommitSha`, **both
 *  load paths**". Two paths, not one scalar: the deploy runbook verifies the marketplace cache and
 *  the installed copy separately because they have drifted in this very deployment, and a single
 *  number has nowhere to record that the two agreed. */
export interface RuntimeIdentity {
  gitCommitSha: string;
  loadPaths: { path: string; gitCommitSha: string }[];
}

export interface FreezeReceiptPayload {
  rule: string;
  artifactKind: 'freeze-receipt';
  candidateCommit: string;
  runtime: RuntimeIdentity;
  config: { path: string; sha256: string; redactionAcknowledged: true };
  k: number;
  txAfter: string;
  txClose: string;
  windowDays: 28;
  tools: Record<string, string>;
  methodDocs: Record<string, string>;
}

/** §4's payload / receipts split, applied here as everywhere: the deterministic half is hashed and
 *  the wall clock is not. `artifact` names the file so it identifies itself without reference to a
 *  filename (§10). */
export interface FreezeReceipt {
  artifact: 'freeze-receipt';
  payloadSha256: string;
  payload: FreezeReceiptPayload;
  receipts: { issuedAt: string; attestation: string };
}

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;

/** §2 fixes one spelling — `YYYY-MM-DDTHH:MM:SS.sssZ` — and compares the window bounds with a
 *  strict STRING comparison. So `2026-07-21T00:00:00Z` and `2026-07-21T00:00:00.000+00:00` name the
 *  same instant and sort differently against a row's `tx`, silently changing which rows fall in the
 *  window. Round-tripping through `Date` is the second half of the check: the shape alone would
 *  accept `2026-02-30T00:00:00.000Z`, which `Date` rolls over to March without complaint.
 *
 *  The validity test comes BEFORE the round trip, and that order is the whole of it. A shape-valid
 *  instant naming no real time — month 13, hour 25, minute 60 — is not rolled over at all: `Date`
 *  yields `Invalid Date` and `.toISOString()` THROWS, so the refusal escaped as
 *  `RangeError: Invalid time value` with no slug and no statement of what was wrong. Every refusal
 *  here names what it refused and why; an uncaught RangeError names neither. */
const canonicalInstant = (label: string, value: string): string => {
  const ms = new Date(value).getTime();
  if (!CANONICAL.test(value) || Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    fail('non-canonical-instant', `${label} is '${value}'; §2 fixes the canonical UTC spelling ` +
      'YYYY-MM-DDTHH:MM:SS.sssZ and compares window bounds with a strict string comparison, so an ' +
      'equal-but-differently-spelled instant would change which rows fall inside the window — and a ' +
      'spelling that names no real instant at all cannot bound a window');
  }
  return value;
};

/** A plain positive decimal integer, parsed rather than coerced.
 *
 *  `Number()` is a coercion, not a parser: it reads `2e1`, `0x14`, ` 20 ` and `+20` as 20, and
 *  `1e-0` as 1. The first four pin the right K under a spelling §10 does not use; the last pins a
 *  DIFFERENT METHOD — K is the cutoff every metric is defined against (§3) — and produces a receipt
 *  that is well-formed, correctly hashed, and wrong. Leading zeros are refused for the same reason
 *  a non-canonical instant is: one value must have one spelling, or two receipts can pin the same
 *  method under two different strings. */
export const decimalInteger = (label: string, text: string): number => {
  if (!/^[1-9][0-9]*$/.test(text)) {
    fail('non-integer-k', `${label} is '${text}'; it must be a plain positive decimal integer. ` +
      'Number() would coerce this instead of parsing it, and a coercion that succeeds on 1e-0 pins ' +
      'K=1 — a different method under a valid-looking receipt');
  }
  return Number(text);
};

/** A git object id in either format — 40 hex for sha1 repositories, 64 for sha256 ones.
 *
 *  Lowercase only, and no surrounding whitespace: both are what git itself emits, and accepting a
 *  looser spelling would let two receipts pin the same commit under two different strings, which is
 *  exactly the drift a pin exists to prevent. A truncated id is refused rather than expanded,
 *  because resolving an abbreviation requires the repository — and the receipt must stay checkable
 *  by a reader who has only the file. */
const objectId = (label: string, value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) {
    fail('malformed-object-id', `${label} is '${String(value)}', which is not a full 40-hex (sha1) or 64-hex ` +
      '(sha256) git object id in lowercase. §10 pins the candidate commit and the installed runtime ' +
      'SEPARATELY and both are re-verified at the close, so neither may be an abbreviation, a branch ' +
      'name, or an empty placeholder');
  }
  return value as string;
};

/** Validate and NORMALISE the runtime identity read from `--runtime`.
 *
 *  Normalised because the result goes into a hashed payload: anything else the runtime file happens
 *  to carry would otherwise ride into `payloadSha256`, and two receipts describing the same runtime
 *  would differ for reasons no reader could see.
 *
 *  The disagreement case is a REFUSAL rather than a disclosure, because there is no honest way to
 *  pick. If the cache and the installed copy carry different bytes, the operator does not know
 *  which one served recall, and §10 verifies both again at the close — a receipt that recorded one
 *  of them would be re-verified against a claim it had already chosen to believe. */
const runtimeIdentity = (value: unknown): RuntimeIdentity => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('malformed-runtime-identity', `--runtime must name a JSON object { gitCommitSha, loadPaths: [{ path, ` +
      `gitCommitSha }, ...] } — the installed plugin's identity as docs/release/deploy-runbook.md verifies it. ` +
      `Got ${JSON.stringify(value)}`);
  }
  const v = value as { gitCommitSha?: unknown; loadPaths?: unknown };
  const gitCommitSha = objectId('the runtime gitCommitSha', v.gitCommitSha);
  if (!Array.isArray(v.loadPaths)) {
    fail('malformed-runtime-identity', `the runtime identity's loadPaths is ${JSON.stringify(v.loadPaths)}; it must ` +
      'be the array of installed copies the runbook checks');
  }
  const raw = v.loadPaths as { path?: unknown; gitCommitSha?: unknown }[];
  if (raw.length < 2) {
    fail('runtime-load-paths-insufficient', `the runtime identity lists ${raw.length} load path(s). §10 line 436 ` +
      'pins the runtime as the installed gitCommitSha at BOTH load paths, and a single path records no ' +
      'agreement at all — the whole point of the pin is that two independently installed copies were the ' +
      'same bytes');
  }
  const loadPaths = raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path === '') {
      fail('malformed-runtime-identity', `load path ${i} is ${JSON.stringify(entry)}; each one needs a non-empty ` +
        'path, because a hash with no path attached says which bytes were installed but not where');
    }
    // NORMALIZED into the hashed payload: '/a//x' and '/a/./x' are one path, and recording the
    // operator's spelling would let two receipts describing one runtime differ by a '//' no
    // reader would notice — the same one-value-one-spelling rule the object ids follow.
    return { path: normalize(entry.path as string), gitCommitSha: objectId(`load path ${i} (${String(entry.path)}) gitCommitSha`, entry.gitCommitSha) };
  });
  const seen = new Set<string>();
  for (const { path } of loadPaths) {
    if (seen.has(path)) {
      fail('runtime-load-paths-duplicate', `${path} is listed twice (after path normalization). That is one ` +
        'load path wearing two rows, which satisfies the count without establishing the agreement the count ' +
        'stands for. These paths are DECLARED, never opened, so normalization is as far as this check can ' +
        'honestly reach: two spellings that alias one file through a symlink or case folding are beyond it');
    }
    seen.add(path);
  }
  const disagreeing = loadPaths.filter((p) => p.gitCommitSha !== gitCommitSha);
  if (disagreeing.length > 0) {
    fail('runtime-load-paths-disagree', `the runtime declares ${gitCommitSha} but ` +
      `${disagreeing.map((p) => `${p.path} carries ${p.gitCommitSha}`).join('; ')}. Which bytes served recall is ` +
      'then unknown, and §10 re-verifies both paths at the close — recording one of them here would only ' +
      'restate a choice this receipt has no basis to make');
  }
  return { gitCommitSha, loadPaths };
};

/** §2 lines 74-79: the cutoff is the freeze commit's authored time, and the document names the
 *  derivation as a trap that "must not be repeated" — the wrong `--date` spelling renders in the
 *  commit's own timezone and a literal `Z` then lies by the author's UTC offset. This is that exact
 *  command, and its result is COMPARED against the operator's `--cutoff` rather than substituted
 *  for it: a value the operator states and the repository confirms is checked; a value the tool
 *  computes silently is merely computed twice. */
export const gitCommitAuthoredAt = (repoRoot: string) => (commit: string): string => {
  // The object TYPE is checked first, because `git log <id>` silently PEELS an annotated tag to
  // the commit it points at: the authored-time verification would then pass against the peeled
  // commit while the receipt records the tag's own id — one method pinnable under two different
  // strings, which is exactly the drift `objectId`'s one-value-one-spelling rule exists to prevent.
  let type: string;
  try {
    type = execFileSync('git', ['cat-file', '-t', commit],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return fail('commit-unresolved', `${commit} does not resolve to a commit in ${repoRoot} ` +
      `(${(e as Error).message.trim()}). Pinning a commit the repository cannot produce is not a freeze: nothing ` +
      'downstream could ever check the method against it');
  }
  if (type !== 'commit') {
    fail('not-a-commit', `${commit} resolves to a ${type} object, not a commit. An annotated tag names the ` +
      'same commit under a second id, and git log would silently peel it — the cutoff check would then pass ' +
      'against the peeled commit while the receipt pinned the tag, one method under two different strings');
  }
  try {
    return execFileSync('git',
      ['log', '-1', '--format=%ad', '--date=format-local:%Y-%m-%dT%H:%M:%S.000Z', commit, '--'],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return fail('commit-unresolved', `${commit} does not resolve to a commit in ${repoRoot} ` +
      `(${(e as Error).message.trim()}). Pinning a commit the repository cannot produce is not a freeze: nothing ` +
      'downstream could ever check the method against it');
  }
};

/** The candidate commit's own bytes for each pinned path — `null` when the commit does not carry
 *  the path. Read with `git cat-file blob`, which emits the exact object bytes with no filters, so
 *  the comparison is byte-for-byte against what the working tree hashes. A per-path failure is
 *  read as ABSENT rather than an error: the commit itself has already resolved (the authored-time
 *  check runs first), so the remaining reason `cat-file` refuses is that the path is not in it. */
export const pinnedBytesAtCommitFrom = (repoRoot: string) =>
  (commit: string, relPaths: string[]): Record<string, Buffer | null> => {
    const out: Record<string, Buffer | null> = {};
    for (const rel of relPaths) {
      try {
        out[rel] = execFileSync('git', ['cat-file', 'blob', `${commit}:${rel}`],
          { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { out[rel] = null; }
    }
    return out;
  };

export const freezeReceipt = (input: {
  candidateCommit: string;
  runtime: RuntimeIdentity;
  configPath: string;
  configBytes: Buffer;
  cutoff: string;
  k: number;
  tools: Record<string, string>;
  methodDocs: Record<string, string>;
  commitAuthoredAt: (commit: string) => string;
  pinnedBytesAtCommit: (commit: string, relPaths: string[]) => Record<string, Buffer | null>;
  now: () => string;
}): FreezeReceipt => {
  const { configPath, configBytes, k, tools, methodDocs, commitAuthoredAt, pinnedBytesAtCommit, now } = input;

  // §10 keeps these two apart on purpose: a repository commit is not proof of what is INSTALLED,
  // and this deployment has already produced a window where the two disagreed. So they are
  // validated and recorded separately and never reconciled into one identity.
  const candidateCommit = objectId('the candidate commit', input.candidateCommit);
  const runtime = runtimeIdentity(input.runtime);
  if (!Number.isInteger(k) || k <= 0) {
    fail('non-integer-k', `k is ${k}; it is the top-K cutoff every metric is defined against (§3), so a ` +
      'fractional, zero or negative value does not name a measurable method');
  }

  const txAfter = canonicalInstant('the cutoff', input.cutoff);
  // The cutoff is DERIVED information that the operator retypes, so it is checked against its
  // source. §2 defines it as the freeze commit's authored time; an off-by-one-second transcription
  // produces a perfectly well-formed receipt and moves the window's open edge across every row
  // minted in between.
  const authored = commitAuthoredAt(candidateCommit);
  if (authored !== txAfter) {
    fail('cutoff-not-commit-time', `--cutoff is ${txAfter} but ${candidateCommit} was authored at ${authored} ` +
      '(TZ=UTC git log -1 --format=%ad --date=format-local). §2 defines the cutoff as the freeze commit\'s ' +
      'authored time and names the mis-rendered-timezone version of this derivation as a trap that must not ' +
      'be repeated, so the two are required to agree rather than reconciled');
  }
  // The close is COMPUTED, never an input. Two operator-supplied instants can disagree — and a
  // 28-day window whose bounds disagree is not the preregistered window, however plausible each
  // bound looks alone. One derived from the other cannot disagree. `toISOString` also emits the
  // canonical spelling by construction, so the close needs no separate format check.
  const txClose = new Date(new Date(txAfter).getTime() + WINDOW_DAYS * DAY_MS).toISOString();

  // The working tree must BE the candidate commit for every pinned path. The tool and document
  // hashes describe the bytes on disk — the bytes that will actually run — while `candidateCommit`
  // is the id a reader will resolve; this repository once froze HEAD while run-pilot.ts differed
  // from HEAD and freeze-receipt.ts existed in no commit, at exit 0, and the receipt disclosed
  // nothing. A receipt pinning bytes its named commit does not contain is a contradiction wearing
  // a valid hash, so divergence REFUSES the freeze. There is deliberately no override flag: the
  // repair is to commit, not to attest around it.
  const commitView = pinnedBytesAtCommit(candidateCommit, [...Object.keys(tools), ...Object.keys(methodDocs)]);
  const diverged: string[] = [];
  for (const [rel, expected] of Object.entries(tools)) {
    const bytes = commitView[rel];
    const atCommit = bytes == null ? null : gitHashObject(bytes);
    if (atCommit !== expected) {
      diverged.push(`${rel} (working tree ${expected}, ${atCommit === null ? 'ABSENT from the commit' : `commit ${atCommit}`})`);
    }
  }
  for (const [rel, expected] of Object.entries(methodDocs)) {
    const bytes = commitView[rel];
    const atCommit = bytes == null ? null : sha256Bytes(bytes);
    if (atCommit !== expected) {
      diverged.push(`${rel} (working tree ${expected}, ${atCommit === null ? 'ABSENT from the commit' : `commit ${atCommit}`})`);
    }
  }
  if (diverged.length > 0) {
    fail('tree-commit-divergence', `the working tree is not ${candidateCommit} for ${diverged.length} pinned ` +
      `path(s): ${diverged.join('; ')}. The receipt would pin bytes its named commit does not contain, and a ` +
      'reader resolving the commit would get a contradiction the artifact never warned about. Commit the ' +
      'candidate state first; there is no flag to attest around this');
  }

  const payload: FreezeReceiptPayload = {
    rule: RULE,
    artifactKind: 'freeze-receipt',
    candidateCommit,
    runtime,
    config: {
      // The path as the operator named it. It says WHICH file was hashed — a bare hash names
      // nothing — and it does not prove the file was `~/.helix/config.json`; the sha256 is the
      // binding part. `redactionAcknowledged` is likewise a DECLARATION, not a check: §10 pins the
      // redacted form, and nothing here inspects the bytes for secrets.
      path: configPath,
      // Hashed as BYTES. Unlike the five close-time `inputs`, which `prepare-gate` re-reads as
      // utf8 text and must therefore be hashed through the same decode, this hash has no
      // counterparty — and a utf8 decode maps every invalid byte to U+FFFD, so two configurations
      // differing only in one such byte would pin identically.
      sha256: sha256Bytes(configBytes),
      redactionAcknowledged: true,
    },
    k,
    txAfter,
    txClose,
    windowDays: WINDOW_DAYS,
    tools,
    methodDocs,
  };

  return {
    artifact: 'freeze-receipt',
    payloadSha256: sha256Hex(JSON.stringify(payload)),
    payload,
    receipts: {
      issuedAt: now(),
      attestation: 'self-reported wall clock; §9 states that no self-attested timestamp proves no earlier ' +
        'pass occurred, so this field dates the receipt and proves nothing about what ran before it',
    },
  };
};

/** Named flags only, no positionals, unknown flags refused — the contract `prepare-gate.ts:260-266`
 *  states and the reason it gives applies here unchanged: overlapping positional shapes in
 *  `generate-manifest` once lined an oracle path up with an output slot and overwrote a hash-pinned
 *  artifact.
 *
 *  Note which flags are ABSENT. There is no `--manifest`, `--classifier`, `--universe` or
 *  `--snapshot`: §9 orders those artifacts three steps AFTER this one, so at the freeze instant
 *  they do not exist and a receipt demanding them could never be issued at its own position. They
 *  belong to `input-pins.ts`, which runs at the close. */
const INPUTS = ['commit', 'runtime', 'config', 'cutoff', 'k', 'out'] as const;
const USAGE = `usage: freeze-receipt ${INPUTS.map((n) => `--${n} <value>`).join(' ')}\n` +
  '  --cutoff is the canonical UTC freeze instant, VERIFIED against --commit\'s authored time;\n' +
  '  the close is DERIVED as cutoff + 28 days. --runtime is the installed plugin identity JSON\n' +
  '  { gitCommitSha, loadPaths: [{ path, gitCommitSha }, ...] }, both load paths required.\n' +
  '  Run from the repository root: the tool hashes of §10 are read from the working tree.';

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
      // `--close` and `--tx-close` land here on purpose. The close instant is DERIVED, and offering
      // it as a flag is what would let two operator-supplied bounds disagree.
      fail('unknown-input', `--${name} is not an input of the freeze. Note in particular that the close ` +
        'instant is not one: it is computed as cutoff + 28 days, because two separately supplied ' +
        'bounds can disagree and one derived from the other cannot. Neither are the close-time ' +
        'artifacts: those are pinned by input-pins, which §9 orders three steps later');
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
    const runtimePath = { arg: '--runtime', path: flags.runtime! };
    const configPath = { arg: '--config', path: flags.config! };
    // §10's tool table and the two binding rule documents are read from the WORKING TREE and hashed
    // into the payload, which makes every one of them an input of this invocation even though no
    // flag names them. An `--out` aimed at one would overwrite a pinned input after it had been
    // hashed — the shape §9 line 376 refuses, and the shape this file's own header once wrongly
    // credited named flags with having closed.
    const pinnedFromTree = [...PINNED_TOOL_PATHS, ...PINNED_METHOD_DOCS]
      .map((rel) => ({ arg: '(pinned from the working tree by §10)', path: join(process.cwd(), rel) }));
    refuseOutputCollisions(out, [runtimePath, configPath, ...pinnedFromTree]);

    // Refusals from `freezeReceipt` throw and exit 1: those are refusals of the FREEZE — "this is
    // not a freezable state". A path that cannot be read, parsed or created exits 2 through the
    // catch below: "you called it wrong". Until X3 was fixed both came back as 1.
    const runtime = parseJsonInput(runtimePath, readInput(runtimePath));

    const receipt = freezeReceipt({
      candidateCommit: flags.commit!,
      runtime: runtime as RuntimeIdentity,
      configPath: flags.config!,
      // No encoding: the bytes are the pin. See `config.sha256` above for why this one differs from
      // the five utf8-decoded input hashes.
      configBytes: readInputBytes(configPath),
      cutoff: flags.cutoff!,
      k: decimalInteger('--k', flags.k!),
      // The working tree is the authority for the tool hashes, not the commit id: §10's pins must
      // describe the bytes that will actually run, and a clean-looking commit is not proof of what is
      // on disk. This is why the CLI must be run from the repository root.
      tools: hashTools(process.cwd()),
      methodDocs: hashMethodDocs(process.cwd()),
      commitAuthoredAt: gitCommitAuthoredAt(process.cwd()),
      pinnedBytesAtCommit: pinnedBytesAtCommitFrom(process.cwd()),
      now: () => new Date().toISOString(),
    });

    writeArtifact(out, JSON.stringify(receipt, null, 1) + '\n');
    console.log(`freeze receipt issued for ${receipt.payload.candidateCommit} (runtime ` +
      `${receipt.payload.runtime.gitCommitSha} at ${receipt.payload.runtime.loadPaths.length} load paths)\n` +
      `window ${receipt.payload.txAfter} .. ${receipt.payload.txClose} (${receipt.payload.windowDays} days, ` +
      'close DERIVED, cutoff verified against the commit)\n' +
      `payload sha256: ${receipt.payloadSha256}\n` +
      'The close-time input pins are NOT in this receipt (§9 orders them later): run input-pins at the close.');
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
