// src/hooks/session-end.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/hooks/session-record.ts
function buildSessionEndRecord(stdinText, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  try {
    const j = JSON.parse(stdinText);
    if (j === null || typeof j !== "object") return null;
    const sessionId = typeof j.session_id === "string" && j.session_id !== "" ? j.session_id : "unknown";
    const reasonRaw = j.reason ?? j.end_reason;
    const reason = typeof reasonRaw === "string" && reasonRaw !== "" ? reasonRaw : "unknown";
    return { kind: "session-end", sessionId, reason, ts: now() };
  } catch {
    return null;
  }
}

// src/hooks/session-end.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
try {
  const record = buildSessionEndRecord(await readStdin());
  if (record) {
    const home = process.env.HELIX_HOME ?? join(homedir(), ".helix");
    const path = process.env.HELIX_SESSIONS ?? join(home, "sessions.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  }
} catch {
}
process.exit(0);
