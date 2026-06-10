// Free (no-quota) smoke: prove the Windows-safe launcher resolution + spawn path works.
// Run: npx tsx scripts/smoke-codex-spawn.ts
import { resolveCodexInvocation, checkCodexAvailable } from '../src/verify/codex.js';

const inv = await resolveCodexInvocation();
console.log('invocation:', JSON.stringify(inv));
const avail = await checkCodexAvailable(inv);
console.log('availability:', JSON.stringify(avail));
if (!avail.available) process.exit(1);
