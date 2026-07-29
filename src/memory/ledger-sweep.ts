import { dirname, basename, join } from 'node:path';
import { realFsOps, type DurableFsOps } from './fs-ops.js';

const HEX32 = '[0-9a-f]{32}';

/** The three artifact classes this codebase writes next to a ledger/key, plus the legacy pid-named
 *  tmps of pre-redesign builds. A DESTRUCTIVE predicate must match exactly what our own writers
 *  create — nothing else (house lesson: erase routing gated on coarse predicates reacted to rows
 *  unrelated to the target). */
export function orphanTmpPattern(base: string): RegExp {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}\\.(c-${HEX32}|lk-${HEX32}|k-${HEX32}|w-${HEX32}|\\d+)\\.tmp$`);
}

/** Remove every orphaned tmp belonging to `artifactPath` (ledger or key) — including a
 *  plaintext-bearing compaction snapshot; removing it is ALSO the fence that makes a lock-losing
 *  compactor's rename fail ENOENT.
 *
 *  THROWS on any failure that leaves the name PRESENT: an unfenceable predecessor must block the
 *  successor (spec Layer 4). A vanished name is the opposite — it is that goal already reached, by
 *  someone else's hand — so ENOENT is tolerated and the sweep continues.
 *
 *  That distinction is load-bearing, not defensive coding. An older docstring here claimed "callers
 *  hold the lock, so every match is a dead/aborted writer's leftover"; that premise is FALSE. A lock
 *  CONTENDER writes `<artifact>.lk-<hex32>.tmp` while it does not yet hold the lock (lock.ts:75),
 *  and every tmp writer removes its own file with a catch that already anticipates a racing sweeper
 *  (lock.ts:79, ledger.ts:514, ledger-mac.ts:49, witness-store.ts:101). Both sides delete the same
 *  path; only one of them used to survive losing. Root-caused 2026-07-29 from a 1-in-30 suite flake
 *  whose blast radius is every commit/erase append (ledger.ts:80), not just the observed key mint. */
export function sweepOrphanTmps(artifactPath: string, opts: { fsOps?: DurableFsOps; keep?: string } = {}): number {
  const fs = opts.fsOps ?? realFsOps;
  const dir = dirname(artifactPath);
  const pat = orphanTmpPattern(basename(artifactPath));
  const keepName = opts.keep ? basename(opts.keep) : null;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pat.test(name) || name === keepName) continue;
    try {
      fs.unlinkSync(join(dir, name));
    } catch (e) {
      // Discriminated on errno, never on the message: a message match would also swallow the
      // code-less failures the abort-semantics tests inject, silently reopening the whole class.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      continue;                          // gone already — not ours to count
    }
    removed++;
  }
  if (removed > 0) fs.fsyncDir(dir);   // the unlink of a plaintext orphan must survive power loss too
  return removed;
}
