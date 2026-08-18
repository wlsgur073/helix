// D3.e — `helix_memory_adopt` has no approval gate, no TTY check, and no user-presence signal: an
// agent can call it unprompted exactly like `helix_memory_recall`. That is the finding, and it is
// not going to be fixed by adding a gate, because MCP carries no presence signal a server can
// enforce. The project's answer was a THREE-PART substitute for one, and when this file was written
// only the third part was measured anywhere:
//
//   1. `adopt` REFUSES a root that is not the active scope — and refuses it in the STORE, not the
//      handler, so a caller that reaches past the handler clears the same check. Unpinned: grep over
//      test/ for either of the two throw strings returned nothing.
//   2. A refusal writes NO audit row. No trust moved, so there is no event to record — unlike
//      confirm, whose 'rejected' row marks an attempt against a real target id. Unpinned.
//   3. The registered tool description states the user is the authority and the tool must not be
//      allow-listed. Pinned twice already (test/server/e2e.test.ts, test/docs/shipped-claims.doc.test.ts).
//
// What makes parts 1 and 2 worth their own file: the substitute is what the prompt SHOWS the user.
// A zero-argument adopt would give the client's approval prompt nothing to render, so a user could
// only ever approve the act and never the target. Requiring the root is therefore not an argument
// convenience — it is the reviewability the missing gate would otherwise have provided.
//
// Every case asserts the SIDE EFFECT, not just the throw. A refusal that threw *after* stamping
// ownership would satisfy `toThrow()` and still hand over the trust boundary, which is the entire
// failure this substitute exists to prevent.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleAdopt } from '../../src/server/handlers.js';
import { isOwned, canonicalRoot } from '../../src/memory/ownership.js';
import { PROJECT_ROOT_SCHEMA } from '../../src/server/helix-server.js';

/** A store with a project layer active but NOT yet adopted — the state a real adopt call starts from. */
function unadoptedProjectStore() {
  const home = mkdtempSync(join(tmpdir(), 'helix-d3e-home-'));
  const root = mkdtempSync(join(tmpdir(), 'helix-d3e-proj-'));
  const store = new MemoryStore(join(home, 'memory.jsonl'), {
    home, sessionId: 's1', project: { ledger: join(root, '.helix', 'memory.jsonl'), root },
  });
  return { store, home, root };
}

describe('adopt names the ledger it moves, and refuses anything else (D3.e)', () => {
  it('a root that is not the active scope is refused, and the active scope stays unowned', () => {
    const { store, home, root } = unadoptedProjectStore();
    const other = mkdtempSync(join(tmpdir(), 'helix-d3e-other-'));

    expect(() => store.adopt(other)).toThrow(/not the active project scope/);

    // The throw is the cheap half. This is the half that matters: an agent that guessed the wrong
    // root must adopt NOTHING — not the root it named, and not the one that happened to be active.
    expect(isOwned(root, home), 'the active project was adopted by a call that named a different root').toBe(false);
    expect(isOwned(other, home), 'the named foreign root was adopted').toBe(false);
  });

  it('with no project layer active there is nothing to adopt, and the named root is not adopted instead', () => {
    const home = mkdtempSync(join(tmpdir(), 'helix-d3e-home-'));
    const lone = mkdtempSync(join(tmpdir(), 'helix-d3e-lone-'));
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' });

    expect(() => store.adopt(lone)).toThrow(/no project scope is active/);

    // An implementation that treated the missing layer as "then adopt whatever you were handed"
    // would pass the throw-free reading of this API and silently trust an arbitrary directory.
    expect(isOwned(lone, home)).toBe(false);
  });

  it('the check lives in the store, so a caller that bypasses the handler clears the same gate', () => {
    // handleAdopt does no validation of its own — it calls store.adopt and audits the result. This
    // case exists to fail if that check is ever relocated INTO the handler as a "cleaner" refactor:
    // the two above already call the store directly, and this one states why that is deliberate by
    // showing the handler's whole contribution is the audit row, not the decision.
    const { store, root } = unadoptedProjectStore();
    const auditPath = join(mkdtempSync(join(tmpdir(), 'helix-d3e-audit-')), 'audit.jsonl');
    const other = mkdtempSync(join(tmpdir(), 'helix-d3e-other-'));

    expect(() => handleAdopt(store, { projectRoot: other }, { auditPath })).toThrow(/not the active project scope/);

    // A refusal writes nothing at all: no trust moved, so there is no event. The audit file must not
    // even exist yet — an 'adopt' row for a call that adopted nothing would misread as an adoption
    // forever after, and the audit trail is what a user reviews when asking what was trusted and when.
    expect(existsSync(auditPath), 'a refused adopt wrote an audit row').toBe(false);

    handleAdopt(store, { projectRoot: root }, { auditPath, now: () => '2026-06-09T00:00:00.000Z' });

    const rows = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; scope: string });
    expect(rows).toHaveLength(1);                       // exactly one — the refusal above added none
    expect(rows[0]!.kind).toBe('adopt');
    expect(rows[0]!.scope).toBe(canonicalRoot(root));   // the canonical scope, recovered from the code
  });
});

// The gap the three cases above left open. Each of them names a root that is REAL and WRONG, and the
// equality check catches it. None of them names a root that resolves to the RIGHT place while naming
// nothing — and that is the reachable one, because the server's cwd IS the active project root (the
// project layer activates on <cwd>/.helix existing). Measured live 2026-08-18 against the shipped
// bundle: `helix_memory_adopt({projectRoot: ""})` was ACCEPTED, wrote .owner, wrote the registry
// entry, wrote the audit row, and a following recall served the project ledger's contents — the same
// outcome as passing the correct absolute path. The prompt the user approves renders `projectRoot: ""`.
//
// Note what a unit store CANNOT show: here cwd is the repo, so canonicalRoot('') resolves to the repo
// and the equality check refuses it for an unrelated reason. That is why the reachability case lives
// in test/acceptance/project-ledger.e2e.test.ts, where the server really does run inside the project.
// These cases pin the RULE cwd-independently: the refusal must be about the argument's shape.
describe('adopt refuses a root that names nothing, at both enforcement layers', () => {
  const NAMES_NOTHING = ['', '.', './', './.', '..', '../sibling', 'proj', ' '];

  it('the store refuses every non-absolute spelling, and says why', () => {
    const { store, home, root } = unadoptedProjectStore();

    for (const spelling of NAMES_NOTHING) {
      // The message, not just the throw: before this rule these refused (in this cwd) as "not the
      // active project scope", which is the incidental answer that disappears the moment the server
      // runs where it really runs. Asserting the reason is what distinguishes the fix from the
      // accident.
      expect(() => store.adopt(spelling), JSON.stringify(spelling)).toThrow(/must be an absolute path/);
    }

    expect(isOwned(root, home), 'a root that named nothing still adopted the active scope').toBe(false);
  });

  it('an absolute root still reaches the scope check, so the rule adds a gate and removes none', () => {
    const { store, home, root } = unadoptedProjectStore();
    const other = mkdtempSync(join(tmpdir(), 'helix-d3e-other-'));

    // Absolute-but-wrong must still fail on scope, not on shape — otherwise the new check would be
    // masking the original guarantee rather than adding to it.
    expect(() => store.adopt(other)).toThrow(/not the active project scope/);

    store.adopt(root);
    expect(isOwned(root, home), 'the absolute, correct root was refused').toBe(true);
  });

  it('PROJECT_ROOT_SCHEMA rejects the same spellings at the MCP boundary, before the handler runs', () => {
    // Same split as ID_SCHEMA/isValidId: the schema gives every MCP caller a clean, client-facing
    // rejection before the handler (and its audit call) runs at all, while the store check above
    // protects any caller that reaches past it. ONE predicate, so the two cannot drift.
    for (const spelling of NAMES_NOTHING) {
      expect(PROJECT_ROOT_SCHEMA.safeParse(spelling).success, JSON.stringify(spelling)).toBe(false);
    }
    expect(PROJECT_ROOT_SCHEMA.safeParse('/tmp/some-project').success).toBe(true);
  });
});
