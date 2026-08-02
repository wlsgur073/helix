/** Artifact I/O shared by every pilot CLI — and an UNGUARDED module on purpose, so all of them may
 *  import it (`snapshot.ts` records why a module carrying `if (isEntryPoint(import.meta.url))`
 *  may never be imported by another `scripts/pilot/*.ts`, and
 *  `test/pilot/entry-point-isolation.test.ts` holds that rule in place).
 *
 *  It exists because two guarantees the pilot CLIs state were not actually implemented anywhere.
 *
 *  ─── 1. §9 line 376: "refuses pre-existing outputs … creates every file exclusively" ───────────
 *
 *  Six CLIs did neither. `--out` aimed at one of the invocation's own inputs overwrote it and
 *  exited 0 — in two cases AFTER the input had been read and hashed, leaving an artifact whose
 *  recorded pin describes a file that no longer exists — and `--out` over any pre-existing file
 *  destroyed it silently.
 *
 *  Three CLI header comments credited NAMED FLAGS with having closed this, citing the
 *  `generate-manifest` incident where "an oracle path was lined up with an output slot". Named
 *  flags close a different hole: they stop an input being MISTAKEN for an output, because no slot
 *  is decided by position any more. They do nothing whatsoever about an output DELIBERATELY (or
 *  mistakenly) pointed at an input path — `--out` accepts any string. Destination reuse needs a
 *  check on the destination, which is what this module is.
 *
 *  Two refusals, deliberately distinct, because what they establish differs. `output-exists` says
 *  choose another name — and ONLY that: the check cannot know what the existing file is (an input
 *  of a stage this invocation never reads, on a case-insensitive mount even an aliased input of
 *  THIS one), so it never advises moving or deleting it. `output-aliases-input` says the run is not
 *  runnable as written: deleting the file to make room would delete the input the run is measured
 *  against.
 *
 *  Both are checked UP FRONT — before any input is read, hashed or measured. §9's ordering makes
 *  every artifact hash its parents, so discovering the destination at the end means discovering it
 *  after the freeze has hashed the working tree or after three runs' worth of recall. The write
 *  itself then repeats the existence check through `O_EXCL`, which is not redundant: the up-front
 *  check is a courtesy to the operator, and the kernel flag is the enforcement, because the window
 *  between them is exactly where a concurrent run lands.
 *
 *  ─── 2. The exit-code split the CLIs promise their callers ────────────────────────────────────
 *
 *  `release-record.ts` states it: "an operator's script can tell 'I invoked this wrongly' from
 *  'the gate forbids what I am recording'." It was false everywhere. A missing input file exited 1
 *  — the gate-refusal code — with a raw `node:fs:441` stack, so automation read a filesystem typo
 *  as a gate refusal, which is the one misreading that turns a mistake into a release decision.
 *
 *  So: a path the operator named that cannot be read, parsed or created is an INVOCATION error
 *  (exit 2, kebab-case slug, no stack). A file that reads and parses but disagrees with what it
 *  must agree with is a REFUSAL (exit 1). The line is "could this argument be retyped correctly?",
 *  and it is drawn here rather than per-CLI so the two codes cannot drift apart again.
 */
import {
  accessSync, appendFileSync, constants, lstatSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** A refusal of HOW the program was invoked, as distinct from a refusal of what it was asked to
 *  record. `main()` maps it to exit 2; everything else propagates and exits 1. */
export class InvocationError extends Error {
  /** The marker `isInvocationError` reads. See there for why it is a property and not the class. */
  readonly invocation = true;
  constructor(message: string) { super(message); this.name = 'InvocationError'; }
}

/** Read as a PROPERTY rather than through `instanceof`, and that is not fastidiousness.
 *
 *  Every pilot CLI is bundled separately (`test/helpers/bundle-cli.ts`), and a class is identified
 *  by the module instance that evaluated its declaration. Any arrangement that loads this module
 *  twice in one process — two bundles imported together, or a test importing the source beside a
 *  bundle — mints two unrelated `InvocationError` classes, and `instanceof` then answers "no" for a
 *  genuine invocation error. The CLI would exit 1: precisely the confusion this split exists to
 *  remove, reintroduced by the mechanism meant to detect it. A property survives the duplication. */
export const isInvocationError = (e: unknown): boolean =>
  e instanceof Error && (e as { invocation?: unknown }).invocation === true;

/** The invocation-error counterpart of each CLI's `fail`. Same slug discipline: kebab-case code,
 *  then a detail that says why this is refused rather than reconciled. */
export const invocationFail = (code: string, detail: string): never => {
  throw new InvocationError(`${code}: ${detail}`);
};

/** The accumulator every pilot `parseFlags` collects into, with NO PROTOTYPE (finding X2).
 *
 *  Two hazards, and the null prototype is what closes both:
 *
 *  READING — `'constructor' in out` is true on an ordinary object literal, so a duplicate check
 *  written with `in` answered "given more than once" for `--constructor`, `--toString`, `--valueOf`
 *  and `--__proto__`: a statement about the operator's command line that is simply false. With no
 *  prototype there is nothing to find.
 *
 *  WRITING — `out['__proto__'] = value` on an object literal stores nothing. It reaches the
 *  inherited `__proto__` setter, which ignores a string, so no own property appears. In a parser
 *  that then validates by walking `Object.keys(out)` — `ordering-receipt.ts` does — the flag is
 *  SILENTLY DROPPED, which is the "an ignored flag leaves an operator believing an argument was
 *  honoured" failure that same file forbids in prose. With no prototype there is no setter to reach
 *  and the key is stored.
 *
 *  WHAT THE MUTATION TESTING ACTUALLY SHOWED, because the honest account is narrower than the one
 *  written here first. Reverting this to `{}` while keeping `Object.hasOwn` fails exactly one test
 *  — the `--__proto__` case — so the null prototype is independently load-bearing and the writing
 *  hazard is real. Reverting the call sites from `Object.hasOwn` to `in` while keeping the null
 *  prototype fails NOTHING: given no prototype the two operators agree, so that mutant is
 *  equivalent. `Object.hasOwn` is therefore not a second enforcement — it is the explicit spelling
 *  of what is being asked, and the guard that keeps every call site correct if an accumulator is
 *  ever changed back to a literal. It is kept for that reason and for no stronger one. */
export const flagAccumulator = (): Record<string, string> => Object.create(null) as Record<string, string>;

/** A path together with the argument it arrived on, so a refusal can name what the operator typed
 *  rather than a path they then have to match back to one of six inputs.
 *
 *  `arg` is spelled as the CLI's own usage line spells it — `--out` for the flag-taking programs,
 *  `<out>` for the two that still take positionals (`generate-manifest`, `classify-o67`). It is
 *  passed already spelled rather than decorated here, because a shared formatter that prefixed
 *  `--` would print `--<out>` for a program that has no flags. */
export interface NamedPath { arg: string; path: string }

/** The identity of a path as a FILE, not as a string.
 *
 *  `--out ./x/../a.json` and `--score /abs/a.json` are one file, and a comparison of the two argv
 *  strings passes both through. `resolve` handles `.`, `..` and relative spellings; `realpathSync`
 *  handles symlinked directories, which `resolve` cannot see through. An output usually does not
 *  exist yet, so when the path itself cannot be resolved its PARENT is, and the basename is
 *  reattached — that is what makes `--out <symlinked dir>/new.json` comparable with an input under
 *  the real directory.
 *
 *  WHAT THIS DOES NOT CATCH: two hard links to one inode, one file reachable under two mounts, and
 *  a case-insensitive filesystem's two spellings of one name. Those are why `writeArtifact` opens
 *  with `O_EXCL` instead of trusting this function — the kernel decides identity, this only
 *  decides which refusal an operator gets to read. */
export const canonicalPath = (p: string): string => {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* not created yet — resolve its parent instead */ }
  try { return resolve(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
};

/** §9 line 376, checked before the work rather than discovered after it.
 *
 *  `inputs` is every path this invocation READS, including ones no flag names directly — the
 *  snapshot's two ledgers are hashed as pinned inputs (`ledger:global` / `ledger:project`) and are
 *  reachable only through `--snapshot`, and the freeze receipt's §10 tool table and rule documents
 *  are read from the working tree. An input the caller omits from this list is an input the output
 *  may still destroy, so the lists are built from what each CLI actually opens. */
export const refuseOutputCollisions = (out: NamedPath, inputs: NamedPath[]): void => {
  const target = canonicalPath(out.path);

  // Aliasing is checked FIRST, so an output that is both an input and pre-existing is reported as
  // the alias. "That file already exists" would send the operator to delete it — which would
  // delete the input the run is measured against, the worst available repair.
  for (const input of inputs) {
    if (canonicalPath(input.path) !== target) continue;
    // Deliberately says nothing about named flags: this same message is raised by the two CLIs that
    // still take positionals, where such a claim would be false. What matters is the same in both —
    // deciding WHICH argument is the output does not constrain the VALUE that argument carries.
    invocationFail('output-aliases-input', `${out.arg} ${out.path} and ${input.arg} ${input.path} ` +
      `name the same file (${target}). This is refused rather than resolved in the output's favour ` +
      'because the write destroys the very bytes the run is measured against: where the input has ' +
      'already been read and hashed, the artifact would record a pin for a file that no longer exists, ' +
      'and where it has not, the run would be scored against whatever the output happens to contain. ' +
      `Neither is recoverable afterwards, and deleting the file to make room would delete the input — ` +
      `name a different ${out.arg}`);
  }

  // `lstatSync`, not `statSync`: a stat that follows links reads a DANGLING symlink as absent, so
  // the old check passed one and `writeArtifact`'s O_EXCL later refused it with the concurrent-run
  // story — a false account, since the link sat at the destination all along. A symlink whose
  // target exists never reaches this lstat as one: `canonicalPath` has already resolved it, so
  // `target` is the real file and the plain `output-exists` below reports it.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try { existing = lstatSync(target); } catch { /* absent is the expected state for an output */ }
  if (existing !== undefined && existing.isSymbolicLink()) {
    invocationFail('output-is-symlink', `${out.arg} ${out.path} is a symbolic link whose target does not ` +
      'exist. Exclusive creation refuses symlinks rather than following them, so the write would fail ' +
      'there anyway; it is reported here, before the measurement, as what it is. The link and whatever ' +
      `it names are left untouched — name a different ${out.arg}`);
  }
  if (existing !== undefined) {
    invocationFail('output-exists', `${out.arg} ${out.path} already exists. §9 line 376 puts "refuses ` +
      'pre-existing outputs" and "creates every file exclusively" in the same sentence as minting a fresh ' +
      'run id, because they close one class together: an exploratory pass, then a second run over the same ' +
      'paths, leaves a clean-looking official sequence with the first pass invisible. Overwriting is ' +
      'refused rather than offered as a flag for the same reason — a --force would be reachable by the ' +
      `operator the check exists to constrain. Name a new ${out.arg}: this check cannot know what the ` +
      'existing file is — it may be a load-bearing input or a prior artifact of some pipeline stage this ' +
      'invocation never reads — so it must not be moved or deleted unless something outside this program ' +
      'establishes it is neither');
  }

  // The parent is checked here too, so an unwritable destination is reported before the measurement
  // rather than after it. `writeArtifact` checks again, because a directory can stop being one.
  let parent: ReturnType<typeof statSync>;
  try { parent = statSync(dirname(target)); }
  catch (e) {
    return invocationFail('output-unwritable', `${out.arg} ${out.path} cannot be created: ` +
      `${dirname(out.path)} is not there (${(e as Error).message}). The directory is not created for you — ` +
      'a mistyped path would otherwise silently mint a tree, and the artifact would be written somewhere ' +
      'no one goes looking');
  }
  if (!parent.isDirectory()) {
    invocationFail('output-unwritable', `${out.arg} ${out.path} cannot be created: ${dirname(out.path)} ` +
      'is not a directory');
  }
  // Writability is TESTED, not inferred from the stat: a mode-0500 parent stats fine and is a
  // directory, so the old check passed it — and the comment above still promised "before the
  // measurement" while freeze-receipt hashed its whole pin set and THEN died at the write. This is
  // advisory — access(2) answers for this process at this instant — and the `wx` open in
  // `writeArtifact` remains the enforcement.
  try { accessSync(dirname(target), constants.W_OK); }
  catch {
    invocationFail('output-unwritable', `${out.arg} ${out.path} cannot be created: ${dirname(out.path)} ` +
      'is not writable by this process');
  }
};

/** The enforcement half of §9 line 376: `wx` is `O_CREAT | O_EXCL`, so the kernel refuses when the
 *  name already exists — including when it is a symlink, which is NOT followed under `O_EXCL` and
 *  therefore cannot be used to redirect the write onto a file the checks above cleared.
 *
 *  This is what closes the window `refuseOutputCollisions` leaves open. That check ran before the
 *  measurement, which is where an operator wants it; everything between then and now is time in
 *  which a concurrent run can create the file. */
export const writeArtifact = (out: NamedPath, bytes: string): void => {
  try { writeFileSync(out.path, bytes, { flag: 'wx' }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // EEXIST has two honest readings, and the message must pick the true one. O_EXCL refuses a
      // symlink WITHOUT following it, so a symlink here — dangling or not — was sitting at the
      // destination before this program started; blaming a write that appeared "between check and
      // write" sends the operator chasing a race that never ran. The race wording is reserved for
      // the remaining case: a non-link that appeared after a clean up-front check.
      let isLink = false;
      try { isLink = lstatSync(out.path).isSymbolicLink(); }
      catch { /* vanished again — then a concurrent actor really is at work; tell the race story */ }
      if (isLink) {
        invocationFail('output-is-symlink', `${out.arg} ${out.path} is a symbolic link. Exclusive ` +
          'creation refuses symlinks rather than following them, so nothing was written — not the link, ' +
          `not whatever it names. This is not a concurrent-run collision; name a different ${out.arg}`);
      }
      invocationFail('output-exists', `${out.arg} ${out.path} was created between this program's ` +
        'destination check and its write. Exclusive creation is what makes that detectable at all: the ' +
        'artifact is not written, because the alternative is one of the two runs silently losing its output');
    }
    invocationFail('output-unwritable', `${out.arg} ${out.path} could not be created ` +
      `(${(e as Error).message})`);
  }
};

/** The ordering log is the ONE pilot write exempt from exclusive creation, and the exemption is
 *  the artifact's whole design: §9 item 4 asks for an APPEND-ONLY receipt, so the file must be
 *  able to grow. Refusing a pre-existing target here would make a second entry impossible and
 *  there would be no chain to verify.
 *
 *  `'a'` positions every write at end-of-file in the kernel, so the existing bytes are never
 *  re-emitted — append-only is a property of the open flag, not a promise about this program. */
export const appendArtifactLine = (out: NamedPath, line: string): void => {
  try { appendFileSync(out.path, line, { flag: 'a' }); }
  catch (e) {
    invocationFail('output-unwritable', `${out.arg} ${out.path} could not be appended to ` +
      `(${(e as Error).message})`);
  }
};

/** Read an input as utf8 text. A path that cannot be opened is an invocation error, not a gate
 *  refusal: `ENOENT` on `--score` means the operator typed a path wrong, and reporting it with the
 *  code reserved for "the gate forbids this" is how a typo gets read as a verdict. */
export const readInput = (input: NamedPath): string => {
  try { return readFileSync(input.path, 'utf8'); }
  catch (e) {
    return invocationFail('input-unreadable', `${input.arg} ${input.path} could not be read ` +
      `(${(e as Error).message})`);
  }
};

/** The same for inputs pinned by their RAW BYTES rather than by a utf8 decode — see `sha256Bytes`
 *  in `pin-hashes.ts` for why those two hashes are not interchangeable. */
export const readInputBytes = (input: NamedPath): Buffer => {
  try { return readFileSync(input.path); }
  catch (e) {
    return invocationFail('input-unreadable', `${input.arg} ${input.path} could not be read ` +
      `(${(e as Error).message})`);
  }
};

/** Parse an input, reporting the FLAG and the PATH. A bare `SyntaxError` names no file — "Unexpected
 *  token } in JSON at position 41" leaves an operator holding six `--` inputs with nothing to act
 *  on — and it escapes as an uncaught throw, which is exit 1, the gate's code. */
export const parseJsonInput = (input: NamedPath, text: string): unknown => {
  try { return JSON.parse(text); }
  catch (e) {
    return invocationFail('input-unparsable', `${input.arg} ${input.path} is not JSON ` +
      `(${(e as Error).message})`);
  }
};

/** Read and parse in one step, which is what most inputs want. Where a CLI needs the TEXT as well —
 *  because the bytes are hashed and the parse must provably come from the same ones — it calls
 *  `readInput` and `parseJsonInput` separately and keeps the string. */
export const readJsonInput = (input: NamedPath): unknown => parseJsonInput(input, readInput(input));

/** The catch clause every pilot `main()` ends with.
 *
 *  Invocation errors print their slug and exit 2. Everything else is re-thrown so it leaves the
 *  process uncaught and exits 1 — a gate or integrity refusal is supposed to be loud, and its stack
 *  is the record of which check refused. The asymmetry is the interface: exit 2 is always a
 *  one-line slug, exit 1 always carries the refusal. */
export const exitOnInvocationError = (e: unknown): never => {
  if (!isInvocationError(e)) throw e;
  console.error((e as Error).message);
  process.exit(2);
};
