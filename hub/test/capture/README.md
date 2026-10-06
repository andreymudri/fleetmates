# Claude Code fixture capture

`capture-cc.mjs` records hook payloads and screen frames from the real Claude Code on your
machine, following `docs/deck/09-testing.md` section 5.2 steps 1 to 4 and 6 (hooks and screens
only: no `claude -p` streams, no transcripts). The fake `claude` in `../fake-claude/` replays what
it writes.

## Cost

One run starts ONE real Claude Code session on your own subscription and drives about eleven
model turns (four Bash permission prompts, an Edit, a Write, a WebFetch of `https://example.com`,
an AskUserQuestion, a plain question, `/compact`, `/clear`). It never runs in CI.

## Steps

The steps run in the order of `STEP_ORDER` in `capture-cc.mjs`:

| Step | Prompt | Answer | Frame |
|---|---|---|---|
| `startup` | none; accepts the trust dialog | `Yes, I trust` | `trust-folder`, `idle-input` |
| `bash-1` | run `node --test capture.test.mjs` | `1` | `spinner`, `permission-bash-3` (or `permission-2`), `tool-output` |
| `bash-2` | the same command | `2`, then saves `option2-rule.json` and restores the settings | |
| `bash-3` | the same command | `3`, waits for `PermissionDenied` | |
| `edit` | append a line to `notes.txt` with Edit | `1` | `permission-edit` |
| `write` | create `capture-write.txt` with Write | `1` | `permission-write` |
| `webfetch` | fetch `https://example.com` with WebFetch | `1` | `permission-webfetch` |
| `bash-long` | `node --test --test-name-pattern="<200 letters a-z>" capture.test.mjs` | `3` | `permission-bash-long` |
| `ask` | AskUserQuestion, pick A or B | `1` | `question-options` |
| `question` | a plain-text question | none | `question-text` |
| `compact`, `clear`, `exit` | `/compact`, `/clear`, `/exit` | none | `compacting` |

The Bash steps run `node --test capture.test.mjs` because the deck has a Safe rule candidate for
it (`Bash(node --test:*)`), so the option 2 label names a command the deck can suggest a rule for.
`bash-long` shows how 2.1.282 wraps or truncates a command longer than one row.

## Running it

From `hub/`, after `npm ci`:

```sh
node test/capture/capture-cc.mjs                # attended: asks you to retry or skip a failed step
node test/capture/capture-cc.mjs --unattended   # retries each failed step up to 2 times, then skips it
```

Flags: `--out <dir>` (default `hub/test/fixtures`), `--unattended`, `--cols 120 --rows 40`.
`CAPTURE_STEP_TIMEOUT_MS` (default 120000) bounds how long a step waits for its hook.

The script refuses to run when `claude --version` differs from `fleetmatesDeck.testedClaudeCode`
in `hub/package.json`, and prints both. It works in a throwaway git repo in a temp dir, so your
user settings are not touched. The repo holds `README.md`, `notes.txt` and a one-test
`capture.test.mjs`, all committed. Its `.claude/settings.local.json` is the text
`captureSettings(hookCommand)` returns: `capture-hook.mjs` registered for every event in
`docs/deck/04-integrations.md` section 2.1, and `"permissions": { "ask": ["Bash", "Edit",
"Write", "WebFetch"] }` so every step prompts even where your settings would allow the tool.
`bash-2` writes that exact text back after option 2 adds its rule. The script starts claude with
`--permission-mode manual` and removes the parent session's variables (`CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT` and the others `childEnv` lists) from the child environment.

## Output

- `hooks/<version>/<Event>[.variant].json`: the first payload seen per event and variant.
- `hooks/<version>/sequence.approve-safe.jsonl`: every hook of the first Bash step (answered `1`).
- `hooks/<version>/option2-rule.json`: the `permissions` object of the repo's
  `.claude/settings.local.json` right after `bash-2` answered `2`, redacted like the payloads.
  It records the rule form 2.1.282 writes for "don't ask again". It is not a hook payload. Absent
  when `bash-2` was skipped.
- `hooks/<version>/MANIFEST.json`: version, capture date, script version, OS, redactions,
  the steps in order (`steps`), skipped steps, the hook files written (`option2-rule.json`
  included), and for each frame how many placeholders were substituted.
- `screens/<version>/<frame>.ansi`: raw PTY bytes from the previous idle point, with the command
  text replaced by `{{cmd}}` and the question text by `{{question}}`. Frames the session did not
  show are absent. No `.expect.json` is written.

### Merging a recapture into an existing set

When new files are copied into an existing `hooks/<version>` and `screens/<version>` set, leave
the existing files and the existing `MANIFEST.json` keys unchanged and add one `recapture` object
to `MANIFEST.json`: `date`, `scriptVersion`, `stepsRun`, `stepsSkipped`, and `added`, the copied
files as paths relative to `hub/test/fixtures` (for example
`hooks/2.1.282/PermissionRequest.Bash.json`). The fixture set test in
`test/unit/fake-claude.test.mjs` counts the hook files in `added` as listed, checks that each
`added` path exists, and does not read `option2-rule.json` as a hook payload. Write each new
frame's `.expect.json` from `parseScreen` output on that frame, reviewed against the frame text.
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

Review checklist, before anything is copied into `hub/test/fixtures`:

1. Read every new file in the output directory.
2. Grep the whole output for `/home/` (only `/home/you` may remain), `@` (only
   `you@example.com`), your username, your display name, your organization, and runs of 40 or
   more base64 or hex characters.
3. Check that `option2-rule.json` holds only the permission pattern strings.
4. Any hit outside the placeholders blocks the commit until it is redacted by hand; record each
   hand redaction in the `MANIFEST.json` notes.
