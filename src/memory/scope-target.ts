/** The scope resolution of the two ceremonies (helix-rebaseline, helix-trust-resolve): the ledger a
 *  scope names AND the witness key it is recorded under, derived together, from one argument, in one
 *  place, and judged by the SAME function every other site uses.
 *
 *  Third fix batch B1 (design 4.2 and 4.10): the project-to-project rule and the copies of the global
 *  rule (scripts/trigger-measure.ts, scripts/bench-replay.ts) are now the one judgement in ownership.ts
 *  (judgeProjectLayer), which takes the global ledger's path as an input. `aliasesGlobalLedger` stays
 *  here only for src/memory/project-root.ts, which applies it once for the server and the SessionStart
 *  hook. */
import { isGlobalLedgerEntry, judgeProjectLayer, projectLedgerPath, type JudgementCause } from './ownership.js';
import { resolvePath } from './path-identity.js';
import { scopeKeyOf } from './witness-store.js';

/**
 * Is `projectLedger` the SAME PHYSICAL FILE as `globalLedger`?
 *
 * Compared canonically, never textually: a symlinked `.helix` (or a symlinked `memory.jsonl`) that
 * points a project ledger at the global one is one inode wearing two names, and the lock and append
 * layers both resolve to that inode. A textual compare would call them distinct and hand the same
 * bytes two identities.
 *
 * The default install layout makes this reachable without any symlink at all: `HELIX_HOME` is
 * `$HOME/.helix`, so the global ledger is `$HOME/.helix/memory.jsonl` — precisely what
 * `projectLedgerPath($HOME)` returns.
 *
 * ALIAS-DOTDOT (second fix batch, D4): both sides are where an append through them lands, computed
 * the kernel's way (path-identity.ts resolvePath), not canonicalRoot. canonicalRoot collapses a
 * `..` after a symlinked directory as text and returns a DANGLING link's own location, so a project
 * ledger linked as `dl/../<path to the global ledger>`, or linked to a global ledger that does not
 * exist yet, read as a separate file while its appends landed in (or created) the global ledger. A
 * side that is not `resolved` is not called the same file here: the project layer then stays
 * configured and the judgement excludes it (rows 4 and 5), so its writes are refused rather
 * than silently routed to the global ledger.
 */
export function aliasesGlobalLedger(projectLedger: string, globalLedger: string): boolean {
  const p = resolvePath(projectLedger);
  const g = resolvePath(globalLedger);
  return p.kind === 'resolved' && g.kind === 'resolved' && p.path === g.path;
}

/** `'global'`, or an absolute project root. */
export type Scope = 'global' | (string & {});

/** Why a project scope is refused. `global-store`: the project memory path IS the global ledger's
 *  directory entry, so there is no separate project scope (use the global one). Every other value is the
 *  judgement's cause for an 'aliased' or 'unusable' layer. */
export type ScopeRefusalCause = 'global-store' | JudgementCause;

export type ScopeResolution =
  | { ok: true; ledger: string; scopeKey: string; destination?: string }
  | {
      ok: false;
      /** The two values this had before the judgement keep their meaning: `aliases-global` (the global
       *  store itself, or a memory file that leads to the global ledger) and `aliases-project` (it leads
       *  to another registered project's ledger). The other aliased causes read `aliased`. */
      reason: 'aliases-global' | 'aliases-project' | 'aliased' | 'unusable';
      cause: ScopeRefusalCause;
      /** The project's memory path as the scope names it. */
      ledger: string;
      /** Where a write through that path lands, when the resolver named a path (design 4.10, m-4). */
      destination?: string;
    };

/**
 * The ledger a scope names AND the witness key it is recorded under.
 *
 * Deriving them separately is what made a project scope able to alias the global ledger: the ledger
 * came from `projectLedgerPath(scope)` while the key came from `canonicalRoot(scope)`, and nothing
 * compared the result against the global ledger. Nothing downstream re-derives the key from the path
 * either — `readScopeWitness`/`planTransition`/`openTransition`/`completeTransition` all take the key
 * as an argument — so the two identities simply diverge, and one physical file ends up witnessed
 * under two of them. The older key is then left attesting to a PREFIX of a file that has since
 * grown: the tail it no longer covers is an unwitnessed window until the next write under that key.
 *
 * `globalLedger` is passed in rather than derived here, because its own resolution
 * (`HELIX_LEDGER ?? <home>/memory.jsonl`) is itself spelled out at several call sites and is not
 * this module's rule to own.
 *
 * A project scope is refused when its layer is 'aliased' or 'unusable' (design 4.10). Every other
 * state resolves as before: the ceremony of a project nobody adopted, or with no memory file yet, is
 * not this function's to refuse.
 */
export function resolveScopeTarget(home: string, globalLedger: string, scope: Scope): ScopeResolution {
  if (scope === 'global') return { ok: true, ledger: globalLedger, scopeKey: scopeKeyOf(home) };
  const ledger = projectLedgerPath(scope);
  if (isGlobalLedgerEntry(ledger, globalLedger)) {
    const g = resolvePath(globalLedger);   // for `resolved ledger:` only: where the global ledger's own writes land
    return { ok: false, reason: 'aliases-global', cause: 'global-store', ledger, destination: g.kind === 'resolved' ? g.path : undefined };
  }
  const j = judgeProjectLayer({ root: scope, ledger, home, globalLedger });
  if (j.state === 'aliased' || j.state === 'unusable') {
    const cause = j.cause ?? 'uninspectable';
    const reason = j.state === 'unusable' ? 'unusable'
      : cause === 'global-ledger' ? 'aliases-global'
      : cause === 'other-project' ? 'aliases-project' : 'aliased';
    return { ok: false, reason, cause, ledger, destination: j.destination };
  }
  return { ok: true, ledger, scopeKey: scopeKeyOf(home, scope), destination: j.destination };
}
