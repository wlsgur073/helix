// IT-M3 and IT-M4 (second fix batch §4.6, §4.7) with rulings R10, R11 and R12, through the real handlers.
//   - IT-M3: a commit whose secret scan replaced a span reports `redactions` and a `notice`; a recheck
//     that cannot bind on such a record says the content was redacted. R10: that sentence follows the
//     record's classification, not the text `[redacted:` a user may type into an unredacted fact.
//   - IT-M4: an EXPLICIT 'global' commit made while this session's project memory is off carries a
//     `notice` that the fact went to global memory. R11: 'unadopted-present' (a cwd project whose
//     memory file Helix did not create, not adopted, excluded from every read) is one of those states,
//     next to 'ancestor-unadopted' and 'aliased'. R12: the `scope` description leaves the choice of
//     global memory to the user, before or after a refusal.
// Success stays ONE JSON object after the verb (`<verb> {json}`, decision E1).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { stampOwnership, projectLedgerPath, projectDispositionOf, type ProjectOrigin } from '../../src/memory/ownership.js';
import { handleCommit, handleRecheck, REDACTION_NOTICE, GLOBAL_WHILE_PROJECT_OFF_NOTICE, type ToolResult } from '../../src/server/handlers.js';
import { REDACTED_BINDING_NOTE } from '../../src/memory/reality-check.js';
import { fromSource } from '../../scripts/inventory/extract-tools.js';

const made: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const text = (r: ToolResult): string => r.content.map((c) => c.text).join('');
const committed = (out: string): Record<string, unknown> => {
  expect(out.startsWith('committed {')).toBe(true);
  return JSON.parse(out.slice('committed '.length)) as Record<string, unknown>;
};

function store(project?: { root: string; origin?: ProjectOrigin }): { store: MemoryStore; home: string } {
  const home = tmp('helix-disc-home-');
  const s = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 's1',
    ...(project ? { project: { root: project.root, ledger: projectLedgerPath(project.root), origin: project.origin ?? 'cwd' } } : {}),
  });
  return { store: s, home };
}

/** A foreign memory file (one row Helix did not write) in a project nobody adopted. */
function foreignLedger(root: string): void {
  mkdirSync(join(root, '.helix'), { recursive: true });
  writeFileSync(projectLedgerPath(root), JSON.stringify({
    id: 'f_1', tx: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
    type: 'assert', state: 'Fresh', content: 'a row Helix did not write', provenance: { source: 'user', sessionId: 'x' },
    supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
  }) + '\n');
}

const UUID_PATH = 'data/3f1c2a9e-7b4d-4e8a-9c2f-5d6e7f8a9b0c/db.conf';

describe('IT-M3: redaction disclosure, and the recheck sentence keyed on the classification (R10)', () => {
  // The two sentences pinned as text: the cases below compare with the imported constants, and an
  // export that does not exist yet reads as undefined on both sides of such a comparison.
  it('the notice and the recheck sentence are the ruled constants', () => {
    expect(REDACTION_NOTICE).toBe('part of this fact was replaced with [redacted:<kind>] markers before storage; a recheck cannot bind a path or pattern that fell inside a redacted span');
    expect(REDACTED_BINDING_NOTE).toBe("this memory's content was redacted at commit ([redacted:<kind>] markers), so a path or pattern inside a redacted span can never bind");
  });

  it('a redacted commit reports redactions and the notice; a recheck through the redacted path names the redaction', () => {
    const { store: s, home } = store();
    const out = committed(text(handleCommit(s, { content: `the staging database config lives at ${UUID_PATH} and sets max_connections = 200`, source: 'user' })));
    expect(Object.keys(out)).toEqual(['id', 'scope', 'state', 'classification', 'redactions', 'notice']);
    expect(out.classification).toBe('secret-redacted');
    expect(out.redactions).toEqual({ 'high-entropy': 1 });
    expect(out.notice).toBe(REDACTION_NOTICE);
    expect(() => handleRecheck(s, { id: out.id as string, check: { kind: 'file-contains', path: UUID_PATH, pattern: 'max_connections = 200' } }, { auditPath: join(home, 'audit.jsonl') }))
      .toThrow(`recheck: check.path is not present in the item content; ${REDACTED_BINDING_NOTE}`);
  });

  it('R10: a fact a user typed "[redacted:token]" into, with nothing redacted, gets the bare refusal', () => {
    const { store: s, home } = store();
    const out = committed(text(handleCommit(s, { content: 'the log line reads [redacted:token] next to app.conf and max_connections = 200', source: 'user' })));
    expect(Object.keys(out)).toEqual(['id', 'scope', 'state', 'classification']);
    expect(out.classification).toBe('normal');
    let message = '';
    try {
      handleRecheck(s, { id: out.id as string, check: { kind: 'file-contains', path: 'other.conf', pattern: 'max_connections = 200' } }, { auditPath: join(home, 'audit.jsonl') });
    } catch (e) { message = (e as Error).message; }
    expect(message).toBe('recheck: check.path is not present in the item content');
  });
});

describe('the commit description names the disclosure (IT-M3)', () => {
  it('says the result adds `redactions` and a `notice` when the secret scan replaced part of the fact', async () => {
    // The source registry, not extractTools(): that one also demands the committed bundle agree, and the
    // bundle is rebuilt only in the build commit.
    const tools = await fromSource();
    const commit = tools.find((t) => t.name === 'helix_memory_commit');
    expect(commit?.description ?? '').toContain('When the secret scan replaced part of the fact, the result adds `redactions` (replaced spans per marker kind) and a `notice`: a recheck cannot bind a path or pattern that fell inside a redacted span.');
  });
});

describe('IT-M4: an explicit global commit while project memory is off carries the notice (R11)', () => {
  const GLOBAL_NOTICE = "written to global memory, which every project sees, while this session's project memory is off";
  const explicitGlobal = (s: MemoryStore, content = 'a fact for every project'): Record<string, unknown> =>
    committed(text(handleCommit(s, { content, source: 'user', scope: 'global' })));

  it('the notice is the ruled constant', () => {
    expect(GLOBAL_WHILE_PROJECT_OFF_NOTICE).toBe(GLOBAL_NOTICE);
  });

  it("R11: 'unadopted-present' (a cwd project whose foreign memory file is not adopted) gets the notice", () => {
    const root = tmp('helix-disc-proj-');
    foreignLedger(root);
    const { store: s, home } = store({ root });
    expect(projectDispositionOf({ root, ledger: projectLedgerPath(root), home, origin: 'cwd' })).toBe('unadopted-present');
    const before = readFileSync(projectLedgerPath(root), 'utf8');
    const out = explicitGlobal(s);
    expect(out.scope).toBe('global');
    expect(out.notice).toBe(GLOBAL_NOTICE);
    expect(readFileSync(projectLedgerPath(root), 'utf8')).toBe(before);           // the foreign file is untouched
  });

  it('R11: with a redaction too, both notices are joined in order, the redaction one first', () => {
    const root = tmp('helix-disc-proj-');
    foreignLedger(root);
    const { store: s } = store({ root });
    const out = explicitGlobal(s, `the staging database config lives at ${UUID_PATH}`);
    expect(out.notice).toBe(`${REDACTION_NOTICE}; ${GLOBAL_NOTICE}`);
  });

  it("'ancestor-unadopted' and 'aliased' keep the notice", () => {
    const parent = tmp('helix-disc-proj-');
    mkdirSync(join(parent, '.helix'));
    expect(explicitGlobal(store({ root: parent, origin: 'ancestor' }).store).notice).toBe(GLOBAL_NOTICE);

    const a = tmp('helix-disc-proj-');
    const { store: s, home } = store({ root: a });
    const b = tmp('helix-disc-proj-');
    stampOwnership(b, home, {});
    stampOwnership(a, home, {});
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));                     // A's memory file is B's
    expect(projectDispositionOf({ root: a, ledger: projectLedgerPath(a), home })).toBe('aliased');
    expect(explicitGlobal(s).notice).toBe(GLOBAL_NOTICE);
  });

  it('commitScoped reports WHICH disposition the global commit bypassed', () => {
    const globalCommit = (s: MemoryStore) => s.commitScoped({ content: 'a fact for every project', source: 'user', scope: 'global' });

    const present = tmp('helix-disc-proj-');
    foreignLedger(present);
    expect(globalCommit(store({ root: present }).store).bypassedProject).toBe('unadopted-present');

    const parent = tmp('helix-disc-proj-');
    mkdirSync(join(parent, '.helix'));
    expect(globalCommit(store({ root: parent, origin: 'ancestor' }).store).bypassedProject).toBe('ancestor-unadopted');

    const a = tmp('helix-disc-proj-');
    const { store: s, home } = store({ root: a });
    const b = tmp('helix-disc-proj-');
    stampOwnership(b, home, {});
    stampOwnership(a, home, {});
    symlinkSync(projectLedgerPath(b), projectLedgerPath(a));                     // A's memory file is B's
    expect(globalCommit(s).bypassedProject).toBe('aliased');

    expect(globalCommit(store().store)).not.toHaveProperty('bypassedProject');
  });

  // A cwd project nobody adopted whose memory file the pre-adopt check refuses reads 'inactive' (its
  // link leads to no file), yet every project write there gets the alias refusal, which calls the
  // layer disabled and offers global memory. The global commit that follows says so too.
  const refusedLinks: Array<[string, (u: string, home: string) => void]> = [
    ["a dangling link to another adopted project's ledger", (u, home) => {
      const b = tmp('helix-disc-proj-');
      stampOwnership(b, home, {});
      symlinkSync(projectLedgerPath(b), projectLedgerPath(u));
    }],
    ['a link body that is not valid UTF-8', (u) => symlinkSync(Buffer.from([0xff]), projectLedgerPath(u))],
    ['a link that leads back to itself', (u) => symlinkSync('memory.jsonl', projectLedgerPath(u))],
  ];
  it.each(refusedLinks)('not adopted, and the pre-adopt check refuses its memory file (%s): the notice, and aliased', (_label, plant) => {
    const u = tmp('helix-disc-proj-');
    mkdirSync(join(u, '.helix'));
    const { store: s, home } = store({ root: u });
    plant(u, home);
    expect(projectDispositionOf({ root: u, ledger: projectLedgerPath(u), home, origin: 'cwd' })).toBe('inactive');
    expect(() => handleCommit(s, { content: 'a project fact', source: 'user' })).toThrow(/the project layer is disabled here/);
    expect(explicitGlobal(s).notice).toBe(GLOBAL_NOTICE);
    expect(s.commitScoped({ content: 'another fact for every project', source: 'user', scope: 'global' }).bypassedProject).toBe('aliased');
  });

  // The adopted side has no rule against the global ledger yet (such a project reads 'owned' and
  // writes through the link until the next server start), so the notice is not claimed for it.
  it('an adopted project whose memory file leads to the global ledger reads owned: no notice', () => {
    const a = tmp('helix-disc-proj-');
    const { store: s, home } = store({ root: a });
    stampOwnership(a, home, {});
    writeFileSync(join(home, 'memory.jsonl'), '');
    symlinkSync(join(home, 'memory.jsonl'), projectLedgerPath(a));
    expect(projectDispositionOf({ root: a, ledger: projectLedgerPath(a), home })).toBe('owned');
    expect(explicitGlobal(s)).not.toHaveProperty('notice');
  });

  it("no notice when project memory is on ('owned'), when nothing is there ('inactive'), or with no project layer", () => {
    const owned = tmp('helix-disc-proj-');
    const o = store({ root: owned });
    o.store.commit({ content: 'the first project fact adopts it', source: 'user' });   // auto-adopt
    expect(explicitGlobal(o.store)).not.toHaveProperty('notice');

    const inactive = tmp('helix-disc-proj-');
    mkdirSync(join(inactive, '.helix'));
    expect(explicitGlobal(store({ root: inactive }).store)).not.toHaveProperty('notice');

    expect(explicitGlobal(store().store)).not.toHaveProperty('notice');
  });

  it("an omitted scope in an 'unadopted-present' project is still refused (R11 changes the explicit-global result only)", () => {
    const root = tmp('helix-disc-proj-');
    foreignLedger(root);
    const { store: s } = store({ root });
    expect(() => handleCommit(s, { content: 'a project fact', source: 'user' })).toThrow(/a project memory file exists here that Helix did not create/);
  });
});

// Ruling R12 (second fix batch §4.7 item 2): the `scope` description also covers a choice of global
// memory made BEFORE any refusal (host measurement, spec §11: in 5 of 10 prototype runs the model chose
// global before any refusal), which no refusal text can reach.
describe('the scope description leaves global memory to the user (IT-M4, R12)', () => {
  it('asks the user before passing global, whether or not a project write was refused first', async () => {
    const tools = await fromSource();
    const commit = tools.find((t) => t.name === 'helix_memory_commit');
    const scope = (commit?.inputSchema as { properties?: Record<string, { description?: string }> }).properties?.scope?.description ?? '';
    expect(scope).toContain("Below a project whose memory is off here (not adopted, or its memory file excluded), storing a fact in global memory is the user's decision: ask the user before passing global, whether or not a project write was refused first.");
  });
});
