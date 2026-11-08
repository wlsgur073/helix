// Test child, bundled by test/helpers/bundle-cli.ts (B2a task A8). argv[2] = the site, argv[3] = the home directory; the
// file under test is named by the site. A FIFO at a home file blocks a plain open for good, so each case runs here, in a
// child the test can kill at a deadline. It reads the error MARKER by property (never imports the module that defines
// it), so it bundles and runs against a checkout where the sites still block: that is what lets the same test fail at
// the base commit by timing out instead of by a build error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit } from '../../src/audit.js';
import { appendCodexLog } from '../../src/codex-log.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { createMetricsSink, noopMetricsSink } from '../../src/metrics.js';
import { tryReadMaster } from '../../src/memory/ledger-mac.js';
import { globalScopeNonce } from '../../src/memory/ownership.js';
import { MemoryStore } from '../../src/memory/store.js';
import { planTransition, openTransition, readScopeWitness } from '../../src/memory/witness-store.js';
import { sha256Hex } from '../../src/memory/witness-core.js';
import { handleCodexStatus, handleErase, handleRecall } from '../../src/server/handlers.js';

const [site, home] = process.argv.slice(2) as [string, string];

const notRegular = (e: unknown): boolean =>
  (e as { notRegularHomeFile?: unknown } | null)?.notRegularHomeFile === true;

/** The text of a tool result (a handler's answer). */
const textOf = (r: unknown): string => (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('');

/** A store clock far in the future, so every ledger mtime is past the compaction grace window (store-auto-compaction.test.ts). */
const FUTURE = '2100-01-01T00:00:00.000Z';

/** 'ok' when `fn` returns, 'not-regular' when it throws the typed refusal, 'other:<class name>' otherwise (never a message or a path). */
function attempt(fn: () => unknown): string {
  try { fn(); return 'ok'; }
  catch (e) { return notRegular(e) ? 'not-regular' : `other:${(e as Error).name}`; }
}

let outcome: string;
let journal: boolean | undefined;

switch (site) {
  case 'key':
    outcome = attempt(() => tryReadMaster(home));
    break;
  case 'registry':
    outcome = globalScopeNonce(home) === null ? 'null' : 'nonce';
    break;
  case 'metrics':
    createMetricsSink(join(home, 'metrics.jsonl'), true).emitCompaction({
      scope: 'global', durationMs: 1, droppedRows: 0, reclaimedBytes: 0, droppedForgedVerifies: 0, ok: true, landed: true,
    });
    outcome = 'ok';
    break;
  case 'audit':
    outcome = attempt(() => appendAudit(join(home, 'audit.jsonl'), { kind: 'erase', ts: '2026-11-08T00:00:00.000Z', id: 'm_1', soft: true }));
    break;
  case 'codex-log':
    appendCodexLog(join(home, 'codex-log.jsonl'), { ts: '2026-11-08T00:00:00.000Z', kind: 'compare', outcome: 'skipped', reason: 'probe' });
    outcome = 'ok';
    break;
  case 'codex-status': {
    const res = await handleCodexStatus({
      inspect: async () => ({ cliFound: false, available: false, authMode: 'none' as const, reason: 'probe' }),
      resolveModel: async () => null,
      config: { ...DEFAULT_CONFIG, dualVerify: { ...DEFAULT_CONFIG.dualVerify, logContent: true } },
      codexLogPath: join(home, 'codex-log.jsonl'),
    });
    const text = (res as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('');
    outcome = `entries=${/\((\d+) entries\)/.exec(text)?.[1] ?? 'none'}`;
    break;
  }
  case 'witness-log': {
    const p = planTransition(home, '@global', 'erase');
    outcome = attempt(() => openTransition(home, '@global', {
      kind: 'erase', epoch: p.epoch, nonce: p.nonce, predecessor: p.predecessor, supersedes: p.supersedes,
      expected: { byteLength: 5, prefixHash: sha256Hex(Buffer.from('aaaaa')) }, tx: '2026-07-18T00:00:00.000Z',
    }));
    journal = readScopeWitness(home, '@global').journal !== null;
    break;
  }
  case 'erase-compact': {
    // Disposition 6 (fix pass 2026-11-08): the witness-log open through the handlers. Three facts are committed, two are erased
    // through the erase handler (soft: a tombstone each, no journal), then one recall through the recall handler runs the
    // auto-compaction, whose openTransition appends to witness-log.jsonl before it writes the journal. The outcome names what
    // the handlers answered, whether the compaction ran and how it ended, and whether the ledger bytes changed.
    let n = 0;
    const compactions: boolean[] = [];
    const ledger = join(home, 'memory.jsonl');
    const store = new MemoryStore(ledger, {
      home, sessionId: 'a8', now: () => FUTURE, genId: () => `m_${++n}`,
      metricsSink: { ...noopMetricsSink, emitCompaction: (c) => { compactions.push(c.ok); } },
      compaction: { auto: true, dirtyRatio: 0.5, minRows: 3, minDirtyBytes: 1, graceMs: 1000, maxBytes: 52_428_800 },
    });
    const ids = ['the blue cluster is the deploy target', 'the green cluster is the fallback', 'the red cluster is retired']
      .map((content) => store.commit({ content, source: 'user' }).id);
    const erased = ids.slice(1).map((id) => textOf(handleErase(store, { id }, { auditPath: join(home, 'audit.jsonl'), now: () => FUTURE })));
    const before = readFileSync(ledger);
    const recalled = handleRecall(store, { query: 'cluster' });
    const served = recalled.isError !== true && textOf(recalled).includes('the blue cluster is the deploy target');
    const compaction = compactions.length === 0 ? 'none' : compactions.every(Boolean) ? 'ok' : 'failed';
    outcome = erased.every((t) => t.startsWith('erased '))
      ? `${served ? 'served' : 'not-served'} compaction=${compaction} ledger=${readFileSync(ledger).equals(before) ? 'unchanged' : 'rewritten'}`
      : 'erase-refused';
    journal = readScopeWitness(home, '@global').journal !== null;
    break;
  }
  default:
    throw new Error(`home-open-child: unknown site ${site}`);
}

process.stdout.write(JSON.stringify({ outcome, journal }) + '\n');
