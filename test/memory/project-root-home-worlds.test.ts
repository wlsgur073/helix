// Third fix batch B1, task A14 (design 4.2, the paragraph on resolveProjectLayer; decisions 8 R5 and 16): the 48
// home-as-project worlds of the 2026-10-05 sweep B. No layer when the memory path IS the global ledger's own directory
// entry; a layer (judged afterwards by the table) when the memory path or the global ledger is itself a link.
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveProjectLayer } from '../../src/memory/project-root.js';
import { isGlobalLedgerEntry, judgeProjectLayer, projectLedgerPath } from '../../src/memory/ownership.js';

const START = process.cwd();
const d = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'helix-b1worlds-')));
afterAll(() => { process.chdir(START); try { execFileSync('rm', ['-rf', '--', d]); } catch { /* best effort: a folder deeper than PATH_MAX needs rm, not rmSync (A2's file) */ } });

const COMP = 'a'.repeat(200);
const FF = Buffer.from([0xff]);
const B = (...parts: Array<string | Buffer>): Buffer => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const w = (p: string | Buffer): void => fs.writeFileSync(p, '');
const mkdirp = (p: string | Buffer): void => { fs.mkdirSync(p, { recursive: true }); };
let n = 0;

/** A real folder tree `firstBytes` + `moreBytes` deep reached through a short link, built one component at a time so no path
 *  string passed to mkdir exceeds the system limit. Returns a path under the limit that the kernel resolves to the deep folder. */
function deepFile(base: string, firstBytes: number, moreBytes: number, name: string | null): string {
  mkdirp(base); process.chdir(base); fs.mkdirSync('deep'); process.chdir('deep');
  let len = Buffer.byteLength(`${base}/deep`);
  while (len < firstBytes) { fs.mkdirSync(COMP); process.chdir(COMP); len += COMP.length + 1; }
  const mid = process.cwd(); const rel: string[] = []; let extra = 0;
  while (extra < moreBytes) { fs.mkdirSync(COMP); process.chdir(COMP); rel.push(COMP); extra += COMP.length + 1; }
  if (name) w(name);
  process.chdir(START);
  fs.symlinkSync(mid, `${base}/L1`);
  return `${base}/L1/${rel.join('/')}`;
}

type GBuilder = (W: string, home: string) => string;
/** [shape, builder, the global ledger is a link]. The builder returns G, the path handed to Helix as the global ledger. */
const GSHAPES: Array<[string, GBuilder, boolean]> = [
  ['g-regular', (W, home) => { mkdirp(home); w(`${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, false],
  ['g-missing', (W, home) => { mkdirp(home); return `${home}/memory.jsonl`; }, false],
  ['g-nohome', (W, home) => `${home}/memory.jsonl`, false],
  ['g-hardlinked', (W, home) => { mkdirp(home); w(`${home}/memory.jsonl`); fs.linkSync(`${home}/memory.jsonl`, `${home}/second-name.jsonl`); return `${home}/memory.jsonl`; }, false],
  ['g-trailing-slash', (W, home) => { mkdirp(home); w(`${home}/memory.jsonl`); return `${home}/memory.jsonl/`; }, false],
  ['g-noise-spelled', (W, home) => { mkdirp(home); w(`${home}/memory.jsonl`); return `${dirname(home)}/./${home.split('/').pop()}//memory.jsonl`; }, false],
  ['g-link', (W, home) => { mkdirp(home); mkdirp(`${W}/gx`); w(`${W}/gx/glob.jsonl`); fs.symlinkSync(`${W}/gx/glob.jsonl`, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-rel', (W, home) => { mkdirp(home); w(`${home}/glob.jsonl`); fs.symlinkSync('glob.jsonl', `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-dangling', (W, home) => { mkdirp(home); mkdirp(`${W}/gx`); fs.symlinkSync(`${W}/gx/glob.jsonl`, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-dd', (W, home) => { mkdirp(home); mkdirp(`${W}/gx/y/z`); mkdirp(`${W}/ga`); fs.symlinkSync(`${W}/gx/y/z`, `${W}/ga/dl`); w(`${W}/gx/y/glob.jsonl`); fs.symlinkSync(`${W}/ga/dl/../glob.jsonl`, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-ff', (W, home) => { mkdirp(home); mkdirp(`${W}/gx`); const t = B(W, '/gx/g', FF, '.jsonl'); w(t); fs.symlinkSync(t, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-ff-dangling', (W, home) => { mkdirp(home); mkdirp(`${W}/gx`); fs.symlinkSync(B(W, '/gx/g', FF, '.jsonl'), `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-ffdir', (W, home) => { mkdirp(home); fs.mkdirSync(B(W, '/', FF, 'gx')); const t = B(W, '/', FF, 'gx/glob.jsonl'); w(t); fs.symlinkSync(t, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-deep', (W, home) => { mkdirp(home); const dir = deepFile(`${W}/gdp`, 3000, 2000, 'glob.jsonl'); fs.symlinkSync(`${dir}/glob.jsonl`, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-link-neardeep', (W, home) => { mkdirp(home); const dir = deepFile(`${W}/gdp`, 2000, 1800, 'glob.jsonl'); fs.symlinkSync(`${dir}/glob.jsonl`, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
  ['g-chain41', (W, home) => { mkdirp(home); w(`${home}/end.jsonl`); let prev = 'end.jsonl'; for (let i = 1; i < 41; i++) { fs.symlinkSync(prev, `${home}/h${i}`); prev = `h${i}`; } fs.symlinkSync(prev, `${home}/memory.jsonl`); return `${home}/memory.jsonl`; }, true],
];

/** The two ledger strings differ and neither directory can be resolved, so they are different entries: the layer stays and row 4
 *  excludes it. These shapes spell G differently from the project ledger, and below a folder whose name is not UTF-8 the
 *  resolver answers `unresolvable` for both directories. */
const GSPELLED_DIFFERENTLY = ['g-trailing-slash', 'g-noise-spelled'];
const differentEntriesByRule = (shape: string, variant: string): boolean => GSPELLED_DIFFERENTLY.includes(shape) && variant === 'hp-under-ffdir-link';

describe('home-as-project worlds: 16 global-ledger shapes x 3 spellings of the directory that holds the home (48 worlds)', () => {
  for (const [shape, build, isLink] of GSHAPES) {
    for (const variant of ['plain', 'hp-is-a-link', 'hp-under-ffdir-link'] as const) {
      const unresolvable = differentEntriesByRule(shape, variant);
      const answer = isLink ? 'the global ledger is a link, so every start inside hp keeps its layer'
        : unresolvable ? 'the two strings differ and neither directory can be resolved, so the layer stays and row 4 excludes it'
        : 'the memory path is the global ledger entry, so there is no layer';
      it(`${shape}/${variant}: ${answer}`, () => {
        const W = `${d}/w${++n}`; fs.mkdirSync(W);
        let hp = `${W}/hp`;
        if (variant === 'plain') mkdirp(hp);
        else if (variant === 'hp-is-a-link') { mkdirp(`${W}/hp-real`); fs.symlinkSync(`${W}/hp-real`, hp); }
        else { fs.mkdirSync(B(W, '/', FF, 'par')); fs.mkdirSync(B(W, '/', FF, 'par/hp')); fs.symlinkSync(B(W, '/', FF, 'par'), `${W}/pl`); hp = `${W}/pl/hp`; }
        const G = build(W, `${hp}/.helix`);
        try { mkdirp(`${hp}/sub/deeper`); } catch { /* the folder of a missing home is not buildable in one shape */ }
        const at = (cwd: string, userHome: string) => resolveProjectLayer({ cwd, userHome, globalLedger: G });
        const layers = [at(hp, hp), at(`${hp}/sub`, hp), at(hp, W), at(`${hp}/sub/deeper`, W), at(`${hp}/`, hp)];
        if (!isLink && !unresolvable) {
          expect(layers).toEqual([undefined, undefined, undefined, undefined, undefined]);
          expect(isGlobalLedgerEntry(projectLedgerPath(hp), G)).toBe(true);
        } else {
          // a start in hp finds hp's own .helix (origin cwd); a start below hp with hp as the user home never walks to hp; a start
          // below hp with a user home above it walks up to hp (origin ancestor)
          expect(layers.map((l) => l?.origin)).toEqual(['cwd', undefined, 'cwd', 'ancestor', 'cwd']);
          expect(isGlobalLedgerEntry(projectLedgerPath(hp), G)).toBe(false);
          if (unresolvable) expect(judgeProjectLayer({ ...layers[0]!, home: `${hp}/.helix`, globalLedger: G })).toMatchObject({ state: 'aliased', row: '4', cause: 'unresolvable' });
        }
      });
    }
  }
});
