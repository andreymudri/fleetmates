# 09 · Testing strategy

Status labels as in [02-domain.md](02-domain.md). **Decided**: the fake `claude` binary for PTY tests, Playwright UI tests, hook payload fixtures pinned per Claude Code version (a Claude Code update that changes hooks must fail CI) with the First run compatibility check against them, scribed contract tests replaying fixtures derived from TurbidAssist's `protocol.py`, a pinned tested Claude Code version, golden queries in vault-mcp for search misses, and the M1 done criterion (3+ parallel sessions for a full work week without opening a pane to check status). Everything else here (tools, layouts, formats, thresholds, CI jobs, the dogfood protocol) is **Proposed** unless marked.

Related: [03-architecture.md](03-architecture.md) (processes, layout, budgets), [04-integrations.md](04-integrations.md) (boundaries and their contract tests), [interaction/state-machines.md](interaction/state-machines.md) (the behaviour under test), [screens/README.md](screens/README.md) section 4 (UI fixtures), [qa/qa-checklist.md](qa/qa-checklist.md) (design QA), [08-security.md](08-security.md), [12-milestones.md](12-milestones.md), [13-operations.md](13-operations.md).

## 1. Principles

1. **Test the boundaries hardest.** The two contracts most likely to break change outside this repo: Claude Code hook payloads and TUI screens, and the scribed protocol (Decided: both get contract tests). vault-mcp and fleetmates run files are next.
2. **The state machines are the product.** The M1 acceptance test depends on the session and request machines never showing a wrong "needs you" and never hiding a real one ([state-machines](interaction/state-machines.md) 1.1). They get the densest unit and property tests.
3. **No real Claude in CI.** Every automated test runs against the fake `claude` binary and captured fixtures. Real Claude Code is exercised only by the capture script and the manual smoke on the owner's machine (section 5.4), because CI has no subscription login (TEST-O1).
4. **Follow the fleetmates house rules** ([reference/fleetmates-contract.md](reference/fleetmates-contract.md), Tests): `node:test` + `node:assert/strict`, one test file per module, and every new test is mutation-verified ("would this test fail if the code were wrong").
5. **Deterministic by construction.** Frozen clocks (`node:test` mock timers, Playwright `page.clock`), seeded graph layouts, fixed terminal buffers, temp `HOME` and `XDG_RUNTIME_DIR` per test. No test touches the real `~/.claude`, `~/.config` or vault.

## 2. Test pyramid and tools

| Layer | Runner | What it covers | Where | Runs |
|---|---|---|---|---|
| Unit | `node:test` | Pure modules: state machine reducers, ingest (reorder buffer, dedupe, alias, late event rule), counts query, tier classifier, rule pattern generator, hook installer merge, settings file round trips, screen parsers, crash error mapping, crew hash and pixel maps (crew.md test vectors), i18n catalog checks, text parsers for vault-mcp answers, scribed codec, fleetmates adapter over fixture run dirs, config loader | `hub/test/unit/**/*.test.mjs` | every PR |
| Contract | `node:test` | Hook fixtures per Claude Code version, screen fixtures per version, `claude -p` stream fixtures, scribed fixtures from `protocol.py`, vault-mcp tool schema snapshot, fleetmates export surface | `hub/test/contract/**/*.test.mjs` | every PR |
| Integration | `node:test` | Real web server + real SQLite in a temp dir + fake deckd or real deckd; real `deck-hook` process to `hooks.sock` to WebSocket; deckd + `node-pty` + fake `claude`; web server restart with live PTYs; security probes | `hub/test/integration/**/*.test.mjs` | every PR |
| UI end to end | Playwright, Chromium | Every acceptance criterion in the screen specs, against the fixture server; axe; XSS; counts property test; keyboard map; visual regression | `hub/test/e2e/**/*.spec.mjs` | every PR (visual phase 2 gates only; see 7) |
| Real-stack smoke | Playwright + `node:test` | deckd + server + browser + fake `claude` end to end (no fixture adapter) | `hub/test/smoke/` | every PR |
| Performance | `node:test` harnesses + Playwright | Budgets from [03-architecture.md](03-architecture.md) section 7 | `hub/test/perf/` | nightly and before a release |
| Manual | checklists | Real Claude Code smoke, dogfood week, design QA, Orca, Firefox | this doc 5.4 and 12, [qa-checklist](qa/qa-checklist.md) | per milestone |

Tool choices (Proposed):

- **`node:test`** for server, deckd, hook, adapters and the web app's plain-JS state layer (`hub/web/src/state/` reducers are framework-free and import cleanly into Node). This matches fleetmates and adds no dependency.
- **Playwright with Chromium** (`playwright` is already a Proposed dev dependency in 03-architecture section 3) for everything rendered. Chromium is the only CI browser; Firefox stays a manual pass per qa-checklist 1.10 (TEST-O5).
- **`@axe-core/playwright`** for accessibility (new Proposed dev dependency; add it to the 03-architecture dependency table in the PR that introduces it).
- **ESLint** (with `react/no-danger`, a JSX text-literal rule for i18n) and **Stylelint** (`declaration-strict-value`) for the static checks the qa-checklist marks **auto**. The fleetmates root has no linter; these are hub-only dev dependencies.
- **JSDoc type check**: `tsc --noEmit -p hub/jsconfig.json` (`checkJs: true`, `strict: true`, 03-architecture section 3). `typescript` is a dev dependency used only as the checker.

Test isolation helpers (Proposed), in `hub/test/helpers/`:

| Helper | Does |
|---|---|
| `tmpHome()` | Temp dir used as `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` (mode 0700), removed after the test |
| `fakeBin(dir, name, script)` | Writes an executable shim on a temp `PATH` (used for `claude`, `notify-send`, `pw-play`, `systemctl`, `makoctl`, `xdg-open`) that records argv, env subset and stdin to a JSONL log |
| `startServer(opts)` | Starts the web server on port 0 with a given fixture adapter or real adapters, returns `{ url, token, ws(), stop() }` |
| `startDeckd(opts)` | Starts deckd on a temp socket, returns a client |
| `gitRepo(spec)` | Creates a temp git repo (fleetmates tests need a git identity; set it in the helper, not globally) |
| `fixtureRun(name)` | Copies `hub/test/fixtures/fleetmates/runs/<name>` into a temp repo |

## 3. The fake `claude` binary (Decided; design Proposed)

### 3.1 Purpose

A scripted stand-in for Claude Code that behaves, at the PTY and hook level, like the pinned Claude Code version: it draws the TUI states the deck parses, fires the configured hooks with version-accurate payloads, reads keystrokes, and exits the way the real one exits. It lets CI test deckd, screen parsing, request delivery, the typing guard, shared input, crash mapping and the Ask engine without a Claude login.

### 3.2 Location and invocation

- `hub/test/fake-claude/fake-claude.mjs`, exposed as `claude` through `fakeBin()` on the test `PATH`.
- Scenario from `FAKE_CLAUDE_SCRIPT=<path>` (a JSON file under `hub/test/fixtures/scripts/`). Output log (every input chunk with a timestamp, every hook fired, every resize) to `FAKE_CLAUDE_LOG=<path>`. Version set from `FAKE_CLAUDE_VERSION` (default: the newest fixture set).
- `claude --version` prints `<version> (Claude Code)` in the format the real binary uses at that version (captured with the fixtures).
- `claude -p ...` switches to Ask engine mode (3.6).
- Fires hooks for real: it reads `hooks` from `$HOME/.claude/settings.json` (and `.claude/settings.local.json` in `cwd`), and for each event runs the configured command with the payload on stdin, honouring `async` and `timeout`, and with its own environment (so `FLEETMATES_DECK_PTY`, 03-architecture 2.1, reaches `deck-hook`). This exercises the real installer output and the real `deck-hook` script.

### 3.3 Frames: replayed, not drawn

The fake never hand-draws the TUI. Screen states are byte streams captured from the real Claude Code by the capture script (section 5.2): `hub/test/fixtures/screens/<cc-version>/<frame>.ansi`. A step names a frame and optional template variables (the command text, the question text); the capture stores placeholders at the positions where those strings appeared. This keeps the parser tests honest: they parse what Claude Code actually prints.

Frames required per fixture set:

| Frame | Real-world state | Parser output it must produce |
|---|---|---|
| `idle-input` | Empty input box after start or a finished turn | `S.ScreenIdle` after `screenIdleAfter` |
| `spinner` | Working, spinner and elapsed time redrawing every tick | nothing; redraws outside the status region do not count as activity (state-machines 1.10) |
| `tool-output` | Tool output scrolling above the input area | `P.Output` activity |
| `permission-bash-3` | Permission prompt with options `1 Yes`, `2 Yes, and don't ask again for <cmd>`, `3 No, and tell Claude what to do differently` (labels as printed by the pinned version) | `S.PromptVisible(options)` with each option's number and verbatim label |
| `permission-edit` | Permission prompt for a file edit (option set as printed by the version) | same, different labels |
| `permission-2` | A prompt variant that prints only two options, if the pinned version has one | options list of length 2; PromptBar must not invent a third |
| `question-options` | AskUserQuestion box with numbered choices and an "Other" free-text line | `S.PromptVisible` with `kind: question` |
| `question-text` | A turn that ends with a plain-text question ("Should I paginate or truncate?") and the idle box | no prompt; the `Stop` heuristic (SM-O3) decides |
| `elicitation` | MCP elicitation dialog, if capturable | question request |
| `compacting` | Compaction progress line | activity `compacting` |
| `trust-folder` | First-run "trust this folder" prompt in a new repo, if the version shows one | recognised and reported as a prompt the deck does not answer |

### 3.4 Script format (Proposed)

```json
{
  "version": "2.x.y",
  "sessionId": "auto",
  "steps": [
    { "hook": "SessionStart", "with": { "source": "startup" } },
    { "frame": "idle-input" },
    { "expectInput": { "match": "^fix the flaky combat test\\r$", "timeoutMs": 5000 } },
    { "hook": "UserPromptSubmit", "with": { "prompt": "$input" } },
    { "frame": "spinner", "forMs": 1500 },
    { "hook": "PreToolUse", "with": { "tool_name": "Bash", "tool_input": { "command": "cargo test --release combat::" } } },
    { "hook": "PermissionRequest", "with": { "tool_name": "Bash", "tool_input": { "command": "cargo test --release combat::" } } },
    { "hook": "Notification", "with": { "notification_type": "permission_prompt" } },
    { "frame": "permission-bash-3", "vars": { "cmd": "cargo test --release combat::" } },
    { "expectKey": { "1": "allowed", "2": "allowedAlways", "3": "denied", "timeoutMs": 60000 } },
    { "branch": {
        "allowed":       [ { "hook": "PostToolUse" }, { "frame": "tool-output" } ],
        "allowedAlways": [ { "hook": "PostToolUse" }, { "frame": "tool-output" } ],
        "denied":        [ { "hook": "PermissionDenied" }, { "frame": "idle-input" } ] } },
    { "hook": "Stop", "with": { "stop_hook_active": false } },
    { "frame": "idle-input" },
    { "exit": { "code": 0 } }
  ]
}
```

Step verbs:

| Verb | Effect |
|---|---|
| `hook` | Build the payload from the version's fixture for that event, merge `with`, fill `session_id`, `cwd`, `transcript_path`, `hook_event_name`, then fire the configured hook commands |
| `frame` | Write the frame bytes (with `vars`); `forMs` keeps redrawing the spinner region at the captured tick rate |
| `expectInput` | Wait for input matching a regex; record it; fail the scenario (exit 97, message on stderr) on timeout |
| `expectKey` | Wait for one key from a set; the label becomes the branch name |
| `branch` | Run the step list named by the last `expectKey` label |
| `sleep` | Wait (fake timers are not available across processes; keep sleeps short) |
| `print` | Write raw text (used for crash tails) |
| `newSession` | Rotate `session_id` (for `/clear`, `/resume`, fork, compaction id changes) |
| `subagent` | Fire the enclosed steps as subagent events (parent `session_id`, `SubagentStart` and `SubagentStop` around them) |
| `exit` | Exit with `code`, or die with `signal` (for example `SIGKILL` sent to itself), after optional `stderr` text |
| `hang` | Stop producing output and ignore input until killed |

### 3.5 Scenarios the fake must cover (Proposed minimum set)

| Script | Covers | Used by |
|---|---|---|
| `approve-safe.json` | Permission prompt, answer `1` from the browser, verification by `PostToolUse` | request machine, PromptBar, drawer (M3) |
| `approve-always.json` | Answer `2`; rule suggestion counter | rules (M3) |
| `deny-then-instruct.json` | Answer `3`, then the typed instruction | drawer "Tell Claude what to do instead" |
| `answered-in-terminal.json` | Prompt answered by a terminal client; browser answer must be refused | typing guard, `answered{via:'terminal'}` |
| `did-not-land.json` | Keystroke arrives but the prompt stays on screen | `delivery = did_not_land` after `verifyTimeout` |
| `question-options.json` | AskUserQuestion with choices | `asked_you`, Reply |
| `question-stop.json` | Turn ends with a `?` sentence | SM-O3 heuristic, false-positive counter |
| `idle.json` | Finished turn, idle box, no more events | `done` or `idle`, `doneDebounce` |
| `spinner-hang.json` | Spinner redraws forever, no hooks | goes `stale` after 20 min (fake timers on the server) |
| `crash-exit1.json` | `print` a stack trace, `exit 1` | crash card generic |
| `crash-enospc.json` | `print` "Error: ENOSPC: no space left on device, write" and a Node stack, `exit 1` | crash card ENOSPC mapping, "Show disk usage" primary |
| `crash-signal.json` | `exit { signal: "SIGKILL" }` with no user stop | `Crashed · signal SIGKILL`, OOM mapping |
| `stop-requested.json` | `U.Stop`, fake exits 143 | ended, no crash card |
| `clear.json` | `SessionEnd(clear)`, `newSession`, `SessionStart(clear)` | alias rule, requests expire |
| `compact.json` | `PreCompact`, `newSession` optional, `PostCompact` | activity `compacting`, not stale |
| `subagents-parallel.json` | Two subagents each open a permission request | two open requests, one on screen, matchKey closing |
| `slow-start.json` | No `SessionStart` for 31 s | `T.StartTimeout` |
| `out-of-order.json` | Hooks fired with shuffled delays | reorder buffer, late event rule |
| `resize.json` | Records SIGWINCH sizes | resize follows the last input source (SM-O12 default) |
| `echo.json` | Echoes every input byte immediately | keystroke latency budget, shared input |
| `long-output.json` | 20,000 lines | scrollback ring limits, memory |

Scripts that exist in `hub/test/fixtures/scripts/` after M3: `answered-in-terminal.json`, `approve-always.json`, `approve-safe.json`, `deny-then-instruct.json`, `did-not-land.json`, `echo.json`, `idle.json`, `question-options.json`, `resize.json`, `slow-start.json` and `subagents-parallel.json` from the table, plus two that are not in it:

| Script | Covers | Used by |
|---|---|---|
| `prompt-swap.json` | A Safe request (`npm run test`) is drawn, then a Destructive `PermissionRequest` (`rm -rf build`) replaces the frame before any answer; a `1` then allows the Destructive prompt | `hub/test/integration/deliver.test.mjs`, `answer-api.test.mjs` |
| `two-sources.json` | Echoes every input byte | the fake `claude` of `hub/test/integration/fm.test.mjs` (`fm claude`, `fm attach`) |

The M3 scripts (`approve-safe`, `approve-always`, `deny-then-instruct`, `answered-in-terminal`, `did-not-land`, `question-options`, `subagents-parallel`, `prompt-swap`) replay the 2.1.285 frames or the synthetic frames marked as synthetic (`synthetic-permission-bash`, `synthetic-permission-always`, D-95). The rest of the table (`question-stop`, `spinner-hang`, the three `crash-*` scripts, `stop-requested`, `clear`, `compact`, `out-of-order`, `long-output`) does not exist as a fake script; whether other tests cover those cases was not checked for this list.

### 3.6 Ask engine mode (`claude -p`)

With `-p`, the fake validates its argv against the invocation in [04-integrations.md](04-integrations.md) section 2.5 (fails with exit 98 on an unexpected tool or a missing `--strict-mcp-config`, so a regression that widens the Ask's tools fails a test), then replays a stream-json fixture from `hub/test/fixtures/claude-p/<cc-version>/<name>.jsonl` (`answer-cited`, `answer-miss`, `general-knowledge`, `error`, `timeout` via `hang`). The fixtures are captured from the real `claude -p` by the capture script.

## 4. Fixture layout under `hub/test/fixtures` (Proposed)

```
hub/test/fixtures/
  hooks/<cc-version>/                 # Decided: pinned per Claude Code version
    MANIFEST.json                     # claude --version output, capture date, capture script version, OS, redactions applied
    SessionStart.startup.json         # one real payload per event and variant
    SessionStart.clear.json
    SessionEnd.clear.json
    UserPromptSubmit.json
    PreToolUse.Bash.json
    PreToolUse.AskUserQuestion.json
    PostToolUse.Bash.json
    PostToolUseFailure.Bash.json
    PermissionRequest.Bash.json
    PermissionDenied.Bash.json
    Notification.permission_prompt.json
    Notification.idle_prompt.json
    Stop.json
    SubagentStart.json  SubagentStop.json
    CwdChanged.json  PreCompact.json  PostCompact.json
    sequence.approve-safe.jsonl       # a whole captured session, in arrival order, with hookTs
  screens/<cc-version>/
    <frame>.ansi                      # raw PTY bytes, placeholders for variables
    <frame>.expect.json               # parser output the frame must produce
  transcripts/<cc-version>/
    <scenario>.jsonl                  # Claude Code transcript captured with the hook set (04-integrations 2.6)
    <scenario>.expect.json            # tail reader output: why line, now line, endsWithQuestion, first user message
  claude-p/<cc-version>/<name>.jsonl  # stream-json output of the Ask engine
  scripts/<scenario>.json             # fake claude scenarios (3.5)
  scribed/<turbidassist-sha>/
    MANIFEST.json                     # TurbidAssist commit, protocol.py hash, exporter version
    commands.jsonl  events.jsonl  invalid.jsonl  scenarios/<name>.jsonl
  vault-mcp/<vault-mcp-version>/
    tools-list.json                   # tools/list snapshot (names, input schemas)
    answers/<tool>.<case>.txt         # real text answers for the deck's parsers
  vault/                              # small fixture vault (copy of vault-mcp's test/fixtures/vault shape)
  fleetmates/runs/<name>/.fleetmates/<runId>/plan.json, status.json
  settings/                           # ~/.claude/settings.json and .claude/settings.local.json variants
    empty.json  fleetmates-plugin-only.json  other-user-hooks.json  deck-installed.json
    deck-installed-old-path.json  malformed.json  comments-and-order.json
  ui/<fixture>.mjs                    # the screens/README section 4 fixtures (busy, calm, crowded12, ...)
  xss/strings.json                    # qa-checklist 1.7 payloads
```

Event and variant names follow the `hook_event_name` values in [04-integrations.md](04-integrations.md) section 2.1, which names the file pattern `<cc-version>/<event>.json`; the `.variant` suffix is an addition for events with several shapes.

Rules:

- Fixture sets are append-only. A new Claude Code version adds a directory; old ones stay so the ingest keeps accepting them (sessions started by an older binary can still be running).
- The **pinned tested version** (Decided that one exists; policy Proposed) is the newest `hooks/<cc-version>/` directory. It is also written to `hub/package.json` under `"fleetmatesDeck": { "testedClaudeCode": "<version>" }` so the First run check and `fleetmates-deck doctor` read it without scanning test files (the test directory is not shipped in the npm package).
- Redactions (applied by the capture script, listed in `MANIFEST.json`): `$HOME` to `/home/you`, session ids to fixed ULIDs, transcript paths to `/home/you/.claude/projects/fixture/<id>.jsonl`, prompts to fixed strings, any token-like string (40+ chars of base64 or hex) to `REDACTED`.
- UI fixtures (`ui/`) are data for the fixture adapter, not captures. They use the canvas data (screens/README section 4). Before the repo goes public, see TEST-O6 on real client and path names.

## 5. Claude Code: hook fixtures, screen fixtures and version pinning

### 5.1 What CI asserts (Decided: a Claude Code update that changes hooks fails CI)

For every `hooks/<cc-version>/` set, `hub/test/contract/hooks.test.mjs`:

1. **Shape**: each payload validates against the deck's hook schema, which lists only the fields the deck relies on ([04-integrations.md](04-integrations.md) section 2.1 last paragraph; [state-machines](interaction/state-machines.md) 0.2). A missing or retyped field fails.
2. **Ingest**: each payload, wrapped in an envelope by the real `deck-hook` code path, is accepted by ingest and never lands in `rejected_events` (state-machines 1.11 item 13).
3. **Sequence**: each `sequence.*.jsonl` replayed through the session and request machines produces the expected state trace (stored next to it as `sequence.*.expect.json`). This is the test that catches semantic drift, for example an event that stops firing.
4. **Screens**: each `screens/<cc-version>/<frame>.ansi` fed through `@xterm/headless` and the parsers equals `<frame>.expect.json`.
   - **Transcripts** (Proposed): each `transcripts/<cc-version>/<scenario>.jsonl` fed through the tail reader equals `<scenario>.expect.json`; unknown record types and a truncated last line are skipped, never fatal ([04-integrations.md](04-integrations.md) section 2.6).
5. **Installer**: the hook entries `init` writes are exactly the event list in 04-integrations section 2.1 (a test fails if the list and the installer diverge).

How a Claude Code change reaches CI: CI cannot run the real Claude Code (no login, section 1 principle 3). The chain is: the owner upgrades Claude Code locally, the First run check (or Settings, Connections) warns that the version is newer than the pinned one (SM-O18 default: warn only), the owner runs the capture script, commits the new fixture directory, and CI then fails if the new payloads or screens break ingest or parsing. A weekly `cc-watch` job (section 10) flags new Claude Code releases so the capture is not forgotten. TEST-O1 asks whether to add a credentialed live canary.

### 5.2 Capturing fixtures from a real Claude Code version (Proposed)

Script: `hub/test/capture/capture-cc.mjs`, run by the owner on his machine, on his subscription. Not run in CI.

1. Create a throwaway git repo in a temp dir with a small file set and a `.claude/settings.local.json` whose `hooks` register a capture hook (`hub/test/capture/capture-hook.mjs`) for every event in 04-integrations section 2.1. Project-level hooks keep the owner's user settings untouched.
2. Start the real `claude` (from `PATH`, version from `claude --version`) in `node-pty` at a fixed size (the size used by the UI fixtures), with a headless terminal attached.
3. Drive a fixed scenario by typing prompts that force known tool calls: a Bash command that needs permission (answer `1`, then again with `2`, then `3`), a file edit, an AskUserQuestion ("Use the AskUserQuestion tool to ask me to pick A or B"), a turn that ends in a plain question, `/compact`, `/clear`, then exit. Each step waits for the hook it expects, with a timeout; the operator confirms any step the model did not follow and can retry it. Model output varies; hook payload shapes and prompt frames are what is captured, and those do not depend on wording.
4. For each target state in the frame table (3.3), snapshot the PTY byte stream from the previous idle point, and store the parser's current output as the draft `.expect.json`. The operator reviews every draft expectation before committing.
   - Copy the session's transcript from `transcript_path` into `transcripts/<cc-version>/<scenario>.jsonl` and store the tail reader's output as the draft `.expect.json`, reviewed like the screen expectations. Verify in M0 which record types carry the assistant text.
5. Capture `claude -p` streams for the Ask fixtures with the exact invocation from 04-integrations section 2.5 against the fixture vault.
6. Redact (section 4), write `MANIFEST.json`, print a diff against the previous version's set (added, removed and retyped fields per event).
7. Run `npm test` in `hub/`. If ingest or parsers fail, fix them in the same PR as the fixtures.

The same script records option labels exactly as printed, which the PromptBar and drawer must mirror (Decided: same options, same numbers as the terminal).

As run in M3 (Task 19, D-83 as applied): the installed Claude Code was 2.1.285, not the pinned 2.1.282, and the owner chose to recapture on 2.1.285. The one authorized capture ran on 2026-10-02, unattended, at 120x40, and wrote `hub/test/fixtures/hooks/2.1.285/` and `hub/test/fixtures/screens/2.1.285/` with a `MANIFEST.json` that lists the redactions and the skipped steps. The script set an `ask` rule for each tool a step uses, so every step prompted. Steps `bash-2` (no `PostToolUse(Bash)`) and `bash-3` (no `PreToolUse(Bash)`) were skipped: the Bash prompt under an `ask` rule shows only "1. Yes" and "2. No", so there is no Bash option 2 label and no `option2-rule.json`. Edit and Write option 2 is "Yes, and switch to accept edits ..."; WebFetch option 2 is "Yes, and don't ask again for example.com". `testedClaudeCode` in `hub/package.json` moved to 2.1.285, and the 2.1.282 set stays as the earlier regression set. Several redactions were done by hand before commit and are listed in the manifest (compact summary and subagent message text, a claude.ai session link, prompt ids, the throwaway repo name); `capture-cc.mjs` does not do them yet ([m3-exit.md](m3-exit.md), open findings).

### 5.3 Claude Code upgrade procedure (policy Proposed)

1. Before upgrading, read the Claude Code changelog for hook and permission-prompt changes.
2. Upgrade, then open Settings, Connections (or `fleetmates-deck doctor`): check 1 shows "newer than this deck was tested with".
3. Run `capture-cc.mjs`; commit `hooks/`, `screens/` and `claude-p/` for the new version, bump `testedClaudeCode`, fix anything that fails.
4. Release a patch version of the hub package ([13-operations.md](13-operations.md) section 12).
5. Until then, drifted payloads are held in `rejected_events` and counted on check 1 ("3 hook payloads did not match the pinned fixtures"); nothing drifted is applied.

Holding Claude Code at the pinned version (disabling its auto-update) is an owner choice: OPS-O5 in 13-operations.

### 5.4 Manual real-Claude smoke (per milestone, Proposed)

Run on the owner's machine with the pinned version, 15 minutes, before each milestone exit and each release:

| Step | Pass |
|---|---|
| `fleetmates-deck init` on a clean `HOME` copy | hooks merged next to fleetmates' hooks, backup file present |
| Plain `claude` in a repo, ask for a Bash command | card goes Needs approval within the hook-to-UI budget; popup and bell |
| Answer in the terminal | request closes as answered via terminal; no second bell |
| `fm claude` (M2+) in a second repo, answer from the browser (M3+) | keystroke lands, PromptBar mirrors the terminal options exactly |
| `/clear` in a running session | same card, requests expired |
| Restart the web server unit | PTYs keep running; the browser reconnects and resyncs |
| Kill `claude` with `kill -9` | "Crashed · signal SIGKILL" |

## 6. scribed contract tests (Decided; design Proposed)

TurbidAssist has no JSON fixture files today; `realtime/scribe/protocol.py` is the single source of the wire format and is tested by its own pytest suite ([reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) sections 2.2 to 2.5, 2.13). The deck's fixtures are therefore **generated from `protocol.py`**, not hand-written.

1. **Exporter** (TEST-O3 on where it lives; default in TurbidAssist as `scripts/export_protocol_fixtures.py`): imports `scribe.protocol`, builds every `Command` and `Event` dataclass with representative values (Portuguese text with accents, int and float numbers, optional keys present and absent, empty lists, idle `status`), and writes `Message.encode()` output line by line to `commands.jsonl` and `events.jsonl`. It also writes `invalid.jsonl`: lines that `decode_command` or `decode_event` reject, each with the exact `ProtocolError` message. `MANIFEST.json` records the TurbidAssist commit and a hash of `protocol.py`.
2. **Scenarios**: the exporter also writes ordered exchanges the deck depends on: start then status recording then stop (with a long gap) then idle status; subscribe (one `status`, then `transcript` only); ask then `ask_delta` lines then `ask_done`; each command's `error` shape with Portuguese text.
3. **Deck tests** (`hub/test/contract/scribed.test.mjs`):
   - the Node decoder parses every `events.jsonl` line into the expected object and rejects every `invalid.jsonl` event line;
   - the Node encoder produces, for each command, JSON that parses equal to the fixture line and uses raw UTF-8 (no `\u` escapes for accents), one object per line;
   - unknown keys in an event are ignored, unknown `type` is an error (mirrors `protocol.py`);
   - a fake scribed server (`hub/test/fakes/fake-scribed.mjs`, a Unix socket replaying scenarios) drives the client through the meeting machine ([state-machines](interaction/state-machines.md) 6), including a `stop` that takes 30 s and a socket that disappears mid-recording.
4. **Drift**: when `protocol.py` changes, the owner re-runs the exporter and commits the new directory; CI fails if the client no longer matches. A root-level check is not possible in CI unless the pipeline can check out TurbidAssist (TEST-O3).

## 7. vault-mcp: golden queries and tool contracts

- **Golden queries (Decided)**: the vault-mcp repo already has `test/golden-queries.test.ts` with 10 `{ query, expectedTopPath }` entries and an assertion that the list has exactly 10 (reference contract 1.9). Process (Proposed): at each milestone exit from M5 on, export the search-miss log (MEM-O2 default: deck SQLite `Miss` table), and for each miss where the vault does contain the answer, add a golden query with the expected note path to vault-mcp (updating the length assertion). A golden query that BM25 cannot satisfy stays in the suite as a `todo` and is the evidence the "measure first" decision (Decided) asks for before any hybrid search. Misses where the vault truly lacks the content are research candidates, not golden queries.
- **vault-mcp changes** (`vault_learn` `preview`, `vault_graph`, `structuredContent`) carry their own tests in the vault-mcp repo, already listed in [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) sections 1.10 and 1.11 (dry run writes no byte, preview equals the real call, and so on).
- **Deck side** (`hub/test/contract/vault-mcp.test.mjs`): spawn the vault-mcp version pinned as a hub dev dependency against `fixtures/vault/`, snapshot `tools/list` (tool names and input schemas) into `fixtures/vault-mcp/<version>/tools-list.json`, and run the deck's text parsers on real answers. A vault-mcp release that renames a tool or changes an answer format fails here.
- **Performance**: the graph budget (section 9) runs against a generated 1,000-note vault.

## 8. fleetmates run files

- Adapter tests read fixture run directories (`fixtures/fleetmates/runs/`): missing optional fields (`gates`, `fixRounds`, `startedAt`, `blockedBy`, `runBranch`), unknown task states, nested run ids, `index/` skipped, a truncated JSON file (retry then error state), a FIFO in place of `status.json` (must not hang; `O_NONBLOCK` + `isFile()`), bidi controls in titles ([reference/fleetmates-contract.md](reference/fleetmates-contract.md) section 6 risks 1 to 11).
- The deck imports fleetmates modules (`state.mjs`, `liveness.mjs`, `names.mjs`, `git.mjs`). Proposed: a root-level `tests/deck-imports.test.mjs` (the root glob is `tests/*.test.mjs`, so it runs in the existing root CI on all three OSes) asserts that the exports the hub uses still exist with the same names. It needs no dependency, so it respects the root zero-dependency rule. A root refactor that breaks the hub then fails the plugin's own CI, not only the hub job.
- The deck never writes under `.fleetmates/`: an integration test runs every adapter against a read-only copy of a run directory.

## 9. Performance checks (Proposed)

Budgets are the Proposed ones in [03-architecture.md](03-architecture.md) section 7. Harnesses live in `hub/test/perf/`; the app emits `performance.mark` names (`deck:snapshot-received`, `deck:home-painted`) so browser timings do not depend on heuristics.

| Budget (03 section 7) | Harness | Method | Pass |
|---|---|---|---|
| Hook to UI p95 under 300 ms | `hook-latency.mjs` + Playwright | Fire 500 envelopes by spawning the real `deck-hook` (as Claude Code does, one process each) at a mixed rate; a Playwright page records when each card's pill changes. Report the split: hook process start to socket, socket to WebSocket send (includes the 250 ms reorder window), WebSocket to DOM | p95 under budget; see TEST-O2 |
| Keystroke echo p95 under 50 ms | `focus-echo.mjs` (run by `npm --prefix hub run perf`) | Fake `claude` in `echo.json` mode through deckd and the deck server; headless Chromium (through `playwright-core`) types 200 letters, 20 ms apart, into the Focus terminal and, on every DOM change of the xterm rows, counts the echoed letters, so each key is timed from its `keydown` to the first render that shows it. It also reports `wire` (the echo's output frame reaching the page, before xterm renders) and refuses to report unless the screen holds exactly the typed letters | p95 under budget |
| Home first paint under 500 ms with 20 sessions | `home-paint.mjs` | New fixture `perf20` (20 sessions in mixed states, 6 open requests); time from `deck:snapshot-received` to `deck:home-painted`, cold cache, 1920 x 1080 | under budget, median of 5 runs |
| Idle CPU under 2% of one core, deckd + server, 10 sessions | `idle-cpu.mjs` | 10 fake `claude` sessions sitting on `idle-input` (no spinner), browser connected, sample `/proc/<pid>/stat` for 60 s | under budget. Also report (not gate) the same with 10 spinning sessions |
| fleetmates derive and liveness every 60 s per active run, never per request | unit test with mock timers | Count `derive` and `livenessRows` calls over 10 simulated minutes with 50 API requests | exactly 10 per run, zero added by requests |
| vault-mcp graph under 500 ms at 1,000 notes | `vault-graph.mjs` (M5+) | Generated 1,000-note vault, 5 warm calls of `vault_graph` through the deck's client | p95 under budget |

Runs: nightly on `main` and in the release workflow. A failure is re-run once; two failures fail the job. Numbers are uploaded as a CI artifact so trends are visible.

## 10. CI jobs (Proposed)

A separate workflow `.github/workflows/deck.yml`, as 03-architecture section 3 requires (the root `test` glob does not reach `hub/test/`). The root `test.yml` (three OSes, no install step) is unchanged.

| Job | Trigger | Runner | Steps |
|---|---|---|---|
| `hub-static` | PR and push touching `hub/**`, `scripts/**`, `docs/deck/**` | ubuntu-latest | `npm ci` in `hub/`; `tsc --noEmit -p jsconfig.json`; ESLint; Stylelint; i18n catalog checks (both `en` and `pt` catalogs have the same keys; no U+2014 or U+2013; no `Alt+`); raw colour grep (qa 1.1) |
| `hub-unit` | same | ubuntu-latest | `node --test test/unit test/contract` (all hook fixture sets, screen sets, scribed, vault-mcp schema) |
| `hub-integration` | same | ubuntu-latest | build tools for `node-pty` if no prebuild; `node --test test/integration test/smoke` |
| `hub-ui` | same | ubuntu-latest | `vite build`; `npx playwright install --with-deps chromium`; Playwright against the fixture server: acceptance criteria, axe, XSS, counts property test, visual regression (phase 2 baselines only, qa-checklist 3.2); traces and screenshots uploaded on failure |
| `hub-perf` | nightly, and in `deck-release.yml` | ubuntu-latest | section 9 |
| `cc-watch` | weekly schedule | ubuntu-latest | `npm view @anthropic-ai/claude-code version` compared with `testedClaudeCode`; on a newer version, fail with a message naming the capture procedure (5.3). Optional (verify it works without login on the pinned version): diff `claude --help` for the flags the Ask engine uses |

Rules:

- **Node minor pinned** (03-architecture section 3, because `node:sqlite` still prints an experimental warning on some 24.x builds): `hub/.node-version` holds an exact `24.<minor>.<patch>`; every job uses `actions/setup-node` with `node-version-file: hub/.node-version`. Bumping it is its own PR with the full suite green.
- **Linux only**. WSL was dropped from v1 and macOS is not targeted (D-05), so the hub has no Windows or macOS matrix, unlike the root.
- Path filter includes `scripts/**` because the hub imports root modules.
- The UI tests never download fonts: Geist is self-hosted (qa 1.10), so screenshots are stable offline.
- Required checks for merging to `main`: `hub-static`, `hub-unit`, `hub-integration`, `hub-ui`. `hub-perf` and `cc-watch` are informational on PRs.

## 11. Security, accessibility and visual tests

### 11.1 Security (Proposed; rules from [08-security.md](08-security.md) and D-34, D-35)

`hub/test/integration/security.test.mjs` and `hub/test/e2e/security.spec.mjs`:

| Threat | Test |
|---|---|
| DNS rebinding | Requests with `Host: evil.example:47800`, `Host: 127.0.0.1.nip.io`, a missing Host, and `Host: [::1]` are rejected; `127.0.0.1:<port>` and `localhost:<port>` pass |
| Drive-by page, CSRF | WebSocket upgrade with `Origin: http://evil.example`, `Origin: null`, and no Origin closes with 4403 (state-machines 4.1); a state-changing POST with a foreign Origin is rejected even with a valid token |
| Missing or wrong token | Every route in the router table, enumerated by the test from the router itself (so a new route cannot skip auth), returns 401 without the token and with a wrong token; WebSocket closes 4401. Token comparison is constant-time (unit test on the compare helper) |
| Binding | The server refuses to start when configured for a non-loopback address (Decided: localhost only) |
| File modes | After `init` in `tmpHome()`: token 0600, state and runtime dirs 0700, sockets 0600, `config.json` 0600 (03-architecture section 5) |
| Hook socket abuse | `hooks.sock` receives non-JSON, a 5 MiB line, invalid UTF-8, 10,000 connections: the server stays up, drops the input, logs once |
| deckd exposure | deckd has no TCP listener (inspect `/proc/<pid>/net/tcp` for its pid) |
| Untrusted text (XSS) | qa-checklist 1.7 payloads (`<img onerror>`, `<script>`, `javascript:` links, U+202E, ANSI escapes) injected into every text field of every UI fixture: no new element, no dialog, no navigation, text visible literally. Server-side: ANSI stripped from crash tails; the markdown renderer runs with `html: false` |
| Approval bypass | API tests: a Destructive request cannot be answered without `confirm: true`, never inside a batch, never from a notification action; no keyboard path approves it (qa 1.3) |
| Confidential meetings | With a confidential tag fixture, grep the SQLite file, the WAL, the debug log and the spool for sentinel transcript strings: zero hits (qa 2.9) |
| Static path traversal | `GET /../../etc/passwd` and encoded variants return 404 |

### 11.2 Accessibility

- **Automated from M1 (Proposed)**: `@axe-core/playwright` on every fixture screen and overlay, zero serious or critical violations (qa 1.9); keyboard map and focus trap tests (qa 1.3); reduced motion (qa 1.4); contrast via axe (qa 1.5).
- **Full audit deferred to the React build** (deferred during design). Proposed timing: at the end of M2, when Focus with a live terminal exists, since terminal focus and screen reader behaviour are the riskiest parts. Findings go to the qa-checklist recurring issues log. Orca smoke test stays manual (qa 1.9).

### 11.3 Visual regression against the canvas (Proposed)

The plan is in [qa/qa-checklist.md](qa/qa-checklist.md) section 3 and is not repeated here: Playwright `toHaveScreenshot`, frozen clock, two baseline phases (canvas renders as a loose review aid, then approved build screenshots as a strict CI gate), the screenshot matrix and the intentional differences list. Storage: canvas baselines copied from the design renders (`render/shots/<Board>.png`, 1920 x 1080) into `hub/test/visual/canvas/`, build baselines in `hub/test/visual/build/`. Phase 1 runs locally and in `hub-ui` as a non-blocking report; phase 2 screens block merges.

## 12. qa-checklist mapping: automated vs manual

| qa-checklist section | Automated (job) | Manual |
|---|---|---|
| 0 Process | none | whole section |
| 1.1 Visual accuracy | raw colours, `var(--color-` outside tokens, crew test vectors (`hub-static`, `hub-unit`) | typography, spacing, icon checks |
| 1.2 Layout and widths | no horizontal scroll at 1280, CLS under 0.02 on Home (`hub-ui`) | layout tables per width |
| 1.3 Interaction and keyboard | focus-visible stops, `Alt+` grep, keys reaching the PTY, no Destructive keyboard path, dialog focus traps (`hub-ui`, `hub-static`) | hover and pressed states, target sizes, pointer-stable reorders |
| 1.4 Motion | no running animation under reduced motion (`hub-ui`) | allowed loops, durations |
| 1.5 Contrast and colour | axe `color-contrast` (`hub-ui`) | state never colour-only, amber-only pulsing |
| 1.6 Content and copy | JSX literal lint, catalog key match, U+2014 and U+2013 grep (`hub-static`) | literal pills, themed-word placement, formats, long-content variants |
| 1.7 Untrusted text | XSS injection, `react/no-danger` (`hub-ui`, `hub-static`) | link confirmation |
| 1.8 Counts consistency | 200-sequence property test (`hub-ui`) plus the counts query unit tests (`hub-unit`) | none |
| 1.9 Accessibility | axe (`hub-ui`) | landmarks review, live region batching, Orca, `lang` attributes, 150% zoom |
| 1.10 Cross-platform | Chromium (`hub-ui`) | Firefox, DPR 1.25, offline fonts |
| 2.x Per-screen | every "Acceptance criteria" item of each screen spec is one Playwright test titled `<screen> AC<n>`; items marked **auto** in qa 2.x (Revoke writes the real file, confidential DB inspection) | the remaining per-screen checkboxes, at 1920, 1440 and 1280 |
| 3 Visual regression | phase 2 gates (`hub-ui`) | phase 1 review against canvas diffs |

A qa item found as an S1 or S2 bug must get an automated regression test (qa 0.5); the test title cites the qa item.

## 13. M1 acceptance: the dogfood week

### 13.1 The criterion (Decided)

"You run 3+ parallel sessions a full work week without opening a tmux pane to check status" (D-08). The deck goes public at M1 (Decided), after this passes.

### 13.2 Protocol (Proposed)

| Item | Rule |
|---|---|
| Duration | 5 consecutive working days, Monday to Friday, on the owner's Omarchy machine |
| Build | A tagged M1 release candidate installed with `fleetmates-deck init` (not a dev server), Claude Code at the pinned version |
| Load | At least 3 Claude Code sessions running in parallel for at least 4 hours of each day, across at least 2 repos, including at least one fleetmates team run during the week. Sessions may be plain `claude` (observed) or `fm claude` if the M0 wrapper is stable |
| What counts as a failure | Opening a terminal pane **to find out what a session is doing or whether it needs you**. Opening a pane to answer a request the deck already surfaced is allowed (in M1 answers happen in the terminal: "Answer in your terminal"), as is opening one to type new work |
| Recording | Every status-check pane open is logged with time, session and reason (TEST-O4 on the mechanism). The deck also writes objective metrics (13.3) |
| Pass | Zero status-check pane opens caused by the deck (wrong, missing or late information) over the 5 days, and every day meets the load rule. Pane opens caused by habit, with the deck correct at that moment, are logged and discussed but do not fail the week |
| Restart rule | An S1 bug (qa-checklist 0.4: wrong or hidden "needs you", wrong count) fails the day; after the fix, the 5-day count restarts. S2 and lower are fixed without restarting |
| Output | A short report committed to `docs/deck/dogfood/<date>-m1.md` (Proposed): metrics table, logged pane opens, bugs filed, SM-O3 false-positive count, decision on SM-O3 and SM-O2 |

### 13.3 Objective metrics collected during the week (Proposed)

Written by the server to the deck database and summarised by a `fleetmates-deck report --since <date>` command (Proposed; listed in [13-operations.md](13-operations.md) section 4.2):

| Metric | Source | Watch for |
|---|---|---|
| Max concurrent sessions per day, hours with 3 or more | session state history | load rule |
| Hook to popup latency (p50, p95) | `hookTs` to `notifiedAt` | budget and felt lag |
| Requests closed in the terminal before the deck notified | `answeredAt` earlier than `notifiedAt` | missed or late "needs you" |
| Requests expired with no outcome | `expiredReason` counts | wrong request opens |
| `asked_you` from the `Stop` question heuristic, and how many the owner dismissed as wrong | request `source = stop_question` | SM-O3 decision |
| `rejected_events` count | ingest | hook drift |
| Stale alarms on sessions that were working | stale entries followed by activity within 1 min | threshold and activity rule |
| Server and deckd restarts, crashes | journald, `crashKind` | stability |

## Open items

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| TEST-O1 | Should CI run a live Claude Code canary with real credentials (an API key, since the subscription cannot log in on CI) to capture hook and screen fixtures automatically when Claude Code releases? It costs money and needs a secret. | No. Fixtures are captured by the owner locally (5.2); `cc-watch` only detects new versions. | none |
| TEST-O2 | The hook-to-UI budget (p95 under 300 ms, 03-architecture 7) includes the 250 ms reorder window (state-machines 0.3) plus a Node process start per hook; the budget is likely unreachable as written. Which gives: a bigger budget, a smaller window, or flushing the buffer early when the expected next event arrives? | Measure in M0. Proposed: flush a session's buffer as soon as a `Stop`, `PermissionRequest` or `Notification` is the latest event, keep 250 ms otherwise, and keep the 300 ms budget for those events only. | M1 |
| TEST-O3 | Where does the scribed fixture exporter live, and can CI check out TurbidAssist to verify the fixtures against `protocol.py` on every run? | Exporter in TurbidAssist (`scripts/export_protocol_fixtures.py`); output committed to `hub/test/fixtures/scribed/<sha>/`; CI does not check out TurbidAssist. | M4 (M0 uses a minimal client) |
| TEST-O4 | How are status-check pane opens logged during the dogfood week? | A dev-only palette action `> log pane check` enabled by `DECK_DOGFOOD=1` that stores time, session and a one-line reason. | M1 |
| TEST-O5 | Run Playwright on Firefox in CI too, or keep Firefox manual (qa-checklist 1.10)? | Manual. | none |
| TEST-O6 | Fixtures and screenshots must keep placeholders; add a CI grep that fails on a denylist of real client names kept outside the repo? | Yes, denylist in a local untracked file, CI check runs only when present | M1 |
