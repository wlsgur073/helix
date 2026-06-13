import type { MemoryStore, CommitInput } from '../memory/store.js';
import type { HelixConfig } from '../config.js';
import type { Availability, CodexRunner } from '../verify/codex.js';
import { dualVerify } from '../verify/dual-verify.js';
import { datamark, frameOpen, frameClose, DATA_SEMANTICS, newNonce } from '../memory/content-frame.js';
import { appendAudit } from '../audit.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  // The MCP SDK's tool-result type carries an index signature for _meta/extras;
  // mirroring it keeps these results assignable to the SDK without importing its types.
  [key: string]: unknown;
}
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

export function handleCommit(store: MemoryStore, args: CommitInput): ToolResult {
  const rec = store.commit(args);
  return ok(`committed ${JSON.stringify({ id: rec.id, state: rec.state, classification: rec.classification })}`);
}

export function handleRecall(store: MemoryStore, args: { query: string; maxItems?: number }): ToolResult {
  const { items, framed } = store.recall(args.query, { maxItems: args.maxItems });
  const flags = items.filter((i) => i.needsReverify).map((i) => i.record.id);
  const note = flags.length ? `\n\n(needs re-verify before acting: ${flags.join(', ')})` : '';
  return ok(framed + note);
}

export function handleInspect(store: MemoryStore, _args: Record<string, never>): ToolResult {
  const rows = store.inspect().map((r) => `- ${r.id} [${r.state}] ${r.content}`);
  return ok(rows.length ? rows.join('\n') : '(memory is empty)');
}

export function handleErase(store: MemoryStore, args: { id: string }): ToolResult {
  store.erase(args.id);
  return ok(`erased ${args.id}`);
}

export interface DualVerifyHandlerDeps {
  config: HelixConfig;
  runner: CodexRunner;
  checkAvailable: () => Promise<Availability>;
  auditPath: string;
  now?: () => string;
  genNonce?: () => string; // injectable per-frame nonce (default crypto)
}

export async function handleDualVerify(
  args: { question: string; helixAnswer: string; stakes?: 'low' | 'medium' | 'high' },
  deps: DualVerifyHandlerDeps,
): Promise<ToolResult> {
  const ts = (deps.now ?? (() => new Date().toISOString()))();
  const result = await dualVerify(args, deps);
  appendAudit(deps.auditPath, {
    kind: 'dual-verify',
    ts,
    enabled: deps.config.dualVerify.enabled,
    spawned: result.attempted,
    mode: result.mode,
    verdict: result.agreement?.verdict,
    reason: result.reason,
  });
  if (!result.ran) {
    return ok(`dual-verify did not run: ${result.reason}. (No Codex answer — nothing fabricated.)`);
  }
  // Codex output is untrusted DATA: frame it with a per-call nonce delimiter + instruction
  // semantics + per-line datamarks so a forged marker cannot close the block early and inject
  // instructions back into the caller's context.
  const nonce = (deps.genNonce ?? newNonce)();
  if (result.mode === 'critique') {
    return ok([
      frameOpen('DUAL-VERIFY', nonce),
      DATA_SEMANTICS,
      'mode: critique',
      '--- EXTERNAL CODEX CRITIQUE (data) ---',
      datamark(result.critique ?? '', 'DATA| '),
      '--- end codex critique ---',
      frameClose(nonce),
    ].join('\n'));
  }
  const a = result.agreement!;
  return ok([
    frameOpen('DUAL-VERIFY', nonce),
    DATA_SEMANTICS,
    `verdict: ${a.verdict} (mode: ${result.mode})`,
    '--- EXTERNAL CODEX OUTPUT (data) ---',
    datamark(result.codexAnswer ?? '', 'DATA| '),
    '--- end codex output ---',
    a.agreements.length ? 'agreements:\n' + a.agreements.map((s) => datamark(s, 'DATA| ')).join('\n') : 'no shared claims',
    a.divergences.length ? 'divergences:\n' + a.divergences.map((d) => datamark(d, 'DATA| ')).join('\n') : 'no divergences',
    frameClose(nonce),
  ].join('\n'));
}
