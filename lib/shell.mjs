/* Shell-command inspection shared by both hooks.
 *
 * This is string inspection, not a sandbox. base64, a variable built at runtime, or a
 * script written and then executed will get past it. What it stops is the realistic
 * failure: a model that reaches for `sed -i` on a file it shouldn't touch, or runs a
 * cleanup that lands in the wrong directory. Anything stronger needs an OS boundary. */

/** Destroys something regardless of target. */
export const DESTRUCTIVE = [
  [/\brm\s+(?:-[a-z]+\s+)*-[a-z]*[rf]/i, "rm with -r or -f"],
  [/\brmdir\b/i, "rmdir"],
  [/\bshred\b/i, "shred"],
  [/\bdel\s+\/[sqf]/i, "del /s"],
  [/\bRemove-Item\b[^;|]*-Recurse/i, "Remove-Item -Recurse"],
  [/\bgit\s+push\b[^;|]*(?:--force|\s-f(?:\s|$))/i, "git push --force"],
  [/\bgit\s+reset\b[^;|]*--hard/i, "git reset --hard"],
  [/\bgit\s+clean\b[^;|]*-[a-z]*[fd]/i, "git clean -f/-d"],
  [/\bgit\s+(?:checkout|restore)\s+--\s/i, "git checkout/restore -- (discards uncommitted work)"],
];

/** Mutates whatever it names. Only a problem when the command also names a sealed path. */
export const WRITE_VERBS = [
  [/\bsed\b[^;|]*\s-i/i, "sed -i"],
  [/\btee\b/i, "tee"],
  [/\b(?:cp|copy|Copy-Item)\b/i, "a copy"],
  [/\b(?:mv|move|Move-Item)\b/i, "a move"],
  [/\brm\b/i, "rm"],
  [/\bpatch\b/i, "patch"],
  [/\b(?:dd|truncate)\b/i, "dd/truncate"],
  [/\b(?:Set-Content|Add-Content|Out-File|New-Item)\b/i, "a PowerShell write cmdlet"],
  [/\bopen\s*\([^)]*['"][wa]/i, "a Python open() in write mode"],
  [/\b(?:chmod|chown|icacls|attrib)\b/i, "a permission change"],
];

/** Drop heredoc bodies: a path inside document text is prose, not an argument. */
export function stripHeredocs(cmd) {
  const out = [];
  let tag = null;
  for (const line of String(cmd).split("\n")) {
    if (tag === null) {
      out.push(line);
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (m) tag = m[2];
    } else if (line.trim() === tag) {
      tag = null;
    }
  }
  return out.join("\n");
}

/** Resolve simple NAME=value (sh) and $Name = "value" (PowerShell) assignments made
 *  earlier in the same command, so `rm -rf "$DST/x"` is seen for what it is. */
export function expandVars(cmd) {
  const vars = new Map();
  let m;
  const sh = /(?:^|[\n;&|(]|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  while ((m = sh.exec(cmd))) {
    vars.set(m[1], m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "");
  }
  const ps = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while ((m = ps.exec(cmd))) {
    vars.set(m[1], m[2] !== undefined ? m[2] : m[3] || "");
  }
  let out = cmd;
  for (let pass = 0; pass < 3; pass++) {
    out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) =>
      vars.has(name) ? vars.get(name) : whole);
  }
  return out;
}

export function splitSegments(cmd) {
  return cmd.split(/\n|;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean);
}

/** Remove redirections and their operands, so `rmdir foo 2>/dev/null` does not read
 *  "2>/dev/null" as a second delete target. */
export function stripRedirections(seg) {
  return seg
    .replace(/\d*>>?\s*&\s*\d+/g, " ")
    .replace(/\d*>>?\s*("[^"]*"|'[^']*'|\S+)/g, " ")
    .replace(/\d*<+\s*("[^"]*"|'[^']*'|\S+)/g, " ");
}

export function tokenize(seg) {
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return toks;
}

/** Redirect TARGETS only, the thing after > or >>. A sealed file used as INPUT
 *  (`python check.py sealed.json > out.txt`) is not a write to it. */
export function redirectTargets(cmd) {
  const out = [];
  const re = /(?:^|[^0-9>])>>?\s*([^\s;|&>]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1].replace(/^["']|["']$/g, ""));
  return out;
}

/** Every delete in a command, with the directory it runs in.
 *  Tracks cd / Set-Location / pushd so relative targets resolve correctly.
 *  Returns [{ target, recursive, dir }], where dir is null if no cd was seen. */
export function deleteTargets(rawCmd) {
  const cmd = expandVars(stripHeredocs(rawCmd));
  let dir = null;
  const found = [];

  for (const rawSeg of splitSegments(cmd)) {
    const toks = tokenize(stripRedirections(rawSeg));
    if (!toks.length) continue;
    const head = toks[0].replace(/^.*[/\\]/, "").toLowerCase().replace(/\.exe$/, "");

    if (head === "cd" || head === "set-location" || head === "pushd") {
      const d = toks.slice(1).find((t) => !t.startsWith("-"));
      if (d) dir = d;
      continue;
    }

    const isRm = head === "rm" || head === "unlink" || head === "del" || head === "erase";
    const isDirRemove = head === "rd" || head === "rmdir";
    const isRemoveItem = head === "remove-item" || head === "ri";
    if (!isRm && !isDirRemove && !isRemoveItem) continue;

    // rmdir / rd remove an EMPTY directory unless /s is passed.
    let recursive = false;
    const targets = [];
    for (const t of toks.slice(1)) {
      if (isDirRemove && /^\/[a-z]$/i.test(t)) {
        if (t.toLowerCase() === "/s") recursive = true;
        continue;
      }
      if (t.startsWith("-")) {
        const f = t.toLowerCase();
        if (isRemoveItem || isDirRemove) {
          if (f.startsWith("-recurse") || f === "-r") recursive = true;
        } else if (f === "--recursive" || /^-[a-z]*r/.test(f)) {
          recursive = true;
        }
        continue;
      }
      targets.push(t);
    }
    for (const t of targets) found.push({ target: t, recursive, dir });
  }
  return found;
}
