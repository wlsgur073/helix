// IT-M16 (second fix batch §4.1 items 5-6) with rulings R1 and R4: the tool's SOFT erase answers one of
// three ways, decided by what the id names in the active scopes.
//   - `erased {"id":…}`    a live memory record carried the id; its tombstone was appended;
//   - `unchanged {"id":…}` a memory record (an assert or supersede row) carries the id but is no longer
//                          live (erased or superseded before), or a real marker row carries it — not an
//                          error, so a retried erase stays idempotent;
//   - the error            no memory record and no marker row carries the id: an id nothing ever held,
//                          an id that only matches a marker FAMILY name (R1), and the id of a verify row
//                          or a tombstone (R4), none of which is a memory record. Audit `outcome:
//                          'rejected'`, and the ledger is left byte-identical.
// The PERMANENT (operator-only) path keeps the family match it needs to purge a planted marker.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { parseLedger, isWitnessFence } from '../../src/memory/ledger.js';
import { handleErase, type ToolResult } from '../../src/server/handlers.js';

function store(): { store: MemoryStore; ledger: string; home: string; audit: string } {
  const home = mkdtempSync(join(tmpdir(), 'helix-erase-outcome-'));
  const ledger = join(home, 'memory.jsonl');
  let n = 0;
  const s = new MemoryStore(ledger, { home, sessionId: 's1', now: () => '2026-10-01T00:00:00.000Z', genId: () => `m_${++n}` });
  return { store: s, ledger, home, audit: join(home, 'audit.jsonl') };
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join('');

/** A marker-SHAPED row (verify, null target, no mac), the way a planted or adopted ledger carries one. */
function plantMarker(ledger: string, id: string): void {
  appendFileSync(ledger, JSON.stringify({
    id, tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'verify', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 'x' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

const absentError = (id: string): string =>
  `erase: no memory has id ${JSON.stringify(id)} — nothing was erased; take a record's id from its PROOF line (helix_memory_recall or helix_memory_inspect)`;

const auditRows = (audit: string): Array<Record<string, unknown>> =>
  existsSync(audit) ? readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];

/** Erase `id` through the tool handler and assert the ABSENT shape: the exact error, one `rejected`
 *  audit row, and a ledger left byte for byte as it was. */
function expectAbsent(f: ReturnType<typeof store>, id: string): void {
  const before = existsSync(f.ledger) ? readFileSync(f.ledger) : null;
  const rowsBefore = auditRows(f.audit).length;
  expect(() => handleErase(f.store, { id }, { auditPath: f.audit })).toThrow(absentError(id));
  const rows = auditRows(f.audit);
  expect(rows).toHaveLength(rowsBefore + 1);
  expect(rows.at(-1)).toMatchObject({ kind: 'erase', id, soft: true, outcome: 'rejected' });
  expect(existsSync(f.ledger) ? readFileSync(f.ledger) : null).toEqual(before);
}

describe('erase outcomes through the tool (IT-M16, R1, R4)', () => {
  it('a live record: erased', () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    expect(text(handleErase(f.store, { id: a.id }, { auditPath: f.audit }))).toBe(`erased ${JSON.stringify({ id: a.id })}`);
    const audit = auditRows(f.audit);
    expect(audit).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ kind: 'erase', id: a.id, soft: true });
    expect(audit.at(-1)).not.toHaveProperty('outcome');
  });

  it('a live record created by a supersede is erased like any other, and unchanged writes the plain audit row', () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    const b = f.store.commit({ content: 'alpha deploy fact, revised', source: 'user', supersedes: a.id });
    const rowsBefore = parseLedger(f.ledger).length;
    expect(text(handleErase(f.store, { id: b.id }, { auditPath: f.audit }))).toBe(`erased ${JSON.stringify({ id: b.id })}`);
    const rows = parseLedger(f.ledger);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: 'erase', supersedes: b.id });
    const auditBefore = auditRows(f.audit).length;
    expect(text(handleErase(f.store, { id: b.id }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: b.id })}`);
    const audit = auditRows(f.audit);
    expect(audit).toHaveLength(auditBefore + 1);
    expect(audit.at(-1)).toMatchObject({ kind: 'erase', id: b.id, soft: true });
    expect(audit.at(-1)).not.toHaveProperty('outcome');
  });

  it('an id nothing ever held: the error, a rejected audit row, nothing written', () => {
    const f = store();
    f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    expectAbsent(f, 'm_never_existed');
  });

  // Review Focus: the first erase of a fresh install, before any commit created the ledger file.
  it('a home with no ledger file yet: the error, a rejected audit row, and no ledger created', () => {
    const f = store();
    expect(existsSync(f.ledger)).toBe(false);
    expectAbsent(f, 'm_anything');
    expect(existsSync(f.ledger)).toBe(false);
  });

  it('already erased, and superseded: unchanged, not an error', () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    const b = f.store.commit({ content: 'bravo deploy fact', source: 'user' });
    f.store.commit({ content: 'bravo replacement fact', source: 'user', supersedes: b.id });
    expect(f.store.erase(a.id)).toBe('erased');
    const before = readFileSync(f.ledger);
    expect(text(handleErase(f.store, { id: a.id }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: a.id })}`);
    expect(text(handleErase(f.store, { id: b.id }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: b.id })}`);
    expect(readFileSync(f.ledger)).toEqual(before);
  });

  it('R1: a name that only matches the witness-fence FAMILY (no row carries it) is the error; the real fence id stays unchanged', () => {
    const f = store();
    const anchor = f.store.commit({ content: 'anchor fact the rewrite purges', source: 'user' });
    f.store.commit({ content: 'a fact that stays', source: 'user' });
    f.store.erase(anchor.id, { permanent: true, scope: 'global' });               // a REAL rewrite plants the fence
    const fence = parseLedger(f.ledger).find(isWitnessFence);
    expect(fence, 'precondition: a witness fence is on disk').toBeDefined();
    expectAbsent(f, 'witness_fence_never_written');
    expect(f.store.erase('witness_fence_never_written')).toBe('absent');           // the store says why
    const before = readFileSync(f.ledger);
    expect(text(handleErase(f.store, { id: fence!.id }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: fence!.id })}`);
    expect(readFileSync(f.ledger)).toEqual(before);
  });

  it('R1: the integrity_ and horizon_ family names with only other members on disk are the error too', () => {
    const f = store();
    f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    plantMarker(f.ledger, 'integrity_planted');
    plantMarker(f.ledger, 'horizon_planted');
    expectAbsent(f, 'integrity_marker');
    expectAbsent(f, 'horizon_marker');
    expect(text(handleErase(f.store, { id: 'integrity_planted' }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: 'integrity_planted' })}`);
  });

  it('R4: the id of a signed verify row (minted by confirm) is the error — a verify is not a memory record', () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    const { record: verify } = f.store.confirm(a.id);
    expect(parseLedger(f.ledger).some((r) => r.id === verify.id && r.type === 'verify')).toBe(true);
    expectAbsent(f, verify.id);
    expect(f.store.recall('alpha deploy').items.map((i) => i.record.id)).toContain(a.id);   // the fact stays live
  });

  it("R4: an erase tombstone's own id is the error", () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    expect(f.store.erase(a.id)).toBe('erased');
    const tomb = parseLedger(f.ledger).find((r) => r.type === 'erase' && r.supersedes === a.id)!;
    expectAbsent(f, tomb.id);
  });

  it("R4: a planted invalidate row's own id is the error too (only assert and supersede rows are memory records)", () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    appendFileSync(f.ledger, JSON.stringify({
      id: 'i_planted', tx: '2026-10-01T00:00:01.000Z', validFrom: '2026-10-01T00:00:01.000Z', validTo: null,
      type: 'invalidate', state: 'Suspect', content: '', provenance: { source: 'user', sessionId: 'x' },
      supersedes: a.id, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    }) + '\n');
    expectAbsent(f, 'i_planted');
    expect(text(handleErase(f.store, { id: a.id }, { auditPath: f.audit }))).toBe(`unchanged ${JSON.stringify({ id: a.id })}`);  // the invalidated fact itself
  });
});

describe('an explicit-scope SOFT erase (library only; the tool passes no scope)', () => {
  it("R1 and R4 ids are 'not found in scope', the refusal an absent id always got there", () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    const { record: verify } = f.store.confirm(a.id);
    plantMarker(f.ledger, 'integrity_planted');
    const before = readFileSync(f.ledger);
    for (const id of ['integrity_marker', verify.id, 'm_never_existed']) {
      expect(() => f.store.erase(id, { scope: 'global' }), id).toThrow('erase: id not found in scope global');
    }
    expect(f.store.erase('integrity_planted', { scope: 'global' })).toBe('not-live');           // the exact marker row
    expect(readFileSync(f.ledger)).toEqual(before);
  });
});

describe('the PERMANENT path keeps the family match (operator-only, R1 scope)', () => {
  it('a family-only name still purges the planted marker, while the soft erase of that name is absent', () => {
    const f = store();
    f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    plantMarker(f.ledger, 'integrity_planted');
    expect(f.store.erase('integrity_marker')).toBe('absent');                                 // soft: nothing named
    expect(parseLedger(f.ledger).some((r) => r.id === 'integrity_planted')).toBe(true);
    expect(f.store.erase('integrity_marker', { permanent: true, scope: 'global' })).toBe('not-live');
    expect(parseLedger(f.ledger).some((r) => r.id === 'integrity_planted')).toBe(false);       // purged by the family match
  });

  it("a verify row's id keeps its pre-R4 reading on the permanent path; R4 narrows the soft path only", () => {
    const f = store();
    const a = f.store.commit({ content: 'alpha deploy fact', source: 'user' });
    const { record: verify } = f.store.confirm(a.id);
    expect(f.store.erase(verify.id)).toBe('absent');                                           // soft: names no memory
    expect(f.store.erase(verify.id, { permanent: true, scope: 'global' })).toBe('not-live');   // permanent: as before R4
    // The rewrite keeps a genuine signed verify of a live fact (planCompaction drops erased FACTS by
    // id, never a verify by its own id), so the row and the fact's grade survive.
    expect(parseLedger(f.ledger).some((r) => r.id === verify.id)).toBe(true);
    expect(f.store.recall('alpha deploy').items.find((i) => i.record.id === a.id)?.record.state).toBe('Verified');
  });
});
