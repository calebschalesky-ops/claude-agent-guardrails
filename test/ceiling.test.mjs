import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../lib/config.mjs";
import { decideCeiling } from "../lib/ceiling.mjs";

const ROOT = path.join(os.tmpdir(), "ceiling-fixture");
const VAULT = path.join(ROOT, "vault");
const fwd = (s) => s.replace(/\\/g, "/");

const cfg = buildConfig({
  ceiling: {
    protectedPaths: ["vault/"],
    deny: { submit_order: "placing an order" },
    ask: { publish_post: "publishing a post" },
    denyCommands: [["\\bnpm\\s+publish\\b", "publishing to npm"]],
  },
}, ROOT);

const run = (tool, tool_input, extra = {}) => decideCeiling({ tool_name: tool, tool_input, cwd: ROOT, ...extra }, cfg);
const bash = (command, extra) => run("Bash", { command }, extra)?.decision ?? null;

// --- deletes into protected folders ------------------------------------------------
test("recursive delete inside a protected folder is denied", () => {
  assert.match(run("Bash", { command: `rm -rf "${fwd(VAULT)}/notes"` }).what, /recursive/);
});
test("single-file delete inside a protected folder is denied", () => {
  assert.match(run("Bash", { command: `rm "${fwd(VAULT)}/a.md"` }).what, /file inside/);
});
test("deletes elsewhere are not this hook's business", () => {
  assert.equal(bash("rm -rf /tmp/build-cache"), null);
  assert.equal(bash("rm -f scratch/out.png"), null);
});
test("relative deletes resolve against the session cwd", () => {
  assert.equal(bash("rm -rf vault/notes"), "deny");
  assert.equal(bash("rm -rf vault/notes", { cwd: path.join(ROOT, "elsewhere") }), null);
});
test("cd before a delete is tracked", () => {
  assert.equal(bash(`cd "${fwd(VAULT)}" && rm -rf old`), "deny");
  assert.equal(bash(`cd /tmp && rm -rf old`), null);
});
test("variables set earlier in the command are expanded", () => {
  assert.equal(bash(`DST="${fwd(VAULT)}"; rm -rf "$DST/x"`), "deny");
  assert.equal(run("PowerShell", { command: `$d = "${VAULT}"; Remove-Item "$d\\x" -Recurse` })?.decision, "deny");
});
test("a vault path inside a heredoc body is prose, not a target", () => {
  const command = `cat > notes.md <<'EOF'\nnever run rm -rf ${fwd(VAULT)}\nEOF`;
  assert.equal(bash(command), null);
});
test("redirections are not read as delete targets", () => {
  assert.equal(bash("rmdir empty 2>/dev/null"), null);
});
test("PowerShell and cmd deletes are understood", () => {
  assert.equal(run("PowerShell", { command: `Remove-Item -Recurse "${VAULT}\\x"` })?.decision, "deny");
  assert.equal(bash(`rd /s /q "${VAULT}\\x"`), "deny");
});
test("traversal into a protected folder is caught", () => {
  assert.equal(bash(`rm -rf "${fwd(ROOT)}/other/../vault/x"`), "deny");
});

// --- git and custom commands -----------------------------------------------------------
test("force push is denied; a normal push is not", () => {
  assert.equal(bash("git push --force origin main"), "deny");
  assert.equal(bash("git push -f origin main"), "deny");
  assert.equal(bash("git push origin main"), null);
});
test("a force push quoted in a heredoc is prose", () => {
  assert.equal(bash("cat > README.md <<EOF\nnever git push --force\nEOF"), null);
});
test("configured command patterns are denied", () => {
  assert.equal(run("Bash", { command: "npm publish --access public" }).what, "publishing to npm");
});
test("force-push denial can be turned off", () => {
  const loose = buildConfig({ ceiling: { denyForcePush: false } }, ROOT);
  assert.equal(decideCeiling({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: ROOT }, loose), null);
});

// --- outward actions --------------------------------------------------------------------
test("sending a message asks, whatever the server prefix", () => {
  const d = run("mcp__ad83146f-gmail__send_message", { to: "a@b.com" });
  assert.equal(d.decision, "ask");
  assert.equal(d.what, "sending a message");
});
test("in bypassPermissions an ask is escalated to deny", () => {
  const d = run("mcp__x__send_message", { to: "a@b.com" }, { permission_mode: "bypassPermissions" });
  assert.equal(d.decision, "deny");
  assert.equal(d.why, "ask-escalated");
});
test("other permission modes still ask", () => {
  for (const permission_mode of ["default", "acceptEdits", "plan"]) {
    assert.equal(run("mcp__x__create_event", {}, { permission_mode }).decision, "ask", permission_mode);
  }
});
test("a message to a local Claude session is not a message to a person", () => {
  assert.equal(run("mcp__ccd_session_mgmt__send_message", { session_id: "local_1a2b3c" }), null);
  assert.equal(run("SendMessage", { to: "researcher" }), null);
});
test("the session exemption cannot be used to reach a person", () => {
  assert.equal(run("mcp__ccd_session_mgmt__send_message", { session_id: "bob@example.com" }).decision, "ask");
  assert.equal(run("mcp__ccd_session_mgmt__send_message", { session_id: "+1 555 123 4567" }).decision, "ask");
});
test("configured ask and deny tools apply", () => {
  assert.equal(run("mcp__social__publish_post", {}).decision, "ask");
  assert.equal(run("mcp__broker__submit_order", {}).decision, "deny");
});
test("replaceDefaultAsk drops the built-in list", () => {
  const only = buildConfig({ ceiling: { replaceDefaultAsk: true, ask: { publish_post: "publishing" } } }, ROOT);
  assert.equal(decideCeiling({ tool_name: "mcp__x__send_message", tool_input: {} }, only), null);
});
test("ordinary tools pass untouched", () => {
  for (const t of ["Read", "Write", "Edit", "Grep", "mcp__x__search_threads"]) assert.equal(run(t, {}), null, t);
});
test("subagents are held to the same ceiling", () => {
  assert.equal(run("mcp__x__send_message", {}, { agent_type: "researcher" }).decision, "ask");
});
