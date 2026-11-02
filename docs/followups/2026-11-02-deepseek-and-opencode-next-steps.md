# DeepSeek and OpenCode: next steps

Status on 2026-11-02, written so the work can be picked up by a fresh agent session.

## Where things stand

- **DeepSeek works today with no code.** Claude Code pointed at
  `https://api.deepseek.com/anthropic` runs the whole fleet on DeepSeek; see
  [docs/reference/deepseek.md](../reference/deepseek.md). One three-task plan passed its gate on
  the first attempt, at about a sixth of the Claude list-price cost and 2.6 times the wall-clock.
- **OpenCode is designed but not started.** An OpenCode adapter is only worth building for
  providers Claude Code cannot reach (OpenRouter, a local Ollama, Gemini). It is not needed for
  DeepSeek.

## 1. Confirm DeepSeek on a harder plan

The one measured run was an easy plan with no failed gate. Before relying on DeepSeek:

1. Top up the DeepSeek account (the paid balance was zero after the first run).
2. Pick a real plan from this repository with at least two phases and tasks that touch shared
   code, so a gate is likely to fail at least once.
3. Run it once on Claude and once on DeepSeek (only the two environment variables differ).
4. Record, per run: gates passed on the first attempt, fix rounds, orphaned tasks, subagent turns,
   tokens (`node scripts/cli.mjs usage`), wall-clock, and the cost from each provider's dashboard.
5. Add the row to the table in `docs/reference/deepseek.md`.

If DeepSeek needs many more fix rounds, the cost advantage may disappear; say so in that file.

## 2. Make the comparison repeatable (optional)

The DeepSeek and Claude numbers above came from a one-off run. A small eval suite would make
later comparisons cheap: a fixed set of plans, each run per harness and per model, recording the
columns from step 1.4. Nothing like it exists in the repository yet.

## 3. OpenCode adapter (only if another provider is needed)

The adapter interface is in `scripts/harnesses/index.mjs`; `scripts/harnesses/cursor.mjs` is the
closest model. The earlier design notes for OpenCode are in
`docs/specs/2026-09-14-headless-driver-codex-design.md` (sub-project 3).

**Blocker to settle first: OpenCode has no OS sandbox.** Its permission rules (`allow`, `ask`,
`deny` per tool) are pattern matching, and its own security policy says they are not isolation.
fleetmates never runs a teammate unsandboxed by default, so choose one before writing code:

| Option | Cost | Risk |
|---|---|---|
| Run `opencode run` inside a container that mounts only the teammate's checkout | Adds a container runtime dependency | Low |
| OS wrapper (`bwrap` on Linux, `sandbox-exec` on macOS) | Different code per platform | Medium; must cover child processes |
| Opt-in `harnesses.opencode.sandbox = "none"` with a loud `probe` warning | Low | High: the teammate has the user's full access |

Then, in order:

1. Write `docs/specs/<date>-headless-driver-opencode-design.md`, modelled on
   `docs/specs/2026-09-16-headless-driver-cursor-design.md`. Measure on an installed OpenCode, do
   not rely on docs alone:
   - the event schema of `opencode run --format json` (third-party notes say `step_start`,
     `tool_use`, `text`, `step_finish`, `error`, with `sessionID` on each line and token usage in
     `step_finish.part.tokens`);
   - resuming with `--session <id>`;
   - `--auto` combined with `OPENCODE_PERMISSION` holding explicit `deny` rules for `webfetch`,
     `websearch` and `external_directory` when `network` is false;
   - what the shell tool can reach outside the checkout, with and without the chosen sandbox;
   - whether user-level plugins and MCP servers load in a headless run.
2. Add `opencode` to `KNOWN_HARNESSES` and `HARNESS_SANDBOXES` in `scripts/config.mjs`, starting
   with only the sandbox mode the measurements proved safe.
3. Add `.opencode/` and `opencode.json` to `CONTROL_PATHS` in `scripts/harnesses/files-sandbox.mjs`:
   a teammate that plants a plugin there runs code in the next `opencode run`.
4. Implement `scripts/harnesses/opencode.mjs` with `probe` (`opencode auth list`), `makeSandbox`,
   `collect`, `cleanup`, `spawn`, `resume`, `readResult` (contract in the prompt, as Cursor does)
   and `readUsage`. Map tiers through `harnesses.opencode.tierModels` as `provider/model`.
5. Tests: follow `CONTRIBUTING.md`. Every new test must be shown to fail by breaking the code it
   covers.
6. Pin the OpenCode version the adapter was measured on and check it in `probe`: OpenCode 2 changes
   the plugin API and may change the event format.

Running fleetmates *as a plugin inside OpenCode* (OpenCode as the orchestrator) comes after the
adapter. OpenCode reads skills from `.claude/skills` in the same `SKILL.md` format, but it has no
hook that blocks a finishing agent and no worktree per subagent, so its teammates would still be
dispatched through the CLI with `--harness`.
