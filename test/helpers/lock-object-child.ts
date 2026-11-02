// Child of test/memory/lock-objects.test.ts (never a *.test.ts). Bundled by bundleCli and run under plain node
// with a hard timeout by the test. usage: <mode> <ledger> <maxWaitMs>
//   acquire | acquire-probe-throws -> withFileLock(ledger, () => 'ACQUIRED', { maxWaitMs })
//   wait    | wait-probe-throws    -> awaitLiveHolder(ledger, { maxWaitMs })
// The *-probe-throws modes inject a liveness probe whose kill0 throws. Prints ONE JSON line.
import { performance } from 'node:perf_hooks';
import * as lock from '../../src/memory/lock.js';
import { realProbe, type LivenessProbe } from '../../src/memory/lock-liveness.js';

const [mode, ledger, ms] = process.argv.slice(2) as [string, string, string];
const probe: LivenessProbe = mode.endsWith('-probe-throws')
  ? { ...realProbe, kill0() { throw new Error('injected liveness failure'); } }
  : realProbe;
const t0 = performance.now();
const done = (o: { outcome: string; message?: string; foreign?: boolean }): void => {
  process.stdout.write(JSON.stringify({ ms: Math.round(performance.now() - t0), message: '', foreign: false, ...o }) + '\n');
};
try {
  if (mode.startsWith('acquire')) done({ outcome: lock.withFileLock(ledger, () => 'ACQUIRED', { maxWaitMs: Number(ms), probe }) });
  else done({ outcome: lock.awaitLiveHolder(ledger, { maxWaitMs: Number(ms), probe }) });
} catch (e) {
  done({ outcome: 'THREW', message: (e as Error).message, foreign: lock.isLockForeignObjectError?.(e) === true });
}
