// C1.4-③ reused-path trust-laundering (design converged 2026-09-01, Codex compare). An ambiguous
// re-adoption — a REGISTERED path whose `.owner` stamp is now missing or does not match the registry
// entry — cannot be told apart from a genuine lost-`.owner` repair (same project) or a path reused
// for new content (old trust would launder in). So the re-adoption must decide NEITHER way: it enters
// a reversible `trust-pending` state that preserves the nonce (repair stays possible) but clamps the
// scope's prior Verified/Corroborated grades to Fresh on read (no laundering), until a human resolves
// it. First adoption and an idempotent matching re-adoption stay `active`.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stampOwnership, trustStateOf, resolveTrust, scopeNonce } from '../../src/memory/ownership.js';
import { MemoryStore } from '../../src/memory/store.js';

function dirs() {
  return {
    home: mkdtempSync(join(tmpdir(), 'helix-home-')),
    proj: mkdtempSync(join(tmpdir(), 'helix-proj-')),
  };
}
const ownerFile = (proj: string) => join(proj, '.helix', '.owner');
const storeAt = (home: string, proj: string, sessionId: string) =>
  new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId, project: { root: proj, ledger: join(proj, '.helix', 'memory.jsonl') } });

describe('trust-pending: ambiguous re-adoption is trust-neutral', () => {
  it('first adoption is active', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'STAMP1' });
    expect(trustStateOf(proj, home)).toBe('active');
  });

  it('an idempotent re-adoption with a matching .owner stays active', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'STAMP1' });
    stampOwnership(proj, home, {}); // .owner still present and matching
    expect(trustStateOf(proj, home)).toBe('active');
  });

  it('a re-adoption with a LOST .owner enters trust-pending (nonce preserved)', () => {
    const { home, proj } = dirs();
    let n = 0;
    stampOwnership(proj, home, { genStamp: () => (n++ === 0 ? 'STAMP1' : 'NONCE1') });
    const nonceBefore = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))[resolve(proj)].macNonce;
    unlinkSync(ownerFile(proj)); // the stamp is lost
    stampOwnership(proj, home, {}); // ambiguous re-adoption
    expect(trustStateOf(proj, home)).toBe('pending');
    const nonceAfter = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))[resolve(proj)].macNonce;
    expect(nonceAfter).toBe(nonceBefore); // reversible: repair must stay possible, so the nonce is kept
  });

  it('a re-adoption with a MISMATCHED .owner enters trust-pending', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, { genStamp: () => 'STAMP1' });
    writeFileSync(ownerFile(proj), 'SOME-OTHER-STAMP'); // a foreign/overwritten stamp
    stampOwnership(proj, home, {});
    expect(trustStateOf(proj, home)).toBe('pending');
  });

  it('trustStateOf is active for an unregistered project (nothing to be pending about)', () => {
    const { home, proj } = dirs();
    expect(trustStateOf(proj, home)).toBe('active');
  });
});

describe('trust-pending: the read path clamps a pending scope to Fresh (no laundering)', () => {
  it('an old Verified row reads Fresh after an ambiguous re-adoption', () => {
    const { home, proj } = dirs();
    const s1 = storeAt(home, proj, 's1');
    s1.adopt(proj);
    const rec = s1.commit({ content: 'the prod db is postgres on blue', source: 'user', scope: 'project' });
    s1.confirm(rec.id);
    expect(s1.inspect().find((x) => x.record.id === rec.id)?.record.state).toBe('Verified');

    // Ambiguous re-adoption: the .owner is lost, then the path is re-adopted -> trust-pending.
    unlinkSync(ownerFile(proj));
    storeAt(home, proj, 's2').adopt(proj);
    expect(trustStateOf(proj, home)).toBe('pending');

    // The laundering fix: the old Verified row now reads Fresh, not Verified, until a human resolves.
    const after = storeAt(home, proj, 's3').inspect().find((x) => x.record.id === rec.id);
    expect(after?.record.state).toBe('Fresh');
    expect(after?.integrity).toBe('ok'); // clamped, NOT reported as corruption
  });

  it('an active scope still surfaces Verified (the clamp is pending-only)', () => {
    const { home, proj } = dirs();
    const s1 = storeAt(home, proj, 's1');
    s1.adopt(proj);
    const rec = s1.commit({ content: 'the region is us-east-1', source: 'user', scope: 'project' });
    s1.confirm(rec.id);
    // No ambiguous re-adoption: stays active, Verified survives a fresh read.
    expect(storeAt(home, proj, 's2').inspect().find((x) => x.record.id === rec.id)?.record.state).toBe('Verified');
  });

  it('confirm in a pending scope is refused with a trust-pending message, not "not owned"', () => {
    const { home, proj } = dirs();
    const s1 = storeAt(home, proj, 's1');
    s1.adopt(proj);
    const rec = s1.commit({ content: 'the cache is redis', source: 'user', scope: 'project' });
    unlinkSync(ownerFile(proj));
    storeAt(home, proj, 's2').adopt(proj); // -> pending
    expect(() => storeAt(home, proj, 's3').confirm(rec.id)).toThrow(/trust-pending/i);
    // and NOT the misleading generic subkey message, which reads as "you never adopted this"
    expect(() => storeAt(home, proj, 's3').confirm(rec.id)).not.toThrow(/not owned/i);
  });
});

describe('trust-pending: human resolution (repair / fresh)', () => {
  function pendingScopeWithVerified() {
    const { home, proj } = dirs();
    const s1 = storeAt(home, proj, 's1');
    s1.adopt(proj);
    const rec = s1.commit({ content: 'the queue backend is sqs', source: 'user', scope: 'project' });
    s1.confirm(rec.id);
    unlinkSync(ownerFile(proj));
    storeAt(home, proj, 's2').adopt(proj); // -> pending
    return { home, proj, id: rec.id };
  }

  it('repair returns the scope to active and restores the old Verified rows (nonce unchanged)', () => {
    const { home, proj, id } = pendingScopeWithVerified();
    const nonceBefore = scopeNonce(proj, home);
    resolveTrust(proj, home, 'repair');
    expect(trustStateOf(proj, home)).toBe('active');
    expect(scopeNonce(proj, home)).toBe(nonceBefore); // repair keeps the nonce
    expect(storeAt(home, proj, 's3').inspect().find((x) => x.record.id === id)?.record.state).toBe('Verified');
  });

  it('fresh returns to active but rotates the nonce, so the old Verified stays Fresh', () => {
    const { home, proj, id } = pendingScopeWithVerified();
    const nonceBefore = scopeNonce(proj, home);
    resolveTrust(proj, home, 'fresh');
    expect(trustStateOf(proj, home)).toBe('active');
    expect(scopeNonce(proj, home)).not.toBe(nonceBefore); // fresh rotates the nonce
    expect(storeAt(home, proj, 's3').inspect().find((x) => x.record.id === id)?.record.state).toBe('Fresh');
  });

  it('resolveTrust on an active scope refuses (nothing is pending)', () => {
    const { home, proj } = dirs();
    stampOwnership(proj, home, {});
    expect(() => resolveTrust(proj, home, 'repair')).toThrow(/not.*pending|no.*pending/i);
  });
});
