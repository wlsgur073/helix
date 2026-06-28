import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, parseLedger, type LedgerPath } from '../../src/memory/ledger.js';
import type { MemoryRecord } from '../../src/types.js';

function rec(id: string, content = 'x'): MemoryRecord {
  return {
    id, tx: '2026-06-09T00:00:00.000Z',
    validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content,
    provenance: { source: 'user', sessionId: 's1' },
    supersedes: null, blastRadius: null, reverifyTrigger: null,
    classification: 'normal',
  };
}

function tmpLedger(): LedgerPath {
  return join(mkdtempSync(join(tmpdir(), 'helix-ledger-')), 'memory.jsonl');
}

describe('ledger', () => {
  it('appendRecord writes one JSON line per call', () => {
    const p = tmpLedger();
    appendRecord(p, rec('m_1'));
    appendRecord(p, rec('m_2'));
    const lines = readFileSync(p, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe('m_1');
  });

  it('parseLedger reads all records back in order', () => {
    const p = tmpLedger();
    appendRecord(p, rec('m_1'));
    appendRecord(p, rec('m_2'));
    const records = parseLedger(p);
    expect(records.map((r) => r.id)).toEqual(['m_1', 'm_2']);
  });

  it('parseLedger returns [] for a missing file', () => {
    expect(parseLedger(tmpLedger())).toEqual([]);
  });

  it('parseLedger tolerates a corrupt line (skips it)', () => {
    const p = tmpLedger();
    appendRecord(p, rec('m_1'));
    appendFileSync(p, '{not json\n');
    appendRecord(p, rec('m_2'));
    expect(parseLedger(p).map((r) => r.id)).toEqual(['m_1', 'm_2']);
  });

  it('appendRecord creates missing parent dirs BEFORE locking (clean-install first commit)', () => {
    // withFileLock mkdirs `<path>.lock` NON-recursively; if appendRecord did not create the parent
    // first, the lock acquire would throw ENOENT on a path whose ancestors do not yet exist.
    const p = join(mkdtempSync(join(tmpdir(), 'helix-ledger-')), 'sub', 'that', 'does', 'not', 'exist', 'memory.jsonl');
    expect(() => appendRecord(p, rec('m_1'))).not.toThrow();
    expect(existsSync(p)).toBe(true);
    expect(parseLedger(p).map((r) => r.id)).toEqual(['m_1']);
  });
});
