import { dirname, basename, join } from 'node:path';
import { realFsOps, type DurableFsOps } from './fs-ops.js';

const HEX32 = '[0-9a-f]{32}';

/** The three artifact classes this codebase writes next to a ledger/key, plus the legacy pid-named
 *  tmps of pre-redesign builds. A DESTRUCTIVE predicate must match exactly what our own writers
 *  create — nothing else (house lesson: erase routing gated on coarse predicates reacted to rows
 *  unrelated to the target). */
export function orphanTmpPattern(base: string): RegExp {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}\\.(c-${HEX32}|lk-${HEX32}|k-${HEX32}|\\d+)\\.tmp$`);
}

/** Remove every orphaned tmp belonging to `artifactPath` (ledger or key). Callers hold the lock,
 *  so every match is a dead/aborted writer's leftover — including a plaintext-bearing compaction
 *  snapshot; removing it is ALSO the fence that makes a lock-losing compactor's rename fail ENOENT.
 *  THROWS on any failure: an unfenceable predecessor must block the successor (spec Layer 4). */
export function sweepOrphanTmps(artifactPath: string, opts: { fsOps?: DurableFsOps; keep?: string } = {}): number {
  const fs = opts.fsOps ?? realFsOps;
  const dir = dirname(artifactPath);
  const pat = orphanTmpPattern(basename(artifactPath));
  const keepName = opts.keep ? basename(opts.keep) : null;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pat.test(name) || name === keepName) continue;
    fs.unlinkSync(join(dir, name));
    removed++;
  }
  if (removed > 0) fs.fsyncDir(dir);   // the unlink of a plaintext orphan must survive power loss too
  return removed;
}
