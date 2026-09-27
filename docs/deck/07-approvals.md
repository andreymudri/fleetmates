# 07 · Approvals, risk tiers and rules

Status labels as in [02-domain.md](02-domain.md). **Decided**: the three tiers and their wording, what each tier allows, unknown commands default to Caution, the tiers.json path, rule suggestion after 5 Safe approvals with the 5 / 3 / Never setting, rules written to `<repo>/.claude/settings.local.json` in Claude Code permission syntax, answers delivered as keystrokes into the PTY, observed sessions answered in the terminal, the Destructive confirm checkbox and the neutral Revoke button. **Proposed**: the classification algorithm, the tiers.json format, every default pattern, compound command handling, the settings file writer, the audit trail and the failure handling. The default pattern lists are Proposed and must pass the design-oversight review before M3 (section 12).

Milestones: the classifier ships in M1 so the drawer and cards can show tier badges (read only, "Answer in your terminal"). Answering from the deck, batch, rules and the confirm checkbox ship in M3.

The request lifecycle (states, guards, verification, transition table) is specified once in [interaction/state-machines.md](interaction/state-machines.md) section 2 and the rule machine in section 2.8. This document does not restate them; it defines the policy those machines apply.

## 1. The three tiers (Decided)

Copy is verbatim from the canvas Settings aside (D-31, [screens/settings.md](screens/settings.md) section 4.2). Tier words are stored in sentence case and uppercased by CSS.

| Tier | Settings aside copy (verbatim) | Drawer section line (verbatim) |
|---|---|---|
| Safe | "Reads, tests, builds, linters. Can be batched, approved from a popup and turned into a rule." | "Reads, tests, builds" |
| Caution | "Network, installs, writes outside the repo. One at a time; a rule is possible only if you add it by hand." | "Network, installs, outside the repo · one at a time" |
| Destructive | "rm, git push --force, git reset --hard, deploys, database writes. Never batched, never a rule, never from a popup, and always behind a confirm checkbox." | "Never batched, never a rule, never from a popup" |

Aside footer (verbatim): "Tiers come from pattern lists in ~/.config/fleetmates/deck/tiers.json. Unknown commands default to Caution."

Questions (AskUserQuestion, elicitation, a turn that ends with a question) are not a tier. They carry `tier = null` and render in their own "Question" section ([02-domain.md](02-domain.md) section 2.3).

## 2. What each tier allows

Decided rows come from the tier copy above and the canvas Approvals board. Mechanics are in state-machines 2.5 and 2.6.

| Capability | Safe | Caution | Destructive | Question |
|---|---|---|---|---|
| Answer from a Home card | yes | yes | no: "Review in Needs you" (Decided) | "Reply" opens the drawer or inline field |
| Answer from the drawer | yes | yes | yes, after the checkbox | yes |
| Answer from the Focus prompt bar | options 1, 2, 3 | options 1 and 3 (option 2 hidden, Proposed) | checkbox, then option 1 by click only | option buttons or reply field |
| Answer from the palette | yes | yes | no: opens the drawer | no: opens the drawer |
| Batch ("Allow both Safe once", `Alt Shift A`) | yes (Decided) | never | never (Decided) | never |
| Desktop popup "Allow once" | yes (Decided) | no, "Open" only (SM-O9, default no) | never (Decided) | no, "Open" only |
| Keyboard shortcut that approves (`Alt A`, digit keys) | yes | yes | never (Decided, [interaction/keyboard.md](interaction/keyboard.md)) | n/a |
| Rule suggestion ("Make it a rule?") | yes, after the threshold (Decided) | never suggested | never | never |
| Rule added by hand in Settings | yes | yes (Decided: "only if you add it by hand") | refused (Decided: "never a rule") | n/a |
| Counts toward the rule threshold | yes | no | no | no |

Server enforcement (Proposed): every row above is enforced by the web server, not only by the UI. `POST /api/requests/:id/answer` rejects a Destructive allow without `confirm: true`; `POST /api/requests/answer-batch` rejects the whole batch if any id is not Safe at the moment of sending; the notification action handler refuses anything but Safe; `POST /api/rules` refuses Destructive patterns (section 7.3). Endpoints are specified in [05-api.md](05-api.md).

## 3. Classification

### 3.1 Inputs

The classifier is a pure function (Proposed):

```
classify({ toolName, toolInput, cwd, repoRoot, worktrees, homeDir, tiers }) -> { tier, reasons[], ruleCandidate | null }
```

- `toolName`, `toolInput`: from the `PermissionRequest` hook payload (02-domain Request `toolName`, `detail`).
- `cwd`: the session's current `cwd`. `repoRoot`: the session's `repoId` (realpath). `worktrees`: paths from `git worktree list --porcelain` for that repo, cached per repo and refreshed on `WorktreeCreate` / `WorktreeRemove` hooks.
- `tiers`: the effective pattern set (section 4.3).
- `reasons[]`: one entry per matched pattern: `{ entryId, tier, segment }`, where `segment` is the simple command or path that matched. Shown as a tooltip "Why Caution: npm install (installs packages)" and stored in the audit trail (section 11).
- `ruleCandidate`: the Claude Code permission pattern this request would become as a rule, or null (section 7.1).

A request opened from a bare `Notification[permission_prompt]` has no `tool_input`: tier Caution, no rule candidate (state-machines 2.2, DRW-O3).

### 3.2 Algorithm (Proposed)

1. **Pick the matcher by tool.** `Bash` goes to the shell analysis (3.3). File tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Read`) go to path analysis (3.5). `WebFetch`, `WebSearch` go to the network entries. `mcp__<server>__<tool>` goes to the MCP entries. Any other tool name goes to the tool entries, else Unknown.
2. **Collect every matching entry.** Order in the file does not matter.
3. **Highest tier wins**: Destructive over Caution over Safe. A Safe entry can never lower a Caution or Destructive match. This is what makes a user-added Safe pattern harmless to the defaults.
4. **Floors** (3.4) raise the result further. They are applied after matching and cannot be lowered by any entry.
5. **Unknown defaults to Caution** (Decided). "Unknown" means: no entry matched a segment, the command could not be parsed, or a segment's command word is not a literal (a variable, a substitution).
6. **Stability**: the tier is computed when the request opens and recomputed when tiers.json changes and just before an answer is sent. An open request's tier can only go up, never down, during its life (Proposed), so an edited tiers.json cannot relax a request the user is already looking at.

### 3.3 Shell commands (Bash)

Proposed. The deck tokenizes the command with its own small POSIX-shell tokenizer (quotes, escapes, `&&`, `||`, `;`, `|`, `&`, newlines, `( )`, `{ }`, `$( )`, backticks, `<( )`, `>( )`, redirections, heredocs). No new dependency: the grammar needed is small and it must fail closed. Anything the tokenizer does not understand makes the whole command Unknown (Caution), never Safe.

Splitting and normalization, applied recursively:

| Construct | Handling |
|---|---|
| `a && b`, `a \|\| b`, `a ; b`, `a & b`, newlines | split into simple commands; classify each; highest tier wins |
| `a \| b` | classify each side; plus the pipe floor in 3.4 when `b` is an interpreter |
| `( ... )`, `{ ...; }` | classify the inside |
| `$( ... )`, backticks, `<( ... )`, `>( ... )` | classify the inner command as its own segment; highest wins |
| `bash -c '...'`, `sh -c`, `zsh -c`, `eval '...'` | if the argument is a literal string, tokenize and classify it; if not literal, Unknown |
| `xargs <cmd>`, `find ... -exec <cmd> {} ;`, `find ... -execdir`, `parallel <cmd>` | classify `<cmd>` as a segment (so `find . -name x -exec rm {} ;` is Destructive) |
| `find ... -delete` | Destructive (same as `rm`) |
| Leading `VAR=value` assignments | stripped before matching, except the variables in the env floor (3.4) |
| Wrappers `env`, `command`, `builtin`, `time`, `nice`, `nohup`, `timeout <n>`, `stdbuf ...` | stripped; classify the wrapped command |
| Runner wrappers `uv run`, `poetry run`, `pnpm exec`, `npx --no-install` | stripped; the wrapped command decides the tier (`uv run pytest` is Safe, `uv run python x.py` is Caution) |
| `sudo ...`, `doas ...` | classify the wrapped command; floor Caution |
| `cd <dir>` | Safe; the new directory is used for later relative redirect targets in the same compound command |
| Redirection `> f`, `>> f`, `&> f`, `2> f`, `tee f` | target resolved against `cwd`; inside the repo scope (3.5): no change; `/dev/null`, `/dev/stdout`, `/dev/stderr`: no change; anywhere else: Caution |
| Heredoc feeding an interpreter (`python - <<EOF`, `bash <<EOF`, `node <<EOF`) | Caution ("runs inline code") |
| Command word is `$VAR`, `${...}`, a substitution, or contains a glob | Unknown |
| Absolute or relative path as command word (`./run.sh`, `/usr/bin/rm`) | matched by basename against the entries (`/usr/bin/rm` matches `rm`); a script in the repo (`./scripts/x.sh`) is Caution ("runs a script") |

Argument matching for an entry: an entry names a command prefix as tokens (`git push`, `cargo test`, `npm run lint`) and optionally `anyArg` (at least one remaining argument matches one of these globs, for flags like `--force`, `-f`, `+*`) and `noneArg` (the entry does not match if any remaining argument matches). Short flag bundles are expanded before matching (`rm -rf` gives `-r -f`; `git push -fu` gives `-f -u`). Long options with values are matched as `--opt` and `--opt=*`.

### 3.4 Floors (Proposed)

Floors apply after matching. They exist so a pattern gap cannot produce a low tier for a known high-risk shape.

| Floor | Minimum tier | Why |
|---|---|---|
| Parse failure, non-literal command word, unknown tool | Caution | Decided default for unknown |
| `sudo`, `doas`, `su`, `pkexec` anywhere | Caution | runs as another user |
| Env assignment of `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `PYTHONPATH`, `GIT_*`, `CARGO_*` `RUSTC_WRAPPER`, `BASH_ENV`, `PROMPT_COMMAND` | Caution | changes what "cargo test" actually runs |
| A pipe or process substitution whose right side is a shell or interpreter and whose left side fetches from the network (`curl ... \| sh`, `wget -O- ... \| bash`, `bash <(curl ...)`) | Destructive | runs unreviewed remote code; nothing to check first. APR-O4 |
| Any command, path or URL that names the deck's own controls: the deck state dir, token file, config dir (including tiers.json), `$XDG_RUNTIME_DIR/fleetmates-deck/`, the web server port on 127.0.0.1 or localhost, `systemctl --user ... fleetmates-deck*` | Destructive | an agent that can read the token or type into deckd can approve its own requests ([08-security.md](08-security.md) section 3.6) |
| Any write to Claude Code settings or hooks: `~/.claude/settings*.json`, `<any>/.claude/settings*.json`, `~/.claude/hooks/`, `.mcp.json`, `CLAUDE.md` outside the repo | Destructive | an agent granting itself permissions or hooks |
| Any write under `.git/` (`.git/hooks/*`, `.git/config`, `.git/info/*`) | Destructive | git hooks and config (`core.fsmonitor`, `core.hooksPath`) run code on the next git command, including the deck's own |

### 3.5 File tools and repo scope (Proposed)

**Repo scope** = the session's repo root plus every worktree of the same repository (fleetmates task worktrees count as inside). Paths are resolved against `cwd`, then realpath of the nearest existing ancestor (so a symlink inside the repo pointing to `~/.ssh` is outside). `.git/` directories are excluded from the repo scope and fall under the floor above.

| Tool | Inside repo scope | Outside repo scope | Sensitive path (any location) |
|---|---|---|---|
| `Read` (only when Claude Code prompts for it) | Safe | Caution ("reads outside the repo") | Caution with description "reads a secret file" for `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.config/gh/**`, `~/.netrc`, `**/.env`, `**/.env.*`, `~/.claude/.credentials.json`; Destructive for the deck token and state dir (floor) |
| `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | Safe (APR-O2) | Caution ("writes outside the repo", Decided tier copy) | Destructive for Claude Code settings, `.git/`, deck files (floors) |

Safe file edits never produce a rule candidate (Proposed): Claude Code edit rules are path globs, and a repo-wide edit rule is a bigger grant than the 5 approvals that would trigger it.

### 3.6 Non-Bash tools (Proposed)

| Tool | Tier | Rule candidate |
|---|---|---|
| `WebFetch` | Caution ("network"); Destructive when the host is `127.0.0.1`, `localhost`, `[::1]` or `0.0.0.0` (deck floor) | none suggested; by hand `WebFetch(domain:<host>)` (canvas example `WebFetch(domain:docs.nestjs.com)`) |
| `WebSearch` | Caution | none suggested; by hand allowed |
| `mcp__vault__vault_search`, `vault_get_note`, `vault_list`, `vault_backlinks`, `vault_graph` | Safe | `mcp__vault__<tool>` |
| `mcp__vault__vault_learn`, `vault_move` | Caution (writes the vault and commits) | none suggested |
| `mcp__vault__vault_delete` | Destructive | never |
| Any other `mcp__<server>__<tool>` whose tool name contains `delete`, `remove`, `drop`, `destroy`, `purge`, `truncate`, `wipe`, `reset` | Destructive | never |
| Any other `mcp__*` | Caution | none suggested; by hand allowed |
| `Task`, `Agent`, `TodoWrite`, `ExitPlanMode` and other tools that do not normally prompt | Caution if they ever prompt (unknown) | none |

The vault server key (`vault`) is the one the owner's Claude Code config uses; the classifier matches the configured server key, read from the deck config, not a hard-coded name (Proposed).

## 4. tiers.json

### 4.1 Location and layering (Proposed, path Decided)

- Shipped defaults: `hub/server/approvals/tiers.default.json`, versioned with the deck release and covered by the classification test corpus (section 13).
- User file: `~/.config/fleetmates/deck/tiers.json` (Decided path), mode 0600. Created by `fleetmates-deck init` as a stub that extends the defaults. It holds only the user's additions and overrides, so deck upgrades keep improving the defaults underneath (APR-O5).
- Effective set = defaults, minus entries the user disabled by id, plus user entries. Entries marked `"floor": true` in the defaults cannot be disabled; the floors in 3.4 are code, not data, and cannot be disabled either.
- The file is watched. On change: parse, validate against the schema, and swap atomically. On a parse or schema error, the deck keeps the last valid set (or the shipped defaults at start), shows a Settings banner "tiers.json has an error on line 12: … Using the previous tiers." and never falls back to anything more permissive.

### 4.2 Format (Proposed)

```json
{
  "$schema": "./tiers.schema.json",
  "version": 1,
  "extends": "default",
  "disable": ["safe.git.commit"],
  "entries": [
    {
      "id": "safe.node.cli-doctor",
      "tier": "safe",
      "tool": "Bash",
      "cmd": "node scripts/cli.mjs doctor",
      "rule": "Bash(node scripts/cli.mjs doctor)",
      "description": "fleetmates self-check"
    },
    {
      "id": "caution.web.nestjs",
      "tier": "caution",
      "tool": "WebFetch",
      "domain": "docs.nestjs.com",
      "description": "NestJS docs"
    },
    {
      "id": "destructive.deploy.wrangler",
      "tier": "destructive",
      "tool": "Bash",
      "cmd": "wrangler deploy",
      "description": "deploys a Cloudflare Worker",
      "confirm": "I checked where this deploys"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `$schema` | `"./tiers.schema.json"` | a relative path, not a web URL (Proposed). The JSON Schema ships in the hub package (`hub/server/approvals/tiers.schema.json`), and `init` copies it next to the user file so editors resolve it offline |
| `version` | 1 | schema version |
| `extends` | `"default"` \| `null` | `null` means the user file is the whole set (not recommended; floors still apply) |
| `disable` | string[] | default entry ids to drop; ids of `floor` entries are rejected with a validation error |
| `entries[].id` | string | unique, dotted, `tier.family.name` by convention |
| `entries[].tier` | `safe` \| `caution` \| `destructive` | |
| `entries[].tool` | string | `Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `WebSearch`, `mcp__server__tool` (glob allowed: `mcp__*__*delete*`) |
| `entries[].cmd` | string | Bash only: command prefix as shell words (`"git push"`) |
| `entries[].anyArg` / `noneArg` | string[] | Bash only: argument globs (3.3) |
| `entries[].sql` | `read` \| `write` | `psql` / `sqlite3` only: match on the SQL in `-c` or the heredoc (3.7) |
| `entries[].path` | `inRepo` \| `outsideRepo` \| glob[] | file tools |
| `entries[].domain` | glob | `WebFetch` |
| `entries[].rule` | string \| null | Safe only: the Claude Code permission pattern suggested after the threshold. Absent means no suggestion (SM-O11 default) |
| `entries[].description` | string | one line shown as the row's consequence (drawer "adds a dependency", DRW-O2) |
| `entries[].confirm` | string | Destructive only: checkbox label template (section 8) |
| `entries[].floor` | boolean | defaults only: cannot be disabled |

### 4.3 Default pattern list (Proposed)

This is the proposed content of `tiers.default.json`, grouped by family. "Rule" is the suggested Claude Code pattern for Safe entries, written here in the canvas form `Bash(x:*)`; the writer emits whichever form the pinned Claude Code version documents ([04-integrations.md](04-integrations.md) section 2.4). Every row is subject to the floors in 3.4 and the compound handling in 3.3.

**General shell**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `fd`, `tree`, `stat`, `file`, `which`, `type`, `echo`, `printf`, `date`, `du`, `df`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `tr`, `jq`, `yq`, `sed` without `-i`, `find` without `-delete`/`-exec`/`-execdir`/`-ok`, `true`, `false`, `test`, `[` | none (read-only commands rarely prompt; no suggestion needed) |
| Caution | `sed -i`, `awk`, `perl`, `cp`, `mv`, `mkdir`, `touch`, `ln`, `chmod`, `chown`, `rmdir`, `kill`, `pkill`, `killall`, `source`, `.`, `make`, `just`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `socat`, `pacman`, `yay`, `apt`, `brew`, `systemctl --user`, scripts run by path | none |
| Destructive | `rm` (any flags, Decided: "rm"), `shred`, `dd`, `mkfs*`, `wipefs`, `truncate`, `find -delete`, `rsync --delete*`, `systemctl` (system scope), `shutdown`, `reboot`, `crontab -r` | never |

**git**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `git status`, `diff`, `log`, `show`, `blame`, `rev-parse`, `ls-files`, `branch` (listing: no `-d -D -m -M -f`), `remote -v`, `stash list`, `worktree list`, `describe`, `shortlog`, `grep`, `config --get*` | none |
| Safe | `git add`, `git commit` without `--amend` and without `--no-verify` (APR-O3) | none (a prefix rule would also allow `--amend`) |
| Caution | `git fetch`, `pull`, `clone`, `push` (plain), `checkout <branch>`, `switch`, `merge`, `rebase`, `cherry-pick`, `revert`, `commit --amend`, `commit --no-verify`, `stash` (push/pop/apply), `tag`, `worktree add`, `submodule`, `config` (set), `gc` | none |
| Destructive | `git push` with `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`, `-d`, or a refspec starting with `+` or `:` (Decided: "git push --force"); `git reset --hard` (Decided), `git reset --keep`/`--merge`; `git clean` with `-f`; `git checkout -- <paths>`, `git checkout .`, `git restore` (without `--staged`); `git branch -D`/`-d`/`-M`; `git stash drop`/`clear`; `git reflog expire`, `git update-ref -d`, `git filter-branch`, `git filter-repo`, `git worktree remove --force` | never |

**cargo (Rust)**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `cargo build`, `check`, `test`, `nextest run`, `clippy`, `fmt`, `doc`, `bench`, `tree`, `metadata`, `--version` | `Bash(cargo build:*)`, `Bash(cargo check:*)`, `Bash(cargo test:*)` (canvas), `Bash(cargo nextest run:*)`, `Bash(cargo clippy:*)` (canvas), `Bash(cargo fmt:*)` |
| Caution | `cargo run`, `add`, `remove`, `install`, `update`, `fetch`, `clean`, `generate-lockfile`, `rustup ...` | none |
| Destructive | `cargo publish`, `cargo yank`, `cargo owner` | never |

**npm, pnpm, node**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `npm test`, `npm run test*`, `npm run lint*`, `npm run build*`, `npm run typecheck`, `npm run check*`, `npm run format:check`, `npm ls`, `npm outdated`; the same with `pnpm` (`pnpm test`, `pnpm lint`, `pnpm run <same names>`, `pnpm -r test`) and with `-w <pkg>` / `--filter <pkg>`; `node --test`, `npx tsc --noEmit`, `npx eslint`, `npx prettier --check`, `npx vitest run`, `npx playwright test` when the tool is a local dependency | `Bash(npm test:*)` (canvas), `Bash(npm run test:*)`, `Bash(npm run lint:*)`, `Bash(npm run build:*)`, `Bash(pnpm test:*)`, `Bash(pnpm lint:*)`, `Bash(node --test:*)` |
| Caution | `npm install`/`i`/`ci`/`add`/`update`/`uninstall`, `pnpm install`/`add`/`update`/`remove`, `npm run <any other script>`, `npx <anything not above>` (may download), `node <file>`, `node -e`, `npm link`, `npm exec` | none |
| Destructive | `npm publish`, `pnpm publish`, `npm unpublish`, `npm deprecate`, `npm dist-tag`, `npm owner` | never |

`npm run <script>` names are matched literally; a Safe name does not inspect what the script runs. The oversight review must accept that an agent can edit `package.json` scripts (section 12).

**go**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `go build`, `go test`, `go vet`, `go fmt`, `gofmt -l`, `gofmt -d`, `go list`, `go version`, `go env` (read), `golangci-lint run`, `staticcheck` | `Bash(go build:*)`, `Bash(go test:*)`, `Bash(go vet:*)`, `Bash(golangci-lint run:*)` |
| Caution | `go run`, `go get`, `go install`, `go mod tidy`, `go mod download`, `go generate`, `gofmt -w`, `go env -w` | none |
| Destructive | `go clean -modcache` | never |

**python**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `pytest`, `python -m pytest`, `ruff check`, `ruff format`, `black --check`, `mypy`, `pyright`, `python -m py_compile`, `pip list`, `pip show`, `uv run pytest` (unwrapped) | `Bash(pytest:*)`, `Bash(python -m pytest:*)`, `Bash(ruff check:*)`, `Bash(mypy:*)` |
| Caution | `python <file>`, `python -c`, `python -m <other>`, `pip install`, `pip uninstall`, `uv add`, `uv sync`, `uv pip install`, `poetry install`, `poetry add`, `black` (writes) | none |
| Destructive | `twine upload`, `uv publish`, `poetry publish` | never |

**docker**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `docker ps`, `images`, `logs`, `inspect`, `version`, `info`, `compose ps`, `compose logs`, `compose config` | none |
| Caution | `docker build`, `pull`, `run`, `exec`, `start`, `stop`, `restart`, `compose build`, `compose up`, `compose down` (without volumes), `compose exec`, `compose run`, `network create` | none |
| Destructive | `docker rm`, `rmi`, `system prune`, `image prune`, `container prune`, `volume rm`, `volume prune`, `network rm`, `compose down -v`/`--volumes`/`--rmi`, `compose rm`, `docker push` | never |

**terraform**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `terraform fmt`, `terraform fmt -check`, `terraform validate`, `terraform version`, `terraform providers` | `Bash(terraform fmt:*)`, `Bash(terraform validate:*)` |
| Caution | `terraform init`, `plan`, `show`, `output`, `state list`, `state show`, `graph`, `workspace list`/`select`, `console` | none |
| Destructive | `terraform apply`, `destroy`, `import`, `refresh`, `taint`, `untaint`, `state rm`/`mv`/`push`/`replace-provider`, `force-unlock`, `workspace delete` (Decided: "deploys") | never |

**psql and sqlite3**

| Tier | Commands | Rule |
|---|---|---|
| Safe | `psql --version`, `sqlite3 --version` | none |
| Caution | `psql -c` / `sqlite3 <db> "<sql>"` whose SQL is only `SELECT`, `EXPLAIN` (without `ANALYZE`), `SHOW`, `\d*`, `\l`, `\dt`; `pg_dump`; interactive `psql` with no SQL | none |
| Destructive | any SQL containing `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `COPY ... FROM`, `VACUUM`, `REINDEX`, `CALL`, `DO`, `EXPLAIN ANALYZE` (Decided: "database writes"); `psql -f <file>` and SQL from a heredoc or pipe the deck cannot read; `pg_restore`, `dropdb`, `createdb`, `dropuser` | never |

SQL matching (Proposed): strip comments and string literals, split on `;`, match the first keyword of each statement case-insensitively; any statement the deck cannot place is Destructive for `psql` (database target is unknown and may be production).

**deploys and publishing (other)**

| Tier | Commands |
|---|---|
| Caution | `gh pr view`/`list`/`checks`, `gh run view`, `gh api` (GET), `gh pr create`, `gh pr merge` |
| Destructive | `wrangler deploy`, `wrangler publish`, `wrangler secret put`/`delete`, `kubectl apply`/`delete`/`replace`/`scale`/`rollout`, `helm install`/`upgrade`/`uninstall`, `fly deploy`, `vercel --prod`, `gh release create`/`delete`, `gh repo delete`, `gh secret set`/`delete`, `gh api` with `-X DELETE`/`PUT`/`PATCH`/`POST` |

### 4.4 Worked examples (Proposed)

| Command | Tier | Why |
|---|---|---|
| `cargo test --release combat::` | Safe | `safe.cargo.test`; rule candidate `Bash(cargo test:*)` |
| `RUST_LOG=debug cargo test` | Safe | assignment stripped, `RUST_LOG` not in the env floor |
| `cargo test && git push --force origin ui/inventory` | Destructive | highest segment wins; no rule candidate (compound) |
| `npm test \| tee out.log` | Safe | `tee` target inside the repo |
| `npm test > /tmp/out.log` | Caution | redirect outside the repo |
| `cd /tmp && rm -rf build` | Destructive | `rm` |
| `find . -name '*.orig' -exec rm {} ;` | Destructive | `-exec` classifies `rm` |
| `sudo pacman -S jq` | Caution | Caution entry plus the sudo floor |
| `curl -fsSL https://x.sh \| sh` | Destructive | network-to-interpreter floor |
| `bash -c "$CMD"` | Caution | non-literal |
| `psql "$DATABASE_URL" -c "select count(*) from users"` | Caution | read-only SQL |
| `psql "$DATABASE_URL" -c "delete from sessions where ..."` | Destructive | database write |
| `docker compose down` | Caution | no volumes |
| `terraform plan -out tf.plan` | Caution | network and credentials |
| `curl -s http://127.0.0.1:47800/api/requests` | Destructive | deck controls floor |
| `Write ~/.claude/settings.json` | Destructive | Claude Code settings floor |
| `Edit src/combat/tick.rs` | Safe | inside the repo |
| `WebFetch https://docs.nestjs.com/guards` | Caution | network |
| `mcp__vault__vault_delete` | Destructive | named entry |

## 5. Answering

### 5.1 Delivery (Decided: keystrokes into the PTY)

Answers are the option keys Claude Code prints, written into the session's PTY by deckd with `source=browser`. The full sequence is [03-architecture.md](03-architecture.md) section 4.3, and the guards, proof and `did_not_land` handling are state-machines 2.6. In short, before any key is written:

1. Tier rules hold (section 2; Destructive needs `confirm: true`, never in a batch).
2. `screenMatch = on_screen`: the prompt deckd's screen model shows right now is this request's prompt (same tool line, command text equal up to the screen's truncation point). This is the check that stops a "1" meant for a Safe prompt from approving a Destructive prompt that replaced it.
3. Typing guard: no terminal input on that PTY in the last 1 s.
4. deckd connected.

Then the digit is written, and the deck waits up to 3 s for proof (prompt gone from the screen, or a matching `PostToolUse` / `PostToolUseFailure` / `PermissionDenied`). No proof gives `did_not_land`; the deck never retries on its own.

Note on the typing guard: as in state-machines 2.6 and [03-architecture.md](03-architecture.md) section 4.3, the request stays `waiting` with the message "You are typing in the terminal. Answer there, or try again in a second." The server refuses with the message; there is no automatic wait.

Proposed additions for the moment of sending:

- The guards are evaluated inside deckd's write path for that PTY, against the screen snapshot deckd holds at that instant, not against a snapshot the web server fetched earlier. The web server sends `{ ptyId, keys, expectPrompt: { tool, commandPrefix, optionLabel } }`; deckd refuses the write if the screen no longer matches (`E_PROMPT_CHANGED`).
- The option digit is taken from the parsed screen options, never assumed. If "1" on screen is not a "Yes" option, the send is refused and the UI falls back to "Answer in the terminal" (Focus: "never guess").
- Deny sends the digit of the option labelled "No, tell Claude what to do" as parsed. The optional "Tell Claude what to do instead" text (state-machines 2.5) is sent as a bracketed paste followed by Enter, only after the deny is verified.

### 5.2 Observed sessions (Decided)

Observed sessions (plain `claude`, hooks only) have no PTY. Every surface shows the request with the tier badge and the text "Answer in your terminal"; there are no Allow, Deny or Reply buttons, and popups offer "Open" only. The API returns `409 observed_session` if an answer is attempted anyway. Terminal answers are still observed through hooks and recorded (state-machines 2.7 rows 16 to 18), and count toward rule suggestions (SM-O10, default yes).

### 5.3 Questions (Proposed mechanics)

| Source | What the deck shows | What it sends |
|---|---|---|
| `AskUserQuestion` (from `PreToolUse` `tool_input`) | question text and the option labels from `tool_input`, plus "Other" | the option's digit as parsed from the screen; "Other" selects the free-text option on screen, then the text as a bracketed paste, then Enter |
| MCP elicitation (`Notification[elicitation_dialog]`) | message text and a single reply field | text as a bracketed paste, then Enter, only when the screen shows a single-field dialog; otherwise "Answer in the terminal" |
| `stop_question` (turn ended with `?`, SM-O3) | the last assistant sentence and a reply field | text as a bracketed paste, then Enter, into the idle input box |

Questions have no tier, no batch, no popup answer and no rule. The same `screenMatch`, typing guard and verification apply; proof is `PostToolUse(AskUserQuestion)` or `UserPromptSubmit`. AskUserQuestion with several questions or multi-select options needs a key sequence (navigation and submit) that only screen fixtures of the pinned Claude Code version can define; until those fixtures exist, such prompts show "Answer in the terminal" (APR-O6).

Pasted text is sanitized before it is written (Proposed): the bracketed-paste end sequence `ESC [ 201 ~` and every other C0/C1 control except tab and newline are removed, so a reply cannot break out of the paste and type keys.

### 5.4 Batch (Safe only)

Decided: only Safe requests; "Allow both Safe once" and `Alt Shift A`. Proposed mechanics (state-machines 2.5): parallel across sessions, sequential within one session, each request with its own guards and verification; the server re-classifies every id at send time and drops any that is no longer Safe from the batch, reporting it as "skipped: now Caution". Result toast "Allowed 2 of 2" or "Allowed 1 of 2: 1 did not land".

## 6. Rule suggestion (Decided threshold and copy, Proposed mechanics)

- Offered after the same Safe command is approved 5 times in the same repo (Decided). Settings offers "5 times", "3 times", "Never suggest" (Decided; SET-O4 confirms the options).
- "The same command" means the same **rule candidate**, not the same argv: `cargo test combat::` and `cargo test --release` both count toward `Bash(cargo test:*)`, because that is exactly what the rule would allow (Proposed).
- A request counts only when it was allowed (browser or terminal, SM-O10), its tier was Safe at answer time, it was a single simple command (no `&&`, `|`, `;`, subshell, redirect outside the repo), and its matched entry has a `rule`. Otherwise it has no rule candidate and never counts (SM-O11 default).
- Copy (Decided, canvas): drawer "You allowed cargo test in rustot 5 times. Make it a rule?"; card "Allowed 5 times. Always allow in rustot?"; toast "Rule added to rustot: Bash(cargo test:*)" with "Undo".
- Dismissing resets the counter; the suggestion comes back after another threshold of approvals (state-machines 2.8, Proposed).
- Counters live in the deck database per `(repoId, pattern)`; they reset when the rule is revoked.

## 7. Writing rules into `<repo>/.claude/settings.local.json`

Decided: rules live in each repo's `.claude/settings.local.json` under `permissions.allow`, in Claude Code permission syntax, so they also apply to plain `claude` in a terminal. The settings file is the source of truth; the deck keeps a mirror row for source and date ([02-domain.md](02-domain.md) section 2.4). Everything below is Proposed.

### 7.1 Pattern syntax

- Bash rules use the prefix form of the pinned Claude Code version: the canvas shows `Bash(cargo test:*)`; newer documentation shows `Bash(cargo test *)`. The writer emits the documented form for the pinned version; the reader treats both as the same rule for display, duplicate detection and revoke matching (Revoke still removes the exact string found in the file).
- Other examples: `WebFetch(domain:docs.nestjs.com)` (canvas), `mcp__vault__vault_search`.
- The pinned-version test suite includes a check that a Bash prefix rule does not approve the same prefix chained with another command (`cargo test && rm -rf x`). Claude Code documents this behaviour; the deck never relies on it without the test, and never generates a rule from a compound command anyway.

### 7.2 Safe merge procedure

1. Resolve `<repo>` to its realpath. Target is `<repo>/.claude/settings.local.json`.
2. `lstat` `<repo>/.claude` and the target. Refuse if either is a symlink, or if the target exists and is not a regular file owned by the user: "Could not write …: not a regular file. Nothing changed." (A repo can ship a symlink that points the write at `~/.bashrc` or `~/.claude/settings.json`.)
3. Read and parse. If the file exists but is not valid JSON, or its top level is not an object, refuse and show the parse error; never overwrite a file the deck cannot read.
4. Create `permissions` (object) and `permissions.allow` (array) only if missing. If `permissions` or `allow` exists with the wrong type, refuse.
5. Append the pattern if no equivalent entry is already present (7.1 equivalence). Never touch `permissions.deny`, `permissions.ask`, `permissions.defaultMode`, `permissions.additionalDirectories`, `hooks`, `env` or any other key. Key order and array order are preserved (JSON.parse keeps insertion order).
6. Backup: copy the previous bytes to `~/.local/state/fleetmates/deck/backups/rules/<sha256(repo path)>/<yyyymmdd-hhmmss>.json` (0600, keep the newest 20 per repo). Backups stay out of the repo so they never show in `git status`.
7. Write a temp file in the same directory (`.settings.local.json.deck-tmp-<pid>`, mode of the existing file, 0600 when new) with 2-space indentation and a trailing newline, `fsync`, then re-read the target: if its bytes changed since step 3 (Claude Code's own option 2 or an editor wrote it), discard the temp file and restart at step 3 (at most 3 attempts). Otherwise `rename` over the target.
8. Verify by re-reading and parsing; the pattern must be present exactly once. Update the mirror row and emit `rules.changed`.
9. If `git ls-files --error-unmatch .claude/settings.local.json` says the file is tracked, show a one-time note on the rule row: "This file is tracked by git in rustot; the rule will be committed with it."

Undo (toast after accepting a suggestion) runs the revoke procedure for that exact string.

### 7.3 Adding a rule by hand

Settings "Add a rule…" ([screens/settings.md](screens/settings.md)). The pattern is validated against Claude Code permission syntax and classified:

- A Bash pattern is refused when its prefix could reach a Destructive entry: `Bash(rm:*)`, `Bash(git push:*)` (it would allow `git push --force`), `Bash(git:*)`, `Bash(docker compose:*)`, `Bash(terraform:*)`. Also refused: a bare `Bash`, `Bash(*)`, and any pattern that names the deck's controls or Claude Code settings. Refusal copy (Decided): "Destructive commands can never become rules."
- Caution patterns are accepted (Decided: "only if you add it by hand") with the tier badge shown on the row.
- A tool-wide rule without a specifier (`WebFetch`, `Edit`) is accepted with an inline warning "Allows every {tool} call in {repo}" (Proposed).

### 7.4 Rules the deck did not write

Rules found in the file that the deck did not write show as "added by hand" (SET-O5). Claude Code's own option 2 ("Yes, don't ask again for …") writes rules there too, including for commands the deck calls Caution or Destructive, and the deck cannot stop a digit typed in the terminal. When a rule in the file matches a Destructive entry, Settings shows it with the Destructive badge and the line "This rule lets Claude run a Destructive command without asking." next to "Revoke…" (Proposed).

## 8. Destructive confirm checkbox

Decided: every Destructive allow is behind a confirm checkbox; the canvas example label is "I checked the 3 commits that will be overwritten" for `git push --force origin ui/inventory`. The checkbox is ticked by click or Space only, Allow once is never the default button, no shortcut approves, and the checkbox resets when the drawer closes or the request's summary changes (state-machines 2.5 and 2.7).

Label templates (Proposed; DRW-O1 is Open because the counts need a source):

| Entry | Template | Count source | Fallback when the count is unknown |
|---|---|---|---|
| `git push` force forms | "I checked the {n} commits that will be overwritten" | `git rev-list --count <local>..<remote-tracking ref>` from the last fetch (may be stale; the row says "as of last fetch") | "I checked the commits this will overwrite" |
| `git reset --hard`, `git checkout -- .`, `git restore` | "I checked the {n} changed files that will be reset" | `git status --porcelain` | "I checked the changes that will be lost" |
| `git clean -f` | "I checked the {n} untracked files that will be deleted" | `git clean -n` with the same flags | "I checked the files this will delete" |
| `rm` | "I checked the {n} paths that will be deleted" | literal arguments (no glob expansion) | "I checked what this will delete" |
| SQL writes | "I checked which database this runs against" | none | same |
| terraform apply/destroy | "I checked the plan for this workspace" | none | same |
| deploy and publish | "I checked where this deploys" / "I checked the version being published" | none | same |
| any other Destructive | entry `confirm`, else "I checked what this command will change" | | |

The deck runs these count commands with the safe git flags from [08-security.md](08-security.md) section 4.8 and never runs anything that changes state to compute a label.

## 9. Revoke

Decided: Revoke is a neutral outline button with an ellipsis ("Revoke…"), red only in the confirm step. Copy from [screens/settings.md](screens/settings.md): title "Revoke Bash(cargo test:*) in rustot?", body "Removes the rule from ~/dev/rustot/.claude/settings.local.json. Claude Code will ask again for this command, also in a plain terminal.", buttons "Cancel" (focused) and "Revoke rule".

Procedure (Proposed): the 7.2 steps 1 to 8 with step 5 replaced by "remove the exact string"; if the entry is already gone, report "already removed" and refresh the mirror ([04-integrations.md](04-integrations.md) section 2.4). The rule machine returns to `counting(0)` (state-machines 2.8). Whether a Claude Code session that is already running picks up a revoked or added rule without a restart is not verified (APR-O7); until it is, the revoke toast adds "Running sessions may keep the old rule until they restart."

## 10. Failure modes

| Failure | What could go wrong | Prevention and detection | What the user sees |
|---|---|---|---|
| Wrong tier, too low | A Destructive command classified Safe could be batched, approved from a popup or become a rule | Highest tier wins; floors; unknown and unparsable are Caution; the tier can only rise during a request; classification corpus in CI; design-oversight review (section 12) | Tier badge and "Why" tooltip on every row; audit records the matched entry for later correction |
| Wrong tier, too high | Friction: Safe work shows as Caution, no batch, no suggestion | Corpus cases for common owner commands; user entries in tiers.json | Caution row; the user can add a Safe entry |
| Prompt changed on screen | The session showed a new prompt (a second subagent request, a Destructive one) between render and click | `screenMatch` checked by deckd at write time with `expectPrompt`; Destructive checkbox resets when the summary changes; option digits come from the parsed screen | "The terminal is showing a different prompt. Open terminal."; row returns to waiting with the new request listed |
| `did_not_land` | Keys lost, screen parser wrong for this Claude Code version, prompt answered in the same instant | 3 s verification; no automatic retry; "Try again" only when still `on_screen` | "Your answer did not reach rustot. The prompt is still open in its terminal." + "Try again", "Open terminal" |
| User typed at the same time | Browser digit and terminal keys interleave; a stray digit lands in the input line | 1 s typing guard; collision indicator "Both typing: last keystroke wins" (state-machines 3) | Guard message, or the stray character visible in Focus (accepted risk, state-machines 2.9 case 2) |
| Screen parse failed | Options not readable (new Claude Code layout) | Parser versioned with screen fixtures; never guess | "Answer in the terminal", no buttons |
| deckd down | No screen model, no key delivery | Send guard 3 | "deckd is reconnecting. Answer in your terminal for now." |
| tiers.json invalid | Parse or schema error after an edit | Keep last valid set; never more permissive | Settings banner with the line number |
| settings.local.json unreadable, symlinked or changed during write | Lost rules, clobbered unrelated file | 7.2 steps 2, 3 and 7; backup before every write | "Could not write {path}: {error}. Nothing changed." |
| Rule written but Claude Code still prompts | Syntax form not supported by the installed Claude Code | Counter keeps rising for a pattern already in the file | Settings row note "Claude Code still asked for a command this rule should allow" (Proposed) |
| Agent tries to approve itself | Agent reads the token or talks to deckd | Deck-controls floor (Destructive) on any command, path or URL naming them; see [08-security.md](08-security.md) section 3.6 for the limits | Destructive row naming the deck file or port |

## 11. Audit trail (Proposed)

Every decision about a request or rule is recorded in the deck database ([06-storage.md](06-storage.md)), table `approval_audit`, append only:

| Field | Notes |
|---|---|
| `at`, `kind` | `answered`, `refused`, `did_not_land`, `expired`, `rule_added`, `rule_revoked`, `rule_found`, `tiers_loaded`, `tiers_rejected` |
| `requestId`, `sessionId`, `repoId` | when applicable |
| `tier`, `reasons` | tier at the moment of the event and the matched entry ids |
| `via` | `browser`, `terminal`, `popup`, `batch`, `settings` |
| `choice`, `optionLabel` | as parsed from the screen |
| `confirmLabel` | the exact checkbox text shown for Destructive allows |
| `summary` | the command, path or URL, redacted with the log redaction rules ([08-security.md](08-security.md) section 4.10) |
| `rulePattern`, `settingsPath`, `beforeSha256`, `afterSha256`, `backupPath` | rule events |
| `tiersSha256` | the effective tier set in force |

Retention: rule events forever (tiny, like the session summary row); request events 30 days, same as the event stream (Decided retention for detail data). APR-O8 confirms. Surfaced in M3 through `fleetmates-deck audit [--repo <name>] [--since <date>]`; a UI view is later.

## 12. Design-oversight review before M3 (Open)

During design the assistant recommended running the ai-design-skills design-oversight review on the tiers before M3, "since that's where a wrong default costs you data"; it has not been run (Q4). This document's defaults are an input to that review, not its outcome. M3 must not ship answering from the deck until the review has signed off (APR-O1).

Questions the review must answer:

1. Is "Safe" acceptable for commands that run code the agent can edit (`cargo test`, `npm test`, `pytest`, `go test`, `npm run <script>`)? The tier names intent and blast radius, not a sandbox.
2. In-repo file edits Safe (APR-O2) and `git add` / `git commit` Safe (APR-O3).
3. Network-to-interpreter as Destructive (APR-O4).
4. Layered tiers.json and non-disablable floors (APR-O5).
5. `rm` of build output (`rm -rf target/`) as Destructive: Decided copy says "rm"; confirm the friction is wanted.
6. Read-only `psql` as Caution rather than Safe.
7. The deck-controls floor wording shown to the user.

The review also runs the classification corpus (section 13) and adds cases for every disagreement.

## 13. Tests (Proposed)

- `hub/test/fixtures/tiers/cases.jsonl`: one line per `{ toolName, toolInput, cwd, expected, reasons }`; at least every row of section 4.4, every Destructive entry with and without compound wrapping, every floor, and parser torture cases (quotes, escapes, heredocs, `$( )` nesting, unicode lookalikes, U+202E in arguments). Runs on every PR.
- Property test: for random compounds of corpus commands, the tier equals the maximum of the parts.
- Settings writer: round-trip fixtures (missing file, empty object, existing deny/ask/hooks keys, wrong types, invalid JSON, symlinked file, symlinked `.claude`, concurrent write) assert every other key is byte-identical after write and revoke.
- Pinned Claude Code tests: rule syntax accepted, chained command not approved by a prefix rule, option 2 writes to the same file.
- Delivery tests with the fake `claude` binary: prompt swapped between render and send, typing collision, lost keys ([09-testing.md](09-testing.md)).

## Open items

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| APR-O1 | Run the ai-design-skills design-oversight review of tiers and defaults (Q4) | Defaults in 4.3 used for M1 display only; answering from the deck stays off | M3 |
| APR-O2 | Are file edits inside the repo scope Safe (batchable, popup) or Caution? | Safe, no rule candidate | M3 |
| APR-O3 | Are `git add` and `git commit` (no `--amend`, no `--no-verify`) Safe? | Safe, no rule candidate | M3 |
| APR-O4 | Is piping network content into an interpreter (`curl ... \| sh`) Destructive or Caution? | Destructive | M3 |
| APR-O5 | tiers.json as a layer over shipped defaults with non-disablable floor entries, instead of a full copy the user owns | Layered, floors fixed | M1 |
| APR-O6 | Key sequences for AskUserQuestion with several questions or multi-select options | "Answer in the terminal" for those prompts | M3 |
| APR-O7 | Does a running Claude Code session pick up an added or revoked rule without restart? | Assume not; toast says so | M3 |
| APR-O8 | Audit retention: rule events forever, request events 30 days | As stated | M3 |
| SM-O9 | Caution from a popup ([state-machines](interaction/state-machines.md) section 13) | No, "Open" only | M3 |
| SM-O10 | Terminal approvals count toward rule suggestions | Yes | M3 |
| SM-O11 | Pattern for a Safe request with no entry | No suggestion | M3 |
| SET-O4 | Threshold options 5 / 3 / Never and re-offer after dismissal ([screens/settings.md](screens/settings.md)) | As designed | M3 |
| DRW-O1 | Source of counts in the Destructive checkbox label ([screens/needs-you-drawer.md](screens/needs-you-drawer.md)) | Templates in section 8 with fallbacks | M3 |
| DRW-O2 | Per-pattern description line | `description` field in tiers.json | M3 |
