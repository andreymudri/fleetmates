# Claude Code fixture capture

`capture-cc.mjs` records hook payloads and screen frames from the real Claude Code on your
machine, following `docs/deck/09-testing.md` section 5.2 steps 1 to 4 and 6 (hooks and screens
only: no `claude -p` streams, no transcripts). The fake `claude` in `../fake-claude/` replays what
it writes.

## Cost

One run starts ONE real Claude Code session on your own subscription and drives about eight
model turns (three Bash permission prompts, an edit, an AskUserQuestion, a plain question,
`/compact`, `/clear`). It never runs in CI.

## Running it

From `hub/`, after `npm ci`:

```sh
node test/capture/capture-cc.mjs                # attended: asks you to retry or skip a failed step
node test/capture/capture-cc.mjs --unattended   # retries each failed step up to 2 times, then skips it
```

Flags: `--out <dir>` (default `hub/test/fixtures`), `--unattended`, `--cols 120 --rows 40`.
`CAPTURE_STEP_TIMEOUT_MS` (default 120000) bounds how long a step waits for its hook.

The script refuses to run when `claude --version` differs from `fleetmatesDeck.testedClaudeCode`
in `hub/package.json`, and prints both. It works in a throwaway git repo in a temp dir whose
`.claude/settings.local.json` registers `capture-hook.mjs` for every event in
`docs/deck/04-integrations.md` section 2.1, so your user settings are not touched. It removes
`CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from the child environment.

## Output

- `hooks/<version>/<Event>[.variant].json`: the first payload seen per event and variant.
- `hooks/<version>/sequence.approve-safe.jsonl`: every hook of the first Bash step (answered `1`).
- `hooks/<version>/MANIFEST.json`: version, capture date, script version, OS, redactions,
  skipped steps, and for each frame how many placeholders were substituted.
- `screens/<version>/<frame>.ansi`: raw PTY bytes from the previous idle point, with the command
  text replaced by `{{cmd}}` and the question text by `{{question}}`. Frames the session did not
  show are absent. No `.expect.json` is written.
- On stdout: the fields added, removed or retyped against the previous version's hook set.

## Review before commit

The output is not safe to commit unreviewed. Redaction is by string replacement
(throwaway repo path, `$HOME`, your account email, display name and organization name, your
username, session ids, transcript paths, typed prompts, JWTs, token-like runs); anything else
in the payloads or on screen is kept as printed. The rules are exported from `capture-cc.mjs`
(`createRedactor`, `readAccount`, `redactTokens`) and pinned in `test/unit/fake-claude.test.mjs`.

The account fields are read at capture time from `oauthAccount` in `~/.claude.json`
(`emailAddress`, `displayName`, `organizationName`) when that file has them, and become
`you@example.com`, `You` and `Example Org`, matched in any case, as is the OS username. With no
`oauthAccount` (an API-key login, say) nothing is known to redact, so the grep below matters more.

Token-like runs are runs of 40 or more base64, base64url or hex characters (`/` and `=`
included) with a letter and a digit, found on the text with escape sequences removed, so a
token split by colour or cursor codes is still redacted (the codes are kept after
`REDACTED`). So that paths such as
`/home/you/.claude/projects/fixture/<id>.jsonl` survive, a run that starts with `/` or follows a
`.` or `~` is only redacted when one of its `/`-separated pieces is 40 or more such characters
by itself. A secret split by `/` into pieces all shorter than 40 that starts with `/` (or follows
a `.`) is therefore kept, and so is anything shorter than 40 characters that is not a JWT;
the reviewer's grep below is what catches those. Which other
personal strings a real 2.1.282 session prints has not been checked yet (Task 4 does that). Read every file, and grep them for `/home/`, `@`, your username,
your display name and long base64 or hex runs before `git add`. A placeholder count of 0 in `MANIFEST.json` means the text
was split by escape sequences and the frame still holds the literal text.
