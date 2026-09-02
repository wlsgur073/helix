// The supersede gate had NO test anywhere. It reads two fields to decide whether one record may
// replace another, and both are caller-supplied and outside the MAC:
//
//   const targetIsAuthoritative = isVerifyingSource(target.provenance.source) || target.state === 'Verified';
//   if (targetIsAuthoritative && !isVerifyingSource(source)) throw ...
//
// These cases pin what it actually does today, including the hole, so the fix has a baseline to move
// against. `state` IS MAC-covered; `provenance.source` is not, on either side of the comparison.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';

function store() {
  const home = mkdtempSync(join(tmpdir(), 'helix-supersede-'));
  return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });
}

// Updated when fix (B) landed: these pinned the pre-fix baseline, and three of them deliberately
// changed. The refusals survive — the same records are still guarded — but the message and the
// reason moved from "your declared source is not authoritative" to "you have not shown you read
// this". The fourth case inverted outright: it used to document the hole and now proves it closed.
describe('supersede gate — what it protects', () => {
  it('refuses an agent-inference commit superseding a Verified fact', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id); // genuine signed verify -> state Verified, MAC-covered
    expect(() => s.commit({ content: 'the prod database is evil.example', source: 'agent-inference', supersedes: a.id }))
      .toThrow(/refusing to supersede/);   // tier 1 decides first — it never reaches the digest tier
  });

  it('refuses an agent-inference commit superseding a user-claimed Fresh fact', () => {
    const s = store();
    const a = s.commit({ content: 'the staging host is stg.internal', source: 'user' });
    // still Fresh — never confirmed. Its ONLY protection is the unauthenticated provenance disjunct.
    expect(() => s.commit({ content: 'the staging host is evil.example', source: 'agent-inference', supersedes: a.id }))
      .toThrow(/refusing to supersede/);   // tier 1: the Fresh accident guard, deliberately kept
  });

  it('allows an agent-inference commit superseding another agent-inference fact', () => {
    const s = store();
    const a = s.commit({ content: 'the cache ttl looks like 60s', source: 'agent-inference' });
    const b = s.commit({ content: 'the cache ttl is 300s', source: 'agent-inference', supersedes: a.id });
    expect(b.id).not.toBe(a.id);
  });

  // THE HOLE, now closed. `source` is a model-supplied enum on the ordinary commit tool, so
  // declaring 'user' was free and walked straight past a Verified target. The credential is no
  // longer a claim about the caller; it is evidence the caller read the record.
  it('declaring source=user no longer lets a caller supersede a Verified fact', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    expect(() => s.commit({ content: 'the prod database is evil.example', source: 'user', supersedes: a.id }))
      .toThrow(/supersedesDigest/);
  });

  // The MAC does hold independently: replacement content cannot inherit the grade.
  it('a superseding commit never inherits the Verified grade', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    const digest = s.inspect().find((r) => r.record.id === a.id)!.contentDigest;
    const b = s.commit({ content: 'the prod database is db2.prod.internal', source: 'user', supersedes: a.id, supersedesDigest: digest });
    const live = s.inspect().find((r) => r.record.id === b.id)!;
    expect(live.record.state).toBe('Fresh');
  });
});

// FIX (B): the gate stops accepting a self-asserted `source` as its credential and requires PROOF OF
// READ instead — the caller echoes back the target's content digest, which it can only obtain by
// having actually retrieved the record. A blind or prompt-injected supersede cannot produce it.
//
// The provenance disjunct STAYS, reframed: it is an accident guard over "records a human claimed to
// author", not an authority test. Deleting it would drop the only protection a Fresh user-authored
// record has.
//
// Residual, stated rather than hidden: an attacker who can guess the target's content byte-exactly
// can compute the digest without reading it. That is strictly narrower than declaring an enum value,
// and short predictable facts are the weak case.
describe('supersede gate — proof of read (B)', () => {
  it('refuses a supersede of a Verified fact when no digest is supplied, even declaring source=user', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    expect(() => s.commit({ content: 'the prod database is evil.example', source: 'user', supersedes: a.id }))
      .toThrow(/supersedesDigest/);
  });

  it('refuses a WRONG digest — guessing the id is not enough', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    expect(() => s.commit({
      content: 'the prod database is evil.example', source: 'user', supersedes: a.id,
      supersedesDigest: 'f'.repeat(64),
    })).toThrow(/supersedesDigest/);
  });

  it('accepts the supersede when the caller echoes the digest the read path handed it', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    const seen = s.inspect().find((r) => r.record.id === a.id)!;
    expect(seen.contentDigest).toBeTypeOf('string');       // the read path must expose it
    const b = s.commit({
      content: 'the prod database is db2.prod.internal', source: 'user', supersedes: a.id,
      supersedesDigest: seen.contentDigest,
    });
    expect(b.id).not.toBe(a.id);
  });

  it('an unprotected target still needs no digest — the guard is scoped, not global', () => {
    const s = store();
    const a = s.commit({ content: 'the cache ttl looks like 60s', source: 'agent-inference' });
    const b = s.commit({ content: 'the cache ttl is 300s', source: 'agent-inference', supersedes: a.id });
    expect(b.id).not.toBe(a.id);
  });

  it('a stale digest is refused — the target moved since the caller read it', () => {
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);
    const stale = s.inspect().find((r) => r.record.id === a.id)!.contentDigest;
    const b = s.commit({ content: 'the prod database is db2.prod.internal', source: 'user', supersedes: a.id, supersedesDigest: stale });
    s.confirm(b.id);                                            // b is now the Verified target
    expect(() => s.commit({
      content: 'the prod database is evil.example', source: 'user', supersedes: b.id,
      supersedesDigest: stale,                                  // digest of the ORIGINAL, not of b
    })).toThrow(/supersedesDigest/);
  });
});

// The tool-surface round trip. Everything above tests the store directly; this proves the only path a
// model can actually take — read the digest out of inspect, echo it into commit — is wired end to
// end. Without it the store guard would simply make a verified fact unsupersedable through MCP,
// which would be a regression, not a fix.
describe('supersede gate — the tool-surface round trip', () => {
  it('inspect publishes the digest for a Verified row, and commit accepts it back', async () => {
    const { handleInspect, handleCommit } = await import('../../src/server/handlers.js');
    const s = store();
    const a = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(a.id);

    const shown = handleInspect(s, {}).content[0]!.text;
    // The published label is `contentDigest` (the value's own name); `supersedesDigest` is the
    // PARAMETER it is pasted into below. Renamed 2026-09-02 with the same edit that stopped
    // withholding the line from unverified rows — see the sibling test.
    const digest = /contentDigest=([0-9a-f]{64})/.exec(shown)?.[1];
    expect(digest).toBeTypeOf('string');

    // The same value the store computes, arrived at only by reading the tool's output.
    const out = handleCommit(s, {
      content: 'the prod database is db2.prod.internal', source: 'user',
      supersedes: a.id, supersedesDigest: digest,
    });
    expect(out.content[0]!.text).toMatch(/^committed /);
  });

  // CONTRACT CHANGE, 2026-09-02. This test used to assert the opposite — that an unverified row
  // publishes NO digest, "the affordance appears exactly where it is required" — on the reading that
  // the supersede gate was the only consumer. A second consumer had since shipped: `helix_dual_verify`
  // resolves a `quotedMemory` {id, contentDigest} pair to exempt a record from the memory-echo guard,
  // and the records a caller quotes are overwhelmingly unverified, so withholding the line made that
  // documented escape impossible to assemble. Left as it was, the old assertion would ALSO have gone
  // vacuous rather than red: it matched the literal `supersedesDigest=`, which the same edit renamed,
  // so it would have kept passing while testing nothing.
  it('an unverified row publishes its digest too — a second consumer needs it in that state', async () => {
    const { handleInspect } = await import('../../src/server/handlers.js');
    const s = store();
    const rec = s.commit({ content: 'the staging host is stg.internal', source: 'user' }); // Fresh, never confirmed
    const shown = handleInspect(s, {}).content[0]!.text;
    expect(shown).toMatch(/contentDigest=[0-9a-f]{64}/);
    // Published for the row it sits on: the value must be the store's own digest, not a placeholder.
    const projected = s.inspect().find((r) => r.record.id === rec.id)!.contentDigest;
    expect(shown).toContain(`contentDigest=${projected}`);
  });
});
