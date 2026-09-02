// `helix_dual_verify` documents `quotedMemory` as `{id, contentDigest}` pairs and calls each pair a
// proof of read; `classifyEgress` resolves a pair against the ledger and exempts the matched record
// from the memory-echo guard. The pair has to be assembled from a tool's OUTPUT, and until this test
// existed nothing checked that any surface publishes the value: `handleInspect` emitted it for
// `Verified` rows only, so for a Fresh, Corroborated or Suspect record the documented escape could
// not be assembled at all.
//
// That is not a hypothetical. The dogfood protocol's cross-check was refused 27 times across 22
// sessions; the 2026-09-02 run was the first to clear the stakes floor, which left the echo guard as
// the only remaining barrier, and its journal recorded that the one documented way past it needs a
// digest `recall`/`inspect` never printed for the records it holds.
//
// These tests assert the CONSEQUENCE — that a pair read out of the tool output resolves against the
// very ledger the guard consults — rather than that some string appears. A test for the literal
// would pass on a published value that is wrong.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { digestContent } from '../../src/memory/ledger-mac.js';
import { handleInspect } from '../../src/server/handlers.js';

function store(): MemoryStore {
  const home = mkdtempSync(join(tmpdir(), 'helix-inspect-digest-'));
  return new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });
}

/** Byte-for-byte the ledger `helix-server.ts` hands the egress guard. */
function guardLedger(s: MemoryStore): Array<{ id: string; content: string; contentDigest: string }> {
  return s.inspect().map(({ record, contentDigest }) => ({
    id: record.id,
    content: record.content,
    contentDigest: contentDigest ?? digestContent(record.content),
  }));
}

/**
 * What a caller can actually do: read one `id -> contentDigest` pair out of the rendered output.
 * The digest sits on the line after its record, and the data frame re-applies the `DATA[state:scope]|`
 * mark to that continuation line, so the pattern has to step over the mark rather than over whitespace.
 */
function pairsFromInspect(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const re = /(m_[0-9a-f-]+)[^\n]*\n[^\n]*?contentDigest=([0-9a-f]{64})/g;
  for (const m of text.matchAll(re)) found.set(m[1]!, m[2]!);
  return found;
}

describe('inspect publishes a contentDigest a caller can quote', () => {
  it('publishes it for an unverified row, and the value resolves against the guard ledger', () => {
    const s = store();
    const rec = s.commit({ content: 'the staging host is stg.internal', source: 'user' }); // Fresh

    const pairs = pairsFromInspect(handleInspect(s, {}).content[0]!.text);
    const quoted = pairs.get(rec.id);
    expect(quoted, 'inspect published no contentDigest for a Fresh row').toBeTypeOf('string');

    const inLedger = guardLedger(s).find((i) => i.id === rec.id);
    expect(quoted).toBe(inLedger!.contentDigest);
  });

  it('publishes it for a Verified row too, so the affordance does not depend on state', () => {
    const s = store();
    const rec = s.commit({ content: 'the prod database is db.prod.internal', source: 'user' });
    s.confirm(rec.id);

    const quoted = pairsFromInspect(handleInspect(s, {}).content[0]!.text).get(rec.id);
    expect(quoted).toBe(guardLedger(s).find((i) => i.id === rec.id)!.contentDigest);
  });

  it('publishes the digest of the row it sits on, not of some other row', () => {
    const s = store();
    const a = s.commit({ content: 'alpha lives at alpha.internal', source: 'user' });
    const b = s.commit({ content: 'bravo lives at bravo.internal', source: 'user' });

    const pairs = pairsFromInspect(handleInspect(s, {}).content[0]!.text);
    expect(pairs.get(a.id)).toBe(digestContent('alpha lives at alpha.internal'));
    expect(pairs.get(b.id)).toBe(digestContent('bravo lives at bravo.internal'));
    expect(pairs.get(a.id)).not.toBe(pairs.get(b.id));
  });
});
