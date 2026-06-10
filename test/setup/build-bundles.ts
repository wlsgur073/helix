import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** vitest globalSetup: bundle bin/ from current src before the suite runs. */
export default function buildBundles(): void {
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' });
}
