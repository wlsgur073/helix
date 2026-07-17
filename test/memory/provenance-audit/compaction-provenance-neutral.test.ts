import { describe, it, expect } from 'vitest';
import { parseLedger, compactLedger } from '../../../src/memory/ledger.js';
import { subkeyForScope } from '../../../src/memory/verified-read.js';
import { verifyVerify } from '../../../src/memory/ledger-mac.js';
import { globalStore } from './_shared.js';

describe('probe (f): compaction preserves provenance; erase removes whole records', () => {
  it('a live record keeps its provenance byte-identically across compaction', () => {
    const { store, global, home } = globalStore();
    const a = store.commit({ content: 'relayed fact', source: 'user-relayed' });
    const before = parseLedger(global).find((r) => r.id === a.id)!;
    const subkey = subkeyForScope(home)!;
    compactLedger(global, {
      erasedIds: new Set(),
      keepValidVerify: (r) => verifyVerify(r, subkey),
    });
    const after = parseLedger(global).find((r) => r.id === a.id)!;
    expect(after.provenance).toEqual(before.provenance); // source + sessionId intact
    expect(after.content).toBe(before.content);
  });

  it('permanent erase removes the whole record', () => {
    const { store, global } = globalStore();
    const a = store.commit({ content: 'secret-bearing', source: 'user' });
    store.erase(a.id, { permanent: true });
    const rows = parseLedger(global);
    expect(rows.find((r) => r.id === a.id && r.content === 'secret-bearing')).toBeUndefined();
  });
});
