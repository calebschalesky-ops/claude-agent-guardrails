#!/usr/bin/env node
// PreToolUse hook: confine each named subagent to its own files. See lib/territory.mjs.
import { loadConfig } from "../lib/config.mjs";
import { decideTerritory, WRITE_TOOLS, SHELL_TOOLS } from "../lib/territory.mjs";
import { readStdin, logTo, emit } from "../lib/io.mjs";

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.exit(0); // caller unknown, so fail open
}

const agent = String(input.agent_type || "").toLowerCase();
if (!agent) process.exit(0); // main session: never governed

let cfg;
try {
  cfg = loadConfig(input.cwd);
} catch (err) {
  // A broken config means no subagent's writes can be proven in scope. Reads still pass.
  const tool = String(input.tool_name || "");
  if (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) {
    logTo(null)({ agent, tool, decision: "deny", why: "config-error", error: String(err) });
    emit("deny", `Territory: the guardrails config could not be read (${String(err)}), so no subagent write can be verified. Fix the config.`);
  }
  process.exit(0);
}

const d = decideTerritory(input, cfg);
if (!d) process.exit(0);

const log = logTo(cfg.log);
log({ hook: "territory", agent, tool: input.tool_name, decision: d.decision, why: d.why, target: d.target,
  command: d.why === "shell-write" ? String(input.tool_input?.command || "").slice(0, 400) : undefined });
if (d.decision === "deny") emit("deny", d.reason);
