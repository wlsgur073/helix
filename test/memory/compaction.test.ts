import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendRecord, parseLedger, compactLedger } from '../../src/memory/ledger.js';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
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
function tmpStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-h-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const store = new MemoryStore(ledger, { sessionId: 's', home, now: () => '2026-06-09T00:00:00.000Z', genId: () => `m_${++n}` });
  return { store, ledger, home };
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

describe('compactLedger HMAC-aware (via store permanent-erase)', () => {
  it('preserves a genuine signed verify, drops a forged one, and emits an integrity tombstone', () => {
    const { store, ledger } = tmpStore();

    // A: genuine — committed by the user, then confirmed (a real signed Verified verify).
    const a = store.commit({ content: 'alpha fact', source: 'user' });
    store.confirm(a.id);

    // B: committed, then a FORGED Verified verify is hand-appended (no MAC/keyId/macVersion).
    const b = store.commit({ content: 'beta fact', source: 'user' });
    appendFileSync(ledger, JSON.stringify({
      id: 'forgedB', tx: '2026-06-09T00:00:00.000Z', validFrom: '2026-06-09T00:00:00.000Z', validTo: null,
      type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
      supersedes: b.id, blastRadius: null, reverifyTrigger: null, classification: 'normal', gen: 5,
      targetDigest: digestContent('beta fact'),
    }) + '\n');

    // C: committed, then permanently erased — this triggers HMAC-aware compaction.
    const c = store.commit({ content: 'gamma fact', source: 'user' });
    store.erase(c.id, { permanent: true });

    // Recall reflects the verifying replay over the compacted ledger.
    const items = store.recall('fact').items;
    const byId = (id: string) => items.find((i) => i.record.id === id);
    expect(byId(a.id)!.record.state).toBe('Verified'); // genuine elevation preserved across compaction
    expect(byId(b.id)!.record.state).toBe('Fresh');     // forged elevation dropped -> honest floor
    expect(byId(c.id)).toBeUndefined();                  // erased -> gone

    const after = parseLedger(ledger);
    // Integrity-incident tombstone: a content-free verify, no MAC, no target.
    const tomb = after.find((r) => r.type === 'verify' && r.content === '' && !r.mac && r.supersedes === null);
    expect(tomb).toBeDefined();
    expect(tomb!.state).toBe('Suspect');
    // The forged B verify (gen 5) is physically gone.
    expect(after.find((r) => r.gen === 5)).toBeUndefined();
    // The genuine signed verify for A is preserved (still carries its MAC, still targets A).
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && !!r.mac)).toBe(true);
  });

  it('key-absent compaction PRESERVES genuine verifies (non-destructive: cannot tell genuine from forged)', () => {
    // Compaction is DESTRUCTIVE (unlike the recoverable read-path clamp). When the subkey is
    // unresolvable (key removed / transient registry-read failure), we cannot distinguish a genuine
    // verify from a forgery — so we must DROP NOTHING rather than permanently destroy recoverable
    // elevations. With no key, the read path clamps everything to Fresh anyway, so kept records
    // confer no trust; the next key-present compaction purges any forgeries.
    const { store, ledger, home } = tmpStore();
    const a = store.commit({ content: 'alpha fact', source: 'user' });
    store.confirm(a.id); // mints the master + signs A's genuine verify

    const masterPath = join(home, 'ledger-mac-master.key');
    expect(existsSync(masterPath)).toBe(true);
    rmSync(masterPath); // key now unavailable -> subkeyForLedger returns null at compact time

    const c = store.commit({ content: 'gamma fact', source: 'user' });
    store.erase(c.id, { permanent: true }); // triggers compaction with a null subkey

    const after = parseLedger(ledger);
    // A's genuine signed verify MUST still be on disk — key-absent compaction must not destroy it.
    expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && !!r.mac)).toBe(true);
    expect(after.find((r) => r.id === c.id)).toBeUndefined(); // erase still took effect
  });

  it('preserves a genuine SIGNED demotion (Suspect) across compaction; the item stays Suspect on replay', () => {
    const { store, ledger } = tmpStore();
    const probeDir = join(tmpdir(), 'helix-demote-probe');
    mkdirSync(probeDir, { recursive: true });
    const probe = join(probeDir, 'probe.txt');
    writeFileSync(probe, 'placeholder file without the marker');
    try {
      const a = store.commit({ content: `deploy note: ${probe} must contain ENABLED_FLAG`, source: 'agent-inference' });
      const rc = store.recheck(a.id, { kind: 'file-contains', path: probe, pattern: 'ENABLED_FLAG' });
      expect(rc.record?.type).toBe('verify');
      expect(rc.record?.state).toBe('Suspect');
      expect(rc.record?.mac).toBeTruthy();
      expect(store.recall('deploy').items.find((i) => i.record.id === a.id)!.record.state).toBe('Suspect');
      const c = store.commit({ content: 'gamma fact', source: 'user' });
      store.erase(c.id, { permanent: true });
      const items = store.recall('deploy').items;
      expect(items.find((i) => i.record.id === a.id)!.record.state).toBe('Suspect');
      const after = parseLedger(ledger);
      expect(after.some((r) => r.type === 'verify' && r.supersedes === a.id && r.state === 'Suspect' && !!r.mac)).toBe(true);
      expect(after.find((r) => r.type === 'verify' && r.content === '' && !r.mac && r.supersedes === null)).toBeUndefined();
      expect(items.find((i) => i.record.id === c.id)).toBeUndefined();
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
