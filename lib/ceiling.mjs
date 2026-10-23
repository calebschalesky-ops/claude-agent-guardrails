/* Ceiling: actions no session, main or sub, takes without a human.
 *
 * Two tiers:
 *   ASK  - outward actions a human can approve per instance (send a message, create a
 *          calendar event, share a file). Forced to prompt.
 *   DENY - deletes that land in a protected folder, force pushes, configured tools and
 *          command patterns.
 *
 * THE BYPASS HOLE. In bypassPermissions mode a hook's "ask" is auto-approved and nobody
 * sees the question. An ask tier that silently becomes "allow" is worse than none, so in
 * a silent mode every ASK item is escalated to DENY.
 *
 * Fails OPEN on its own errors: a hook that crashes every session gets deleted, and then
 * the ceiling is a promise again. Every decision is logged so a miss can be traced. */

import { toAbs, under } from "./paths.mjs";
import { deleteTargets, stripHeredocs } from "./shell.mjs";
import { toolSuffix } from "./io.mjs";

/** Messages to another local Claude session are not messages to a person. Matched by FULL
 *  tool name, so a connector's send_message (email, chat, SMS) can never use this. */
const SESSION_MESSAGE_TOOLS = new Map([
  ["mcp__ccd_session_mgmt__send_message", "session_id"],
  ["SendMessage", "to"],
]);

function isLocalSessionTarget(t) {
  if (typeof t !== "string") return false;
  const s = t.trim();
  if (!s || s.length > 300) return false;
  if (/[@:/]/.test(s)) return false;               // email, URL, server:resource
  if (/^\+?[\d\s().-]{7,}$/.test(s)) return false;  // phone number
  return /^[A-Za-z0-9_.\- [\]]+$/.test(s);
}

const SILENT_MODES = new Set(["bypasspermissions", "bypass"]);

/** The harness's permission mode. Several shapes are checked because the field name is not
 *  guaranteed across versions, and a wrong guess would silently reopen the bypass hole. */
export function permissionModeOf(input) {
  const cands = [
    input?.permission_mode, input?.permissionMode,
    input?.context?.permission_mode, input?.session?.permission_mode,
  ];
  for (const c of cands) if (typeof c === "string" && c) return c;
  return null;
}

/** Why a shell command is denied, or null. */
export function shellDenyReason(cmd, ceiling, cwd) {
  if (!cmd) return null;

  if (ceiling.protectedPaths.length) {
    for (const d of deleteTargets(cmd)) {
      const base = d.dir ? toAbs(d.dir, cwd) : cwd;
      const abs = toAbs(d.target, base);
      const hit = abs && ceiling.protectedPaths.find((p) => under(abs, p));
      if (hit) {
        return d.recursive
          ? `a recursive delete inside the protected folder ${hit}`
          : `a delete of a file inside the protected folder ${hit}`;
      }
    }
  }

  // Heredoc bodies are document text being written, not commands being run.
  const scanned = stripHeredocs(cmd);
  if (ceiling.denyForcePush && /\bgit\s+push\b[^|;\n]*(?:--force|\s-f(?:\s|$))/i.test(scanned)) {
    return "a force push";
  }
  for (const [re, what] of ceiling.denyCommands) {
    if (re.test(scanned)) return what;
  }
  return null;
}

/** Decide one PreToolUse call. Returns null (no opinion) or { decision: "ask" | "deny", ... }. */
export function decideCeiling(input, cfg) {
  if (!cfg) return null;
  const { ceiling } = cfg;
  const tool = String(input.tool_name || "");
  const args = input.tool_input || {};
  const cwd = toAbs(input.cwd || process.cwd());
  const suffix = toolSuffix(tool);

  if (tool === "Bash" || tool === "PowerShell") {
    const why = shellDenyReason(String(args.command || ""), ceiling, cwd);
    return why
      ? { decision: "deny", why: "shell", what: why,
          reason: `Ceiling: blocked ${why}. If this is genuinely intended, a human runs it.` }
      : null;
  }

  if (ceiling.deny.has(suffix)) {
    const what = ceiling.deny.get(suffix);
    return { decision: "deny", why: "deny-tool", what,
      reason: `Ceiling: ${what} is never done by an agent here. A human does it.` };
  }

  const field = SESSION_MESSAGE_TOOLS.get(tool);
  if (field && isLocalSessionTarget(args[field])) return null;

  const what = ceiling.ask.get(suffix);
  if (!what) return null;

  const mode = permissionModeOf(input);
  if (mode && SILENT_MODES.has(mode.toLowerCase())) {
    return { decision: "deny", why: "ask-escalated", what, mode,
      reason: `Ceiling: ${what} needs a human's per-instance approval, and this session is in ${mode} mode, where an "ask" is auto-approved and nobody sees it. Denied instead. Run it in a session that can prompt, or have a human do it.` };
  }
  return { decision: "ask", why: "ask", what, mode,
    reason: `Ceiling: ${what} needs your explicit approval for this one instance.` };
}
