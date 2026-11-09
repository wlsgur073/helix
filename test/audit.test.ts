import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeRefusalError, isHomeRefusalError } from '../src/memory/home-env.js';
import { appendAudit, assertAuditWritable, type AuditEvent } from '../src/audit.js';

function tmpAudit() { return join(mkdtempSync(join(tmpdir(), 'helix-audit-')), 'audit.jsonl'); }

// DEVIATION (documented, task-7-report.md): appendAudit has no injectable DurableFsOps seam of its
// own — audit.jsonl is a single best-effort side channel, not one of the coordinated durable-write
// paths (ledger/key/witness) that thread `fsOps` through for that purpose. To prove the deliberate
// audit.ts exemption (task 7: a genuinely failed directory fsync on every append must NOT abort an
// already-succeeded primary operation) without adding a production-facing test hook, mock the ONE
// function audit.ts imports from fs-ops.js and make it throw exactly once, on command — every other
// test in this file exercises the real, unmocked fsyncDir via the pass-through below (vitest hoists
// vi.mock above the imports above, so import order here does not matter). This is the ONLY module
// mock in this suite.
let throwOnNextFsyncDir: (Error & { code?: string }) | null = null;
vi.mock('../src/memory/fs-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/fs-ops.js')>();
  return {
    ...actual,
    fsyncDir: (dir: string) => {
      const err = throwOnNextFsyncDir;
      throwOnNextFsyncDir = null; // one-shot: only the dedicated test below arms it
      if (err) throw err;
      return actual.fsyncDir(dir);
    },
  };
});

describe('appendAudit', () => {
  it('fsyncs the directory on EVERY append, not only first creation (audit first-create race)', () => {
    const p = tmpAudit();
    const dirs: string[] = [];
    const io = { fsyncDir: (d: string) => { dirs.push(d); } };
    const e = { kind: 'erase', ts: 't', id: 'm_1' } as never;
    appendAudit(p, e, io);
    appendAudit(p, e, io);
    expect(dirs).toHaveLength(2); // a non-creator appender owns the durability of the row it acknowledges
  });

  it('appends one JSON line per event and reads back', () => {
    const p = tmpAudit();
    const e: AuditEvent = { kind: 'dual-verify', ts: '2026-06-09T00:00:00.000Z', enabled: true, spawned: true, verdict: 'agree' };
    appendAudit(p, e);
    appendAudit(p, { ...e, verdict: 'diverge' });
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe('dual-verify');
    expect(JSON.parse(lines[1]!).verdict).toBe('diverge');
  });

  it('round-trips an indeterminate verdict row', () => {
    const p = tmpAudit();
    appendAudit(p, { kind: 'dual-verify', ts: '2026-07-26T00:00:00.000Z', enabled: true, spawned: true, verdict: 'indeterminate' });
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).verdict).toBe('indeterminate');
  });

  it('round-trips the enum/ID-only egress fields', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'dual-verify', ts: '2026-06-14T00:00:00.000Z', enabled: true, spawned: false,
      reason: 'blocked: memory-echo (2 items)',
      egressDecision: 'blocked', decidedLeg: 'memory_echo',
      piiKinds: ['email', 'credit_card'], echoMemoryIds: ['m_1', 'm_2'],
    };
    appendAudit(p, e);
    const back = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(back.egressDecision).toBe('blocked');
    expect(back.decidedLeg).toBe('memory_echo');
    expect(back.piiKinds).toEqual(['email', 'credit_card']);
    expect(back.echoMemoryIds).toEqual(['m_1', 'm_2']);
  });

  it('round-trips an allowed_override egress event', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'dual-verify', ts: '2026-06-14T00:00:00.000Z', enabled: true, spawned: true,
      egressDecision: 'allowed_override', decidedLeg: 'pii', piiKinds: ['credit_card'],
    };
    appendAudit(p, e);
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).egressDecision).toBe('allowed_override');
  });

  it('appends a content-free verify audit row (no path/pattern)', () => {
    const p = tmpAudit();
    const e: AuditEvent = {
      kind: 'verify', ts: '2026-01-01T00:00:00Z', id: 'm1', source: 'reality-check',
      checkKind: 'file-contains', resultState: 'Corroborated', bound: true,
      outcome: { ran: true, indeterminate: false, passed: true },
    };
    appendAudit(p, e);
    const row = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(row.kind).toBe('verify');
    expect(row.resultState).toBe('Corroborated');
    expect(JSON.stringify(row)).not.toMatch(/path|pattern/); // content-free
  });

  // Task 7 (LEAD-DIRFSYNC-SUPPRESSED): fs-ops.ts's fsyncDir now PROPAGATES an attempted-and-failed
  // directory fsync instead of swallowing it — correct for the ledger/key/witness write paths.
  // audit.jsonl is deliberately exempted: this file's own docstring says completeness is best-effort,
  // NOT transactional, and no caller (handlers.ts) wraps appendAudit — by the time it runs, every
  // caller has already COMPLETED its primary operation (successfully in handleErase, handleAdopt and
  // the post-success appends of handleRecheck/handleConfirm, or having already FAILED in the catch
  // blocks of handleRecheck/handleConfirm/handleErase, about to re-throw its own real error). Fix round 1 (review
  // Important 3): the primary operation is not always a SUCCESS that "already durably committed" —
  // see audit.ts's own docstring for the corrected, per-site breakdown. Fix round 2: that breakdown
  // itself first undercounted the success sites (three, not four — handleConfirm's own post-success
  // append was missing). Fix round 3: both copies cited LINE numbers, and all seven had drifted by
  // the time anyone re-read them; they name functions now.
  // Letting a directory-fsync failure escape here would, at best, report an already-successful
  // primary operation as FAILED for an unrelated reason, and at worst — at the reject sites —
  // REPLACE the real rejection error with a generic fsync error, masking it. Both are worse than
  // the audit row silently missing, which the
  // docstring already accepts. The row content itself (writeAll + fsyncSync(fd)) is UNCHANGED — still
  // unconditional and still propagates — only the directory fsync on every append is swallowed here.
  it('a genuinely failed directory fsync on every append does not abort the audit append (best-effort by design)', () => {
    const p = tmpAudit();
    throwOnNextFsyncDir = Object.assign(new Error('EIO fake (audit dir fsync)'), { code: 'EIO' });
    expect(() => appendAudit(p, { kind: 'adopt', ts: '2026-08-07T00:00:00.000Z', scope: '/x' })).not.toThrow();
    expect(JSON.parse(readFileSync(p, 'utf8').trim()).kind).toBe('adopt'); // the row still landed
  });
});

// Third fix batch B2a, task B4 (ruling J4; design 4.6): the look that confirm, erase, recheck and adopt take at the audit file
// BEFORE they write their ledger row. It reads permissions and kinds, opens nothing (an open of a FIFO would block) and creates
// nothing. A sync call cannot be interrupted by a test timeout, so the FIFO row is the last of its table.
describe.skipIf(process.platform === 'win32')('assertAuditWritable', () => {
  const HOME_TEXT = 'the Helix home directory cannot be written, so the operation was refused before anything was changed';
  const AUDIT_TEXT = 'the Helix audit file cannot be written, so the operation was refused before anything was changed';
  const AS_ROOT = process.getuid?.() === 0;
  const made: string[] = [];
  const dir = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'aw-'))); made.push(d); return d; };
  afterEach(() => { for (const d of made.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
  const refusal = (f: () => void): HomeRefusalError => {
    try { f(); } catch (e) { expect(isHomeRefusalError(e)).toBe(true); return e as HomeRefusalError; }
    throw new Error('expected a refusal');
  };

  it('passes a writable directory that holds no audit file, and creates nothing', () => {
    const d = dir();
    expect(() => assertAuditWritable(join(d, 'audit.jsonl'))).not.toThrow();
    expect(readdirSync(d)).toEqual([]);
  });

  it('passes an existing regular audit file and a link to one (the append follows links)', () => {
    const d = dir(); const other = dir();
    writeFileSync(join(d, 'audit.jsonl'), '', { mode: 0o600 });
    expect(() => assertAuditWritable(join(d, 'audit.jsonl'))).not.toThrow();
    const real = join(other, 'real.jsonl'); writeFileSync(real, '', { mode: 0o600 });
    const l = dir(); symlinkSync(real, join(l, 'audit.jsonl'));
    expect(() => assertAuditWritable(join(l, 'audit.jsonl'))).not.toThrow();
  });

  const NOT_DECIDED: Array<[string, (b: string) => string]> = [
    ['a missing directory', (b) => join(b, 'nodir', 'audit.jsonl')],
    ['a "directory" that is a regular file', (b) => { writeFileSync(join(b, 'f'), ''); return join(b, 'f', 'audit.jsonl'); }],
  ];
  it.each(NOT_DECIDED)('leaves %s to the operation, so the store\'s own refusal is the one reported', (_name, plant) => {
    const b = dir(); const p = plant(b); const before = readdirSync(b);
    expect(() => assertAuditWritable(p)).not.toThrow();
    expect(readdirSync(b)).toEqual(before);
  });

  // Final review G10 (revising plan decision B4-2): a home whose own name is a symbolic link is refused by the look with
  // ensureHelixDir's existing symlinked-home refusal. A link that does not resolve left the store no refusal of its own (a
  // confirm or recheck answered "target not found", an erase "no memory has id"), so the look answers it.
  const LINKED_HOME: Array<[string, (b: string) => string]> = [
    ['a link loop', (b) => { symlinkSync('loop', join(b, 'loop')); return join(b, 'loop'); }],
    ['a link to a missing target', (b) => { symlinkSync(join(b, 'gone', 'helix'), join(b, 'h')); return join(b, 'h'); }],
    ['a link to a real directory', (b) => { mkdirSync(join(b, 'real')); symlinkSync(join(b, 'real'), join(b, 'h')); return join(b, 'h'); }],
  ];
  it.each(LINKED_HOME)('a home that is %s is refused as a symlinked home, and nothing is created', (_name, plant) => {
    const b = dir(); const home = plant(b); const before = readdirSync(b);
    const e = refusal(() => assertAuditWritable(join(home, 'audit.jsonl')));
    expect(e.homeRefusalCause).toBe('symlinked-home');
    expect(e.message).toBe(`refusing to use ${home}: it is a symlink, not a directory Helix owns`);
    expect(readdirSync(b)).toEqual(before);
  });

  // Final review G12: a dangling audit.jsonl link whose target's folder is not a directory cannot be created through, so the
  // look refuses it before the row (a confirm used to land its row and read Verified with no audit row). A dangling link into
  // a folder that exists keeps the followed append (ruling L).
  const DANGLING_AUDIT: Array<[string, (d: string) => void]> = [
    ['an absolute body into a missing folder', (d) => symlinkSync(join(d, 'nowhere', 'x'), join(d, 'audit.jsonl'))],
    ['a relative body into a missing folder', (d) => symlinkSync('nowhere/x', join(d, 'audit.jsonl'))],
    ['a body whose folder is a regular file', (d) => { writeFileSync(join(d, 'plain'), ''); symlinkSync(join(d, 'plain', 'x'), join(d, 'audit.jsonl')); }],
  ];
  it.each(DANGLING_AUDIT)('an audit.jsonl link with %s is audit-unwritable, and nothing is created', (_name, plant) => {
    const d = dir(); plant(d); const before = readdirSync(d);
    const e = refusal(() => assertAuditWritable(join(d, 'audit.jsonl')));
    expect(e.homeRefusalCause).toBe('audit-unwritable');
    expect(e.message).toBe(AUDIT_TEXT);
    expect(readdirSync(d)).toEqual(before);
  });

  it('a dangling audit.jsonl link into a folder that exists passes (ruling L: the append follows it), and nothing is created', () => {
    const d = dir(); const other = dir();
    symlinkSync(join(other, 'x.jsonl'), join(d, 'audit.jsonl'));
    expect(() => assertAuditWritable(join(d, 'audit.jsonl'))).not.toThrow();
    const e2 = dir(); symlinkSync('fresh.jsonl', join(e2, 'audit.jsonl'));          // a relative body beside the link
    expect(() => assertAuditWritable(join(e2, 'audit.jsonl'))).not.toThrow();
    expect(readdirSync(other)).toEqual([]);
    expect(readdirSync(e2)).toEqual(['audit.jsonl']);
  });

  describe.skipIf(AS_ROOT)('a home without write permission', () => {
    it.each([['no audit file yet', false], ['an audit file that could itself be appended', true]] as Array<[string, boolean]>)(
      'is home-unwritable with %s',
      (_name, present) => {
        const d = dir();
        if (present) writeFileSync(join(d, 'audit.jsonl'), '', { mode: 0o600 });
        chmodSync(d, 0o500);
        const before = readdirSync(d);
        const e = refusal(() => assertAuditWritable(join(d, 'audit.jsonl')));
        expect(e.homeRefusalCause).toBe('home-unwritable');
        expect(e.message).toBe(HOME_TEXT);
        expect(e.message).not.toContain(d);
        chmodSync(d, 0o700);
        expect(readdirSync(d)).toEqual(before);
      },
    );
  });

  const UNWRITABLE: Array<[string, (d: string) => void, boolean]> = [
    ['a file without write permission', (d) => writeFileSync(join(d, 'audit.jsonl'), '', { mode: 0o400 }), true],
    ['a directory', (d) => mkdirSync(join(d, 'audit.jsonl')), false],
    ['a link loop', (d) => symlinkSync('audit.jsonl', join(d, 'audit.jsonl')), false],
    ['a FIFO', (d) => { execFileSync('mkfifo', [join(d, 'audit.jsonl')]); }, false],
  ];
  it.each(UNWRITABLE)('an audit.jsonl that is %s is audit-unwritable', (_name, plant, needsNonRoot) => {
    if (needsNonRoot && AS_ROOT) return;   // root passes access(2) for W_OK whatever the mode
    const d = dir(); plant(d);
    const e = refusal(() => assertAuditWritable(join(d, 'audit.jsonl')));
    expect(e.homeRefusalCause).toBe('audit-unwritable');
    expect(e.message).toBe(AUDIT_TEXT);
    expect(e.message).not.toContain(d);
  });
});
