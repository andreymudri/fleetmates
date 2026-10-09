# Running on Codex and Cursor

Moved from the project README. Teammates run as Claude Code subagents by default; this page covers the headless harnesses.

## Running on Codex

fleetmates also runs headless under Codex CLI, alongside Claude Code, from the same package:

    codex plugin marketplace add andreymudri/fleetmates
    codex plugin add fleetmates@fleetmates
    codex login

The package installs unchanged from the same `.claude-plugin/marketplace.json` — there is no
separate Codex manifest.

**Trust the hooks in `/hooks` after installing.** Without that, `using-fleetmates` activates only
by its description text, not through the `SubagentStop` hook this plugin relies on for
enforcement.

### Sandbox

Teammates run sandboxed in an isolated clone by default (`harnesses.codex.sandbox = "clone"`) —
never unsandboxed. A git-less `files` fallback and `full` (`danger-full-access`) are also
selectable. The orchestrator itself needs full access to write the run repo's git, and exits with
a fixable message if it is started inside a sandbox. Network access is off by default.

In `files` mode the teammate has no repository of its own, so:

- its prompt opens with an override telling it to skip every git step of the implementer
  instructions (task branch, `locate`, commit, commit proof, `complete`);
- fleetmates commits the checkout as **one commit** on the task branch, byte for byte, without
  running git in the checkout;
- a change to `.cursor/*.json`, `.cursor/hooks/`, `.claude/settings*.json` or `.vscode/` is refused
  (the task is orphaned, naming the paths) rather than dropped.

## Running on Cursor

Cursor can run a fleet's teammates. The orchestrator stays whichever harness you drive — Claude
Code or Codex — and passes `--harness cursor` to `dispatch`, `dispatch-reviews`,
`dispatch-integrator` and `message`:

    cursor-agent login

### Sandbox

Cursor runs git itself, outside its own sandbox, so a repository inside a teammate's workspace is a
way out of it. Cursor teammates therefore only ever run in a git-less `files` checkout
(`harnesses.cursor.sandbox` accepts nothing else), always with `--sandbox enabled` and never with
`--force`:

- A Cursor teammate cannot commit. Its prompt opens with an override telling it to skip every git
  step of the implementer instructions, and when it finishes, fleetmates commits its checkout as
  **one commit** on the task branch, byte for byte, without ever pointing git at the checkout.
- Checkouts live under `$XDG_CACHE_HOME/fleetmates/cursor/` (default `~/.cache`), outside the
  repository: Cursor runs the `.cursor/hooks.json` of any git repository that encloses its
  workspace. `dispatch` refuses if that cache directory is itself inside a git repository.
  A checkout is removed once its task is recorded `done`; a blocked, failed or orphaned task keeps
  its checkout, so `message` or a new `dispatch` can resume it there.
- `.cursor/{sandbox,hooks,cli,mcp,worktrees}.json`, `.cursor/hooks/`, `.claude/settings*.json` and
  `.vscode/` are removed from the checkout before every session, without following symlinks at any
  level. A teammate that changes one of them — or replaces `.cursor` or `.claude` with a file or a
  symlink — is orphaned, and that checkout is refused for good; none of those paths ever changes on
  the task branch.
- Network access is off by default; `harnesses.cursor.network = true` turns it on.
- `dispatch` refuses to start while a global `~/.cursor/sandbox.json` widens every sandbox (extra
  writable paths, a non-default `type`, or a network default of `allow`), and warns when a global
  `~/.cursor/hooks.json` exists, because those hooks run outside the sandbox.

### Platforms

The Cursor sandbox behaviour above was measured on Linux. The adapter spawns `cursor-agent`
directly, without a shell, which a Windows `.cmd` shim does not support; running Cursor teammates on
Windows is untested.

Strict execution and native verification are POSIX-only. On Windows `workflow-execute`,
`workflow-resume`, `workflow-status`, `workflow-resolve`, `workflow-accept`, `workflow-prune`,
`execution-record`, `execution-status` and `dispatch --execution` refuse with exit 2 and print the
reason on one line. Legacy dispatch without `--execution` is unaffected.

### Models and effort

Cursor has no separate effort setting: effort is part of the model id. Map each tier to the variant
you want in `harnesses.cursor.tierModels`, for example
`{ "cheap": "composer-2.5", "mid": "claude-sonnet-5-thinking-high", "capable": "claude-opus-5-high" }`
(`cursor-agent models` lists them). An unmapped tier runs `--model auto`, the only model a free
Cursor plan accepts. `agents.<role>.effort` is ignored for Cursor teammates, and each
session record says so with `effortIgnored: true`.
