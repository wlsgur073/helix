// IT-M3 (second fix batch §4.6) with ruling R10, through the real handlers: a commit whose secret scan
// replaced a span reports `redactions` and a `notice`; a recheck that cannot bind on such a record says
// the content was redacted. R10: that sentence follows the record's classification, not the text
// `[redacted:` a user may type into an unredacted fact. Success stays ONE JSON object after the verb
// (`<verb> {json}`, decision E1).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleCommit, handleRecheck, REDACTION_NOTICE, type ToolResult } from '../../src/server/handlers.js';
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

function store(): { store: MemoryStore; home: string } {
  const home = tmp('helix-disc-home-');
  return { store: new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 's1' }), home };
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
