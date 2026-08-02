/** The close-time input pins — the second half of §9's element 1, and the file `prepare-gate.ts`
 *  compares every input against.
 *
 *  It is a separate artifact from the freeze receipt because §9's ordering makes it one. The chain
 *  runs `freeze receipt → close-bounded snapshot → manifest / candidate universe / classifier →
 *  prepare`, so at the instant the freeze is issued NONE of the four hashed artifacts exists yet.
 *  A single receipt carrying both the method and the input hashes would be unissuable at its own
 *  ordered position, and issuing it later is exactly what §8 calls resolving a method choice with
 *  the outcome in view. Worse, the pins could not survive the window even if backdated: §2 makes
 *  the snapshot CLOSE-bounded and §5 recomputes eligibility at the close, so any hash pinned at the
 *  freeze is stale the moment a single row accrues — and a window that accrued no rows fails the
 *  minimum of 2 anyway.
 *
 *  So the split follows the chain: the freeze receipt fixes the METHOD at T, this fixes the INPUTS
 *  at the close, and `freezeSha256` is what says the second was derived under the first.
 *
 *  `k` and the window bounds are COPIED out of the freeze receipt and are not flags. A value typed
 *  twice can disagree; a value copied cannot. That is the same reason the freeze DERIVES its close
 *  instead of accepting one.
 */
import { join } from 'node:path';
import { projectLedgerPath } from '../../src/memory/ownership.js';
import { defaultExpansion } from '../../src/memory/expansion.js';
import { isEntryPoint } from '../../src/entry-point.js';
import {
  exitOnInvocationError, flagAccumulator, invocationFail, readInput, readInputBytes,
  refuseOutputCollisions, writeArtifact,
} from './artifact-io.js';
import { hashMethodDocs, hashPinnedInputs, hashTools, sha256Bytes, sha256Hex } from './pin-hashes.js';

/** The `Pins` shape `prepare-gate.ts` parses (`gate-set.ts:63`), plus the binding it ignores.
 *
 *  `freezeSha256` is deliberately outside the four fields prepare-gate reads: it must not change
 *  what the prepare phase compares, and adding a fifth compared field would have required editing
 *  the consumer to accept an artifact it already accepts. It is there for the reader reconstructing
 *  the chain, who otherwise has a pins file that any freeze — or none — could have produced. */
export interface InputPinsFile {
  k: number;
  txAfter: string;
  txClose: string;
  inputs: Record<string, string>;
  freezeSha256: string;
  attestation: string;
}

/** What this artifact re-verified, and — first — what it did NOT. The runtime identity is a
 *  DECLARED pair of load paths: nothing in it can be re-derived from bytes here, so claiming it
 *  was re-checked would be the overstatement this repo treats as a defect. The deploy runbook's
 *  load-path check is that pin's counterparty. Everything else in the receipt's method half has
 *  bytes on this machine, and §9a's "re-verified at the close" is discharged against them. */
const ATTESTATION =
  'method pins re-verified at the close against this working tree and the recorded config path: tools, ' +
  'method documents, configuration. The runtime identity is declared, not derivable from bytes, and is ' +
  'NOT re-verified here — the deploy runbook\'s load-path check is its counterparty.';

const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };

/** A parse failure is an INVOCATION error (exit 2), not a refusal of the pins (exit 1).
 *
 *  The distinction the two codes carry is "I invoked this wrongly" versus "what you are recording is
 *  refused", and a file that will not parse at all answers the first: the path names something that
 *  is not the artifact it was supposed to be, which is a thing the operator retypes. Exit 1 is kept
 *  for a freeze receipt that parses and then disagrees — `manifest-method-mismatch` and
 *  `freeze-receipt-tampered` below are that, and they stay exit 1. */
const parseJson = (label: string, code: string, text: string): unknown => {
  try { return JSON.parse(text); }
  catch (e) {
    return invocationFail(code, `${label} could not be parsed as JSON (${(e as Error).message}). A parse error ` +
      'names no file, so it is reported here with the artifact that failed rather than escaping as a bare ' +
      'SyntaxError');
  }
};

/** Everything the pins take from the freeze, and nothing else.
 *
 *  The payload hash is verified BEFORE any field is read. It proves the payload beside it is the
 *  payload that was hashed — it is not a signature and proves nothing about who issued it, which is
 *  why this refuses rather than attests. */
interface FrozenMethod {
  k: number; txAfter: string; txClose: string; freezeSha256: string;
  tools: Record<string, string>;
  methodDocs: Record<string, string>;
  config: { path: string; sha256: string };
}
const methodFromFreeze = (freezeText: string): FrozenMethod => {
  const doc = parseJson('the freeze receipt', 'freeze-receipt-unreadable', freezeText) as Record<string, unknown>;
  if (doc === null || typeof doc !== 'object' || doc.artifact !== 'freeze-receipt') {
    fail('not-a-freeze-receipt', `--freeze names a file whose artifact field is '${String((doc as { artifact?: unknown })?.artifact)}'. ` +
      '§10 gives every artifact a self-naming field so a file is identified by its content, not by the path it ' +
      'arrived on; reading whatever shape turns up would report a mistyped path as a method disagreement');
  }
  const payload = doc.payload;
  const payloadSha256 = doc.payloadSha256;
  // `return fail(...)` rather than a bare call, here and below: `fail` returns `never`, but a
  // control-flow analysis only sees that at a return statement, so this is what makes the reads
  // afterwards type-safe instead of casts asserting what the check already established.
  if (payload === null || typeof payload !== 'object' || typeof payloadSha256 !== 'string') {
    return fail('freeze-receipt-incomplete', 'the freeze receipt has no payload/payloadSha256 pair, so there is ' +
      'nothing to verify and nothing to copy');
  }
  if (sha256Hex(JSON.stringify(payload)) !== payloadSha256) {
    fail('freeze-receipt-tampered', `the freeze receipt's payload hashes to ${sha256Hex(JSON.stringify(payload))} ` +
      `but ${String(payloadSha256)} is recorded beside it. Every artifact downstream is compared against these ` +
      'pins rather than against the receipt, so a method edited after issue would otherwise propagate silently');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.k !== 'number' || typeof p.txAfter !== 'string' || typeof p.txClose !== 'string') {
    return fail('freeze-receipt-incomplete', `the freeze receipt supplies k=${String(p.k)}, ` +
      `txAfter=${String(p.txAfter)}, txClose=${String(p.txClose)}; all three are copied into the pins, and an ` +
      'absent one would be written as null and compared against the manifest as a value nothing declared');
  }
  // The method half §9a re-verifies at the close. A receipt without it has nothing to re-verify
  // AGAINST, and skipping the re-verification for an incomplete receipt would make "the receipt
  // forgot to pin the tools" indistinguishable from "the tools were re-verified and agreed".
  const hashMap = (name: string, v: unknown): Record<string, string> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v) ||
      Object.values(v as Record<string, unknown>).some((h) => typeof h !== 'string')) {
      return fail('freeze-receipt-incomplete', `the freeze receipt's ${name} is ${JSON.stringify(v)}; §9a requires ` +
        're-verifying the method pins at the close, and a receipt that never carried them cannot be re-verified');
    }
    return v as Record<string, string>;
  };
  const tools = hashMap('tools', p.tools);
  const methodDocs = hashMap('methodDocs', p.methodDocs);
  const cfg = p.config as { path?: unknown; sha256?: unknown } | null | undefined;
  if (cfg === null || cfg === undefined || typeof cfg !== 'object' ||
    typeof cfg.path !== 'string' || typeof cfg.sha256 !== 'string') {
    return fail('freeze-receipt-incomplete', `the freeze receipt's config is ${JSON.stringify(p.config)}; the ` +
      'close-time re-verification re-reads the configuration at its recorded path, and a receipt without one ' +
      'leaves nothing to re-read');
  }
  return {
    k: p.k, txAfter: p.txAfter, txClose: p.txClose, freezeSha256: payloadSha256,
    tools, methodDocs, config: { path: cfg.path, sha256: cfg.sha256 },
  };
};

/** §9a: "the pins re-verified at the close"; §10: "Both are verified again at the close". This is
 *  the implementer those two sentences did not have: round 3 edited a pinned tool, amended a
 *  BINDING method document and swapped the config to critique after the freeze, and the whole
 *  close sequence ran green — a §8-resetting method change invisible to every artifact. The
 *  comparison is set-wise in BOTH directions: a tool the close-time tree has lost, or grown, is
 *  drift exactly as an edited one is. */
const refuseMethodDrift = (frozen: FrozenMethod, current: {
  tools: Record<string, string>;
  methodDocs: Record<string, string>;
  configBytesAt: (path: string) => Buffer;
}): void => {
  const diverged: string[] = [];
  const compare = (kind: string, frozenMap: Record<string, string>, currentMap: Record<string, string>) => {
    for (const rel of new Set([...Object.keys(frozenMap), ...Object.keys(currentMap)])) {
      const was = frozenMap[rel];
      const is = currentMap[rel];
      if (was !== is) {
        diverged.push(`${kind} ${rel} (frozen ${was ?? 'NOT PINNED'}, close-time ${is ?? 'ABSENT'})`);
      }
    }
  };
  compare('tool', frozen.tools, current.tools);
  compare('method doc', frozen.methodDocs, current.methodDocs);
  const configNow = sha256Bytes(current.configBytesAt(frozen.config.path));
  if (configNow !== frozen.config.sha256) {
    diverged.push(`config ${frozen.config.path} (frozen ${frozen.config.sha256}, close-time ${configNow})`);
  }
  if (diverged.length > 0) {
    fail('method-drift', `${diverged.length} method pin(s) changed between the freeze and the close: ` +
      `${diverged.join('; ')}. §8 resets the window on any change to the measured method, so pins derived over ` +
      'a drifted method would freeze inputs for a method other than the one the receipt names');
  }
};

export const inputPins = (input: {
  freezeText: string;
  manifestText: string;
  inputs: Record<string, string>;
  current: {
    tools: Record<string, string>;
    methodDocs: Record<string, string>;
    configBytesAt: (path: string) => Buffer;
  };
}): { pins: InputPinsFile; bytes: string } => {
  const { freezeText, manifestText, inputs, current } = input;
  const frozen = methodFromFreeze(freezeText);
  const { k, txAfter, txClose, freezeSha256 } = frozen;
  refuseMethodDrift(frozen, current);

  // The manifest is cross-checked against the freeze, so it has to be the SAME manifest that is
  // being hashed into the pins. Comparing a manifest read separately from the one hashed would
  // validate one file and pin another.
  if (inputs.manifest !== sha256Hex(manifestText)) {
    fail('manifest-not-the-pinned-file', `the supplied manifest text hashes to ${sha256Hex(manifestText)} but the ` +
      `input hash being pinned is ${String(inputs.manifest)}. The cross-check below reads this text's own k and ` +
      'window, so pinning a different file would check one manifest and freeze another');
  }
  const manifest = parseJson('the manifest', 'manifest-unreadable', manifestText) as
    { k?: unknown; txAfter?: unknown; txClose?: unknown };

  // `prepare-gate.ts` catches this disagreement as well, at the far end of the chain. The
  // duplication buys ATTRIBUTION, not recoverability — both programs run at the close, and a
  // mis-generated manifest is equally regenerable at either refusal. But prepare's `pin-mismatch`
  // arrives wearing the PINS' name, sending the operator at the file this program derived; the
  // refusal here names the manifest, which is the thing that actually disagrees.
  if (manifest.k !== k || manifest.txAfter !== txAfter || manifest.txClose !== txClose) {
    fail('manifest-method-mismatch', `the manifest declares k=${String(manifest.k)}, window ` +
      `${String(manifest.txAfter)}..${String(manifest.txClose)}; the freeze receipt fixes k=${k}, window ` +
      `${txAfter}..${txClose}. The pins would freeze inputs produced under a method other than the frozen one`);
  }

  const pins: InputPinsFile = { k, txAfter, txClose, inputs, freezeSha256, attestation: ATTESTATION };
  return { pins, bytes: JSON.stringify(pins, null, 1) + '\n' };
};

/** Named flags only, and note which flags are ABSENT: there is no `--k`, no `--cutoff` and no
 *  `--close`. Those three are copied from the freeze receipt, and offering them here would restore
 *  precisely the transcription step this artifact exists to remove. */
const INPUTS = ['freeze', 'manifest', 'classifier', 'universe', 'snapshot', 'out'] as const;
const USAGE = `usage: input-pins ${INPUTS.map((n) => `--${n} <path>`).join(' ')}\n` +
  '  k and the window bounds are COPIED from the freeze receipt and cannot be supplied.';

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
      fail('unknown-input', `--${name} is not an input of the pins. In particular k, the cutoff and the close ` +
        'are not: they are copied from the freeze receipt, because a value typed twice can disagree with itself ' +
        'and a value copied cannot');
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
    // The pins file this program writes is the ONE artifact in the close-time set that is not
    // itself hashed into `inputs`, which is exactly why an --out aimed at one of the five pinned
    // files is so damaging: the pin would describe bytes this program then replaced (§9 line 376).
    refuseOutputCollisions(out, [
      { arg: '--freeze', path: flags.freeze! },
      manifestPath,
      { arg: '--classifier', path: flags.classifier! },
      { arg: '--universe', path: flags.universe! },
      { arg: '--snapshot', path: join(flags.snapshot!, 'home', 'memory.jsonl') },
      { arg: '--snapshot', path: projectLedgerPath(join(flags.snapshot!, 'proj')) },
    ]);

    // The expansion pin hashes the RESOLVED table, so the table must resolve HERE, in the process
    // deriving the pins. `undefined` is a gate refusal (exit 1), not an invocation error: the
    // prepare phase refuses `expansionAvailable: false` as a degraded run, and pins derived
    // without the table would freeze a method the healthy pipeline then never matches.
    // `?? fail(...)` rather than a guarding if: `fail` returns `never`, but control-flow analysis
    // only credits that in expression position (the same reason methodFromFreeze uses
    // `return fail(...)`), so this is what leaves `expansion` non-optional below.
    const expansion = defaultExpansion() ??
      fail('expansion-unavailable', 'the semantic-neighbor asset did not resolve beside this executable, so ' +
        'the expansion:semantic-neighbors pin cannot be derived. Round 3 proved recall silently ranks without ' +
        'expansion when the asset is missing — pins derived in that state would freeze the degraded method');

    // A refusal from `inputPins` throws and exits 1: it refuses the PINS. A path that cannot be
    // read or parsed exits 2 through the catch below — it refuses the INVOCATION.
    const manifestText = readInput(manifestPath);
    const { pins, bytes } = inputPins({
      freezeText: readInput({ arg: '--freeze', path: flags.freeze! }),
      manifestText,
      // Hashed exactly as `prepare-gate.ts`'s `main` will hash the same files. The whole arrangement
      // is worthless unless these agree byte for byte, which is why both sides compute their own.
      inputs: hashPinnedInputs(flags.snapshot!, {
        manifest: flags.manifest!, classifier: flags.classifier!, universe: flags.universe!,
      }, expansion),
      // The close-time view §9a's re-verification compares against the receipt: the same working
      // tree the freeze hashed at T, re-hashed now, and the config re-read at the path the receipt
      // recorded. An unreadable config path is an invocation error via readInputBytes — the flag
      // it is blamed on is --freeze, since that is the file that named the path.
      current: {
        tools: hashTools(process.cwd()),
        methodDocs: hashMethodDocs(process.cwd()),
        configBytesAt: (path) => readInputBytes({ arg: '--freeze (its recorded config path)', path }),
      },
    });
    writeArtifact(out, bytes);
    console.log(`input pins derived under freeze ${pins.freezeSha256}\nwindow ${pins.txAfter} .. ${pins.txClose} ` +
      `(k=${pins.k})\n${Object.keys(pins.inputs).length} inputs pinned: ${Object.keys(pins.inputs).join(', ')}`);
  } catch (e) { exitOnInvocationError(e); }
};
if (isEntryPoint(import.meta.url)) main();
