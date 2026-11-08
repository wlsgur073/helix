/** One resolution of HELIX_HOME, HELIX_LEDGER and HELIX_SESSIONS for every entry point, and the one typed home
 *  refusal (B2a design 4.1 and 4.6, decisions C and D). This module imports node builtins and path-identity.ts only. */
import { posix, win32 } from 'node:path';
import { resolvePath } from './path-identity.js';

/** The three variables this module reads. */
export type HomeVariable = 'HELIX_HOME' | 'HELIX_LEDGER' | 'HELIX_SESSIONS';

/** Why a home was refused. Task A2 raises the first two; the others name the refusals later tasks raise through the same
 *  type: A6 (the directory rules of `ensureHelixDir`), B1 and B2 (a destination at a control file), B4 (a home or an audit
 *  file that cannot be written). */
export type HomeRefusalCause =
  | 'relative-value' | 'unresolvable-home'
  | 'symlinked-home' | 'not-a-directory' | 'foreign-owner' | 'parent-missing'
  | 'home-control-file'
  | 'home-unwritable' | 'audit-unwritable';

/** A refusal of the home, as one typed error for the env rules, the directory rules and the pre-row checks. */
export class HomeRefusalError extends Error {
  /** The marker isHomeRefusalError reads (a property, never class identity: a module loaded twice mints two classes). */
  readonly homeRefusal = true as const;
  constructor(readonly homeRefusalCause: HomeRefusalCause, message: string) {
    super(message);
    this.name = 'HomeRefusalError';
  }
}

export const isHomeRefusalError = (e: unknown): boolean =>
  e instanceof Error && (e as { homeRefusal?: unknown }).homeRefusal === true;

/** Constant texts of the env refusals: ASCII, no path, no interpolation, no imperative. Fixed at the text review. */
export const RELATIVE_VALUE_TEXT: Readonly<Record<HomeVariable, string>> = {
  HELIX_HOME: 'HELIX_HOME is not an absolute path, so it is refused',
  HELIX_LEDGER: 'HELIX_LEDGER is not an absolute path, so it is refused',
  HELIX_SESSIONS: 'HELIX_SESSIONS is not an absolute path, so it is refused',
};
export const UNRESOLVABLE_HOME_TEXT =
  'the Helix home cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links), so it is refused';

/** The three resolved paths every entry point works from. */
export interface HelixPaths { home: string; globalLedger: string; sessionsFile: string }

/** An unset or empty variable reads as unset, as `dogfood-postrun.sh` already reads `${HELIX_HOME:-...}`. */
const given = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

function absoluteOrRefuse(variable: HomeVariable, value: string, isAbsolute: (p: string) => boolean): string {
  if (!isAbsolute(value)) throw new HomeRefusalError('relative-value', RELATIVE_VALUE_TEXT[variable]);
  return value;
}

/** The final component of `p` once a trailing `/` and a trailing `/.` are gone: the same cut `finalName` in
 *  home-permissions.ts makes, so `<link>/` and `<link>/.` name the link itself and not what it points at. */
function withoutTrailingSlashOrDot(p: string): string {
  let n = p;
  for (;;) {
    if (n.length > 1 && n.endsWith('/')) { n = n.slice(0, -1); continue; }
    if (n.length > 2 && n.endsWith('/.')) { n = n.slice(0, -2); continue; }
    return n;
  }
}

/** The home the kernel reaches (decision D): the directory part is resolved by `resolvePath`, the final component is
 *  appended as written and never followed, so a home that is itself a link stays a link (the writes refuse it and the
 *  reads are served, as today). A final component of `..` (or `.`, or none) names a directory, which cannot be a link, so
 *  the whole path is resolved. A directory part the resolver cannot inspect (EACCES, ENOTDIR, ENOENT before a `..`, an
 *  I/O error) keeps the path as given and fails later with its own fs error; one it cannot name (a name that is not
 *  valid UTF-8, a path past the system limit, a link loop) is refused. */
function kernelWayHome(path: string): string {
  const name = withoutTrailingSlashOrDot(path);
  const last = name.slice(name.lastIndexOf('/') + 1);
  const namesDirectory = last === '' || last === '.' || last === '..';
  const r = resolvePath(namesDirectory ? name : posix.dirname(name));
  if (r.kind === 'unresolvable') throw new HomeRefusalError('unresolvable-home', UNRESOLVABLE_HOME_TEXT);
  if (r.kind === 'uninspectable') return path;
  return namesDirectory ? r.path : posix.join(r.path, last);
}

/** Resolve the three variables once (decisions C and D; design 4.1). Reads only `env`, never `process.env`. A value that is
 *  not absolute is refused first, in the order HELIX_HOME, HELIX_LEDGER, HELIX_SESSIONS, before any file system call; then
 *  the home's directory part is resolved (`kernelWayHome`), and a part that cannot be named is refused. `userHome` is the
 *  parent of the default home (`os.homedir()` in the entry points). An entry point passes only the variables it reads, as
 *  literal `process.env.HELIX_*` reads, never the bare `process.env`: the inventory's env extractor
 *  (scripts/inventory/extract-config.ts) sees only that literal form in the shipped bundles. On win32 the given absolute
 *  home is kept as it is, as ensureHelixDir's win32 branch keeps its dir: resolvePath splits on `/` and is not asked there.
 *  `platform` exists for that branch and its tests; the entry points omit it. */
export function resolveHelixPaths(env: NodeJS.ProcessEnv, userHome: string, platform: NodeJS.Platform = process.platform): HelixPaths {
  const p = platform === 'win32' ? win32 : posix;
  const homeValue = absoluteOrRefuse('HELIX_HOME', given(env.HELIX_HOME) ?? p.join(userHome, '.helix'), p.isAbsolute);
  const ledger = given(env.HELIX_LEDGER);
  if (ledger !== null) absoluteOrRefuse('HELIX_LEDGER', ledger, p.isAbsolute);
  const sessions = given(env.HELIX_SESSIONS);
  if (sessions !== null) absoluteOrRefuse('HELIX_SESSIONS', sessions, p.isAbsolute);
  // After all three are known to be absolute: a relative value is refused before any fs call.
  const home = platform === 'win32' ? homeValue : kernelWayHome(homeValue);
  return { home, globalLedger: ledger ?? p.join(home, 'memory.jsonl'), sessionsFile: sessions ?? p.join(home, 'sessions.jsonl') };
}
