/** One name for the rule that decides whether a project ledger is a SEPARATE participant from the
 *  global one, plus the scope resolution that has to honour it.
 *
 *  The rule already existed, three times, written out longhand: `src/server/index.ts` gates the
 *  project layer with it, `src/hooks/session-start.ts` repeats it to keep its disposition snapshot
 *  and its read in agreement, and `scripts/trigger-measure.ts` repeats it again with a comment
 *  pointing at the server. The re-baseline ceremony did not have it — that was the defect — and an
 *  invariant nobody could name is exactly the kind that gets copied three times and forgotten
 *  elsewhere (the dev-only replay benchmark had also missed it; `scripts/bench-replay.ts` runReal
 *  reads it from here now). Naming the rule is most of the fix; `resolveScopeTarget` is the rest,
 *  because it stops the ceremony deriving a ledger and a witness key from the same argument by two
 *  independent routes. */
import { canonicalRoot, projectLedgerPath } from './ownership.js';
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
 */
export function aliasesGlobalLedger(projectLedger: string, globalLedger: string): boolean {
  return canonicalRoot(projectLedger) === canonicalRoot(globalLedger);
}

/** `'global'`, or an absolute project root. */
export type Scope = 'global' | (string & {});

export type ScopeResolution =
  | { ok: true; ledger: string; scopeKey: string }
  | { ok: false; reason: 'aliases-global'; ledger: string };

/**
 * The ledger a scope names AND the witness key it is recorded under — derived together, from one
 * argument, in one place.
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
 */
export function resolveScopeTarget(home: string, globalLedger: string, scope: Scope): ScopeResolution {
  if (scope === 'global') return { ok: true, ledger: globalLedger, scopeKey: scopeKeyOf(home) };
  const ledger = projectLedgerPath(scope);
  if (aliasesGlobalLedger(ledger, globalLedger)) return { ok: false, reason: 'aliases-global', ledger };
  return { ok: true, ledger, scopeKey: scopeKeyOf(home, scope) };
}
