import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { parseLedger } from '../../../src/memory/ledger.js';
import { verifiedLive } from '../../../src/memory/verified-read.js';
import { globalStore } from './_shared.js';

describe('probe (e): a confirmed verify does not bless mutated target bytes', () => {
  it('rewriting the target content after confirm demotes it below Verified on replay', () => {
    const { store, global, home } = globalStore();
    const a = store.commit({ content: 'the API base url is example dot com', source: 'user' });
    store.confirm(a.id);
    expect(verifiedLive(global, home).live.get(a.id)!.state).toBe('Verified');

    // Tamper: rewrite the assert row's content, leaving the (targetDigest-bound) verify untouched.
    const rows = parseLedger(global);
    const tampered = rows.map((r) =>
      r.id === a.id && r.type === 'assert' ? { ...r, content: 'the API base url is evil dot com' } : r,
    );
    writeFileSync(global, tampered.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // The verify's targetDigest no longer matches the live content → no elevation.
    expect(verifiedLive(global, home).live.get(a.id)!.state).not.toBe('Verified');
  });
});
