// aliasedLedgerRefusal is the advisory pre-check a caller consults BEFORE publishing durable
// intent (the re-baseline ceremony's write-ahead witness journal). Two properties are under test:
// it answers ONLY the aliased-ledger question, and it is TOTAL — it returns, promptly, for any
// path a caller can name. Non-regular files are where both go wrong for an open()-based check:
// open('r') on a directory SUCCEEDS and every directory has nlink >= 2, so a misconfigured path
// reads as "N hard links"; open('r') on a FIFO blocks until a writer appears, and blocking is not
// an exception — no catch can make it total.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasedLedgerRefusal } from '../src/memory/ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'helix-alias-precheck-')); dirs.push(d); return d; };

describe('aliasedLedgerRefusal — the aliased question, and nothing else', () => {
  it('reports a hard-linked regular file, in the append layer\'s own wording', () => {
    const d = scratch();
    const ledger = join(d, 'memory.jsonl');
    writeFileSync(ledger, '{"x":1}\n');
    linkSync(ledger, join(d, 'alias.jsonl'));
    expect(aliasedLedgerRefusal(ledger)).toContain('2 hard links');
  });

  it('returns null for an absent path — the append speaks for itself there', () => {
    expect(aliasedLedgerRefusal(join(scratch(), 'never-written.jsonl'))).toBeNull();
  });

  it('returns null for a directory at the ledger path', () => {
    // A directory is not an aliased LEDGER, whatever its link count says. Reporting one as
    // "N hard links -- see SECURITY.md" sends the operator to the wrong remedy; the accurate
    // error (EISDIR) belongs to whichever downstream read or append actually touches the path.
    const d = scratch();
    const dirAtLedgerPath = join(d, 'memory.jsonl');
    mkdirSync(dirAtLedgerPath);
    expect(aliasedLedgerRefusal(dirAtLedgerPath)).toBeNull();
  });

  it('returns null for a FIFO, promptly — the check must never open what it inspects', () => {
    // open('r') on a FIFO blocks until a writer opens the other end. A pre-check that can hang
    // holds the ceremony hostage before its first line of output, on a path an adversary with
    // repository write access gets to choose. stat answers from the inode without opening.
    const d = scratch();
    const fifo = join(d, 'memory.jsonl');
    const mk = spawnSync('mkfifo', [fifo]);
    expect(mk.status).toBe(0);
    expect(aliasedLedgerRefusal(fifo)).toBeNull();
  });
});
