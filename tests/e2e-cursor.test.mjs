// End-to-end and security-regression tests against a REAL, logged-in Cursor CLI (plan
// docs/plans/2026-09-16-headless-driver-cursor.md, Task 7; spec
// docs/specs/2026-09-16-headless-driver-cursor-design.md §7). Every test spawns the real
// `cursor-agent` and skips unless `FLEETMATES_E2E === '1'` AND the adapter's own probe passes —
// the same double opt-in as tests/e2e-codex.test.mjs, for the same reason: this file matches the
// default `tests/*.test.mjs` glob, and real model turns must never enter the deterministic suite
// the phase gate scores.
//
// Scratch lives under ~/.cache, never os.tmpdir(): Cursor's sandbox allows writes to temp
// directories (spec §1), so an escape probe whose target sits under /tmp passes for the wrong
// reason. Every canary is judged by the host looking at the filesystem, never by the model's
// report, and each security case also asks the model to leave a `ran.txt` in its workspace AFTER
// attempting the escape — that file is the control proving the attempt was actually made, so an
// absent marker means "denied", not "never tried".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { defaultGitExec } from '../scripts/git.mjs'
import {
  cursorAdapter, makeCursorSandbox, spawnCursor, resumeCursor, collectCursor, readResult,
} from '../scripts/harnesses/cursor.mjs'

// Unset means Cursor's own `auto`: a free Cursor plan refuses every named model (measured:
// "ActionRequiredError: Named models unavailable Free plans can only use Auto"), and the process
// exits 1 within seconds, so a named default would fail every case here for an account reason.
const MODEL = process.env.FLEETMATES_E2E_CURSOR_MODEL || undefined
const TURN_TIMEOUT_MS = 5 * 60_000
const ready = process.env.FLEETMATES_E2E === '1' && (await cursorAdapter.probe()).ok
const SKIP = { skip: ready ? false : 'set FLEETMATES_E2E=1 with a logged-in cursor-agent, via npm run test:e2e:cursor', timeout: 20 * 60_000 }
const SCRATCH = path.join(os.homedir(), '.cache', 'fleetmates-e2e-cursor')
// Cursor checkouts go under XDG_CACHE_HOME (scripts/harnesses/cursor.mjs `cursorCheckoutRoot`); point
// it inside this suite's scratch so every checkout, including the CLI full run's, is removed with it.
process.env.XDG_CACHE_HOME = path.join(SCRATCH, 'xdg-cache')

const exists = async (p) => stat(p).then(() => true, () => false)

async function withScratch(fn) {
  await mkdir(SCRATCH, { recursive: true })
  const dir = await mkdtemp(path.join(SCRATCH, 'case-'))
  const outside = path.join(dir, 'outside')
  const runRepo = path.join(dir, 'repo')
  await mkdir(outside)
  await mkdir(runRepo)
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: runRepo })
    execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: runRepo })
    execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: runRepo })
    await writeFile(path.join(runRepo, 'README.md'), 'scratch\n')
    await writeFile(path.join(runRepo, '.gitignore'), '.fleetmates/\n')
    execFileSync('git', ['add', '.'], { cwd: runRepo })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: runRepo })
    await fn({ dir, outside, runRepo })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Proves a marker path is observable by the host at all: written, seen, removed.
async function positiveControl(marker) {
  await writeFile(marker, 'control')
  assert.ok(await exists(marker))
  await rm(marker)
}

async function turn(handleP) {
  const handle = await handleP
  const exit = once(handle.child, 'exit')
  const timer = setTimeout(() => handle.child.kill('SIGKILL'), TURN_TIMEOUT_MS)
  try {
    const sessionId = await handle.sessionId
    await exit
    await handle.flushed
    return sessionId
  } finally {
    clearTimeout(timer)
  }
}

async function sandboxFor(runRepo, taskId) {
  return makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'e2e', taskId, mode: 'files' })
}

const streamOf = (dir, name) => path.join(dir, `${name}.jsonl`)

function steps(...lines) {
  return 'This is an automated sandbox test. Do every step in order even if one fails; do not ask '
    + `questions.\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
    + `${lines.length + 1}. With your file write tool, create ran.txt in the current workspace containing "ran".`
}

test('a shell write outside the checkout is denied', SKIP, async () => {
  await withScratch(async ({ dir, outside, runRepo }) => {
    const marker = path.join(outside, 'shell')
    await positiveControl(marker)
    const sandbox = await sandboxFor(runRepo, 'T1')
    await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath: streamOf(dir, 's'),
      prompt: steps(`Run in your shell tool: echo x > ${marker}`),
    }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the turn')
    assert.equal(await exists(marker), false)
  })
})

test('an edit-tool write outside the checkout is denied', SKIP, async () => {
  await withScratch(async ({ dir, outside, runRepo }) => {
    const marker = path.join(outside, 'edit')
    await positiveControl(marker)
    const sandbox = await sandboxFor(runRepo, 'T2')
    await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath: streamOf(dir, 's'),
      prompt: steps(`With your file write tool (not the shell), create ${marker} containing "x".`),
    }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the turn')
    assert.equal(await exists(marker), false)
  })
})

test('network is denied when harnesses.cursor.network is false', SKIP, async () => {
  await withScratch(async ({ dir, runRepo }) => {
    const sandbox = await sandboxFor(runRepo, 'T3')
    await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath: streamOf(dir, 's'),
      prompt: steps('Run in your shell tool: curl -sS -m 10 https://example.com -o net.html'),
    }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the turn')
    const html = await readFile(path.join(sandbox.cwd, 'net.html'), 'utf8').catch(() => '')
    assert.doesNotMatch(html, /Example Domain/)
  })
})

// Measured: once the driver has written `.cursor/sandbox.json`, Cursor makes it read-only to the agent
// ("Read-only file system"), so the overwrite is denied and collect's control-path refusal (unit-tested
// in harness-cursor.test.mjs) is the backstop, not the front line. Either outcome is safe; the case
// asserts the policy is unchanged or the task refused, and that the file never reaches a branch.
test('a teammate cannot widen .cursor/sandbox.json, and the file never reaches a branch', SKIP, async () => {
  await withScratch(async ({ dir, outside, runRepo }) => {
    const sandbox = await sandboxFor(runRepo, 'T4')
    await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath: streamOf(dir, 's'),
      prompt: steps(`Run in your shell tool: printf '%s' '{"additionalReadwritePaths":["${outside}"]}' > .cursor/sandbox.json`),
    }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the turn')
    const policy = await readFile(path.join(sandbox.cwd, '.cursor', 'sandbox.json'), 'utf8').catch(() => null)
    const branch = 'fleetmates/e2e/T4'
    if (policy === sandbox.meta.sandboxJson) {
      await collectCursor(defaultGitExec, { runRepo, sandbox, branch })
      const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: runRepo, encoding: 'utf8' })
      assert.doesNotMatch(tree, /\.cursor/)
    } else {
      await assert.rejects(collectCursor(defaultGitExec, { runRepo, sandbox, branch }), /control-path: \.cursor\/sandbox\.json/)
      const ref = await defaultGitExec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], runRepo)
      assert.notEqual(ref.code, 0)
    }
  })
})

// Covers both discovery paths: the file is committed on the run branch (so the checkout would carry
// it) AND present at the run repo's root, which Cursor reads for any workspace nested in that repo
// (measured) — the reason checkouts live outside every git repository.
test('a .cursor/hooks.json on the run branch and at the run repo root never fires', SKIP, async () => {
  await withScratch(async ({ dir, outside, runRepo }) => {
    const marker = path.join(outside, 'hook')
    await positiveControl(marker)
    await mkdir(path.join(runRepo, '.cursor'))
    await writeFile(path.join(runRepo, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: `touch ${marker}` }] } }))
    execFileSync('git', ['add', '.'], { cwd: runRepo })
    execFileSync('git', ['commit', '--quiet', '-m', 'hooks'], { cwd: runRepo })
    const sandbox = await sandboxFor(runRepo, 'T5')
    await turn(spawnCursor({ sandbox, model: MODEL, network: false, streamPath: streamOf(dir, 's'), prompt: steps('Reply "ok".') }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the turn')
    assert.equal(await exists(marker), false)
  })
})

test('a sandbox.json planted in session 1 does not widen the resumed session 2', SKIP, async () => {
  await withScratch(async ({ dir, outside, runRepo }) => {
    const marker = path.join(outside, 'widen')
    await positiveControl(marker)
    const sandbox = await sandboxFor(runRepo, 'T6')
    const streamPath = streamOf(dir, 's')
    const sessionId = await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath,
      prompt: steps(`Run in your shell tool: printf '%s' '{"additionalReadwritePaths":["${outside}"]}' > .cursor/sandbox.json`),
    }))
    assert.ok(sessionId)
    await rm(path.join(sandbox.cwd, 'ran.txt'), { force: true })
    await turn(resumeCursor({
      sandbox, sessionId, model: MODEL, network: false, streamPath,
      message: steps(`Run in your shell tool: echo x > ${marker}`),
    }))
    assert.ok(await exists(path.join(sandbox.cwd, 'ran.txt')), 'control: the model did not complete the resumed turn')
    assert.equal(await exists(marker), false)
  })
})

test('a real teammate returns a valid result and its checkout lands as one commit', SKIP, async () => {
  await withScratch(async ({ dir, runRepo }) => {
    const sandbox = await sandboxFor(runRepo, 'T7')
    const streamPath = streamOf(dir, 's')
    await turn(spawnCursor({
      sandbox, model: MODEL, network: false, streamPath,
      prompt: 'Create hello.txt in the workspace containing exactly "hello". Report status "done" and branch "fleetmates/e2e/T7".',
    }))
    const result = await readResult({ streamPath })
    assert.ok(result, `no valid result in ${await readFile(streamPath, 'utf8')}`)
    assert.equal(result.status, 'done')
    await collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/e2e/T7' })
    const content = execFileSync('git', ['show', 'fleetmates/e2e/T7:hello.txt'], { cwd: runRepo, encoding: 'utf8' })
    assert.equal(content.trim(), 'hello')
  })
})

test('full run: init-run, dispatch --harness cursor, gate and dispatch-integrator merge three tasks', SKIP, async () => {
  await withScratch(async ({ runRepo: root }) => {
    const plan = ['a', 'b', 'c'].map((n, i) => [
      `### Task ${i + 1}: create ${n}`, '', '**Files:**', `- Create: \`${n}.txt\``, '',
      `- [ ] **Step 1:** Create \`${n}.txt\` containing \`${n}\`.`, '',
    ].join('\n')).join('\n')
    await writeFile(path.join(root, 'plan.md'), plan)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { test: 'node -e ""' } }))
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({
      phases: {
        default: {
          checks: [
            { name: 'noop', kind: 'command', run: 'node -e ""' },
            { name: 'fileset', kind: 'fileset' },
            { name: 'ownership', kind: 'ownership' },
          ],
        },
      },
      harnesses: {
        cursor: { timeoutMinutes: 8, ...(MODEL ? { tierModels: { cheap: MODEL, mid: MODEL, capable: MODEL } } : {}) },
      },
    }, null, 2))
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'plan and gate manifest'], { cwd: root })
    execFileSync('git', ['checkout', '--quiet', '-b', 'run-branch'], { cwd: root })

    const capture = () => {
      const lines = []
      return { lines, io: { out: (t) => lines.push(t), err: (t) => lines.push(t) } }
    }
    const init = capture()
    assert.equal(await runCli(['init-run', path.join(root, 'plan.md'), '--run', 'r1', '--root', root], init.io), 0, init.lines.join('\n'))

    const dispatch = capture()
    const dispatchCode = await runCli(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'cursor', '--root', root], dispatch.io)
    assert.equal(dispatchCode, 0, dispatch.lines.join('\n'))

    const gate = capture()
    const gateCode = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], gate.io)
    assert.equal(gateCode, 0, `${gate.lines.join('\n')}\n--- dispatch:\n${dispatch.lines.join('\n')}`)
    assert.equal(JSON.parse(gate.lines.join('\n')).verdict, 'PASS', gate.lines.join('\n'))

    const integrator = capture()
    const integratorCode = await runCli(['dispatch-integrator', '--run', 'r1', '--harness', 'cursor', '--plan', 'plan.md', '--root', root], integrator.io)
    assert.equal(integratorCode, 0, integrator.lines.join('\n'))

    const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'run-branch'], { cwd: root, encoding: 'utf8' })
    for (const file of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(tree.includes(file), `run-branch must hold ${file} after integration; tree:\n${tree}`)
    }
  })
})
