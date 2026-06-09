import type { MemoryStore, CommitInput } from '../memory/store.js';

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

export function handleDualVerify(_store: MemoryStore, _args: { question: string }): ToolResult {
  // Phase 3 wires the real `codex exec` adapter. In Phase 2 this is an explicit stub.
  return ok('dual-verify is not available in this build (Phase 3 stub — no Codex call was made)');
}
