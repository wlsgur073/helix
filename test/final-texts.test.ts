// Third fix batch B1, task B9: the final wording of every exported text of the batch, as literals (the plan's table of
// texts). A text that changes fails here by name. Texts that stay private to a module (the CLI strings, the timeout
// sentences) are pinned by the tests of the task that owns them; the one ceremony text B8 exports is pinned here too.
import { describe, it, expect } from 'vitest';
import { DESTINATION_CHANGED_REFUSAL, PROC_LOST_REFUSAL } from '../src/memory/ledger.js';
import { LOCK_FOREIGN_OBJECT_REFUSAL } from '../src/memory/lock.js';
import { UnresolvablePathError } from '../src/memory/path-identity.js';
import {
  ALIASED_LEDGER_NOTE, UNUSABLE_LEDGER_NOTE, WITNESS_FILE_UNUSABLE_NOTE, WITNESS_PATH_UNRESOLVABLE_NOTE,
  WITNESS_READ_TRANSIENT_NOTE, GLOBAL_LEDGER_READ_ONLY_NOTE,
} from '../src/memory/content-frame.js';
import { GLOBAL_WRITE_REFUSAL, GLOBAL_DESTINATION_CHANGED, GLOBAL_READ_ONLY_STARTUP_LINE } from '../src/memory/global-ledger.js';
import { witnessUnusableRefusal, WitnessUnusableError } from '../src/memory/witness-store.js';
import { STORED_THEN_FAILED_RESPONSE } from '../src/server/handlers.js';
import { REBASELINE_DESTINATION_CHANGED_REFUSAL } from '../scripts/rebaseline-cli.js';
import {
  PROJECT_WRITE_REFUSAL, FIRST_WRITE_FAILED_UNDONE, FIRST_WRITE_FAILED_NOT_UNDONE, ADOPT_NOT_LEDGER_CONTENT,
  ADOPT_LOCK_BUSY_REFUSAL, ADOPT_LOCK_UNIDENTIFIED_REFUSAL, ADOPT_RECORD_FAILED_UNDONE, ADOPT_RECORD_FAILED_NOT_UNDONE,
} from '../src/memory/store.js';

const ALIASED =
  "this project's memory file resolves outside this project, to another Helix memory file, to a file with more than one hard link, " +
  'or through a path Helix cannot resolve';
const UNUSABLE =
  "this project's memory file cannot be used as it is (it is not a regular file or cannot be opened, a folder on its way cannot be read " +
  'or is not a directory, its .helix folder is a link or is not a directory, it is a link into a folder that does not exist, or it is a ' +
  'link to a file that does not hold Helix memory records)';
const UNWRITABLE = "this project's memory folder cannot be written (a read-only folder or file system)";
const GLOBAL_CAUSE =
  "the global memory file's path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, too many links, " +
  'or a link into a directory that does not exist)';

describe('the ledger and lock layers', () => {
  it('the unresolvable-path message names no path and lists the three causes', () => {
    expect(new UnresolvablePathError('non-utf8-name').message).toBe(
      'the path cannot be resolved (a name that is not valid UTF-8, a path past the system limit, or too many links)');
  });
  it('WP-3: the changed-destination refusal says "changed" and "in progress"', () => {
    expect(DESTINATION_CHANGED_REFUSAL).toBe(
      "commit: this project's memory file changed while the write was in progress — nothing was written. Try the commit again; if it happens again, tell the user.");
  });
  it('WP-6: the lost-/proc refusal is operation-neutral', () => {
    expect(PROC_LOST_REFUSAL).toBe(
      "Helix can no longer confirm which folder this write goes into, because the system's process file table became unavailable after this " +
      'session started — nothing was written. Restart the session; if it happens again, tell the user.');
  });
  it('the foreign lock object refusal says "for this path" and keeps the do-not-remove sentence', () => {
    expect(LOCK_FOREIGN_OBJECT_REFUSAL).toBe(
      'withFileLock: the lock file for this path is not a lock Helix wrote (a link, a FIFO, a socket or a device stands at its name) — ' +
      'refusing to read it or wait on it. Ask the user to look at that object and remove it; do not remove it for them.');
  });
});

describe('the notes', () => {
  it('ALIASED_LEDGER_NOTE', () => {
    expect(ALIASED_LEDGER_NOTE).toBe(`(${ALIASED}, and is excluded from results)`);
  });
  it('WP-1 and WP-2: UNUSABLE_LEDGER_NOTE lists five causes and says "off here"', () => {
    expect(UNUSABLE_LEDGER_NOTE).toBe(
      "(this project's memory file cannot be used as it is: it is not a regular file or cannot be opened, a folder on its way cannot be read " +
      'or is not a directory, its .helix folder is a link or is not a directory, it is a link into a folder that does not exist, or it is a ' +
      'link to a file that does not hold Helix memory records; project memory is off here)');
  });
  it('WP-8: WITNESS_FILE_UNUSABLE_NOTE ends at the user, not at removal', () => {
    expect(WITNESS_FILE_UNUSABLE_NOTE).toBe(
      '(the rollback-witness file exists but cannot be read or parsed, or a link stands at its name, so grades cannot be checked against it: ' +
      'elevated grades are shown as Fresh and nothing can be stored until the user restores or resets that file)');
  });
  it('WP-8: WITNESS_PATH_UNRESOLVABLE_NOTE names the three refused operations and has no "session"', () => {
    expect(WITNESS_PATH_UNRESOLVABLE_NOTE).toBe(
      "(the rollback-witness file's path cannot be resolved, so nothing can be stored, erased or re-graded until that path is repaired: " +
      'existing records are shown, and their grades are checked against that file as it stands)');
  });
  it('WITNESS_READ_TRANSIENT_NOTE', () => {
    expect(WITNESS_READ_TRANSIENT_NOTE).toBe(
      "(the rollback-witness file could not be read at this moment, so this project's memory is left out of this block; the next session reads it again)");
  });
  it('WP-9: GLOBAL_LEDGER_READ_ONLY_NOTE says where a rollback witness mismatch beside it can come from', () => {
    expect(GLOBAL_LEDGER_READ_ONLY_NOTE).toBe(
      "(the global memory file's path cannot be used for writing (it cannot be resolved, or it is a link into a directory that does not exist), " +
      'so global memory is read-only: records that can be read through that path are shown, and nothing can be stored, erased or re-graded ' +
      'there until the path is repaired; while the path is broken, a rollback witness mismatch note for global memory can come from the broken ' +
      'path and not from a rollback)');
  });
  it('GLOBAL_READ_ONLY_STARTUP_LINE', () => {
    expect(GLOBAL_READ_ONLY_STARTUP_LINE).toBe(
      "helix: NOTE - the global memory file's path cannot be used for writing (it cannot be resolved, or it is a link into a directory that does " +
      'not exist), so global memory is read-only: nothing can be stored, erased or re-graded there until the path is repaired');
  });
});

describe('the witness refusals and the stored-then-failed responses', () => {
  it('the witness refusal is the 4.9 row with the tool name in front', () => {
    expect(witnessUnusableRefusal('commit')).toBe(
      'commit: the rollback-witness file cannot be used (its path cannot be resolved, a link stands at its name, it is not a regular file, or it ' +
      'cannot be read or parsed) — the write is refused rather than replacing that file, which would drop the baseline of every scope. Ask the ' +
      'user whether to restore it from a backup or to remove it, which starts every scope again from first contact; do not choose for them.');
  });
  it('the transient failure advises no removal', () => {
    expect(new WitnessUnusableError('confirm', 'transient').message).toBe(
      'confirm: the rollback-witness file could not be read at this moment (the system is out of file descriptors, or the read was interrupted), ' +
      'so this call failed. The file itself was not found to be damaged; try the call again.');
  });
  it.each([
    ['commit', 'commit: the record was stored, but a step after the write failed (the rollback witness may not have been updated). Do not commit it again; tell the user what happened.'],
    ['erase', 'erase: the erase was stored, but a step after the write failed (the rollback witness may not have been updated). Do not erase it again; tell the user what happened.'],
    ['confirm', 'confirm: the confirmation was stored, but a step after the write failed (the rollback witness may not have been updated). Do not confirm it again; tell the user what happened.'],
    ['recheck', "recheck: the check's result was stored, but a step after the write failed (the rollback witness may not have been updated). Do not run the recheck again; tell the user what happened."],
  ] as const)('WP-4: %s says "may not have been updated"', (op, text) => {
    expect(STORED_THEN_FAILED_RESPONSE[op]).toBe(text);
  });
});

describe('the global write refusals', () => {
  it.each(['commit', 'erase', 'confirm', 'recheck', 'compaction'] as const)('%s: the 4.9 row, the cause list, one tail', (op) => {
    expect(GLOBAL_WRITE_REFUSAL[op]).toBe(
      `${op}: ${GLOBAL_CAUSE} — nothing was written. Tell the user that the global memory path needs repair; do not repair it for them.`);
  });
  it.each([
    ['commit', 'commit: the global memory file changed while the write was in progress — nothing was written. Try the commit again; if it happens again, tell the user.'],
    ['erase', 'erase: the global memory file changed while the erase was in progress — nothing was erased. Try the erase again; if it happens again, tell the user.'],
    ['confirm', 'confirm: the global memory file changed while the confirmation was in progress — the grade was not changed. Try the confirmation again; if it happens again, tell the user.'],
    ['recheck', 'recheck: the global memory file changed while the recheck was in progress — the grade was not changed. Try the recheck again; if it happens again, tell the user.'],
    ['compaction', 'compaction: the global memory file changed while the rewrite was in progress — nothing was rewritten.'],
  ] as const)('WP-3: %s says "changed" and "in progress"', (op, text) => {
    expect(GLOBAL_DESTINATION_CHANGED[op]).toBe(text);
  });
});

describe('the project write refusals, every cell of the table', () => {
  const EXPECTED = {
    commit: {
      aliased: `commit: ${ALIASED}, so the project layer is disabled here — the write is refused rather than written somewhere else. Ask the user whether to store this fact in global memory, which every project sees, or to replace the link with the project's own file; do not choose for them.`,
      unusable: `commit: ${UNUSABLE}, so the project layer is disabled here — nothing was written. Ask the user whether to store this fact in global memory, which every project sees, or to repair the project's memory file; do not choose for them.`,
      unwritable: `commit: ${UNWRITABLE}, so nothing was written. Ask the user whether to store this fact in global memory, which every project sees, or to make that folder writable; do not choose for them.`,
      changed: "commit: this project's memory file changed while the write was in progress — nothing was written. Try the commit again; if it happens again, tell the user.",
      notAdopted: 'commit: a project memory file exists here that Helix did not create — ask the user whether to adopt it (helix_memory_adopt) or to move it away; do not choose for them.',
    },
    erase: {
      aliased: `erase: ${ALIASED} — the erase is refused rather than applied somewhere else.`,
      unusable: `erase: ${UNUSABLE} — nothing was erased.`,
      unwritable: `erase: ${UNWRITABLE}, so nothing was erased. Ask the user whether to make that folder writable; do not choose for them.`,
      changed: "erase: this project's memory file changed while the erase was in progress — nothing was erased. Try the erase again; if it happens again, tell the user.",
      notAdopted: "erase: this project's memory is not adopted — ask the user whether to adopt it (helix_memory_adopt); do not choose for them.",
    },
    confirm: {
      aliased: `confirm: ${ALIASED} — the grade was not changed rather than recorded somewhere else.`,
      unusable: `confirm: ${UNUSABLE} — the grade was not changed.`,
      unwritable: `confirm: ${UNWRITABLE}, so the grade was not changed. Ask the user whether to make that folder writable; do not choose for them.`,
      changed: "confirm: this project's memory file changed while the confirmation was in progress — the grade was not changed. Try the confirmation again; if it happens again, tell the user.",
      notAdopted: "confirm: this project's memory is not adopted — the grade was not changed. Ask the user whether to adopt it (helix_memory_adopt); do not choose for them.",
    },
    recheck: {
      aliased: `recheck: ${ALIASED} — the grade was not changed rather than recorded somewhere else.`,
      unusable: `recheck: ${UNUSABLE} — the grade was not changed.`,
      unwritable: `recheck: ${UNWRITABLE}, so the grade was not changed. Ask the user whether to make that folder writable; do not choose for them.`,
      changed: "recheck: this project's memory file changed while the recheck was in progress — the grade was not changed. Try the recheck again; if it happens again, tell the user.",
      notAdopted: "recheck: this project's memory is not adopted — the grade was not changed. Ask the user whether to adopt it (helix_memory_adopt); do not choose for them.",
    },
    compaction: {
      aliased: `compaction: ${ALIASED} — nothing was rewritten.`,
      unusable: `compaction: ${UNUSABLE} — nothing was rewritten.`,
      unwritable: `compaction: ${UNWRITABLE}, so nothing was rewritten.`,
      changed: "compaction: this project's memory file changed while the rewrite was in progress — nothing was rewritten.",
      notAdopted: "compaction: this project's memory is not adopted — nothing was rewritten.",
    },
    adopt: {
      aliased: `adopt: ${ALIASED}, so the project layer is disabled here — nothing was adopted.`,
      unusable: `adopt: ${UNUSABLE}, so the project layer is disabled here — nothing was adopted.`,
      unwritable: `adopt: ${UNWRITABLE}, so nothing was adopted. Ask the user whether to make that folder writable; do not choose for them.`,
      changed: "adopt: this project's memory file changed while the adoption was in progress — nothing was adopted. Try the adoption again; if it happens again, tell the user.",
      notAdopted: `adopt: ${UNUSABLE}, so the project layer is disabled here — nothing was adopted.`,
    },
  } as const;

  it('the table has exactly these six operations and five cells each', () => {
    expect(Object.keys(PROJECT_WRITE_REFUSAL).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const op of Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>) {
      expect(Object.keys(PROJECT_WRITE_REFUSAL[op]).sort(), op).toEqual(['aliased', 'changed', 'notAdopted', 'unusable', 'unwritable']);
    }
  });
  const cells = (Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>).flatMap((op) =>
    (['aliased', 'unusable', 'unwritable', 'changed', 'notAdopted'] as const).map((cell) => [op, cell] as const));
  it.each(cells)('%s.%s', (op, cell) => {
    expect(PROJECT_WRITE_REFUSAL[op][cell]).toBe(EXPECTED[op][cell]);
  });
  it('WP-5: the first-write texts', () => {
    expect(FIRST_WRITE_FAILED_UNDONE).toBe(
      "commit: the first write to this project's memory file failed, so the project was not adopted and nothing was written. Ask the user whether " +
      "to store this fact in global memory, which every project sees, or to look at the project's memory folder first; do not choose for them.");
    expect(FIRST_WRITE_FAILED_NOT_UNDONE).toBe(
      "commit: the first write to this project's memory file failed and the adoption recorded for it could not be undone, so the project may stay " +
      'adopted, and a file at its memory path would then be read as its memory — nothing was written. Tell the user what happened; do not try to ' +
      'repair it for them.');
  });
  it('the adopt-only texts', () => {
    expect(ADOPT_NOT_LEDGER_CONTENT).toBe(
      "adopt: the file this project's memory path leads to holds content that is not Helix memory records — nothing was adopted. Ask the user which " +
      "file this project's memory should be; do not choose for them.");
    expect(ADOPT_LOCK_BUSY_REFUSAL).toBe(
      "adopt: another write to this project's memory file did not finish while the adoption waited for its lock — nothing was adopted. Try the " +
      'adoption again; if it happens again, tell the user.');
    expect(ADOPT_LOCK_UNIDENTIFIED_REFUSAL).toBe(
      "adopt: the lock beside this project's memory file has a holder Helix cannot identify or show to be gone (the lock file cannot be read or " +
      'does not parse as a lock, its holder cannot be checked, or it is a lock folder left by an older version), so Helix does not remove it — ' +
      'nothing was adopted. Ask the user to look at that lock; do not remove it for them.');
    expect(ADOPT_RECORD_FAILED_UNDONE).toBe(
      'adopt: recording the adoption failed, so the project was not adopted and nothing was recorded. Tell the user what happened.');
    expect(ADOPT_RECORD_FAILED_NOT_UNDONE).toBe(
      'adopt: recording the adoption failed and could not be undone, so the project may be partly adopted. Tell the user what happened; do not try ' +
      'to repair it for them.');
  });
});

describe('the ceremony text with an export (rulings H R-6)', () => {
  it('a destination that changes under the re-baseline: true for both scopes, no word of the commit tool', () => {
    expect(REBASELINE_DESTINATION_CHANGED_REFUSAL).toBe(
      'helix-rebaseline: REFUSING - the memory file changed while the re-baseline was in progress, so no fence was written.\n' +
      'Check what the memory path leads to now, then re-run.\n',
    );
  });
});

describe('words the wording pass removed stay out of every exported text', () => {
  // Built inside the cases, not at collection time, so a name that is not exported yet fails the case and not the file.
  const allTexts = (): string[] => [
    DESTINATION_CHANGED_REFUSAL, PROC_LOST_REFUSAL, LOCK_FOREIGN_OBJECT_REFUSAL, ALIASED_LEDGER_NOTE, UNUSABLE_LEDGER_NOTE,
    WITNESS_FILE_UNUSABLE_NOTE, WITNESS_PATH_UNRESOLVABLE_NOTE, WITNESS_READ_TRANSIENT_NOTE, GLOBAL_LEDGER_READ_ONLY_NOTE,
    GLOBAL_READ_ONLY_STARTUP_LINE, FIRST_WRITE_FAILED_UNDONE, FIRST_WRITE_FAILED_NOT_UNDONE, ADOPT_NOT_LEDGER_CONTENT,
    ADOPT_LOCK_BUSY_REFUSAL, ADOPT_LOCK_UNIDENTIFIED_REFUSAL, ADOPT_RECORD_FAILED_UNDONE, ADOPT_RECORD_FAILED_NOT_UNDONE,
    witnessUnusableRefusal('commit'), new WitnessUnusableError('confirm', 'transient').message,
    ...Object.values(STORED_THEN_FAILED_RESPONSE), ...Object.values(GLOBAL_WRITE_REFUSAL), ...Object.values(GLOBAL_DESTINATION_CHANGED),
    ...Object.values(PROJECT_WRITE_REFUSAL).flatMap((row) => Object.values(row)),
  ];
  it('no text says "for this session", "in this session", "was replaced while", "was not updated" or "with no memory file", and none keeps the old cause clause', () => {
    for (const t of allTexts()) {
      expect(t).not.toMatch(/for this session|in this session|was replaced while|was not updated|with no memory file|that folder is missing or not a directory/);
    }
  });
  it('only the one operation-neutral text lacks an operation prefix, among the refusals', () => {
    const prefixed = /^(commit|erase|confirm|recheck|compaction|adopt|withFileLock): /;
    const bare = allTexts().filter((t) => !t.startsWith('(') && !t.startsWith('helix: ') && !prefixed.test(t));
    expect(bare).toEqual([PROC_LOST_REFUSAL]);
  });
});
