// src/hooks/session-end.ts
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";

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

// src/memory/home-permissions.ts
import { lstatSync, chmodSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
function ensureHelixDir(dir) {
  if (process.platform === "win32") {
    mkdirSync(dir, { recursive: true });
    return;
  }
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    st = null;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) throw new Error(`refusing to use ${dir}: it is a symlink, not a directory Helix owns`);
    if (!st.isDirectory()) throw new Error(`refusing to use ${dir}: it exists and is not a directory`);
    const uid = process.getuid?.();
    if (uid !== void 0 && st.uid !== uid) {
      throw new Error(`refusing to use ${dir}: it is owned by uid ${st.uid}, not by this user (${uid})`);
    }
    if ((st.mode & 63) !== 0) chmodSync(dir, 448);
    return;
  }
  const parent = dirname(dir);
  if (!existsSync(parent)) {
    throw new Error(`refusing to create ${dir}: its parent ${parent} does not exist (Helix creates one directory, never a chain)`);
  }
  try {
    mkdirSync(dir, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    ensureHelixDir(dir);
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
    const home = process.env.HELIX_HOME ?? join2(homedir(), ".helix");
    const path = process.env.HELIX_SESSIONS ?? join2(home, "sessions.jsonl");
    ensureHelixDir(dirname2(path));
    appendFileSync(path, JSON.stringify(record) + "\n", { mode: 384 });
  }
} catch {
}
