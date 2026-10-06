import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendExecutionEvent, readExecutionEvents, reconcileExecution } from '../scripts/execution-journal.mjs'
const inputs = { commit: 'a'.repeat(40), plan: 'p', manifest: 'm', environment: 'e', verifier: 'v' }
const event = (id, kind, at = 1, extra = {}) => ({ id, kind, at, runId: 'r1', step: 'implement', attempt: 'attempt-1', inputs, ...extra })
const effect = { id: 'external-1', kind: 'pr', reference: 'pr-1' }
test('immutable execution events outside disposable workspaces are idempotent and reject conflicting identities', async t => {
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'fm-execution-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await appendExecutionEvent(common, event('start', 'step-started', 1, { prompt: 'private text must not persist' }))
  await appendExecutionEvent(common, event('start', 'step-started'))
  assert.equal((await readExecutionEvents(common, 'r1')).length, 1)
  assert.equal((await readExecutionEvents(common, 'r1'))[0].prompt, undefined)
  await assert.rejects(appendExecutionEvent(common, event('start', 'step-failed')), /different data/)
  await assert.rejects(appendExecutionEvent(common, event('bad', 'step-started', 1, { version: 2 })), /Invalid/)
})
test('recovery retains unknown effects and invalidates changed inputs or branch tips without claiming completion', () => {
  const history = [event('start', 'step-started'), event('effect', 'effect-started', 2, { effect }), event('end', 'step-completed', 3)]
  assert.equal(reconcileExecution(history, { inputs }).attempts[0].state, 'unknown-effect')
  assert.equal(reconcileExecution(history, { inputs }).verifiedComplete, false)
  assert.equal(reconcileExecution([event('start', 'step-started')], { inputs }).attempts[0].state, 'interrupted')
  for (const key of Object.keys(inputs)) assert.equal(reconcileExecution(history, { inputs: { ...inputs, [key]: 'changed' } }).attempts[0].state, 'stale')
  const successful = [event('start', 'step-started'), event('end', 'step-completed', 2, { branches: { 'refs/heads/task': 'b'.repeat(40) } })]
  assert.equal(reconcileExecution(successful, { inputs }).attempts[0].state, 'branch-changed')
  const current = reconcileExecution(successful, { inputs, branches: { 'refs/heads/task': 'b'.repeat(40) } })
  assert.equal(current.attempts[0].state, 'completed-observation')
  assert.equal(current.attempts[0].requiresCurrentGates, true)
  assert.throws(() => reconcileExecution([event('end', 'step-completed')], { inputs }), /one start/)
})
test('killing the recorder after persisted start preserves recoverable unknown outcomes', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'fm-execution-crash-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const module = new URL('../scripts/execution-journal.mjs', import.meta.url).href
  const code = `import { appendExecutionEvent } from ${JSON.stringify(module)}; await appendExecutionEvent(${JSON.stringify(common)}, ${JSON.stringify(event('start', 'step-started'))}); await appendExecutionEvent(${JSON.stringify(common)}, ${JSON.stringify(event('effect', 'effect-started', 2, { effect }))}); console.log('persisted'); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const exit = once(child, 'exit')
  await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw new Error('Recorder exited before persistence') })])
  child.kill('SIGKILL'); await exit
  const records = await readExecutionEvents(common, 'r1')
  assert.equal(records.length, 2)
  assert.equal(reconcileExecution(records, { inputs }).attempts[0].state, 'unknown-effect')
})
test('execution CLI stores metadata in common Git storage and refuses to turn unknown effects into completion', async t => {
  const { writeFile, access } = await import('node:fs/promises')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-execution-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'file.txt'), 'baseline')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const actualInputs = { ...inputs, commit: git(['rev-parse', 'HEAD'], root) }, file = path.join(root, 'event.json'), output = []
  const io = { out: value => output.push(value) }
  for (const record of [event('start', 'step-started'), event('effect', 'effect-started', 2, { effect })]) {
    await writeFile(file, JSON.stringify({ ...record, inputs: actualInputs }))
    assert.equal(await runCli(['execution-record', '--file', file, '--root', root], io), 0)
  }
  await writeFile(file, JSON.stringify({ inputs: actualInputs }))
  assert.equal(await runCli(['execution-status', '--run', 'r1', '--file', file, '--root', root], io), 4)
  assert.equal(JSON.parse(output.at(-1)).attempts[0].state, 'unknown-effect')
  assert.equal(JSON.parse(output.at(-1)).verifiedComplete, false)
  await assert.rejects(access(path.join(root, '.fleetmates')))
  assert.equal((await readExecutionEvents(path.join(root, '.git'), 'r1')).length, 2)
})
