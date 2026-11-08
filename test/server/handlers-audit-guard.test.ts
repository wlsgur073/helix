// Third fix batch B2a, task B4 (ruling J4; design 4.6; plan decision P5). Four things, none of which touches the bundle:
// (1) the audit row a handler writes in its catch can fail without replacing the error the caller is about to see (the store's
//     refusal, or the fixed stored-then-failed answer); WBR-global F1 and B1-BATCH-TEXTS;
// (2) a HomeRefusalError the store raises before it writes is audited `rejected`, one carrying the stored mark `indeterminate`;
// (3) an unwritable home or audit file is refused BEFORE the ledger row, for confirm, erase, recheck and adopt;
// (4) P5: the audit row after a success that stored a row can fail, and the answer is then the fixed stored-then-failed text.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import { handleErase, handleConfirm, handleRecheck, handleAdopt, STORED_THEN_FAILED_RESPONSE } from '../../src/server/handlers.js';
import * as auditMod from '../../src/audit.js';
import * as witnessStoreMod from '../../src/memory/witness-store.js';
import { HomeRefusalError, isHomeRefusalError } from '../../src/memory/home-env.js';
import type { EraseAudit } from '../../src/audit.js';
import { fixture, cleanupFixtures, keepWritable, registryKeys } from '../helpers/first-write-fixture.js';

const AS_ROOT = process.getuid?.() === 0;
const POSIX = process.platform !== 'win32';
const AUDIT_BOOM = 'AUDIT-APPEND-FAILED-FIXTURE';
const HOME_TEXT = 'the Helix home directory cannot be written, so the operation was refused before anything was changed';
const AUDIT_TEXT = 'the Helix audit file cannot be written, so the operation was refused before anything was changed';

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); cleanupFixtures();
  for (const d of made.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); }
});

/** A global-scope store in a short-named home; the audit file lives beside the ledger, as in production. */
function gfx() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ag-'))); made.push(dir); let n = 0;
  const s = new MemoryStore(join(dir, 'm.jsonl'), { home: dir, sessionId: 's', now: () => '2026-11-08T00:00:00.000Z', genId: () => `m_${++n}` });
  return { dir, s, ledger: join(dir, 'm.jsonl'), auditPath: join(dir, 'audit.jsonl') };
}
const lines = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0);
const lastAudit = <T>(p: string): T => { const l = readFileSync(p, 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]!) as T; };
const thrown = (f: () => unknown): Error => { try { f(); } catch (e) { return e as Error; } throw new Error('expected a throw'); };
/** A recheck binds its relative path against the cwd; the directory name is short on purpose (a long path inside committed content is redacted). */
function inDir<T>(dir: string, f: () => T): T { const cwd = process.cwd(); process.chdir(dir); try { return f(); } finally { process.chdir(cwd); } }

type Op = 'erase' | 'confirm' | 'recheck';
const OPS: Op[] = ['erase', 'confirm', 'recheck'];
const CHECK = { kind: 'file-contains', path: 'app.json', pattern: '/v2/users' } as const;
const FACT = 'api base /v2/users in app.json';
const sourceFor = (op: Op): 'user' | 'user-relayed' => (op === 'recheck' ? 'user-relayed' : 'user');
function call(op: Op, s: MemoryStore, id: string, auditPath: string): unknown {
  if (op === 'erase') return handleErase(s, { id }, { auditPath });
  if (op === 'confirm') return handleConfirm(s, { id }, { auditPath });
  return handleRecheck(s, { id, check: CHECK }, { auditPath });
}

describe('the audit row of a failed call: its own failure never replaces the error the caller sees (F1)', () => {
  it.each(OPS)('%s: the store\'s refusal reaches the caller although the audit append throws', (op) => {
    const { s, auditPath } = gfx();
    const control = thrown(() => call(op, s, 'm_none', auditPath)).message;     // the real append works here, and writes the rejected row
    expect(control.length).toBeGreaterThan(0);
    const audit = vi.spyOn(auditMod, 'appendAudit').mockImplementation(() => { throw new Error(AUDIT_BOOM); });
    const e = thrown(() => call(op, s, 'm_none', auditPath));
    expect(audit).toHaveBeenCalledTimes(1);                                       // the catch reached the append
    expect(e.message).toBe(control);
    expect(e.message).not.toContain(AUDIT_BOOM);
  });

  it.each(OPS)('%s: after the row is stored the fixed stored-then-failed answer survives a failing audit append', (op) => {
    const { dir, s, ledger, auditPath } = gfx();
    writeFileSync(join(dir, 'app.json'), 'base /v2/users');
    const id = s.commit({ content: FACT, source: sourceFor(op), scope: 'global' }).id;
    const before = lines(ledger);
    const advance = vi.spyOn(witnessStoreMod, 'advanceWitness').mockImplementationOnce(() => { throw Object.assign(new Error('EIO: fixture'), { code: 'EIO' }); });
    const audit = vi.spyOn(auditMod, 'appendAudit').mockImplementation(() => { throw new Error(AUDIT_BOOM); });
    try {
      const e = inDir(dir, () => thrown(() => call(op, s, id, auditPath)));
      expect(e.message).toBe(STORED_THEN_FAILED_RESPONSE[op]);
      expect(audit).toHaveBeenCalledTimes(1);
    } finally { advance.mockRestore(); audit.mockRestore(); }
    expect(lines(ledger)).toBe(before + 1);
  });
});

describe('erase audits a typed home refusal by what it means (design 4.6)', () => {
  const refusal = (): Error => new HomeRefusalError('foreign-owner', 'fixture refusal');
  it('a HomeRefusalError the store raises before it writes is audited rejected', () => {
    const { s, auditPath } = gfx();
    vi.spyOn(s, 'erase').mockImplementation(() => { throw refusal(); });   // the wiring from ensureHelixDir to the typed error is task A6's test
    const e = thrown(() => handleErase(s, { id: 'm_1' }, { auditPath }));
    expect(isHomeRefusalError(e)).toBe(true);
    expect(lastAudit<EraseAudit>(auditPath)).toMatchObject({ kind: 'erase', soft: true, outcome: 'rejected' });
  });
  it('the same refusal carrying the stored mark keeps indeterminate and the fixed stored-then-failed answer', () => {
    const { s, auditPath } = gfx();
    vi.spyOn(s, 'erase').mockImplementation(() => { throw witnessStoreMod.markRecordStored(refusal(), 'Fresh'); });
    const e = thrown(() => handleErase(s, { id: 'm_1' }, { auditPath }));
    expect(e.message).toBe(STORED_THEN_FAILED_RESPONSE.erase);
    expect(lastAudit<EraseAudit>(auditPath)).toMatchObject({ kind: 'erase', soft: true, outcome: 'indeterminate' });
  });
});

describe('an audit file that cannot be appended is refused before the row (N7: the confirm used to take effect with no audit row)', () => {
  it.each(OPS)('%s: an audit.jsonl that is a directory gives audit-unwritable and leaves the ledger as it was', (op) => {
    const { dir, s, ledger, auditPath } = gfx();
    writeFileSync(join(dir, 'app.json'), 'base /v2/users');
    const id = s.commit({ content: FACT, source: sourceFor(op), scope: 'global' }).id;
    mkdirSync(auditPath);
    expect(lstatSync(auditPath).isDirectory(), 'fixture: audit.jsonl is a directory').toBe(true);
    const before = readFileSync(ledger);
    const e = inDir(dir, () => thrown(() => call(op, s, id, auditPath)));
    expect(isHomeRefusalError(e)).toBe(true);
    expect((e as HomeRefusalError).homeRefusalCause).toBe('audit-unwritable');
    expect(e.message).toBe(AUDIT_TEXT);
    expect(readFileSync(ledger).equals(before)).toBe(true);
  });

  it('adopt: the same refusal, and the project is not adopted', () => {
    const fx = fixture();
    const auditPath = join(fx.home, 'audit.jsonl');
    mkdirSync(auditPath);
    const e = thrown(() => handleAdopt(fx.store('b'), { projectRoot: fx.root }, { auditPath }));
    expect(isHomeRefusalError(e)).toBe(true);
    expect((e as HomeRefusalError).homeRefusalCause).toBe('audit-unwritable');
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
  });
});

describe('the audit row after a success: its failure answers the fixed stored-then-failed text (plan decision P5)', () => {
  it.each(OPS)('%s: the row is stored, the audit append after it throws, and the answer is the fixed stored-then-failed text', (op) => {
    const { dir, s, ledger, auditPath } = gfx();
    writeFileSync(join(dir, 'app.json'), 'base /v2/users');
    const id = s.commit({ content: FACT, source: sourceFor(op), scope: 'global' }).id;
    const before = lines(ledger);
    const audit = vi.spyOn(auditMod, 'appendAudit').mockImplementation(() => { throw new Error(AUDIT_BOOM); });
    const e = inDir(dir, () => thrown(() => call(op, s, id, auditPath)));
    expect(e.message).toBe(STORED_THEN_FAILED_RESPONSE[op]);
    expect(witnessStoreMod.isRecordStoredError(e)).toBe(true);
    expect((e.cause as Error).message).toBe(AUDIT_BOOM);
    expect(audit).toHaveBeenCalledTimes(1);                                       // the success append only: no catch row after it
    expect(lines(ledger)).toBe(before + 1);                                       // the row landed: a retry would store a second one
  });

  it('adopt: the project is adopted, the audit append after it throws, and the answer is the adopt text', () => {
    const fx = fixture();
    const auditPath = join(fx.home, 'audit.jsonl');
    const audit = vi.spyOn(auditMod, 'appendAudit').mockImplementation(() => { throw new Error(AUDIT_BOOM); });
    const e = thrown(() => handleAdopt(fx.store('b'), { projectRoot: fx.root }, { auditPath }));
    expect(e.message).toBe(STORED_THEN_FAILED_RESPONSE.adopt);
    expect(witnessStoreMod.isRecordStoredError(e)).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(true);
    expect(registryKeys(fx.home)).toHaveLength(1);
  });

  it('control: an erase answered unchanged stored nothing, so the append\'s own error reaches the caller, never the stored text', () => {
    const { s, ledger, auditPath } = gfx();
    const id = s.commit({ content: FACT, source: 'user', scope: 'global' }).id;
    handleErase(s, { id }, { auditPath });                                        // the tombstone, with its real audit row
    const before = readFileSync(ledger);
    vi.spyOn(auditMod, 'appendAudit').mockImplementation(() => { throw new Error(AUDIT_BOOM); });
    const e = thrown(() => handleErase(s, { id }, { auditPath }));                // 'not-live': nothing is written
    expect(e.message).toBe(AUDIT_BOOM);
    expect(witnessStoreMod.isRecordStoredError(e)).toBe(false);
    expect(readFileSync(ledger).equals(before)).toBe(true);
  });
});

describe.skipIf(AS_ROOT || !POSIX)('a home that became read-only after start is refused before the row (ledger length unchanged)', () => {
  it.each(OPS)('%s: a project row is not stored, the answer is the home-unwritable refusal, and no audit file appears', (op) => {
    const fx = fixture();
    writeFileSync(join(fx.root, 'app.json'), 'base /v2/users');
    const id = fx.store('seed').commit({ content: FACT, source: sourceFor(op) }).id;       // the project becomes owned, the key and the witness exist
    const auditPath = join(fx.home, 'audit.jsonl');
    const before = readFileSync(fx.ledger);
    keepWritable(fx.home); chmodSync(fx.home, 0o500);
    const e = inDir(fx.root, () => thrown(() => call(op, fx.store('b'), id, auditPath)));
    chmodSync(fx.home, 0o700);
    expect(isHomeRefusalError(e), e.message).toBe(true);
    expect((e as HomeRefusalError).homeRefusalCause).toBe('home-unwritable');
    expect(e.message).toBe(HOME_TEXT);
    expect(readFileSync(fx.ledger).equals(before)).toBe(true);
    expect(existsSync(auditPath)).toBe(false);
  });

  it('adopt: the same refusal, no ownership record, no registry entry, no audit file', () => {
    const fx = fixture();                                                                   // .helix exists, no .owner
    const auditPath = join(fx.home, 'audit.jsonl');
    keepWritable(fx.home); chmodSync(fx.home, 0o500);
    const e = thrown(() => handleAdopt(fx.store('b'), { projectRoot: fx.root }, { auditPath }));
    chmodSync(fx.home, 0o700);
    expect(isHomeRefusalError(e), e.message).toBe(true);
    expect((e as HomeRefusalError).homeRefusalCause).toBe('home-unwritable');
    expect(e.message).toBe(HOME_TEXT);
    expect(existsSync(join(fx.helix, '.owner'))).toBe(false);
    expect(registryKeys(fx.home)).toEqual([]);
    expect(existsSync(auditPath)).toBe(false);
  });
});
