/* Territory: which FILES a named subagent may write.
 *
 * Claude Code's `tools:` allowlist decides which tools an agent holds, never which paths
 * it may write. An agent given Edit to maintain one file can reach every other file on
 * disk. This closes that gap one layer down, at PreToolUse.
 *
 * WHO IS CALLING. A subagent's tool call carries `agent_type`; a main-session call carries
 * none. So the hook only ever narrows a named subagent and is invisible to everything else.
 *
 * FAIL OPEN FOR STRANGERS, CLOSED FOR THE SCOPED. Anything this hook doesn't recognize
 * passes untouched: a hook that wedges every session gets deleted. Once a scoped agent is
 * positively identified, an error means "cannot prove this write is allowed", and the
 * answer is no. A scoped agent that fails open is the boundary quietly not existing.
 *
 * RESOLUTION ORDER. Exact beats prefix, deny beats allow at equal specificity:
 *   deny (exact) -> allow (exact) -> denyPrefixes -> allowPrefixes -> out of scope.
 * So an explicitly allowed file can sit inside a sealed folder, and nothing beats an
 * exact deny. The config file, the hooks folder and Claude Code's settings files are
 * added to every agent's deny lists, so no agent can rewrite its own fence. */

import { toAbs, under } from "./paths.mjs";
import { DESTRUCTIVE, WRITE_VERBS, redirectTargets } from "./shell.mjs";
import { toolSuffix } from "./io.mjs";

/** Tools that write a file, mapped to the input keys naming the target. */
export const WRITE_TOOLS = new Map([
  ["Write", ["file_path"]],
  ["Edit", ["file_path"]],
  ["MultiEdit", ["file_path"]],
  ["NotebookEdit", ["notebook_path", "file_path"]],
]);

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Returns a denial reason for a `shell: "guarded"` agent, or null to allow. */
export function shellVerdict(cmd, scope, cwd) {
  if (!cmd) return null;

  for (const [re, what] of DESTRUCTIVE) {
    if (re.test(cmd)) return `it runs ${what}, and ${scope.label} never deletes or discards anything`;
  }
  for (const [re, what] of scope.denyShellPatterns) {
    if (re.test(cmd)) return `it runs ${what}, which ${scope.label} may not do`;
  }

  const sealedNames = scope.deny.map((p) => p.slice(p.lastIndexOf("/") + 1));

  for (const t of redirectTargets(cmd)) {
    const abs = toAbs(t, cwd);
    const base = t.replace(/\\/g, "/").split("/").pop().toLowerCase();
    if (abs && scope.allow.includes(abs)) continue; // exact beats prefix here too
    if ((abs && scope.deny.includes(abs)) || sealedNames.includes(base)) {
      return `it redirects output into ${t}, which is a sealed file`;
    }
    if (abs && scope.denyPrefixes.some((p) => under(abs, p))) {
      return `it redirects output into ${t}, which is inside a sealed directory`;
    }
  }

  const lower = cmd.toLowerCase();
  const named = sealedNames.find((n) => n && lower.includes(n));
  if (named) {
    for (const [re, what] of WRITE_VERBS) {
      if (re.test(cmd)) return `it uses ${what} in a command naming the sealed file ${named}`;
    }
  }

  // Sealed directories matched as a path fragment, not a basename: "agents" or "docs" are
  // ordinary words, and a fragment is what appears in a command about to write into one.
  const flat = lower.replace(/\\/g, "/");
  const namedDir = scope.denyPrefixes.find((p) => flat.includes(p) || flat.includes(p.slice(p.indexOf("/") + 1)));
  if (namedDir) {
    for (const [re, what] of WRITE_VERBS) {
      if (re.test(cmd)) return `it uses ${what} in a command naming the sealed directory ${namedDir}`;
    }
  }
  return null;
}

/** Decide one PreToolUse call. Returns null (no opinion) or
 *  { decision: "pass" | "deny", why, reason?, target? }. "pass" is logged but never emitted:
 *  this hook narrows permissions and never grants them. */
export function decideTerritory(input, cfg) {
  const agentType = String(input.agent_type || "").toLowerCase();
  if (!agentType || !cfg) return null;
  const scope = cfg.territory.agents[agentType];
  if (!scope) return null; // main session, or an ungoverned agent

  try {
    const tool = String(input.tool_name || "");
    const args = input.tool_input || {};
    const cwd = input.cwd || process.cwd();
    const note = scope.note ? ` ${scope.note}` : "";

    if (SHELL_TOOLS.has(tool)) {
      if (scope.shell === "none") {
        return { decision: "deny", why: "shell",
          reason: `Territory: ${scope.label} has no shell. A shell defeats every path restriction under it, so it is denied even if the tools allowlist grants it.${note}` };
      }
      if (scope.shell === "guarded") {
        const why = shellVerdict(String(args.command || ""), scope, cwd);
        if (why) {
          return { decision: "deny", why: "shell-write",
            reason: `Territory: ${scope.label} may not run this command: ${why}.${note} The shell itself is allowed; changing what this agent doesn't own is not.` };
        }
      }
      return null;
    }

    if (cfg.territory.mcpWriteSuffixes.has(toolSuffix(tool))) {
      return { decision: "deny", why: "mcp-write",
        reason: `Territory: ${scope.label} may not write through ${tool}. Its writes are limited to specific file paths, which this tool bypasses.${note}` };
    }

    const keys = WRITE_TOOLS.get(tool);
    if (!keys) return null; // read-only or unrelated tool

    const rawTarget = keys.map((k) => args[k]).find((v) => v);
    if (!rawTarget) {
      return { decision: "deny", why: "no-target",
        reason: `Territory: ${scope.label} called ${tool} with no readable target path, so the write could not be checked. Denied rather than assumed safe.${note}` };
    }

    const abs = toAbs(rawTarget, cwd);

    if (scope.deny.includes(abs)) {
      return { decision: "deny", why: "sealed", target: abs,
        reason: `Territory: ${rawTarget} is SEALED for ${scope.label} and is never writable.${note} Say what should change and why; do not change it.` };
    }
    if (scope.allow.includes(abs)) return { decision: "pass", why: "allow", target: abs };

    const sealedDir = scope.denyPrefixes.find((p) => under(abs, p));
    if (sealedDir) {
      return { decision: "deny", why: "sealed-dir", target: abs,
        reason: `Territory: ${rawTarget} is inside ${sealedDir}, a SEALED directory for ${scope.label}.${note} Say what should change and why; do not change it.` };
    }
    if (scope.allowPrefixes.some((p) => under(abs, p))) return { decision: "pass", why: "allow-prefix", target: abs };

    const listing = [
      ...scope.allow.map((a) => `  - ${a}`),
      ...scope.allowPrefixes.map((a) => `  - ${a} (anything under)`),
    ].join("\n") || "  (none)";
    return { decision: "deny", why: "out-of-scope", target: abs,
      reason: `Territory: ${scope.label} may not write ${rawTarget}.${note}\nAllowed:\n${listing}\nIf the scope genuinely needs to change, a human changes the config.` };
  } catch (err) {
    return { decision: "deny", why: "hook-error",
      reason: `Territory: the scope check for ${scope.label} failed (${String(err)}), so this call could not be verified as in scope. Denied rather than passed through. This is a hook bug, not a scope violation.` };
  }
}
