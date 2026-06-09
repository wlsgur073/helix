import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendRecord, parseLedger, compactLedger } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

function rec(p: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'x',
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    ...p,
  };
}
function tmpLedger() {
  return join(mkdtempSync(join(tmpdir(), 'helix-compact-')), 'memory.jsonl');
}

describe('compactLedger', () => {
  it('drops the erased item from the live set but keeps a content-free tombstone', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'keep me' }));
    appendRecord(p, rec({ id: 'secret', content: 'PASSWORD', classification: 'personal' }));
    appendRecord(p, rec({ id: 'e_1', type: 'erase', supersedes: 'secret', content: '' }));

    compactLedger(p, { erasedIds: new Set(['secret']) });

    const after = parseLedger(p);
    expect(after.find((r) => r.id === 'm_1')?.content).toBe('keep me'); // unaffected fact kept
    expect(after.find((r) => r.id === 'secret')).toBeUndefined();       // erased: gone from live set
    const tomb = after.find((r) => r.id === 'e_1');                     // tombstone remains for audit
    expect(tomb).toBeDefined();
    expect(tomb!.content).toBe('');
    expect(JSON.stringify(after)).not.toContain('PASSWORD');            // no plaintext anywhere
  });

  it('drops superseded records entirely', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1', content: 'old' }));
    appendRecord(p, rec({ id: 'm_2', type: 'supersede', supersedes: 'm_1', content: 'new' }));

    compactLedger(p, { erasedIds: new Set() });

    const ids = parseLedger(p).map((r) => r.id);
    expect(ids).not.toContain('m_1');
    expect(ids).toContain('m_2');
  });

  it('leaves no temp file behind (atomic rename)', () => {
    const p = tmpLedger();
    appendRecord(p, rec({ id: 'm_1' }));
    compactLedger(p, { erasedIds: new Set() });
    const files = readdirSync(dirname(p));
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(existsSync(p)).toBe(true);
  });
});
