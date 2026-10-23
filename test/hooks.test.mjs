// End to end: run the real hook scripts with JSON on stdin, the way Claude Code does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");
let dir, env;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-e2e-"));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "guardrails.json"), JSON.stringify({
    territory: { agents: { scribe: { allowPrefixes: ["notes/"], shell: "none" } } },
    ceiling: { protectedPaths: ["notes/"] },
  }));
  env = { ...process.env, GUARDRAILS_LOG: path.join(dir, "test.log"), GUARDRAILS_CONFIG: "" };
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function hook(name, payload, raw) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: raw ?? JSON.stringify({ cwd: dir, ...payload }), env, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test("territory: out-of-scope write by a scoped agent emits deny", () => {
  const out = hook("territory.mjs", { agent_type: "scribe", tool_name: "Write", tool_input: { file_path: path.join(dir, "src", "x.ts") } });
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");
});
test("territory: in-scope write emits nothing (never grants)", () => {
  assert.equal(hook("territory.mjs", { agent_type: "scribe", tool_name: "Write", tool_input: { file_path: path.join(dir, "notes", "a.md") } }), null);
});
test("territory: main session emits nothing", () => {
  assert.equal(hook("territory.mjs", { tool_name: "Write", tool_input: { file_path: path.join(dir, "src", "x.ts") } }), null);
});
test("territory: unparseable input fails open", () => {
  assert.equal(hook("territory.mjs", null, "not json"), null);
});
test("territory: a broken config denies subagent writes but not reads", () => {
  const cfg = path.join(dir, ".claude", "guardrails.json");
  const good = fs.readFileSync(cfg, "utf8");
  fs.writeFileSync(cfg, "{ broken");
  try {
    assert.equal(hook("territory.mjs", { agent_type: "anyone", tool_name: "Write", tool_input: { file_path: "x" } }).permissionDecision, "deny");
    assert.equal(hook("territory.mjs", { agent_type: "anyone", tool_name: "Read", tool_input: { file_path: "x" } }), null);
  } finally {
    fs.writeFileSync(cfg, good);
  }
});
test("ceiling: protected delete emits deny", () => {
  assert.equal(hook("ceiling.mjs", { tool_name: "Bash", tool_input: { command: "rm -rf notes" } }).permissionDecision, "deny");
});
test("ceiling: outward action emits ask, and deny under bypass", () => {
  assert.equal(hook("ceiling.mjs", { tool_name: "mcp__mail__send_message", tool_input: {} }).permissionDecision, "ask");
  assert.equal(hook("ceiling.mjs", { tool_name: "mcp__mail__send_message", tool_input: {}, permission_mode: "bypassPermissions" }).permissionDecision, "deny");
});
test("ceiling: unparseable input fails open", () => {
  assert.equal(hook("ceiling.mjs", null, "{"), null);
});
test("every decision is logged", () => {
  const lines = fs.readFileSync(env.GUARDRAILS_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines.some((l) => l.hook === "territory" && l.decision === "deny"));
  assert.ok(lines.some((l) => l.hook === "ceiling" && l.decision === "ask"));
});
