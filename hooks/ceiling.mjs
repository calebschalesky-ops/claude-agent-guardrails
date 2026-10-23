#!/usr/bin/env node
// PreToolUse hook: outward actions ask a human; protected deletes and force pushes are denied.
// See lib/ceiling.mjs. Fails open on its own errors.
import { loadConfig, buildConfig } from "../lib/config.mjs";
import { decideCeiling } from "../lib/ceiling.mjs";
import { readStdin, logTo, emit } from "../lib/io.mjs";

const raw = await readStdin();
try {
  const input = JSON.parse(raw || "{}");
  const cfg = loadConfig(input.cwd) || buildConfig({}, process.cwd());
  const d = decideCeiling(input, cfg);
  if (d) {
    logTo(cfg.log)({ hook: "ceiling", agent: input.agent_type || "main", tool: input.tool_name,
      decision: d.decision, why: d.why, what: d.what, mode: d.mode ?? undefined });
    emit(d.decision, d.reason);
  }
} catch (err) {
  logTo(null)({ hook: "ceiling", error: String(err) }); // fail open
}
