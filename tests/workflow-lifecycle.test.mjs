import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { git, discover, bindSession, readBinding, transition, lifecycleStatus, planHash } from '../scripts/workflow-lifecycle.mjs'
import { handleOrchestratorStop } from '../scripts/orchestrator-stop.mjs'
import { runCli } from '../scripts/cli.mjs'

async function fixture(t) {
  // Ledger storage rejects linked parents; macOS temporary paths can contain /var aliases.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fm-workflow-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), '### Task 1: Add A\n\n**Files:**\n- Create: `a.mjs`\n')
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ maxParallel: 1, phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } } }))
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  git(['switch', '-c', 'run'], root)
  const binding = { run: 'r1', branch: 'refs/heads/run', base: 'main', plan: 'plan.md', anchor: 'refs/heads/main' }
  await mkdir(path.join(root, '.fleetmates', 'r1'), { recursive: true })
  await bindSession(root, 'session', binding)
  return { root, binding, input: { cwd: root, session_id: 'session' } }
}

test('session binding is explicit, immutable and tied to tracked regular plan content', async t => {
  const { root, binding } = await fixture(t)
  const { common } = discover(root)
  assert.equal((await readBinding(common, 'session')).run, 'r1')
  assert.equal(await readBinding(common, 'unknown'), null)
  await bindSession(root, 'session', binding)
  await assert.rejects(bindSession(root, 'session', { ...binding, run: 'r2' }), /already bound/)
  await assert.rejects(bindSession(root, 'other', { ...binding, plan: '../plan.md' }), /relative/)
  await assert.rejects(bindSession(root, 'other', { ...binding, plan: 'absent.md' }), /tracked regular/)
  await assert.rejects(bindSession(root, 'other', { ...binding, run: '../outside' }), /identity/)
})

test('lifecycle markers distinguish suspension, resume and final abandonment without claiming completion', async t => {
  const { root, binding } = await fixture(t)
  assert.equal(lifecycleStatus(root, 'r1').state, 'running')
  const tip = git(['rev-parse', 'HEAD'], root)
  assert.equal(transition(root, 'r1', 'suspend', binding.branch).suspended, tip)
  assert.equal(transition(root, 'r1', 'resume').state, 'running')
  const abandoned = transition(root, 'r1', 'abandon', binding.branch)
  assert.equal(abandoned.state, 'abandoned'); assert.equal(abandoned.abandoned, tip)
  assert.equal(abandoned.verifiedComplete, false)
  assert.throws(() => transition(root, 'r1', 'resume'), /Abandoned/)
  assert.throws(() => transition(root, 'other', 'suspend', 'refs/heads/main'), /mismatch/)
  const output = []
  assert.equal(await runCli(['run-status', '--run', 'r1', '--root', root], { out: s => output.push(s) }), 0)
  assert.equal(JSON.parse(output.at(-1)).state, 'abandoned')
  assert.equal(await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root], { out: s => output.push(s) }), 4)
  assert.equal(JSON.parse(output.at(-1)).state, 'abandoned')
})

test('Stop guard recomputes only the bound run and maps failed and unresolved checks to one block', async t => {
  const { root, input } = await fixture(t)
  for (const status of [1, 4, 0, 2]) {
    const messages = []; let called = 0
    const result = await handleOrchestratorStop(input, { err: s => messages.push(s), execute: (exe, args, options) => {
      called++
      assert.equal(exe, process.execPath)
      assert.deepEqual(args.slice(1), ['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--enforcement-only'])
      assert.equal(options.timeout, 12000)
      return { status, stdout: 'computed verdict', stderr: '' }
    } })
    assert.equal(called, 1); assert.equal(result, [1, 4].includes(status) ? 2 : 0)
    assert.match(messages.join('\n'), status === 0 ? /not completion evidence/ : status === 2 ? /configuration/ : /unresolved enforcement/)
  }
  assert.equal(await handleOrchestratorStop(input, { execute: () => ({ error: new Error('timeout'), status: null }) }), 0)
  let calls = 0
  assert.equal(await handleOrchestratorStop({ ...input, stop_hook_active: true }, { execute: () => { calls++; return { status: 1 } } }), 0)
  assert.equal(calls, 0, 'harness retry must not recompute or block')
})

test('unbound, switched, suspended and stale requirements never enforce another run', async t => {
  const { root, input, binding } = await fixture(t)
  let calls = 0
  const execute = () => { calls++; return { status: 1, stdout: 'should not execute' } }
  assert.equal(await handleOrchestratorStop({ ...input, session_id: 'unknown' }, { execute }), 0)
  git(['switch', 'main'], root)
  assert.equal(await handleOrchestratorStop(input, { execute }), 0)
  git(['switch', 'run'], root)
  transition(root, 'r1', 'suspend', binding.branch)
  assert.equal(await handleOrchestratorStop(input, { execute }), 0)
  transition(root, 'r1', 'resume')
  const old = planHash(root, 'main', 'plan.md')
  git(['switch', 'main'], root)
  await writeFile(path.join(root, 'plan.md'), '# Changed requirements\n')
  git(['add', '.'], root); git(['commit', '-m', 'requirements'], root)
  git(['switch', 'run'], root); git(['merge', 'main'], root)
  assert.notEqual(planHash(root, 'main', 'plan.md'), old)
  assert.equal(await handleOrchestratorStop(input, { execute }), 0)
  assert.equal(calls, 0, 'unbound or changed requirements must never execute finish')
})

test('registered Stop hook blocks on actual Git recomputation despite a forged PASS and allows deleted state', async t => {
  const { root, input } = await fixture(t)
  const output = []
  assert.equal(await runCli(['bind-session', '--run', 'r1', '--plan', 'plan.md', '--session', 'actual', '--base', 'main', '--root', root], { out: s => output.push(s) }), 0)
  assert.equal(JSON.parse(output.at(-1)).run, 'r1')
  await writeFile(path.join(root, '.fleetmates', 'r1', 'status.json'), JSON.stringify({ state: 'finished', gates: { 1: 'PASS' } }))
  const messages = []
  assert.equal(await handleOrchestratorStop({ ...input, session_id: 'actual' }, { err: s => messages.push(s) }), 2)
  assert.match(messages.join('\n'), /failed|pending/)
  await rm(path.join(root, '.fleetmates'), { recursive: true })
  let calls = 0
  assert.equal(await handleOrchestratorStop(input, { execute: () => { calls++; return { status: 1 } } }), 0)
  assert.equal(calls, 0, 'deleted state must fail open before finish')
  const { readFile } = await import('node:fs/promises')
  const hooks = JSON.parse(await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.equal(hooks.hooks.Stop[0].hooks[0].async, false)
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /orchestrator-stop/)
})

test('unbound real Stop entry point costs one Git process and produces a session-scoped doctor receipt', async t => {
  const { root } = await fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { readFile } = await import('node:fs/promises')
  const { hookDoctor } = await import('../scripts/hook-doctor.mjs')
  const trace = path.join(root, 'trace.log')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'config'), GIT_TRACE: trace }
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/orchestrator-stop.mjs', import.meta.url))], {
    cwd: root, env, input: JSON.stringify({ cwd: root, session_id: 'unbound-session' }), encoding: 'utf8',
  })
  const lines = (await readFile(trace, 'utf8')).split('\n').filter(line => line.includes('built-in: git '))
  assert.equal(lines.length, 1, 'unbound hook must perform only repository discovery')
  const report = await hookDoctor({ env, includeStop: true, sessionId: 'unbound-session' })
  assert.equal(report.hooks.find(h => h.hook === 'Stop').state, 'observed')
  assert.equal(report.ok, false, 'Stop alone cannot prove the other callbacks fired')
  const { readEvents } = await import('../scripts/event-ledger.mjs')
  const { receiptPath } = await import('../scripts/context-hook.mjs')
  assert.deepEqual(await readEvents(receiptPath(env)), [], 'new Stop receipts must not change the legacy four-hook receipt stream')
  const other = await hookDoctor({ env, includeStop: true, sessionId: 'other-session' })
  assert.equal(other.hooks.find(h => h.hook === 'Stop').state, 'unverified')
})
