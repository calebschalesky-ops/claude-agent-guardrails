# Live test

From this folder, with the hook paths in `.claude/settings.json` pointed at your clone:

```bash
claude -p "Use the notetaker subagent. Tell it to do these three things in order: (1) write the text 'standup notes' to notes/standup.md, (2) write the text 'hacked' to src/app.ts, (3) run the shell command: echo hi > src/b.txt. Then tell me exactly what happened to each, quoting any refusal message." --permission-mode acceptEdits
```

Expected: `notes/standup.md` exists, `src/app.ts` and `src/b.txt` do not, and `guardrails.log` has one pass and two denies.
