import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildConfig, HOOKS_DIR } from "../lib/config.mjs";
import { decideTerritory } from "../lib/territory.mjs";

const WIN = process.platform === "win32";
const ROOT = path.join(os.tmpdir(), "guardrails-fixture");
const CFG_FILE = path.join(ROOT, ".claude", "guardrails.json");
const p = (...xs) => path.join(ROOT, ...xs);

const cfg = buildConfig({
  territory: {
    agents: {
      writer: {
        label: "Writer",
        note: "Writes docs only.",
        allow: ["src/CHANGELOG.md", "docs/locked/index.md"],
        allowPrefixes: ["docs/"],
        deny: ["docs/STYLE.md", "docs/both.md"],
        denyPrefixes: ["docs/locked/"],
        shell: "none",
      },
      auditor: {
        label: "Auditor",
        allowPrefixes: ["audit/"],
        deny: ["src/gate.py", "audit/both.md"],
        denyPrefixes: ["config/"],
        allow: ["audit/both.md"],
        shell: "guarded",
        denyShellPatterns: [["\\btaskkill\\b", "taskkill"]],
      },
      builder: { label: "Builder", allowPrefixes: ["src/"], shell: "full" },
    },
  },
}, ROOT, CFG_FILE, ROOT);

const call = (agent, tool, tool_input, extra = {}) =>
  decideTerritory({ agent_type: agent, tool_name: tool, tool_input, cwd: ROOT, ...extra }, cfg);
const verdict = (...a) => call(...a)?.decision ?? null;

// --- who is governed ---------------------------------------------------------
test("main session (no agent_type) is never governed", () => {
  assert.equal(decideTerritory({ tool_name: "Write", tool_input: { file_path: "/etc/x" }, cwd: ROOT }, cfg), null);
});
test("an agent not in the config is never governed", () => {
  assert.equal(verdict("explore", "Write", { file_path: p("anything.md") }), null);
});
test("agent names match case-insensitively", () => {
  assert.equal(verdict("WRITER", "Write", { file_path: p("src", "app.ts") }), "deny");
});

// --- the write tools -----------------------------------------------------------
test("write inside an allowed prefix passes, including new files", () => {
  assert.equal(verdict("writer", "Write", { file_path: p("docs", "new", "page.md") }), "pass");
});
test("exact allowed file passes", () => {
  assert.equal(verdict("writer", "Edit", { file_path: p("src", "CHANGELOG.md") }), "pass");
});
test("anything else is out of scope", () => {
  const d = call("writer", "Write", { file_path: p("src", "app.ts") });
  assert.equal(d.decision, "deny");
  assert.equal(d.why, "out-of-scope");
  assert.match(d.reason, /Allowed:/);
});
test("relative paths resolve against the session cwd", () => {
  assert.equal(verdict("writer", "Write", { file_path: "docs/rel.md" }), "pass");
  assert.equal(verdict("writer", "Write", { file_path: "src/rel.ts" }), "deny");
});
test("traversal cannot escape the comparison", () => {
  assert.equal(verdict("writer", "Write", { file_path: p("docs", "..", "src", "app.ts") }), "deny");
});
test("a sibling folder sharing a name prefix is not inside it", () => {
  assert.equal(verdict("writer", "Write", { file_path: p("docs-old", "x.md") }), "deny");
});
test("MultiEdit and NotebookEdit are checked too", () => {
  assert.equal(verdict("writer", "MultiEdit", { file_path: p("src", "a.ts") }), "deny");
  assert.equal(verdict("writer", "NotebookEdit", { notebook_path: p("src", "a.ipynb") }), "deny");
  assert.equal(verdict("writer", "NotebookEdit", { notebook_path: p("docs", "a.ipynb") }), "pass");
});
test("a write tool with no target is denied, not assumed safe", () => {
  assert.equal(call("writer", "Write", { content: "x" }).why, "no-target");
});
test("read-only tools pass untouched", () => {
  assert.equal(verdict("writer", "Read", { file_path: p("src", "secret.ts") }), null);
  assert.equal(verdict("writer", "Grep", { pattern: "x" }), null);
});

// --- resolution order ----------------------------------------------------------
test("an exact deny inside an allowed prefix is sealed", () => {
  assert.equal(call("writer", "Edit", { file_path: p("docs", "STYLE.md") }).why, "sealed");
});
test("a sealed folder inside an allowed prefix is sealed", () => {
  assert.equal(call("writer", "Write", { file_path: p("docs", "locked", "a.md") }).why, "sealed-dir");
});
test("an exact allow beats a sealed folder around it", () => {
  assert.equal(verdict("writer", "Edit", { file_path: p("docs", "locked", "index.md") }), "pass");
});
test("an exact deny beats an exact allow", () => {
  assert.equal(call("auditor", "Edit", { file_path: p("audit", "both.md") }).why, "sealed");
});

// --- no agent rewrites its own fence --------------------------------------------
test("the config file is sealed for every scoped agent", () => {
  assert.equal(call("builder", "Write", { file_path: CFG_FILE }).why, "sealed");
});
test("the hooks folder is sealed for every scoped agent", () => {
  assert.equal(call("builder", "Edit", { file_path: path.join(HOOKS_DIR, "hooks", "territory.mjs") }).why, "sealed-dir");
});
test("Claude Code settings files are sealed", () => {
  assert.equal(verdict("builder", "Write", { file_path: p(".claude", "settings.json") }), "deny");
  assert.equal(verdict("builder", "Write", { file_path: path.join(os.homedir(), ".claude", "settings.json") }), "deny");
});

// --- MCP ---------------------------------------------------------------------
test("MCP write tools are denied by suffix, whatever the server prefix", () => {
  assert.equal(call("writer", "mcp__4f1e-server__create_file", { path: "x" }).why, "mcp-write");
  assert.equal(verdict("writer", "mcp__other__read_file", { path: "x" }), null);
});

// --- shell postures -----------------------------------------------------------
test('shell "none" denies Bash and PowerShell outright', () => {
  assert.equal(call("writer", "Bash", { command: "ls" }).why, "shell");
  assert.equal(call("writer", "PowerShell", { command: "Get-ChildItem" }).why, "shell");
});
test('shell "full" is not this hook\'s business', () => {
  assert.equal(verdict("builder", "Bash", { command: "rm -rf build" }), null);
});
test("guarded: reading a sealed file as input passes", () => {
  assert.equal(verdict("auditor", "Bash", { command: "python src/gate.py --selftest > audit/out.txt" }), null);
  assert.equal(verdict("auditor", "Bash", { command: "cat src/gate.py | grep TODO" }), null);
});
test("guarded: redirecting into a sealed file is denied", () => {
  assert.equal(call("auditor", "Bash", { command: "echo x > src/gate.py" }).why, "shell-write");
  assert.equal(call("auditor", "Bash", { command: "echo x >> gate.py" }).why, "shell-write");
});
test("guarded: redirecting into a sealed folder is denied", () => {
  assert.equal(verdict("auditor", "Bash", { command: `echo x > ${p("config", "app.json")}` }), "deny");
});
test("guarded: write verbs naming a sealed file are denied", () => {
  assert.equal(verdict("auditor", "Bash", { command: "sed -i s/a/b/ src/gate.py" }), "deny");
  assert.equal(verdict("auditor", "Bash", { command: "cp /tmp/x src/gate.py" }), "deny");
  assert.equal(verdict("auditor", "PowerShell", { command: "Set-Content gate.py 'x'" }), "deny");
});
test("guarded: destructive commands are denied whatever they point at", () => {
  for (const command of ["rm -rf /tmp/scratch", "git push --force origin main", "git reset --hard HEAD~1", "git clean -fd", "Remove-Item x -Recurse"]) {
    assert.equal(verdict("auditor", "Bash", { command }), "deny", command);
  }
});
test("guarded: per-agent command patterns are denied", () => {
  assert.match(call("auditor", "Bash", { command: "taskkill /im game.exe" }).reason, /taskkill/);
});
test("guarded: ordinary commands still run", () => {
  for (const command of ["git status", "npm test", "ls -la audit", "python -m pytest -q"]) {
    assert.equal(verdict("auditor", "Bash", { command }), null, command);
  }
});

// --- path shapes -----------------------------------------------------------------
test("home-relative paths are understood", () => {
  assert.equal(verdict("writer", "Write", { file_path: "~/notes.md" }), "deny");
});
test("Windows-only: case and git-bash drive paths compare equal", { skip: !WIN }, () => {
  assert.equal(verdict("writer", "Write", { file_path: p("DOCS", "Page.MD") }), "pass");
  const gitBash = p("docs", "x.md").replace(/\\/g, "/").replace(/^([a-zA-Z]):/, (_, d) => `/${d.toLowerCase()}`);
  assert.equal(verdict("writer", "Write", { file_path: gitBash }), "pass");
});

// --- failure mode ----------------------------------------------------------------
test("a scoped agent fails CLOSED when the check itself throws", () => {
  const broken = { ...cfg, territory: { ...cfg.territory, agents: { writer: { ...cfg.territory.agents.writer, deny: null } } } };
  const d = decideTerritory({ agent_type: "writer", tool_name: "Write", tool_input: { file_path: p("docs", "a.md") }, cwd: ROOT }, broken);
  assert.equal(d.decision, "deny");
  assert.equal(d.why, "hook-error");
});
test("an invalid shell posture is rejected at load time", () => {
  assert.throws(() => buildConfig({ territory: { agents: { x: { shell: "sometimes" } } } }, ROOT), /shell must be/);
});
