// Third fix batch B1, task A3 (design 4.1 item 2, the seven-row table, M67): the lock, the append, the rewrite and
// the witness store read the ONE resolver; `canonical` is gone.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lockModule from '../../src/memory/lock.js';
import { withFileLock, lockPathOf } from '../../src/memory/lock.js';
import { appendRecord, parseLedger } from '../../src/memory/ledger.js';
import { readScopeWitness, WITNESS_READ_AS_GIVEN } from '../../src/memory/witness-store.js';
import { isUnresolvablePathError } from '../../src/memory/path-identity.js';
import { MemoryStore } from '../../src/memory/store.js';
import { WITNESS_INIT_NOTE, WITNESS_PATH_UNRESOLVABLE_NOTE, GLOBAL_LEDGER_READ_ONLY_NOTE } from '../../src/memory/content-frame.js';
import type { MemoryRecord } from '../../src/types.js';

const d = realpathSync(mkdtempSync(join(tmpdir(), 'helix-callers-')));
afterAll(() => { try { execFileSync('rm', ['-rf', '--', d]); } catch { /* best effort */ } });
let n = 0;
function fresh(): { sd: string; real: string } { const sd = join(d, `s${++n}`); mkdirSync(join(sd, 'real'), { recursive: true }); return { sd, real: join(sd, 'real') }; }
const FF = Buffer.from([0xff]);
const B = (...parts: Array<string | Buffer>): Buffer => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const thrownBy = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };
const codeOf = (f: () => unknown): string | undefined => (thrownBy(f) as NodeJS.ErrnoException | undefined)?.code;
const rec = (id: string): MemoryRecord => ({
  id, tx: '2026-10-01T00:00:00.000Z', validFrom: '2026-10-01T00:00:00.000Z', validTo: null, type: 'assert', state: 'Fresh',
  content: `fact ${id}`, provenance: { source: 'user', sessionId: 's' }, supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
});

describe('the lock path is the resolver\'s answer plus ".lock" (design 4.1 item 2)', () => {
  it('lock.ts no longer exports canonical', () => {
    expect('canonical' in lockModule).toBe(false);
  });

  it('a plain file and a link to it share ONE lock path, beside the file the kernel reaches', () => {
    const { sd, real } = fresh();
    mkdirSync(join(sd, 'tgt')); writeFileSync(join(sd, 'tgt', 'real.jsonl'), '');
    symlinkSync(join(sd, 'tgt', 'real.jsonl'), join(real, 'l.jsonl'));
    expect(lockPathOf(join(real, 'l.jsonl'))).toBe(`${join(sd, 'tgt', 'real.jsonl')}.lock`);
    expect(lockPathOf(join(sd, 'tgt', 'real.jsonl'))).toBe(lockPathOf(join(real, 'l.jsonl')));
  });

  it('M67: a dangling link locks beside its TARGET, never beside the link, and nothing is left behind', () => {
    const { real } = fresh();
    const link = join(real, 'l.jsonl'); const target = join(real, 'absent.jsonl');
    symlinkSync('absent.jsonl', link);
    expect(lockPathOf(link)).toBe(`${target}.lock`);
    withFileLock(link, () => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(existsSync(`${link}.lock`)).toBe(false);
    });
    expect(readdirSync(real)).toEqual(['l.jsonl']);
  });

  it('a link into a missing folder: ENOENT from the resolver, nothing published', () => {
    const { sd, real } = fresh();
    symlinkSync(join(sd, 'nodir', 'absent.jsonl'), join(real, 'l.jsonl'));
    expect(codeOf(() => withFileLock(join(real, 'l.jsonl'), () => undefined))).toBe('ENOENT');
    expect(readdirSync(real)).toEqual(['l.jsonl']);
    expect(existsSync(join(sd, 'nodir'))).toBe(false);
  });

  it('a link body that is not valid UTF-8: UnresolvablePathError, and no lock file appears anywhere', () => {
    const { sd, real } = fresh();
    mkdirSync(join(sd, 't')); const t = B(sd, '/t/re', FF, 'l.jsonl'); writeFileSync(t, '');
    symlinkSync(t, join(real, 'l.jsonl'));
    expect(isUnresolvablePathError(thrownBy(() => lockPathOf(join(real, 'l.jsonl'))))).toBe(true);
    expect(isUnresolvablePathError(thrownBy(() => withFileLock(join(real, 'l.jsonl'), () => undefined)))).toBe(true);
    expect(readdirSync(real)).toEqual(['l.jsonl']);
    expect(readdirSync(join(sd, 't'), { encoding: 'buffer' }).map((b) => b.toString('latin1'))).toEqual([t.subarray(t.lastIndexOf('/') + 1).toString('latin1')]);
  });

  it('a body that ends in a slash: the kernel\'s ENOTDIR from the resolver (the old hand walk dropped the slash and locked the file)', () => {
    const { real } = fresh();
    writeFileSync(join(real, 'real.jsonl'), '');
    symlinkSync('real.jsonl/', join(real, 'l.jsonl'));
    expect(codeOf(() => lockPathOf(join(real, 'l.jsonl')))).toBe('ENOTDIR');
    expect(readdirSync(real).sort()).toEqual(['l.jsonl', 'real.jsonl']);
  });

  it('R-1: a trailing slash on a missing final name is ENOENT, not a lock beside the unslashed name', () => {
    const { real } = fresh();
    expect(codeOf(() => lockPathOf(`${join(real, 'absent.jsonl')}/`))).toBe('ENOENT');
  });
});

describe('append and rewrite resolve once, through the resolver', () => {
  it('an append through a dangling link creates the TARGET and stores the row; the link stays a link', () => {
    const { real } = fresh();
    const link = join(real, 'l.jsonl'); const target = join(real, 'absent.jsonl');
    symlinkSync('absent.jsonl', link);
    appendRecord(link, rec('m_1'));
    expect(parseLedger(target).map((r) => r.id)).toEqual(['m_1']);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(real).sort()).toEqual(['absent.jsonl', 'l.jsonl']);   // no lock file left, no second ledger
  });

  it('an append through an unresolvable link is refused with UnresolvablePathError; the planted file stays empty', () => {
    const { sd, real } = fresh();
    mkdirSync(join(sd, 't')); const t = B(sd, '/t/re', FF, 'l.jsonl'); writeFileSync(t, '');
    symlinkSync(t, join(real, 'l.jsonl'));
    expect(isUnresolvablePathError(thrownBy(() => appendRecord(join(real, 'l.jsonl'), rec('m_1'))))).toBe(true);
    expect(readFileSync(t, 'utf8')).toBe('');
  });
});

describe('witness-store reads its path through the resolver', () => {
  it('a virgin home (its folder does not exist yet) has no witness state (IT-H1 stays)', () => {
    const { sd } = fresh();
    expect(readScopeWitness(join(sd, 'nohome'), '@global')).toEqual({ entry: null, journal: null, macInvalid: false });
  });

  it('a home whose physical folder name is not valid UTF-8: the default read refuses with the witness refusal (reason unresolvable); the read option opens the file as written', () => {
    const { sd } = fresh();
    const ffHome = B(sd, '/', FF, 'home'); mkdirSync(ffHome);
    symlinkSync(ffHome, join(sd, 'hl'));
    const e = thrownBy(() => readScopeWitness(join(sd, 'hl'), '@global')) as { witnessUnusable?: boolean; reason?: string };
    expect(e.witnessUnusable).toBe(true); expect(e.reason).toBe('unresolvable');
    expect(readScopeWitness(join(sd, 'hl'), '@global', WITNESS_READ_AS_GIVEN)).toEqual({ entry: null, journal: null, macInvalid: false, file: 'as-given' });   // no file there yet: an empty store, but read through the path as written, and the mark says so (W-R1)
  });

  it('records under such a home with no witness file: every live read holds the path note and not the first-contact note, whose next write is refused; the as-of view holds neither', () => {
    const { sd } = fresh();
    const ffHome = B(sd, '/', FF, 'home'); mkdirSync(ffHome);
    const row = JSON.stringify({
      id: 'm_1', tx: '2026-07-05T00:00:00.000Z', validFrom: '2026-07-05T00:00:00.000Z', validTo: null,
      type: 'assert', state: 'Fresh', content: 'alpha fixture fact', provenance: { source: 'user', sessionId: 's' },
      supersedes: null, blastRadius: null, reverifyTrigger: null, classification: 'normal',
    });
    writeFileSync(B(ffHome, '/memory.jsonl'), `${row}\n`);
    symlinkSync(ffHome, join(sd, 'hl'));
    const home = join(sd, 'hl');
    const store = new MemoryStore(join(home, 'memory.jsonl'), { home, sessionId: 't', now: () => '2026-10-01T00:00:00.000Z' });
    const recall = store.recall('alpha');
    expect(recall.items.length).toBe(1);
    for (const notes of [recall.witnessNotes, store.currentView().witnessNotes, store.historyView().witnessNotes]) {
      expect(notes).toContain(WITNESS_PATH_UNRESOLVABLE_NOTE);
      expect(notes).not.toContain(WITNESS_INIT_NOTE);
    }
    // B6 (design 4.7): the global ledger below such a home cannot be resolved either, so every view, the as-of view
    // included, carries the read-only note; neither witness note is in the as-of view.
    expect(store.asOfView('2026-10-01T00:00:00.000Z').witnessNotes).toEqual([GLOBAL_LEDGER_READ_ONLY_NOTE]);
  });
});

describe('no code under src/memory resolves a path by `canonical` any more', () => {
  it('no call to canonical( and no import of it from ./lock.js', () => {
    const dir = fileURLToPath(new URL('../../src/memory/', import.meta.url));
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      // No `\s*` before the parenthesis: asof.ts:9 and store.ts:1095 say "assumed canonical (…)" about a timestamp.
      if (/\bcanonical\(/.test(text)) offenders.push(`${f}: canonical(`);
      if (/import\s*\{[^}]*\bcanonical\b[^}]*\}\s*from\s*'\.\/lock\.js'/.test(text)) offenders.push(`${f}: import of canonical`);
    }
    expect(offenders).toEqual([]);
  });
});
