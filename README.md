# claude-agent-guardrails

Two Claude Code `PreToolUse` hooks for running several agents at once without trusting a prompt to keep them in line.

- **`territory`**: each named subagent may write only its own files. Claude Code's `tools:` allowlist decides *which tools* an agent holds, never *which paths* it may write, so an agent given `Edit` for one file can edit every file on disk. This closes that gap.
- **`ceiling`**: outward actions (sending a message, creating a calendar event, sharing a file) stop and ask a human. Deletes inside protected folders and force pushes are denied outright.

**Node 18+ · no dependencies · 65 tests** (`npm test`)

## Where this comes from

I extracted these from the hooks that run my own multi-agent setup: a dozen agents with their own seats (a game studio, a video editor, a research engine, a finance seat), working in parallel in one workspace. Here's what those originals have logged so far:

| Hook | In use since | Decisions logged | Denied | Asked a human |
|---|---|---|---|---|
| territory | 2026-09-14 | 370, across 8+ agents | 57 | n/a |
| ceiling | 2026-09-06 | 395 | 124 | 42 |

Every denial is a write or command that would have run if the rule had lived only in a prompt.

## Install

1. Clone this repo anywhere.
2. Add both hooks to `.claude/settings.json` (project) or `~/.claude/settings.json` (everything). See [`examples/settings.json`](examples/settings.json).
3. Write `.claude/guardrails.json` in your project (or `~/.claude/guardrails.json`, or point `$GUARDRAILS_CONFIG` at a file). See [`examples/guardrails.json`](examples/guardrails.json).

```json
{
  "territory": {
    "agents": {
      "docs-writer": { "allowPrefixes": ["docs/"], "deny": ["docs/STYLE.md"], "shell": "none" },
      "qa":          { "allowPrefixes": ["qa/"], "shell": "guarded" }
    }
  },
  "ceiling": { "protectedPaths": ["data/"] }
}
```

The keys under `agents` are subagent names, the `name:` in `.claude/agents/*.md`. Relative paths resolve from the project root.

## How `territory` decides

A subagent's tool call carries `agent_type` and a main-session call doesn't. So the hook only ever narrows a named subagent, and your own session is never touched.

| Field | Meaning |
|---|---|
| `allow` | exact files the agent may write |
| `allowPrefixes` | folders it may write anywhere under, new files included |
| `deny` | files it may never write |
| `denyPrefixes` | sealed folders, even inside an allowed one |
| `shell` | `"none"` (no shell at all), `"guarded"` (shell runs; destructive commands and writes to sealed paths are denied), or `"full"` |
| `denyShellPatterns` | `[regex, label]` pairs denied for this agent |

**Resolution order:** exact deny → exact allow → sealed folder → allowed folder → out of scope. An explicitly allowed file can sit inside a sealed folder, and nothing beats an exact deny.

**No agent can rewrite its own fence.** The config file, this repo's folder and Claude Code's `settings.json` files are sealed for every scoped agent automatically.

**Fails open for strangers, closed for the scoped.** Anything the hook doesn't recognize passes, because a hook that breaks every session gets deleted. Once it has identified a scoped agent, an error means "can't prove this write is allowed", and the answer is no.

**It never grants.** The hook only ever emits `deny`. An in-scope write still goes through your normal permission mode.

## How `ceiling` decides

- **Ask:** outward actions, matched on the tool-name suffix after the last `__`. MCP tool names carry a per-install prefix that changes when a connector is re-added. Defaults cover sending, replying and forwarding messages, calendar writes, sharing and trashing files, and spam and label changes. Add your own with `ask`, or replace the defaults with `replaceDefaultAsk: true`.
- **The bypass hole:** in `bypassPermissions` mode, a hook's `ask` is auto-approved and nobody sees it. So in that mode, every ask is escalated to **deny**. An ask tier that silently turns into "allow" is worse than having none.
- **Deny:** deletes whose target resolves inside `protectedPaths`. The hook follows `cd`, expands `NAME=value` variables, ignores heredoc bodies and redirections, and understands `rm`, `del`, `rd /s` and `Remove-Item`. It also denies force pushes (`denyForcePush: false` turns that off), any tool listed in `deny`, and any `denyCommands` pattern.
- Messages to another local Claude session (`SendMessage`) are not messages to a person and pass. The exemption is matched by full tool name and rejects targets that look like an email or phone number.
- Fails open on its own errors.

## What this is not

It's not a sandbox. Shell inspection reads the command string, and base64, a script written and then run, or a variable built at runtime will get past it. It stops the realistic failure, the one I actually saw: a model that reaches for `sed -i` on a file it doesn't own, or a cleanup that lands in the wrong folder. If you need to stop an adversary, use an OS-level boundary.

## Tests

```bash
npm test
```

There are 65 cases. Unit tests call the decision functions directly. End-to-end tests run the real hook scripts with JSON on stdin, the way Claude Code calls them. Each check has a matching case that proves the agent can still do its job: a fence that blocks the work is a broken agent, not a safe one.

Every decision is appended to a JSON-lines log (`log` in the config, or `$GUARDRAILS_LOG`), so a miss can be traced afterwards.
