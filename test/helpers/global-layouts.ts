// Third fix batch B1, tasks B6 and B8 (design 4.7): the layouts of the global ledger's path the tests share.
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, renameSync, realpathSync, writeFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, type MemoryStoreOptions } from '../../src/memory/store.js';

export const FF = Buffer.from([0xff]);
const bytes = (...parts: Array<string | Buffer>): Buffer => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
const NOW = '2026-11-01T00:00:00.000Z';

export type GlobalLayoutName =
  | 'plain' | 'link-to-file' | 'dangling-target-dir-present' | 'plain-missing-dir' | 'symlinked-ancestor-first-run'
  | 'nonutf8-link-body' | 'nonutf8-dir-link' | 'chain-41' | 'loop'
  | 'dangling-target-dir-missing' | 'below-dangling-dir-link' | 'below-dangling-dir-link-dotdot';

export interface GlobalLayout {
  readonly name: GlobalLayoutName;
  /** 'writable' (resolved), 'unresolvable' (D3) or 'target-directory-missing' (FN-25, a directory link above the file included). */
  readonly cls: 'writable' | 'unresolvable' | 'target-directory-missing';
  readonly base: string;
  readonly home: string;
  /** The path Helix is given: HELIX_LEDGER, or <home>/memory.jsonl. */
  readonly ledger: string;
  /** The ids of the rows a read through `ledger` as given shows. */
  readonly ids: readonly string[];
  /** Where those rows physically are (a Buffer when the name is not UTF-8), or null. */
  readonly kernelFile: string | Buffer | null;
  store(sessionId?: string, extra?: Partial<MemoryStoreOptions>): MemoryStore;
  /** Makes the path resolvable again (nonutf8-dir-link, below-dangling-dir-link). */
  repair(): void;
}

const made: string[] = [];
export function cleanupLayouts(): void { for (const b of made.splice(0)) rmSync(b, { recursive: true, force: true }); }

/** Two rows, or (dirty) six facts of which five are superseded: eleven physical rows, six live. */
function seed(home: string, ledger: string, dirty: boolean): string[] {
  let n = 0;
  const s = new MemoryStore(ledger, { home, sessionId: 'seed', now: () => NOW, genId: () => `g_${++n}` });
  if (!dirty) return [s.commit({ content: 'alpha deploy fact', source: 'user' }).id, s.commit({ content: 'beta deploy fact', source: 'user' }).id];
  const first: string[] = [];
  for (let i = 0; i < 6; i++) first.push(s.commit({ content: `fact ${i} deploy timeout`, source: 'user' }).id);
  const live = [first[5]!];
  for (let i = 0; i < 5; i++) live.push(s.commit({ content: `fact ${i} updated deploy timeout`, source: 'user', supersedes: first[i]! }).id);
  return live;
}

export function buildGlobalLayout(name: GlobalLayoutName, opts: { seeded?: boolean; dirty?: boolean } = {}): GlobalLayout {
  const seeded = opts.seeded ?? true;
  const dirty = opts.dirty ?? false;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gl-')));
  made.push(base);
  let home = join(base, 'home');
  let ledger = join(home, 'memory.jsonl');
  let ids: string[] = [];
  let kernelFile: string | Buffer | null = null;
  let cls: GlobalLayout['cls'] = 'writable';
  let repair = (): void => { throw new Error(`layout ${name} cannot be repaired by renaming`); };
  if (name !== 'symlinked-ancestor-first-run') mkdirSync(home, { mode: 0o700 });
  switch (name) {
    case 'plain':
      if (seeded) ids = seed(home, ledger, dirty);
      kernelFile = ledger;
      break;
    case 'link-to-file': {
      mkdirSync(join(base, 't'));
      const target = join(base, 't', 'real.jsonl');
      if (seeded) ids = seed(home, target, dirty);
      symlinkSync(target, ledger);
      kernelFile = target;
      break;
    }
    case 'dangling-target-dir-present':
      mkdirSync(join(base, 't'));
      symlinkSync(join(base, 't', 'real.jsonl'), ledger);
      kernelFile = join(base, 't', 'real.jsonl');
      break;
    case 'plain-missing-dir':
      ledger = join(base, 'nodir', 'sub', 'g.jsonl');
      break;
    case 'symlinked-ancestor-first-run':
      mkdirSync(join(base, 'real'));
      symlinkSync(join(base, 'real'), join(base, 'lnk'));
      home = join(base, 'lnk', 'home');
      ledger = join(home, 'memory.jsonl');
      break;
    case 'nonutf8-link-body': {
      cls = 'unresolvable';
      mkdirSync(join(base, 't'));
      const target = bytes(base, '/t/re', FF, 'l.jsonl');
      const staging = join(base, 't', 'stage.jsonl');
      if (seeded) { ids = seed(home, staging, dirty); renameSync(staging, target); } else writeFileSync(target, '');
      symlinkSync(target, ledger);
      kernelFile = target;
      break;
    }
    case 'nonutf8-dir-link': {
      cls = 'unresolvable';
      const odd = bytes(base, '/', FF, 'dir');
      mkdirSync(odd);
      const staging = join(base, 'stage.jsonl');
      if (seeded) { ids = seed(home, staging, dirty); renameSync(staging, bytes(odd, '/memory.jsonl')); }
      symlinkSync(odd, join(base, 'gl'));
      ledger = join(base, 'gl', 'memory.jsonl');
      kernelFile = bytes(odd, '/memory.jsonl');
      repair = () => {
        const ok = join(base, 'okdir');
        renameSync(odd, ok);
        unlinkSync(join(base, 'gl'));
        symlinkSync(ok, join(base, 'gl'));
        kernelFile = join(ok, 'memory.jsonl');
      };
      break;
    }
    case 'chain-41': {
      cls = 'unresolvable';
      mkdirSync(join(base, 'c'));
      let prev = join(base, 'c', 'end.jsonl');
      writeFileSync(prev, '');
      for (let i = 41; i >= 1; i--) { const l = join(base, 'c', `l${i}`); symlinkSync(prev, l); prev = l; }
      symlinkSync(prev, ledger);
      break;
    }
    case 'loop':
      cls = 'unresolvable';
      symlinkSync(join(base, 'loopb'), ledger);
      symlinkSync(ledger, join(base, 'loopb'));
      break;
    case 'dangling-target-dir-missing':
      cls = 'target-directory-missing';
      symlinkSync(join(base, 'nodir', 'real.jsonl'), ledger);
      break;
    case 'below-dangling-dir-link':
      cls = 'target-directory-missing';
      symlinkSync(join(base, 'gone'), join(base, 'ddl'));
      ledger = join(base, 'ddl', 'memory.jsonl');
      repair = () => { mkdirSync(join(base, 'gone')); };
      break;
    case 'below-dangling-dir-link-dotdot':
      // The kernel reads `live/..` as `other/`, so the file is below the dangling folder link `other/dl`; folded as text
      // the same string names `<base>/dl`, which does not exist. Built by concatenation: path.join would fold `live/..`.
      cls = 'target-directory-missing';
      mkdirSync(join(base, 'other', 'dir'), { recursive: true });
      symlinkSync(join(base, 'other', 'dir'), join(base, 'live'));
      symlinkSync(join(base, 'gone'), join(base, 'other', 'dl'));
      ledger = `${base}/live/../dl/memory.jsonl`;
      repair = () => { mkdirSync(join(base, 'gone')); };
      break;
  }
  const layout: GlobalLayout = {
    name, cls, base, home, ledger, ids, get kernelFile() { return kernelFile; },
    store: (sessionId = 's', extra = {}) => {
      let k = 100;
      return new MemoryStore(ledger, { home, sessionId, now: () => NOW, genId: () => `n_${++k}`, ...extra });
    },
    repair: () => repair(),
  };
  return layout;
}

/** Every entry below `root` (names as bytes, shown latin1): kind, mode and, for a file, its size. Links are not followed.
 *  Two snapshots that are equal mean nothing was created, removed or re-moded in between. */
export function snapshotTree(root: string | Buffer): string[] {
  const out: string[] = [];
  const walk = (dir: Buffer, rel: string): void => {
    const names = (readdirSync(dir, { encoding: 'buffer' }) as unknown as Buffer[]).sort(Buffer.compare);
    for (const name of names) {
      const p = Buffer.concat([dir, Buffer.from('/'), name]);
      const st = lstatSync(p);
      const label = `${rel}/${name.toString('latin1')}`;
      out.push(`${label}|${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'}|${(st.mode & 0o777).toString(8)}|${st.isFile() ? st.size : 0}`);
      if (st.isDirectory()) walk(p, label);
    }
  };
  walk(Buffer.from(root), '');
  return out;
}
