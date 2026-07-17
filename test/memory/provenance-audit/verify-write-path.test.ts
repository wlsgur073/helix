import { describe, it, expect } from 'vitest';
import { parseLedger } from '../../../src/memory/ledger.js';
import { verifyVerify } from '../../../src/memory/ledger-mac.js';
import { subkeyForScope } from '../../../src/memory/verified-read.js';
import { globalStore } from './_shared.js';

// Cross-process lock exclusion is covered by test/memory/lock-concurrency.test.ts (real OS subprocesses); this probe pins the single-writer OUTPUT contract: exactly one signed verify per confirm, per-target gen monotonic.
describe('probe (c): the signed-verify write path — one verify per confirm, monotonic per-target gen', () => {
  it('confirm mints exactly one valid v2 verify bound to the target, no duplicate gen', () => {
    const { store, global, home } = globalStore();
    const a = store.commit({ content: 'db is postgres', source: 'user' });
    store.confirm(a.id);
    const rows = parseLedger(global);
    const verifies = rows.filter((r) => r.type === 'verify' && r.supersedes === a.id);
    expect(verifies).toHaveLength(1);           // one lock-held append, not two
    const v0 = verifies[0]!;                    // non-null: the length check above guarantees index 0 exists
    const subkey = subkeyForScope(home)!;
    expect(verifyVerify(v0, subkey)).toBe(true);
    expect(v0.gen).toBe(1);                     // monotonic gen computed under the lock
  });

  it('confirming the SAME target twice advances its per-target gen 1 -> 2 (monotonic, no collision)', () => {
    const { store, global } = globalStore();
    const a = store.commit({ content: 'fact', source: 'user' });
    store.confirm(a.id);           // gen 1 for target a
    store.confirm(a.id);           // gen 2 for target a (maxGen computed under the lock)
    const gens = parseLedger(global)
      .filter((r) => r.type === 'verify' && r.supersedes === a.id)
      .map((r) => r.gen)
      .sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(gens).toEqual([1, 2]);  // same-target gens are distinct and monotonic
  });
});
