# Headless driver — the OpenCode adapter — design

Date: 2026-11-02. The third harness after Codex and Cursor, asked for by
`docs/followups/2026-11-02-deepseek-and-opencode-next-steps.md` section 3. It implements the
adapter interface fixed by `docs/specs/2026-09-14-headless-driver-codex-design.md` (the "Codex
spec") and follows `docs/specs/2026-09-16-headless-driver-cursor-design.md` (the "Cursor spec")
wherever the two harnesses share a problem, which is most of them: neither has an operating system
sandbox strong enough to be the only barrier, and neither can be handed a result schema.

Everything marked **not measured** below is exactly that. The measurements were taken with no paid
credential, so every path that needs one (a successful turn, token usage, a model refusal) is
unverified and is implemented defensively. Nothing in this document borrows Codex's or Cursor's
behaviour to fill such a gap.

## Decisions already made

| Question | Decision |
|---|---|
| Which product line? | **OpenCode 2.2.5**, npm `@opencode/cli`. The 1.x line (`opencode-ai`) is a different CLI and is out of scope. |
| Security bar? | Lower than Codex and Cursor, and said so out loud: OpenCode has **no operating system sandbox**. The default is the most restrictive arrangement that could be sustained with evidence; the weak one is opt-in only. |
| Sandbox layout? | **Git-less checkout only** (`files`, and the opt-in `none`). The isolated-clone layouts are refused (§2). |
| Who commits? | The host, from the checkout, through the shared `commitFilesTree` — as for Cursor. |
| Scope of "runs on OpenCode"? | OpenCode as a **teammate backend** driven by `dispatch --harness opencode`. The orchestrator stays whatever harness the user drives. |
| Required role policies? | Refused. `resolveRoleCapabilities` knows only Codex and Cursor, and OpenCode cannot enforce a capability contract anyway (§4.6). |

## 1. Measured on this machine (opencode v2.2.5, Linux x64, Node v24.11.0)

Taken from `/workspace/research/opencode-v2-measured.md` plus the runs made while implementing
this adapter. Each item was executed, not read.

1. **Headless invocation.**
   `opencode run --standalone --format json --auto -m <provider/model> "<prompt>" </dev/null`.
   `--format` accepts only `default` and `json`.
2. **`--standalone` is required.** It is a global flag available on `run`. Without it the run talks
   to the user's shared background server and inherits that server's config and permissions, so the
   policy this adapter sets would not apply. The adapter always passes it.
3. **stdin is concatenated to the prompt.** A non-TTY stdin is read to EOF and appended to the
   message, so the child's stdin is `ignore` (`</dev/null`) and the prompt travels in argv.
4. **There is no `--dir` on `run` in 2.2.5.** `opencode --help` shows a positional `[<directory>]`
   on the root command only; `run` has none. The working directory comes from the process.
5. **The model reference is `provider/model#variant`.** From `opencode run --help`: "Model to use in
   the format provider/model#variant". A model id validator must therefore accept `#`.
6. **`-s <id>` creates the session when it does not exist.** `--session` is documented as "Session
   ID to continue, or to create if it does not exist" — unlike 1.x, which failed with
   "Session not found".
7. **Exit codes.** Provider error (`provider.no-route`): 1. Free-tier limit (429): 1. Malformed
   model id: 1. Unknown flag: 1, with the whole help text printed on **stdout**.
   **Not measured:** the exit code of a successful run, of a model refusal, and of SIGINT.
8. **The event stream.** One JSON object per line on stdout, envelope
   `{"type":…,"timestamp":…,"sessionID":…,"part"|"error":…}`. Observed live:

       {"type":"step_start","timestamp":…,"sessionID":"ses_…","part":{"id":"prt_…","sessionID":"ses_…","messageID":"msg_…","type":"step-start"}}
       {"type":"error","timestamp":…,"sessionID":"ses_…","error":{"type":"provider.free-limit","message":"Free usage limit reached…","status":429,"response":{"body":"…"},"retryAfterMs":80668000}}
       {"type":"error","timestamp":…,"sessionID":"","error":{"type":"unknown","message":"Invalid model reference: lixo"}}

9. **`error.type` is a usable taxonomy**, and it, not the exit code, is the signal: observed
   `provider.no-route`, `provider.free-limit` (carries `status: 429` and `retryAfterMs`) and
   `unknown`.
10. **`sessionID` can be the empty string** on an early error (item 8, third line). An adapter must
    not take the first `sessionID` it sees as the session id.
11. **`part.type` is hyphenated (`step-start`) while the envelope `type` is underscored
    (`step_start`)**, in the same event. The two spellings are kept apart in the code on purpose.
12. **Non-JSON text shares the stdout** with the NDJSON (item 7, the help text). The parser skips a
    line that does not parse instead of stopping.
13. **There is no final result event.** The turn ends at EOF.
14. **Events can arrive out of order.** In the free-limit run above the `error` line (timestamp
    …732574) was printed *before* the `step_start` line (…732233). No reader may assume ordering by
    timestamp, or that `step_start` opens a turn.
15. **`OPENCODE_CONFIG_CONTENT` is accepted by `run`** and does not have to be a file:
    `{"snapshot":false,"permission":{…}}` in the environment ran without complaint.
16. **`"snapshot": false` stops the snapshot.** An earlier run (no snapshot setting) carried
    `part.snapshot: "4b825dc6…"`, the empty-tree hash; with `"snapshot": false` in
    `OPENCODE_CONFIG_CONTENT` the `step_start` part had no `snapshot` field at all.
17. **No credential is required to start a run.** `opencode auth list` printed
    `No authenticated integrations` and exited 0, and `run` still executed on a free tier until it
    hit `provider.free-limit`.
18. **State paths** (`opencode debug paths`): data `~/.local/share/opencode`, config
    `~/.config/opencode`, state `~/.local/state/opencode`, cache `~/.cache/opencode`, tmp
    `/tmp/opencode`, db `~/.local/share/opencode/opencode.db`. Sessions live in that SQLite file,
    and so does `auth.json`, in the data directory.
19. **Subcommands in 2.2.5:** `run`, `session`, `auth`, `models`, `plugin`, `mcp`, `debug`, `acp`,
    `stats`, `api`, `service`. There is no `serve`.

### 1b. Not measured

These need a paid credential or an environment this container did not have. They are implemented
defensively and are named again where they are used:

- the exit code of a successful run, of a refusal, and of SIGINT (item 7);
- the shape of the `text`, `tool_use` and `step_finish` events, and of
  `step_finish.part.tokens`, which `readUsage` sums (§4.4);
- whether the shell tool can in practice leave the checkout, with or without the deny rules;
- whether `<git-common-dir>/opencode` is written (it did not appear in a repository with no
  successful run);
- whether user-level plugins and MCP servers load in a headless run;
- the exact glob semantics of a `bash` permission pattern (`"git commit *"` versus `"git commit"`);
- `--fork`, and a resume against a session id that really exists;
- what `opencode auth list` prints when a credential IS configured — only the empty case was seen.

## 2. Why this layout

OpenCode's own permission rules are `allow`/`ask`/`deny` pattern matching over tool calls. They are
not isolation: a `bash` command can `cd`, run a script, or run a program that writes anywhere the
user can. There is no seatbelt, no landlock, no container.

| Layout | Verdict | Reason |
|---|---|---|
| Codex-style clone with the `.git` pointer | rejected | Nothing stops the teammate's shell from writing into that git directory's `config` and running a filter the next git command executes. OpenCode's own git calls (`rev-parse --show-toplevel`) run outside any confinement because there is none. |
| Clone with the pointer removed | rejected | Same exposure, and the shell would need `GIT_DIR` to commit, which hands the teammate the git directory anyway. |
| **Git-less checkout, deny rules, host commits** | **chosen (`files`, default)** | No repository in the workspace, so a planted git config has nothing to act on; the gate still reads commits the host made from bytes it read itself. |
| The same checkout with no deny rules | **opt-in only (`none`)** | Honest name for "nothing is enforced". Never selected automatically; `probe` says so on every dispatch. |
| A container or `bwrap`/`sandbox-exec` wrapper | out of scope here | The followup lists it as the low-risk option. It is a separate piece of work: it adds a runtime dependency and per-platform code, and it would wrap any harness, not just this one. |

The same principle the Codex adapter applies to `danger-full-access` applies here: the weak mode
exists, it is reachable only through explicit configuration, and no code path picks it.

Cost: an OpenCode teammate cannot commit, so a task lands as one host-made commit.

## 3. Components

- **`scripts/harnesses/opencode.mjs`** — the only module that knows the OpenCode CLI. Exports
  `opencodeAdapter` with `probe`, `makeSandbox`, `collect`, `cleanup`, `spawn`, `resume`,
  `readResult`, `readUsage`, plus `readError` (§4.4).
- **`scripts/harnesses/index.mjs`** — registers `opencode`.
- **`scripts/config.mjs`** — `KNOWN_HARNESSES` gains `opencode`;
  `HARNESS_SANDBOXES.opencode = ['files', 'none']`.
- **`scripts/harnesses/files-sandbox.mjs`** — `CONTROL_PATHS` gains `.opencode` and `opencode.json`
  (§4.2). Everything else there is reused unchanged.
- **`scripts/capability-preflight.mjs`** — the `harness` capability probes `opencode auth list` for
  this harness instead of `cursor-agent status`.

## 4. The adapter

### 4.1 Argv and environment

Spawn:

    opencode run --standalone --format json --auto [-m <provider/model#variant>] -- <prompt>

Resume: the same, plus `-s <sessionId>`. The child's cwd is the checkout, its stdin is `ignore`
(item 3), and the prompt is a positional argument after `--`, so a prompt starting with a dash is
still a prompt.

`buildSpawnArgv` / `buildResumeArgv` are pure and exported. `assertSafeArgv` refuses `--server`,
`--continue`/`-c`, `--fork`, `--agent` and `--wizard`, and refuses an argv that is missing
`--standalone` or `--format json`, so a later edit cannot silently reintroduce item 2. A model that
is not one bounded token (`#` included, item 5) is refused, never repaired.

`--auto` is mandatory, not a loosening: without it every "ask" is auto-rejected with nobody to
answer, and a headless teammate cannot work at all. The denies below are what `--auto` must not
override.

Environment of the child (`childEnv`):

| Variable | Value | Why |
|---|---|---|
| `OPENCODE_CONFIG_CONTENT` | the policy of §4.2 | item 15; it is the second-to-last config layer, so it beats the user's global and project config |
| `OPENCODE_DISABLE_AUTOUPDATE` | `1` | the version is pinned and checked (§4.5); an autoupdate would move it under the run |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `1` (checkout modes only) | the project config layer is read from the teammate-writable checkout |
| `OPENCODE_DISABLE_CLAUDE_CODE` | `1` (checkout modes only) | otherwise `.claude` material in the checkout, which the teammate can write, is read as instructions and skills |

A `full` sandbox (reviewers, the integrator) is the user's own repository, so it keeps the project
and `.claude` layers and gets only `snapshot: false`.

**Not isolated:** the data directory, the session SQLite database and the cache are shared between
every teammate on the host (item 18). Redirecting them with `XDG_DATA_HOME` would also hide
`auth.json`, so the adapter leaves them alone. Concurrent teammates therefore share one database.

### 4.2 Policy, scrub and control paths

The policy (`configContent`), for `files`:

```json
{ "snapshot": false,
  "permission": {
    "external_directory": "deny",
    "webfetch": "deny", "websearch": "deny",
    "bash": { "*": "allow", "git commit": "deny", "git commit *": "deny", "…": "deny" } } }
```

- `snapshot: false` — item 16. Without it OpenCode keeps a parallel snapshot repository over the
  checkout.
- `external_directory: deny` — its only path-scoped rule. It is pattern matching over parsed paths,
  **not** confinement, and is documented as such.
- `webfetch`/`websearch` are denied unless `harnesses.opencode.network` is true.
- `bash` is `allow` by default in OpenCode, which means the model can run `git commit` by itself.
  The gate is computed from git and tolerates no commit the host did not make, so every
  ref-moving git command is denied, in both the bare and the argument form:
  `git commit|push|checkout|switch|branch|reset|rebase|merge|tag|update-ref|cherry-pick|am`.
  The exact glob semantics of these patterns are **not measured** (§1b); the two forms are listed
  because the last matching rule wins.

In `none` mode only `snapshot: false` is sent. That is what the mode means.

`CONTROL_PATHS` gains `.opencode` and `opencode.json`: a teammate that plants a plugin, an MCP
server or an agent definition there executes code inside the next `opencode run`. They are scrubbed
from the checkout before every spawn and every resume, scrubbed again at collect, and taken from
the run branch rather than from the checkout at commit time, exactly as the Cursor spec §4.2
describes for `.cursor/`.

Unlike Cursor, this adapter writes **no** file into the checkout — the policy travels in the
environment — so any control path found at collect is the teammate's work: `collect` throws
`control-path: <paths>`, writes a refusal marker next to the checkout (the scrub that detects the
violation also removes the evidence), and every later spawn, resume and collect on that checkout
refuses too.

### 4.2a Checkout location

`$XDG_CACHE_HOME/fleetmates/opencode/<sha256(runRepo)[:16]>/<runId>/<taskId>`, outside the run repo
and never in a temp directory. `makeSandbox` walks the ancestors for a `.git` marker (a filesystem
check, no git command) and refuses with that repository's path: OpenCode resolves its project with
`git rev-parse --show-toplevel` from the cwd, so a checkout inside a repository would be read as
part of that repository. Whether it also writes `<git-common-dir>/opencode` there is **not
measured**.

### 4.3 Commit

`commitFilesTree`, unchanged and shared with Cursor: the host hashes the bytes it read itself with
filters off, assembles the tree in a private index, and never points git at the checkout.

### 4.4 Data flow

- **Session id** — the first event whose `sessionID` is a **non-empty** string (item 10).
  `null` when the stream never carried one.
- **Turn boundary** — OpenCode emits no trustworthy "turn started" event (items 13 and 14), so
  before each spawn and each resume the host appends one line of its own to the stream file,
  `{"type":"fleetmates.turn","bytes":…}`. The last turn is everything after the last such line.
  This is what keeps a resume that produced no answer from returning the previous turn's answer.
- **Result** — OpenCode has no output-schema flag, so the contract is in the prompt
  (`RESULT_INSTRUCTION`), as for Cursor. `readResult` reads the last turn, returns `null` when it
  holds any `error` event, and otherwise takes the model's last `text` event (then, as a fallback,
  every `text` of the turn joined) and accepts the first candidate — whole text, last fenced
  ```` ```json ```` block, or a JSON object ending the text — that validates against
  `RESULT_SCHEMA`. `null` → `orphaned`, never a throw. **The `text` event shape is not measured**:
  the reader takes `part.text` when it is a string and ignores everything else.
- **Errors** — `readError` returns the last `error` of the turn as
  `{ type, message, retriable, retryAfterMs }`. `provider.free-limit` and `provider.no-route` are
  `retriable: true`: they say nothing about the work, so they are infrastructure failures rather
  than a failed task. The adapter interface has no channel for that distinction today, so
  `readResult` still returns `null` and the task is `orphaned`; `readError` exists so the reason is
  recoverable from the stream by a caller or by hand. The exit code is deliberately not the signal
  (item 7).
- **Usage** — `readUsage` sums `step_finish.part.tokens` over the whole stream file (so a resume's
  turns add up), mapping `input`, `output`, `reasoning`, `cache.read` → `cachedInput` and
  `cache.write` → `cacheWrite`. `null` when no such event exists. **Not measured** (§1b): the field
  names come from OpenCode's published event types and every missing field counts as zero.
- **Prompt precedence** — in a checkout the prompt is `FILES_PREAMBLE` + persona and brief +
  `RESULT_INSTRUCTION`, as for Cursor. `full` sandboxes get neither.
- **Model** — `harnesses.opencode.tierModels` maps `cheap`/`mid`/`capable` to full references, e.g.
  `"capable": "anthropic/claude-sonnet-5-5"`. Unmapped → no `-m`, and OpenCode picks its own
  default.
- **Effort** — `supportsEffort: false`. The reasoning variant is the third segment of the model
  reference (item 5), so it is chosen in `tierModels`, and the driver records `effortIgnored`.

### 4.5 Probe

Never runs an agent turn.

- `opencode --version` must start and must print a version. A major other than 2 is refused by
  name: the 1.x line is a different CLI. A 2.x build other than the measured `2.2.5` is accepted
  **with a warning**, because the event format carries no version guarantee.
- `opencode auth list` must exit 0 and must not say `No authenticated integrations` (item 17) →
  else `fix: "run: opencode auth login"`.
- The config home (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
  `~/.config/opencode`) must be writable.
- Every successful probe returns a `warning`, which `dispatch` prints: OpenCode has no operating
  system sandbox. With `sandboxMode: 'none'` the warning says that the permission rules are off as
  well and the teammate runs with the user's full access. A managed config directory
  (`/etc/opencode`) is named too: it is merged after `OPENCODE_CONFIG_CONTENT` and can re-allow
  what the adapter denies.

### 4.6 Required role policies

Refused. `resolveRoleCapabilities` accepts only `codex` and `cursor`, and OpenCode could not honour
a capability contract anyway: its rules are pattern matching with no observable enforcement. Any
`enforcement` argument, any `sandbox.meta.enforcement`, and any bound `prerequisites.rolePolicy`
make the argv builders throw rather than quietly produce a legacy, unverified run.
`createVerificationExecutor` throws for the same reason.

## 5. Error handling

| Condition | Result |
|---|---|
| `probe` fails | `dispatch*` exits 2 before any checkout, printing `reason` and `fix`. |
| `probe` succeeds | `dispatch*` prints the no-sandbox warning every time. |
| `error` event in the turn (any `error.type`) | no result → `orphaned`; `readError` names the type and, for a 429, `retryAfterMs`. |
| Non-JSON line on stdout | skipped (item 12). |
| Control path touched by the teammate | `orphaned`, reason `control-path: <paths>`, no commit, checkout kept, refusal permanent. |
| Capture past `maxStreamBytes` | child SIGKILLed, `outputLimited` true, stream truncated exactly at the bound. |
| Argv missing `--standalone`/`--format json`, or holding a forbidden flag | internal assertion throws before spawning. |
| Required role policy | adapter throws (§4.6). |
| Timeout, driver kill, second driver, redirect | driver behaviour from the Codex spec, unchanged. |

## 6. Configuration

```json
{ "harnesses": { "opencode": {
  "sandbox": "files", "network": false, "timeoutMinutes": 90,
  "tierModels": { "cheap": "openrouter/…", "mid": "openrouter/…", "capable": "anthropic/claude-sonnet-5-5" }
} } }
```

- `sandbox` defaults to `files`. `none` is the opt-in weak mode. `clone` and `full` are refused with
  `OpenCode has no operating system sandbox; only "files" and the opt-in "none" are supported`.
- `network` decides whether `webfetch` and `websearch` are denied (§4.2). It cannot stop a shell
  command from reaching the network: there is no network sandbox.
- Same layering, validation and `config set`/`unset` rules as `harnesses.codex.*`.

## 7. Testing

`tests/harness-opencode.test.mjs`, against a fake `opencode` on `PATH` (as the Codex and Cursor
suites do), plus `tests/config.test.mjs` and `tests/files-sandbox.test.mjs` for the shared pieces.
Each test was watched failing with the code it covers broken, per `CONTRIBUTING.md`.

- Argv: exact spawn and resume shapes; `--standalone` and `--format json` required; each forbidden
  flag refused; a model token with `#` accepted and a dashed or oversized one refused.
- Policy: the deny rules and `snapshot: false` reach the child's environment; `none` drops the deny
  rules; `network: true` drops the `webfetch`/`websearch` denies; project and `.claude` layers are
  disabled in a checkout and left alone in `full`.
- Session id: taken from the first non-empty `sessionID`, not from the empty one of an early error.
- `readResult`: raw JSON, fenced JSON, prose, an `error` event, a non-JSON line between events, and
  a resume that produced no answer after one that did.
- `readError`: `provider.free-limit` is retriable and carries `retryAfterMs`; `unknown` is not.
- `readUsage`: two `step_finish` events summed; none → `null`.
- `probe`: a 1.x version refused, a 2.x drift warned, no authenticated integrations refused, an
  unwritable config home refused, the no-sandbox warning always present, `none` warned about
  explicitly.
- Sandbox: `clone` and `full` refused; a checkout inside a git repository refused by name; collect
  refuses a planted `.opencode/plugin.js` or `opencode.json` and creates no branch; the refusal
  survives the scrub.
- Control paths: `.opencode` and `opencode.json` scrubbed, kept from the run branch, never added.

An opt-in end-to-end suite against a real OpenCode is **not** part of this work: every run on this
machine ends in `provider.free-limit`, so there is nothing to assert that would not be inventing
the result.

## Out of scope

- Running the orchestrator inside OpenCode (fleetmates as an OpenCode plugin).
- A container or `bwrap`/`sandbox-exec` wrapper, which would make this harness as strong as Codex.
- The OpenCode server mode (`service`, `api`), per-permission approval and session diffs.
- OpenCode 1.x.
- Per-teammate isolation of the OpenCode data directory and session database.
- Mixed-harness fleets.
