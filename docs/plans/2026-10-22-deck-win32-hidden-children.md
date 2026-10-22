# Deck win32: no visible console windows from background children (issue #56)

On Windows the deck services run detached with no console, so every console child they start
without `windowsHide: true` opens a new visible window. The session scan in
`hub/server/machines/session.mjs` runs `git` several times per scan, which matches the report of
windows flashing nonstop until the deck's node process is killed.

Audit of `hub/` production code against master `ee55b21e`:

| Call site | `windowsHide` | Reachable on win32 |
|---|---|---|
| `server/machines/session.mjs:17` `execFileSync('git')` | missing | yes, per scan (main cause) |
| `server/setup/doctor.mjs:40` `probe` | missing | yes, server `doctor()` and CLI |
| `server/setup/wait.mjs:19` `probe` | missing | yes, `init` checks |
| `server/adapters/notify.mjs:11` | missing | no, win32 gets the unsupported notifier |
| `server/meetings/start-scribed.mjs:94` | missing | no, `systemd-run` is Linux only |
| `deckd/login-env.mjs:122` | missing | no, returns early on win32 |
| `server/ask/engine.mjs:464`, `server/adapters/vault-mcp.mjs:299` | via `commandSpawn` options | yes, already hidden |
| `server/adapters/git-read.mjs`, `server/main.mjs`, `server/setup/browser.mjs`, `server/setup/service.mjs`, `platform/index.mjs` | present | yes, already hidden |
| `bin/fm.mjs:128` | via `commandSpawn` options | foreground, inherits the console |
| `hook/deck-hook.mjs:54` | missing | no, returns before the call on win32; run by Claude Code, not the deck |

The fix routes every hub child-process call through one module that always sets
`windowsHide: true`, and a test refuses any production file that imports `node:child_process`
directly, so a future call site cannot regress the way these did.

## Destination

No deck background work opens a visible window on Windows, and adding a new child-process call
in `hub/` without hiding it fails the hub suite on every platform.

## Global Constraints

- Base branch: `master`; run with `--base master`
- All changes inside `hub/`; no new dependencies
- Commit messages: single line, commitlint style, English, scope `deck` (for example `fix(deck): ...`)
- Never add Co-Authored-By, session links or tool attribution to commits or PR bodies
- Hub tests: `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test`
- Every new test is seen failing under a targeted mutation of the code it covers, then the code is restored
- No personal names, emails or real home paths in code, docs or test output
- Before finishing, `pgrep -af "$PWD/hub/(deckd|server)/main\.mjs|fake-claude\.mjs"` from the repo root prints nothing

## Not Yet Specified

- Does a real Windows 11 run with `fleetmates-deck init` show zero windows over ten minutes of session scans? Only the owner can check this on the reporting machine; the issue stays open until then.

## Out of Scope

- `hub/hook/deck-hook.mjs` keeps its `node:child_process` import — `init` copies it alone and it may import only `node:` modules; on win32 it returns before calling `execFile`.
- node-pty spawns in `deckd/pty-host.mjs` — they are not `child_process` calls and ConPTY does not open a console window.
- Making the notifier work on win32 — a feature, not this bug.

### Task 1: hidden child-process module

**Files:**
- Create: `hub/platform/child.mjs`
- Test: `hub/test/unit/child-hidden.test.mjs`

- [ ] **Step 1:** Write the failing test. It builds the wrappers over a fake module that records the options it receives, and asserts `windowsHide === true` for `spawn`, `spawnSync`, `execFile` and `execFileSync`, both when the caller omits it and when the caller passes `windowsHide: false`. It also asserts the other options, `file`, `args` and the `execFile` callback arrive unchanged, and that `promisify(execFile)` from the real default export resolves for `process.execPath -e ""`.
- [ ] **Step 2:** Implement:

```js
// Every child process the hub starts goes through here. On Windows the deck services run
// detached with no console, so a console child started without windowsHide opens a visible
// window (issue #56). windowsHide is set after the caller's options so no caller can drop it.
import nodeChildProcess from 'node:child_process'

/** @param {object | undefined} options */
export const hidden = (options) => ({ ...options, windowsHide: true })

/** @param {Pick<typeof nodeChildProcess, 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync'>} cp */
export function hiddenChildProcess (cp) {
  return {
    /** @type {typeof nodeChildProcess.spawn} */
    spawn: (file, args, options) => cp.spawn(file, args, hidden(options)),
    /** @type {typeof nodeChildProcess.spawnSync} */
    spawnSync: (file, args, options) => cp.spawnSync(file, args, hidden(options)),
    /** @type {typeof nodeChildProcess.execFile} */
    execFile: (file, args, options, callback) => cp.execFile(file, args, hidden(options), callback),
    /** @type {typeof nodeChildProcess.execFileSync} */
    execFileSync: (file, args, options) => cp.execFileSync(file, args, hidden(options)),
  }
}

const real = hiddenChildProcess(nodeChildProcess)
export const { spawn, spawnSync, execFile, execFileSync } = real
export default real
```

  Every hub call site passes `args` as an array, so the wrappers take the `(file, args, options)` form only; say so in the JSDoc.
- [ ] **Step 3:** Mutate: move `windowsHide: true` before the spread in `hidden`; the `windowsHide: false` cases must fail. Restore.

### Task 2: session scan uses the hidden module

**Files:**
- Modify: `hub/server/machines/session.mjs`

**Depends:** T1

- [ ] **Step 1:** Replace `import { execFileSync } from 'node:child_process'` with `import { execFileSync } from '../../platform/child.mjs'`. No other change; the `git()` options stay as they are.
- [ ] **Step 2:** Run `test/unit/machines.test.mjs` and the rest of the hub suite; they must stay green.

### Task 3: setup paths use the hidden module

**Files:**
- Modify: `hub/server/setup/doctor.mjs`
- Modify: `hub/server/setup/wait.mjs`
- Modify: `hub/server/setup/service.mjs`
- Modify: `hub/server/setup/browser.mjs`
- Modify: `hub/server/main.mjs`

**Depends:** T1

- [ ] **Step 1:** In each file, import from `../../platform/child.mjs` (from `../platform/child.mjs` in `server/main.mjs`) instead of `node:child_process`, keeping the same names. In `service.mjs` the default import `childProcess` becomes `import childProcess from '../../platform/child.mjs'`, so `childProcess.spawnSync` and the `spawn = childProcess.spawn` default keep working.
- [ ] **Step 2:** Leave existing explicit `windowsHide: true` options in place; they are now redundant but harmless.
- [ ] **Step 3:** Hub suite green.

### Task 4: remaining call sites use the hidden module

**Files:**
- Modify: `hub/server/adapters/git-read.mjs`
- Modify: `hub/server/adapters/notify.mjs`
- Modify: `hub/server/adapters/vault-mcp.mjs`
- Modify: `hub/server/ask/engine.mjs`
- Modify: `hub/server/meetings/start-scribed.mjs`
- Modify: `hub/deckd/login-env.mjs`
- Modify: `hub/bin/fm.mjs`
- Modify: `hub/platform/index.mjs`

**Depends:** T1

- [ ] **Step 1:** Swap each `node:child_process` import for the matching relative import of `platform/child.mjs`, keeping local names (`nodeSpawn`, `execFileCallback`, the `childProcess` default in `platform/index.mjs`). JSDoc type references such as `import('node:child_process').ChildProcess` stay; they are types, not imports.
- [ ] **Step 2:** `start-scribed.mjs` keeps `promisify(execFileCallback)`; the wrapper passes the callback through, and the awaited result is unused, so the generic promisify behaviour is enough.
- [ ] **Step 3:** Hub suite green, including `test/unit/start-scribed.test.mjs`, `test/unit/ask-engine.test.mjs`, `test/contract/vault-mcp.test.mjs`, `test/integration/fm.test.mjs` and `test/unit/platform.test.mjs`.

### Task 5: guard test against raw child_process imports

**Files:**
- Test: `hub/test/unit/no-raw-child-process.test.mjs`

**Depends:** T2, T3, T4

- [ ] **Step 1:** Walk `hub/bin`, `hub/deckd`, `hub/server` and `hub/platform` for `.mjs` and `.js` files. Strip comments before matching (a JSDoc `import('node:child_process')` type is not an import). Fail, naming file and line, on any `from 'node:child_process'`, `from 'child_process'`, `require('child_process')` or dynamic `import('node:child_process')`, except in `hub/platform/child.mjs`.
- [ ] **Step 2:** Assert the walk visited `server/machines/session.mjs` and at least 20 files, so a broken walk cannot pass by finding nothing.
- [ ] **Step 3:** Mutate: put the raw import back in `session.mjs`; the test must fail naming that file. Then add a raw import inside a comment; the test must stay green. Restore both.
- [ ] **Step 4:** Full hub suite green; the root suite (`npm test`) green.
- [ ] **Step 5:** Comment on issue #56 with the commit, the audit table above, and the request that the owner confirm on the Windows 11 machine before closing.
