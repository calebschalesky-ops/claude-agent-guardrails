import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";

/** Normalize any path shape Claude Code produces into one comparable form:
 *  Windows (C:\x), git-bash (/c/x), relative, and ~. Forward slashes everywhere,
 *  lowercased on Windows (case-insensitive filesystem). ".." is resolved, so
 *  traversal cannot escape a comparison. */
export function toAbs(p, base) {
  let s = String(p ?? "").trim();
  if (!s) return null;

  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(os.homedir(), s.slice(1));
  }

  // /c/x -> c:/x. Must run before any isAbsolute check: on Windows,
  // path.resolve("/c/x") yields C:\c\x, which would compare wrong.
  if (WIN) {
    const drive = s.match(/^\/([a-zA-Z])\/(.*)$/);
    if (drive) s = `${drive[1]}:/${drive[2]}`;
  }

  const rooted = WIN ? /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") : s.startsWith("/");
  if (!rooted) s = path.join(base || process.cwd(), s);

  const out = path.resolve(s).replace(/\\/g, "/");
  return WIN ? out.toLowerCase() : out;
}

/** A directory prefix: normalized, always ending in "/". */
export function toPrefix(p, base) {
  const a = toAbs(p, base);
  if (!a) return null;
  return a.endsWith("/") ? a : a + "/";
}

/** True when abs is the prefix directory itself or anything under it. */
export function under(abs, prefix) {
  return abs === prefix.slice(0, -1) || abs.startsWith(prefix);
}
