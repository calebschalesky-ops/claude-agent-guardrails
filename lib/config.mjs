import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toAbs, toPrefix } from "./paths.mjs";

/** The directory holding the hooks. Every scoped agent is denied writes here, so no
 *  agent can rewrite its own fence. */
export const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** First match wins: $GUARDRAILS_CONFIG, <project>/.claude/guardrails.json, ~/.claude/guardrails.json. */
export function findConfig(cwd) {
  const candidates = [
    process.env.GUARDRAILS_CONFIG,
    cwd && path.join(cwd, ".claude", "guardrails.json"),
    path.join(os.homedir(), ".claude", "guardrails.json"),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

/** Read and compile the config. Throws on a malformed file; callers decide whether that
 *  fails open or closed. Returns null when there is no config at all. */
export function loadConfig(cwd) {
  const file = findConfig(cwd);
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  const root = raw.root
    ? toAbs(raw.root, dir)
    : path.basename(dir) === ".claude" ? path.dirname(dir) : dir;
  return buildConfig(raw, root, file, cwd);
}

const DEFAULT_MCP_WRITE_SUFFIXES = [
  "create_file", "update_file", "copy_file", "trash_file", "share_file",
  "write_file", "edit_file", "move_file", "delete_file", "write_note", "edit_note",
];

const DEFAULT_ASK = {
  send_message: "sending a message",
  reply: "sending a reply",
  forward: "forwarding a message",
  create_event: "creating a calendar event",
  update_event: "changing a calendar event",
  delete_event: "deleting a calendar event",
  respond_to_event: "responding to a calendar invitation",
  share_file: "sharing a file with someone",
  trash_file: "trashing a file",
  trash_message: "trashing an email",
  trash_thread: "trashing an email thread",
  mark_message_spam: "marking mail as spam",
  mark_thread_spam: "marking a thread as spam",
  delete_label: "deleting a mail label",
};

/** Paths no scoped agent may ever write: the config, the hooks, Claude Code's settings. */
function selfProtected(file, cwd) {
  const files = [
    file,
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
  ];
  if (cwd) {
    files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  }
  return {
    files: files.filter(Boolean).map((p) => toAbs(p)),
    dirs: [toPrefix(HOOKS_DIR)],
  };
}

function compileAgent(name, a, root, self) {
  const shell = a.shell || "full";
  if (!["full", "guarded", "none"].includes(shell)) {
    throw new Error(`agent "${name}": shell must be "full", "guarded" or "none", not "${shell}"`);
  }
  return {
    name,
    label: a.label || name,
    note: a.note || "",
    allow: (a.allow || []).map((p) => toAbs(p, root)),
    allowPrefixes: (a.allowPrefixes || []).map((p) => toPrefix(p, root)),
    deny: [...(a.deny || []).map((p) => toAbs(p, root)), ...self.files],
    denyPrefixes: [...(a.denyPrefixes || []).map((p) => toPrefix(p, root)), ...self.dirs],
    shell,
    denyShellPatterns: (a.denyShellPatterns || []).map(([re, label]) => [new RegExp(re, "i"), label || re]),
  };
}

/** Compile a raw config object. Exported so tests can build configs in memory. */
export function buildConfig(raw, root, file = null, cwd = null) {
  const self = selfProtected(file, cwd);
  const t = raw.territory || {};
  const agents = {};
  for (const [name, spec] of Object.entries(t.agents || {})) {
    agents[name.toLowerCase()] = compileAgent(name, spec, root, self);
  }
  const c = raw.ceiling || {};
  return {
    file,
    root,
    log: raw.log ? toAbs(raw.log, root) : null,
    territory: {
      agents,
      mcpWriteSuffixes: new Set(t.mcpWriteSuffixes || DEFAULT_MCP_WRITE_SUFFIXES),
    },
    ceiling: {
      ask: new Map(Object.entries({ ...(c.replaceDefaultAsk ? {} : DEFAULT_ASK), ...(c.ask || {}) })),
      deny: new Map(Object.entries(c.deny || {})),
      protectedPaths: (c.protectedPaths || []).map((p) => toPrefix(p, root)),
      denyForcePush: c.denyForcePush !== false,
      denyCommands: (c.denyCommands || []).map(([re, label]) => [new RegExp(re, "i"), label || re]),
    },
  };
}
