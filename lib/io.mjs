import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => resolve(raw));
  });
}

/** Every decision is appended as one JSON line, so a miss can be reconstructed later.
 *  $GUARDRAILS_LOG wins, so a test run never writes into the real audit log. */
export function logTo(cfgLog) {
  const file = process.env.GUARDRAILS_LOG || cfgLog || path.join(os.homedir(), ".claude", "guardrails.log");
  return (entry) => {
    try {
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    } catch { /* logging must never break a hook */ }
  };
}

/** Claude Code PreToolUse hook output. Only "deny" and "ask" are ever emitted:
 *  these hooks narrow permissions, they never grant them. */
export function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

/** MCP tool names carry a per-install prefix (mcp__<server>__tool) that can change when a
 *  connector is re-added, so tools are matched on the suffix after the last "__". */
export function toolSuffix(tool) {
  return tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
}
