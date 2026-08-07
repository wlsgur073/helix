import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { strayTrustFiles, TRUST_FILE_NAMES, compareStrayMasterKey, assessGradeLoss } from '../../src/memory/trust-store-layout.js';
import { MemoryStore } from '../../src/memory/store.js';
import { ensureMaster } from '../../src/memory/ledger-mac.js';
import { advanceWitness, witnessPath, scopeKeyOf } from '../../src/memory/witness-store.js';

const layout = () => {
  const base = mkdtempSync(join(tmpdir(), 'helix-layout-'));
  const home = join(base, 'home');
  const elsewhere = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(elsewhere);
  return { home, elsewhere };
};

describe('strayTrustFiles', () => {
  it('finds nothing when the ledger lives in the home directory', () => {
    const { home } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(home, 'memory.jsonl'))).toEqual([]);
  });

  it('does NOT fire on a trailing-slash home that names the same directory', () => {
    // The comparison has to be canonical, not textual: `join()` normalises the ledger's dirname
    // while the environment variable keeps whatever the user typed. A textual compare reads
    // "/x/home/" and "/x/home" as different places and hard-downs a correctly configured user.
    const { home } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home + sep, join(home, 'memory.jsonl'))).toEqual([]);
  });

  it('reports a master key sitting beside a relocated ledger', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['ledger-mac-master.key']);
  });

  it('reports a witness and a registry only when they are shape-valid', () => {
    const { home, elsewhere } = layout();
    // `projects.json` and `witness.json` are generic enough names that a repo could hold unrelated
    // files by those names; only Helix-shaped content counts, or the fix refuses to start over
    // somebody else's data.
    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ some: 'unrelated tool config' }));
    writeFileSync(join(elsewhere, 'witness.json'), 'not json at all');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);

    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ '/a/project': { stamp: 'x', adoptedAt: '2026-01-01T00:00:00.000Z', macNonce: 'n' } }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['projects.json']);
  });

  it('reports every stray file it finds, in a stable order', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness-log.jsonl'), '{"v":1}\n');
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl')))
      .toEqual(TRUST_FILE_NAMES.filter((n: string) => n === 'ledger-mac-master.key' || n === 'witness-log.jsonl'));
  });

  it('finds nothing beside a relocated ledger that has no trust state yet', () => {
    // A user who set HELIX_LEDGER on a FRESH install has nothing to migrate and must not be blocked.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'memory.jsonl'), '');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  // F1B-DETECTOR-DOS: the five predicates above are weak enough that a repo-writing adversary
  // (the same threat model F1 itself assumes — see docs/issues/repros/f1-detector-startup-dos.ts)
  // can plant a file that reads as "ours" and trigger the startup refusal. Each case below is the
  // planted artifact from that probe, translated 1:1.

  it('does not treat a one-byte ledger-mac-master.key as ours', () => {
    // The real key is exactly 32 bytes (ledger-mac.ts's MASTER_LEN); size > 0 alone lets one
    // arbitrary byte impersonate it.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), 'x');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat projects.json with non-string stamp/macNonce as ours', () => {
    // The real registry validator (ownership.ts) requires stamp/adoptedAt/macNonce to be strings;
    // a predicate that only checks key PRESENCE accepts a file the real reader would reject as corrupt.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'projects.json'), JSON.stringify({ anything: { stamp: 1, macNonce: 1 } }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat witness.json {"scopes":1} as ours', () => {
    // `scopes` must be an object (a scope-keyed map) in the real witness store shape; a bare
    // property-presence check accepts any type at all, including a number.
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness.json'), JSON.stringify({ scopes: 1 }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat an empty witness-log.jsonl as ours', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness-log.jsonl'), '');
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  it('does not treat a symlinked projects.json as ours', () => {
    // existsSync/statSync/readFileSync all FOLLOW symlinks, so a planted link can point at
    // Helix-shaped content living anywhere on disk without the bytes ever touching the repo.
    const { home, elsewhere } = layout();
    const outside = join(home, '..', 'somewhere-else.json');
    writeFileSync(outside, JSON.stringify({ a: { stamp: 'x', adoptedAt: '2026-01-01T00:00:00.000Z', macNonce: 'y' } }));
    symlinkSync(outside, join(elsewhere, 'projects.json'));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual([]);
  });

  // Reverse-direction lock: tightening the predicates must not blind the detector to the genuine
  // article, or the fix regresses F1 (the original defect this detector exists to catch). The other
  // four real file shapes are already exercised above; witness.json's genuine shape is the one gap.
  it('still reports a genuine witness.json (object scopes) beside a relocated ledger', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'witness.json'), JSON.stringify({ v: 1, scopes: {} }));
    expect(strayTrustFiles(home, join(elsewhere, 'memory.jsonl'))).toEqual(['witness.json']);
  });
});

// F1B-DETECTOR-DOS, owner's reversal (2026-08-07): the startup refusal is gated on KEY COMPARISON,
// not key PRESENCE. Presence-only let a genuine F1 scenario through with silent grade loss (see
// server/index.ts's comment on this gate for the full repro) -- home having *a* key is not proof
// that re-grading under it is safe; only a byte-identical stray key is.
describe('compareStrayMasterKey', () => {
  it('returns match when the stray key is byte-identical to HOME\'s own', () => {
    const { home, elsewhere } = layout();
    const key = randomBytes(32);
    writeFileSync(join(home, 'ledger-mac-master.key'), key, { mode: 0o600 });
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), key, { mode: 0o600 });
    expect(compareStrayMasterKey(home, elsewhere)).toBe('match');
  });

  it('returns mismatch when the stray key DIFFERS from HOME\'s own (the F1 regression case)', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    expect(compareStrayMasterKey(home, elsewhere)).toBe('mismatch');
  });

  it('returns mismatch when HOME has a key but no key sits beside the ledger to compare against', () => {
    // Other trust files (e.g. witness.json) can be stray without the master key itself being
    // there. With nothing to prove the ledger's history is safe under HOME's key, this must not
    // read as a proven-safe leftover.
    const { home, elsewhere } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    expect(compareStrayMasterKey(home, elsewhere)).toBe('mismatch');
  });

  it('returns no-home-key when HOME has no master key at all', () => {
    const { home, elsewhere } = layout();
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    expect(compareStrayMasterKey(home, elsewhere)).toBe('no-home-key');
  });

  it('returns no-home-key rather than throwing when HOME\'s key is wrong-sized (the Minor this closes)', () => {
    // Before this fix, a wrong-sized HOME key read as "HOME has a key" via existsSync, downgraded
    // the refusal to a NOTE, and then threw an uncaught LedgerMacError once the store actually
    // tried to use it. tryReadMaster's strict size check must be caught, not left to propagate.
    const { home, elsewhere } = layout();
    writeFileSync(join(home, 'ledger-mac-master.key'), 'x', { mode: 0o600 });
    writeFileSync(join(elsewhere, 'ledger-mac-master.key'), randomBytes(32), { mode: 0o600 });
    expect(compareStrayMasterKey(home, elsewhere)).toBe('no-home-key');
  });
});

// F1B-DETECTOR-DOS round 2, owner's final ruling (2026-08-07): key presence and key identity are
// BOTH proxies. compareStrayMasterKey's 'mismatch' (round 1) refused whenever there was no stray
// key to compare against -- which reopened the DoS this job exists to close: a HEALTHY install (HOME
// has its own key) refused the instant an adversary planted ONE shape-valid stray file with no
// master key beside it. The refusal now measures the loss directly instead.
describe('assessGradeLoss', () => {
  it('finds no loss for a missing ledger, even with no HOME key at all', () => {
    const { home, elsewhere } = layout();
    const result = assessGradeLoss(home, join(elsewhere, 'memory.jsonl'));
    expect(result).toEqual({ loses: false, unverifiableRecordIds: [], witnessMismatch: false, clampedRecordIds: [] });
  });

  it('finds no loss for a ledger whose records are all Fresh (nothing elevated)', () => {
    const { home, elsewhere } = layout();
    const ledger = join(elsewhere, 'memory.jsonl');
    let n = 0;
    const store = new MemoryStore(ledger, { home, sessionId: 's', genId: () => `m_${++n}` });
    store.commit({ content: 'never confirmed, stays Fresh', source: 'user' });
    const result = assessGradeLoss(home, ledger);
    expect(result.loses).toBe(false);
    expect(result.clampedRecordIds).toEqual([]);
  });

  it('tolerates a torn/corrupt ledger line without throwing, and still finds no loss', () => {
    const { home, elsewhere } = layout();
    const ledger = join(elsewhere, 'memory.jsonl');
    writeFileSync(ledger, 'not even json\n{"also":"not a record"}\n');
    expect(() => assessGradeLoss(home, ledger)).not.toThrow();
    expect(assessGradeLoss(home, ledger).loses).toBe(false);
  });

  it('loses via path (a) ALONE: a genuinely elevated record that does not verify under HOME\'s own key', () => {
    // HOME mints its OWN real key (ensureMaster) but its witness for '@global' is never touched --
    // first-contact, not mismatch -- so ANY loss found here can only be the MAC-verification path,
    // proving path (a) is checked independently of witness state.
    const { home, elsewhere } = layout();
    ensureMaster(home);
    const foreignHome = mkdtempSync(join(tmpdir(), 'helix-foreign-home-'));
    const ledger = join(elsewhere, 'memory.jsonl');
    let n = 0;
    const foreign = new MemoryStore(ledger, { home: foreignHome, sessionId: 'foreign', genId: () => `f_${++n}` });
    const rec = foreign.commit({ content: 'confirmed under a key HOME does not have', source: 'user' });
    const { record: verifyRec } = foreign.confirm(rec.id); // the `verify`-type record itself -- scanLegacyElevated reports ITS id, not the target's

    const result = assessGradeLoss(home, ledger);
    expect(result.witnessMismatch).toBe(false); // first-contact, never advanced -- not the alarm kind
    expect(result.clampedRecordIds).toEqual([]);
    expect(result.unverifiableRecordIds).toContain(verifyRec.id);
    expect(result.loses).toBe(true);
  });

  it('loses via path (b) ALONE: a validly-signed record HOME\'s witness no longer recognizes (the reviewer\'s F1 repro)', () => {
    // Build a REAL elevated record under HOME's own key first (witness advances in step, in-sync).
    // Then reset HOME's witness to a DIFFERENT, unrelated baseline for the SAME scope -- the record's
    // own MAC is untouched and still validates under HOME's (unchanged) key, so any loss found here
    // can only be the witness-mismatch clamp, proving path (b) is checked even when signature
    // verification alone would say everything is fine.
    const { home, elsewhere } = layout();
    const ledger = join(elsewhere, 'memory.jsonl');
    let n = 0;
    const store = new MemoryStore(ledger, { home, sessionId: 's', genId: () => `m_${++n}` });
    const rec = store.commit({ content: 'confirmed under HOME\'s own real key', source: 'user' });
    store.confirm(rec.id);
    expect(assessGradeLoss(home, ledger).loses).toBe(false); // sanity: in-sync, nothing lost yet

    rmSync(witnessPath(home), { force: true });
    advanceWitness(home, scopeKeyOf(home), Buffer.from('an unrelated prior baseline, not this ledger\'s bytes'), null);

    const result = assessGradeLoss(home, ledger);
    expect(result.unverifiableRecordIds).toEqual([]); // the record's own MAC still validates fine
    expect(result.witnessMismatch).toBe(true);
    expect(result.clampedRecordIds).toContain(rec.id);
    expect(result.loses).toBe(true);
  });

  it('finds no loss when witness mismatches but nothing live is elevated (the DoS this measurement kills)', () => {
    const { home, elsewhere } = layout();
    const ledger = join(elsewhere, 'memory.jsonl');
    let n = 0;
    const store = new MemoryStore(ledger, { home, sessionId: 's', genId: () => `m_${++n}` });
    store.commit({ content: 'never confirmed, stays Fresh', source: 'user' }); // advances witness, in-sync

    rmSync(witnessPath(home), { force: true });
    advanceWitness(home, scopeKeyOf(home), Buffer.from('an unrelated prior baseline'), null);

    const result = assessGradeLoss(home, ledger);
    expect(result.witnessMismatch).toBe(true);
    expect(result.clampedRecordIds).toEqual([]); // nothing live was elevated, so the clamp is a no-op
    expect(result.loses).toBe(false);
  });

  // Round 3: assessGradeLoss must be a genuine pure read, not merely documented as one.
  // subkeyForScope (verified-read.ts) resolves the global subkey via ownership.ts's
  // globalScopeNonce, which MINTS a nonce and WRITES projects.json under a lock when one is not
  // already established -- exactly the state-changing action this call site (which runs BEFORE the
  // refuse/start decision) must not perform. A refused startup must leave HOME exactly as it found
  // it, not write into it on the way to exit 78.
  it('never mints HOME\'s global-scope nonce: master key present, projects.json absent, stray files at risk', () => {
    const { home, elsewhere } = layout();
    ensureMaster(home); // HOME has its own master key...
    expect(existsSync(join(home, 'projects.json')), 'fixture sanity: no established global scope yet').toBe(false);

    // A genuinely elevated record HOME cannot verify without a nonce to derive its subkey from --
    // exercises the real predicate, not a vacuous empty-ledger pass.
    const foreignHome = mkdtempSync(join(tmpdir(), 'helix-foreign-home-'));
    const ledger = join(elsewhere, 'memory.jsonl');
    let n = 0;
    const foreign = new MemoryStore(ledger, { home: foreignHome, sessionId: 'foreign', genId: () => `p_${++n}` });
    const rec = foreign.commit({ content: 'confirmed elsewhere; HOME has no nonce to verify it with', source: 'user' });
    foreign.confirm(rec.id);

    const result = assessGradeLoss(home, ledger);
    expect(result.loses).toBe(true); // no nonce -> cannot verify -> cannot vouch for this ledger either
    // The purity assertion: still absent AFTER the call. Without this, a future refactor that swaps
    // back to the minting subkeyForScope would silently reintroduce the mint and every other
    // assertion in this file would keep passing.
    expect(existsSync(join(home, 'projects.json')), 'assessGradeLoss must not have minted a nonce').toBe(false);
  });
});
