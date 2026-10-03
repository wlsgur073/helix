// IT-M15 (second fix batch §4.3, D3): with a subkey resolved, a verify offender is split by the fields
// the MAC check dispatches on, so the startup scan can name its cause — forged/legacy, tampered (the
// current key id with a failing MAC), other-key (a nonce rotated by --fresh, a re-minted key, or a
// forgery) or newer-version. Every case is a REAL signed ledger (a store's confirm), then one field moved.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLegacyElevated, classifyLegacyOffenders } from '../../src/memory/legacy-scan.js';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger } from '../../src/memory/ledger.js';
import { subkeyForScope } from '../../src/memory/verified-read.js';
import { verifyVerify, signVerify, deriveSubkey, tryReadMaster, digestContent, keyIdOf, isFutureMacVersion, MAC_VERSION } from '../../src/memory/ledger-mac.js';
import type { MemoryRecord } from '../../src/types.js';

const pred = (subkey: Buffer | null) => (r: MemoryRecord) => (subkey ? verifyVerify(r, subkey) : false);

/** A global ledger holding one fact and the genuine signed verify confirm minted for it. */
function signedLedger() {
  const home = mkdtempSync(join(tmpdir(), 'helix-m15-'));
  const ledger = join(home, 'memory.jsonl');
  const store = new MemoryStore(ledger, { sessionId: 's', home });
  const fact = store.commit({ content: 'the staging db host is db.staging.internal', source: 'user' });
  store.confirm(fact.id);
  const subkey = subkeyForScope(home)!;
  const records = parseLedger(ledger);
  const verify = records.find((r) => r.type === 'verify')!;
  return { home, subkey, records, verify, factId: fact.id };
}

const classify = (records: MemoryRecord[], subkey: Buffer | null) =>
  classifyLegacyOffenders(records, scanLegacyElevated(records, pred(subkey)).offenders, !!subkey, subkey);

describe('classifyLegacyOffenders — the four classes under a resolved subkey (IT-M15)', () => {
  it('a genuine signed verify is no offender at all', () => {
    const { subkey, records } = signedLedger();
    expect(classify(records, subkey)).toEqual({ forged: [], tampered: [], otherKey: [], newerVersion: [], unverifiable: [] });
  });

  it('a different key (a rotated nonce: what --fresh does) is otherKey, never forged', () => {
    const { home, records, verify } = signedLedger();
    const rotated = deriveSubkey(tryReadMaster(home)!, 'a-rotated-nonce');
    const c = classify(records, rotated);
    expect(c.otherKey).toEqual([verify.id]);
    expect(c.forged).toEqual([]);
    expect(c.tampered).toEqual([]);
  });

  it('a MAC-covered field moved under the CURRENT key id is tampered', () => {
    const { subkey, records, verify } = signedLedger();
    const edited = records.map((r) => (r.id === verify.id ? { ...r, gen: (r.gen ?? 0) + 7 } : r));
    const c = classify(edited, subkey);
    expect(c.tampered).toEqual([verify.id]);
    expect(c.forged).toEqual([]);
    expect(c.otherKey).toEqual([]);
  });

  it('a future macVersion is newerVersion', () => {
    const { subkey, records, verify } = signedLedger();
    const newer = records.map((r) => (r.id === verify.id ? { ...r, macVersion: 3 } : r));
    expect(classify(newer, subkey).newerVersion).toEqual([verify.id]);
  });

  it('a MAC that checks over a state this build does not know is newerVersion (C9)', () => {
    const { subkey, records, verify } = signedLedger();
    const unknownState = signVerify({ ...verify, id: 'v_unknown_state', state: 'Attested' as MemoryRecord['state'], mac: undefined, keyId: undefined, macVersion: undefined }, subkey);
    expect(verifyVerify(unknownState, subkey)).toBe(true);
    const c = classify([...records, unknownState], subkey);
    expect(c.newerVersion).toEqual(['v_unknown_state']);
    expect(c.tampered).toEqual([]);
  });

  it('a verify with no mac, or no keyId, and a baked non-Fresh assert stay forged/legacy', () => {
    const { subkey, records, verify, factId } = signedLedger();
    const noMac: MemoryRecord = { ...verify, id: 'v_nomac', mac: undefined };
    const noKeyId: MemoryRecord = { ...verify, id: 'v_nokeyid', keyId: undefined };
    const baked: MemoryRecord = { ...records.find((r) => r.id === factId)!, id: 'a_baked', state: 'Verified' };
    const c = classify([...records, noMac, noKeyId, baked], subkey);
    expect(c.forged).toEqual(['v_nomac', 'v_nokeyid', 'a_baked']);
  });

  it('with NO subkey the split is unchanged: verify rows unverifiable, baked rows forged', () => {
    const { records, verify, factId } = signedLedger();
    const baked: MemoryRecord = { ...records.find((r) => r.id === factId)!, id: 'a_baked', state: 'Verified' };
    const c = classify([...records, baked], null);
    expect(c.unverifiable).toEqual([verify.id]);
    expect(c.forged).toEqual(['a_baked']);
    expect(c.otherKey).toEqual([]);
  });

  it('two rows sharing one id are each classified on their own fields', () => {
    const { subkey, records, verify } = signedLedger();
    const forgedCopy: MemoryRecord = { ...verify, mac: undefined };  // same id, placed BEFORE the genuine row
    const reordered = [...records.filter((r) => r.id !== verify.id), forgedCopy, verify];
    const c = classify(reordered, subkey);
    expect(c.forged).toEqual([verify.id]);
    expect(c.tampered).toEqual([]);
  });

  it('scanLegacyElevated itself is unchanged: the same offenders under the same predicate', () => {
    const { home, records } = signedLedger();
    const rotated = deriveSubkey(tryReadMaster(home)!, 'a-rotated-nonce');
    expect(scanLegacyElevated(records, pred(rotated)).offenders).toHaveLength(1);
  });
});

// Ruling R8 (second fix batch §4.3 item 1): `macVersion` is not MAC-covered, so a forged row can set it.
// Absent or not a number — something no Helix build ever wrote beside a mac and a keyId (signVerify has
// stamped it since the first signing commit) — is forged/legacy, never "newer". Which NUMBERS read as
// newer-version is plan refinement P2, pinned in the describe after this one.
describe('macVersion absent or not a number is forged/legacy (R8)', () => {
  /** The genuine verify with its MAC replaced by garbage: still the CURRENT key id. */
  const forgedCurrentKey = (verify: MemoryRecord): MemoryRecord => ({ ...verify, id: 'v_forged', mac: '0'.repeat(64) });

  it('a current-key forgery is tampered at macVersion 2, and forged/legacy with macVersion absent, a string, or null', () => {
    const { subkey, records, verify } = signedLedger();
    const cases: Array<[string, unknown, keyof ReturnType<typeof classify>]> = [
      ['2 (accepted)', 2, 'tampered'],
      ['absent', undefined, 'forged'],
      ['the string "2"', '2', 'forged'],
      ['null', null, 'forged'],
    ];
    for (const [label, macVersion, expected] of cases) {
      const row = { ...forgedCurrentKey(verify), macVersion } as unknown as MemoryRecord;
      const c = classify([...records, row], subkey);
      expect(c[expected], label).toEqual(['v_forged']);
      for (const other of ['forged', 'tampered', 'otherKey', 'newerVersion', 'unverifiable'] as const) {
        if (other !== expected) expect(c[other], `${label}: ${other}`).toEqual([]);
      }
    }
  });

  it('a genuine row whose macVersion is deleted or stringified is forged/legacy too (the field is not MAC-covered)', () => {
    const { subkey, records, verify } = signedLedger();
    const { macVersion: _dropped, ...noVersion } = verify;
    expect(classify(records.map((r) => (r.id === verify.id ? noVersion as MemoryRecord : r)), subkey).forged).toEqual([verify.id]);
    const stringy = { ...verify, macVersion: '2' } as unknown as MemoryRecord;
    expect(classify(records.map((r) => (r.id === verify.id ? stringy : r)), subkey).forged).toEqual([verify.id]);
  });
});

// Plan refinement P2 (second fix batch §4.3 item 1, R8): a "newer version" NUMBER is what compaction
// already keeps as a FUTURE row — a macVersion that is a safe integer above MAC_VERSION — through ONE
// exported predicate, isFutureMacVersion, so the scan's newer-version NOTE and compaction's keep rule
// (store.ts keepValidVerifyFor) read a future version the same way. Every other number (0, negative,
// fractional, beyond the safe-integer range, infinite) is no version any Helix writes, so it is
// forged/legacy.
describe('newer-version means a future MAC version, the rule compaction keeps by (P2)', () => {
  it('isFutureMacVersion is true only for a safe integer above MAC_VERSION', () => {
    for (const v of [MAC_VERSION + 1, 99, Number.MAX_SAFE_INTEGER]) expect(isFutureMacVersion(v), String(v)).toBe(true);
    for (const v of [1, MAC_VERSION, 0, -1, 2.5, MAC_VERSION + 0.5, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN, '3', null, undefined]) {
      expect(isFutureMacVersion(v), String(v)).toBe(false);
    }
  });

  it('a genuine row moved to a future version is newer-version; moved to any other number, forged/legacy', () => {
    const { subkey, records, verify } = signedLedger();
    const at = (macVersion: number): ReturnType<typeof classify> =>
      classify(records.map((r) => (r.id === verify.id ? { ...r, macVersion } : r)), subkey);
    for (const v of [MAC_VERSION + 1, 99, Number.MAX_SAFE_INTEGER]) {
      expect(at(v).newerVersion, String(v)).toEqual([verify.id]);
      expect(at(v).forged, String(v)).toEqual([]);
    }
    for (const v of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN]) {
      expect(at(v).forged, String(v)).toEqual([verify.id]);
      expect(at(v).newerVersion, String(v)).toEqual([]);
    }
  });

  it('the scan calls newer-version exactly the planted rows a permanent-erase compaction keeps', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-m15-p2-'));
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, { sessionId: 's', home });
    const keep = store.commit({ content: 'keep me', source: 'user' });
    const gone = store.commit({ content: 'erase me', source: 'user' });
    store.confirm(keep.id);                                  // the master exists: compaction runs HMAC-aware
    const subkey = subkeyForScope(home)!;
    const ts = '2026-07-01T00:00:00.000Z';
    const versions: Record<string, number> = {
      v_3: 3, v_99: 99, v_max: Number.MAX_SAFE_INTEGER,      // future versions
      v_0: 0, v_neg: -1, v_frac: 2.5, v_unsafe: Number.MAX_SAFE_INTEGER + 2,   // numbers no Helix writes
    };
    // Every planted row carries the CURRENT key id and a MAC that fails. Compaction drops a verify as
    // forged only when every eligible verify carries one key id (planCompaction's single-lineage rule:
    // a second key id reads as a second lineage and preserves every row, which made an earlier draft of
    // this case keep all seven), so here the keep rule alone decides what survives.
    for (const [id, macVersion] of Object.entries(versions)) {
      appendFileSync(ledger, JSON.stringify({ id, tx: ts, validFrom: ts, validTo: null,
        type: 'verify', state: 'Verified', content: '', provenance: { source: 'user', sessionId: 's' },
        supersedes: keep.id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
        gen: 9, targetDigest: digestContent('keep me'), mac: '0'.repeat(64), keyId: keyIdOf(subkey), macVersion }) + '\n');
    }
    const newer = classify(parseLedger(ledger), subkey).newerVersion;
    store.erase(gone.id, { permanent: true });
    const kept = parseLedger(ledger).map((r) => r.id).filter((id) => id in versions);
    expect([...newer].sort()).toEqual(['v_3', 'v_99', 'v_max']);
    expect([...kept].sort()).toEqual([...newer].sort());
  });
});

// The classifier applies its checks in verifyVerify's own order. Each case moves one field on a row that
// an earlier case left alone, so a check that ran out of order would file the row under another class
// (and print a NOTE where the WARNING belongs).
describe("classifyVerifyOffender's order: missing fields, then the version, then the key id, then the MAC", () => {
  it('a future-version row with no mac, or no keyId, is forged/legacy: the missing-field check comes first', () => {
    const { subkey, records, verify } = signedLedger();
    const noMac = { ...verify, id: 'v_nomac3', mac: undefined, macVersion: MAC_VERSION + 1 } as MemoryRecord;
    const noKeyId = { ...verify, id: 'v_nokeyid3', keyId: undefined, macVersion: MAC_VERSION + 1 } as MemoryRecord;
    const c = classify([...records, noMac, noKeyId], subkey);
    expect(c.forged).toEqual(['v_nomac3', 'v_nokeyid3']);
    expect(c.newerVersion).toEqual([]);
  });

  it('the version checks come before the key-id check (a row under ANOTHER key id)', () => {
    const { subkey, records, verify } = signedLedger();
    const at = (macVersion: unknown) =>
      classify([...records, { ...verify, id: 'v_x', keyId: 'aaaaaaaaaaaaaaaa', macVersion } as unknown as MemoryRecord], subkey);
    for (const v of [undefined, '2', 0]) {
      expect(at(v).forged, String(v)).toEqual(['v_x']);
      expect(at(v).otherKey, String(v)).toEqual([]);
    }
    expect(at(3).newerVersion).toEqual(['v_x']);
    expect(at(3).otherKey).toEqual([]);
    expect(at(2).otherKey).toEqual(['v_x']);
  });

  it('a failing MAC under the current key id is tampered whatever its state', () => {
    const { subkey, records, verify } = signedLedger();
    const row = { ...verify, id: 'v_x', mac: '0'.repeat(64), state: 'Attested' } as unknown as MemoryRecord;
    const c = classify([...records, row], subkey);
    expect(c.tampered).toEqual(['v_x']);
    expect(c.newerVersion).toEqual([]);
  });
});

// classifyLegacyOffenders re-states the scan's offender rule to pair each offender id with the row it came
// from. These cases hold that copy and the pairing walk in place: a row the scan does not flag never takes
// an offender's id, and an offender the walk cannot match is still reported.
describe('classifyLegacyOffenders pairs each offender id with its own row', () => {
  const otherKeyRow = (verify: MemoryRecord, id: string): MemoryRecord => ({ ...verify, id, keyId: 'aaaaaaaaaaaaaaaa' });

  it('two rows sharing one id, the genuine row FIRST', () => {
    const { subkey, records, verify } = signedLedger();
    const c = classify([...records, { ...verify, mac: undefined }], subkey);
    expect(c.forged).toEqual([verify.id]);
    expect(c.tampered).toEqual([]);
  });

  it("a Fresh assert ahead of an other-key verify that shares its id does not take the offender's place", () => {
    const { subkey, records, verify, factId } = signedLedger();
    const freshAssert: MemoryRecord = { ...records.find((r) => r.id === factId)!, id: 'dup' };
    const c = classify([...records, freshAssert, otherKeyRow(verify, 'dup')], subkey);
    expect(c.otherKey).toEqual(['dup']);
    expect(c.forged).toEqual([]);
  });

  it("a content-free marker ahead of an other-key verify that shares its id does not take the offender's place", () => {
    const { subkey, records, verify } = signedLedger();
    const marker = { ...verify, id: 'dup', supersedes: null, mac: undefined, keyId: undefined, macVersion: undefined, content: '', state: 'Suspect' } as MemoryRecord;
    const c = classify([...records, marker, otherKeyRow(verify, 'dup')], subkey);
    expect(c.otherKey).toEqual(['dup']);
    expect(c.forged).toEqual([]);
  });

  it('an offender the walk cannot match falls back to forged/legacy; none is lost and none is counted twice', () => {
    const { subkey, records, verify } = signedLedger();
    const ledger = [...records, otherKeyRow(verify, 'v_other')];
    const offenders = scanLegacyElevated(ledger, pred(null)).offenders;       // a key-less scan: the genuine verify is an offender too
    expect(offenders).toEqual([verify.id, 'v_other']);
    const c = classifyLegacyOffenders(ledger, offenders, true, subkey);         // classified WITH the key: no row matches the first id
    expect(c.forged).toContain(verify.id);
    expect([...c.forged, ...c.tampered, ...c.otherKey, ...c.newerVersion, ...c.unverifiable].sort()).toEqual([...offenders].sort());
  });

  it('keyResolved false wins over a handed subkey: a verify offender stays unverifiable', () => {
    const { home, records, verify } = signedLedger();
    const rotated = deriveSubkey(tryReadMaster(home)!, 'a-rotated-nonce');
    const c = classifyLegacyOffenders(records, scanLegacyElevated(records, pred(rotated)).offenders, false, rotated);
    expect(c.unverifiable).toEqual([verify.id]);
    expect(c.otherKey).toEqual([]);
  });
});
