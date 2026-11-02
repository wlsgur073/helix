// Third fix batch B1, task B11: the shipped documents state what the batch does. Each case pins the shortest phrase
// that carries a claim (or recovers the value from the code first), and a second group pins that the sentences the
// batch made false are gone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_CONTENT_READ_BOUND_BYTES } from '../../src/memory/ledger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const flat = (name: string): string => readFileSync(join(ROOT, name), 'utf8').replace(/\s+/g, ' ');
// The content check's bound in MiB, recovered from the code: every document case that names it builds the phrase from this.
const MIB = LEDGER_CONTENT_READ_BOUND_BYTES / (1024 * 1024);

describe('SECURITY.md states the write path the batch built', () => {
  const sec = flat('SECURITY.md');

  it('the content check reads the first MiB, recovered from the code', () => {
    expect(Number.isInteger(MIB)).toBe(true);
    expect(sec).toContain(`first ${MIB} MiB holds no Helix record line`);
    expect(sec).toContain(`whose first ${MIB} MiB holds content that is neither empty nor at least one Helix record line`);
  });
  it('a path Helix cannot resolve is refused, and an unresolvable global ledger is read-only', () => {
    expect(sec).toContain('is refused by the lock, the append and the rewrite alike and is never guessed at');
    expect(sec).toContain('global memory is read-only');
    expect(sec).toContain('no longer replaces a link with a regular file');
    expect(sec).toContain('that home counts as a path that cannot be inspected');
  });
  it('the layer judgement has two exclusion classes, one function, and runs under the lock', () => {
    expect(sec).toContain('is excluded as `aliased` when its memory file resolves outside the project');
    expect(sec).toContain('A project is excluded as `unusable` when its `.helix` is a link or is not a directory');
    expect(sec).toContain('again under the ledger lock before the append');
  });
  it('the first write is one critical section with a restore, and the stored-then-failed message is described', () => {
    expect(sec).toContain("A project's first write is one critical section");
    expect(sec).toContain('(`O_CREAT | O_EXCL | O_NOFOLLOW`)');
    expect(sec).toContain('the registry entry and `.owner` are put back');
    expect(sec).toContain('says the record was stored and must not be repeated');
  });
  it('lock files are read as objects', () => {
    expect(sec).toContain('opened `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`');
    expect(sec).toContain('"not a lock Helix wrote"');
    expect(sec).toContain('takes the lock budget (5 s), not 7 s');
  });
  it('an unusable witness file is not a trust-on-first-use case', () => {
    expect(sec).toContain('is not one of the trust-on-first-use cases above');
    expect(sec).toContain('A symlink at `witness.json` is not followed, for reading or for writing, except in the narrow window');
  });
  it('every residual of the outline row is written', () => {
    for (const phrase of [
      'to an empty file, or to a file that holds the records of another project nobody registered',
      'a component that was already replaced when its identity was first sampled',
      'The `.owner` write and the removal that undoes it go by path in that case',
      'its identity is sampled just before it is opened',
      'not measured in a chroot',
      'can swap the name and have its file deleted',
      'an empty file can stay behind after a refused check',
      'the project stays adopted, with no memory file or with the file that was in the way',
      'keeps its registry entry with no memory file',
      'a bind mount the user made',
      'an inode of 0 is never equal',
      "gives the new file the old one's inode number",
      'a link into the home folder is caught by no rule',
      'a crash can lose the row that the caller was told was stored',
      "The witness lock's name is not looked at before an append",
      'more than two seconds old',
      'shared writable mapping',
      'Native Windows has no `O_NOFOLLOW`',
      'see a first contact where the file cannot be used',
      'take different locks for the single write that creates the target',
      'the empty file Helix made stays behind',
      'a regular file again when it is looked at is not caught',
      'replaced by the next witness write',
      'with the witness transition left open',
    ]) {
      expect(sec, phrase).toContain(phrase);
    }
  });
  it('the scan sentence and the two MAC sentences carry their conditions', () => {
    expect(sec).toContain('The scan reads a project ledger only after the layer judgement has passed it');
    expect(sec).toContain('above the current one and below 2^53, on a row that carries a MAC and a key id');
    expect(sec).toContain('(the unsigned content-free markers a rewrite writes are not such a row)');
  });
  it('the three passages outside the rewritten blocks give the exclusion by its two classes', () => {
    expect(sec).toContain('recallable — unless its layer is excluded (`aliased` or `unusable`, see *Ledger locking');
    expect(sec).toContain('an adopted project whose layer is not excluded (`aliased` or `unusable`, see *Ledger locking');
    expect(sec).toContain("unless that project's layer is excluded (`aliased` or `unusable`, see *Ledger locking");
  });
  it('the sentences the batch made false are gone', () => {
    for (const phrase of [
      "unless it resolves to another adopted project's ledger file, which stays excluded",
      "leads neither to another adopted project's file nor through a path Helix cannot resolve",
      "unless that ledger resolves to another adopted project's file or through a path Helix cannot resolve",
      "is locked at the link's own location for the one write that creates the target",
      'The global ledger is never excluded',
      'An adopted project is not compared with the global ledger while the server runs',
      'dangling or not, is the global store rather than a project',
      'so one file is never written under two project scopes',
      'The scan also skips an aliased project layer',
    ]) {
      expect(sec, phrase).not.toContain(phrase);
    }
  });
});

describe('README.md states the first commit and the exclusions', () => {
  const readme = flat('README.md');
  it('the first commit is exclusive and put back on failure', () => {
    expect(readme).toContain("Under the project's ledger lock it records a home-registry entry plus the in-repo `.owner` stamp and creates the ledger exclusively");
    expect(readme).toContain('so a failed first commit leaves the project unadopted');
  });
  it('the exclusions name their causes and the adopt refusal', () => {
    expect(readme).toContain('unless the project\'s memory file is judged unfit, adopted or not');
    expect(readme).toContain(`whose first ${MIB} MiB holds no Helix record`);
    expect(readme).toContain('and also a file that holds content other than Helix records');
  });
  it('the sentence the batch replaced is gone', () => {
    expect(readme).not.toContain('Only a pre-existing ledger that Helix did not create needs the explicit');
    expect(readme).not.toContain('unless the ledger resolves to another adopted project');
  });
});

describe('CHANGELOG.md lists the changed layouts', () => {
  const changelog = flat('CHANGELOG.md');
  it('each changed behaviour has its entry', () => {
    for (const phrase of [
      'One judgement of a project\'s memory file for every read, write, erase, adoption, startup scan and ceremony',
      "A project's first commit is one critical section",
      'makes global memory read-only',
      'A rollback-witness file that cannot be used',
      'Lock files are read without following links',
      'must not be repeated, for commit, erase, confirm and recheck',
      '`helix-trust-resolve` follows `HELIX_LEDGER` for the global ledger',
      'it is now an excluded project layer (`aliased`), and that commit is refused',
    ]) {
      expect(changelog, phrase).toContain(phrase);
    }
  });
  it('the content check bound in the two entries that name it, recovered from the code', () => {
    expect(changelog).toContain(`whose first ${MIB} MiB holds no Helix record`);
    expect(changelog).toContain(`(decided on its first ${MIB} MiB)`);
  });
  it('the FIFO sentence and the scan sentence are corrected', () => {
    expect(changelog).toContain('so a FIFO behind one prints no line');
    expect(changelog).toContain('The scan reads a project ledger only after the layer judgement passes it');
    expect(changelog).not.toContain('The scan skips an aliased project layer, and an unadopted working-directory project whose memory file leads to another registered');
  });
  it('control: the tool count that shipped-claims.doc.test.ts pins is still there', () => {
    expect(changelog).toMatch(/nine MCP tools/i);
  });
});
