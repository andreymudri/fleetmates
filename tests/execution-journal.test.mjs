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

const strictInputs = { commit: 'a'.repeat(40), ...Object.fromEntries(['plan', 'manifest', 'context', 'environment', 'verifier'].map(k => [k, 'b'.repeat(64)])) }
const strictEvent = (id, kind, extra = {}) => ({ version: 2, id, kind, at: Date.now(), runId: 'strict-run', executionId: 'execution-1',
  task: 'T1', step: 'command', attempt: 'attempt-1', inputs: strictInputs, branches: { 'refs/heads/main': strictInputs.commit },
  checkout: 'worker-1', artifacts: [], effect: null, resolution: null, ...extra })
test('version 2 records bind strict context and stable execution metadata', async t => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const { strictExecutionIdentity } = await import('../scripts/completion-obligations.mjs')
  const observed = executionEvent(strictEvent('start', 'step-started'))
  assert.equal(observed.version, 2)
  assert.equal(observed.identity, strictExecutionIdentity(strictInputs))
  assert.equal(observed.executionId, 'execution-1')
  assert.throws(() => executionEvent(strictEvent('bad', 'step-started', { command: 'unsafe' })), /fields/)
  assert.throws(() => executionEvent(strictEvent('bad', 'step-started', { inputs: { ...strictInputs, context: 'legacy' } })), /strict/)
  assert.throws(() => executionEvent(strictEvent('bad', 'step-started', { branches: { 'refs/heads/../bad': strictInputs.commit } })), /branch/)
  assert.throws(() => executionEvent(strictEvent('bad', 'step-completed')), /artifact/)
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-journal-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started')
  await appendExecutionEvent(common, start)
  await appendExecutionEvent(common, start)
  assert.equal((await readExecutionEvents(common, start.runId)).length, 1)
  await assert.rejects(appendExecutionEvent(common, strictEvent('second-start', 'step-started')), /start/)
  await assert.rejects(appendExecutionEvent(common, strictEvent('end', 'step-failed', { at: start.at - 1 })), /ordered/)
  await assert.rejects(appendExecutionEvent(common, strictEvent('changed', 'step-failed', { inputs: { ...strictInputs, context: 'c'.repeat(64) } })), /identity/)
})
test('required start persistence and bounded retention precede the action', async t => {
  const journal = await import('../scripts/execution-journal.mjs')
  const start = journal.runAfterExecutionStart
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-persist-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  let called = false
  await assert.rejects(start({ common, event: strictEvent('start', 'step-started'),
    retention: { maxEvents: 1, maxBytes: 1, maxAgeMs: 1000 }, action: () => { called = true } }), /budget/)
  assert.equal(called, false)
  const event = strictEvent('start', 'step-started')
  await start({ common, event, action: async () => {
    assert.equal((await readExecutionEvents(common, event.runId))[0].kind, 'step-started')
    called = true
  } })
  assert.equal(called, true)
  await assert.rejects(appendExecutionEvent(common, strictEvent('end', 'step-failed'), { retention: { maxEvents: 1, maxBytes: 8192, maxAgeMs: 1000 } }), /budget/)
  await assert.rejects(appendExecutionEvent(common, strictEvent('end', 'step-failed'), { now: event.at + 2000, retention: { maxEvents: 10, maxBytes: 8192, maxAgeMs: 1000 } }), /retention/)
})

test('persisted required start cannot authorize a second action', async t => {
  const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-once-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const event = strictEvent('start', 'step-started')
  let actions = 0
  const request = { common, event, action: () => { actions++ } }
  await runAfterExecutionStart(request)
  await assert.rejects(runAfterExecutionStart(request), /already persisted/)
  assert.equal(actions, 1)
})

test('unknown external effects block a new non-idempotent attempt at persistence', async t => {
  const { resolveExecutionEffect } = await import('../scripts/execution-recovery.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-retry-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started')
  await appendExecutionEvent(common, start)
  await appendExecutionEvent(common, strictEvent('effect', 'effect-started', { at: start.at + 1, effect: { id: 'external-1', kind: 'publication', reference: null } }))
  const retry = strictEvent('retry', 'step-started', { attempt: 'attempt-2', at: start.at + 2 })
  await assert.rejects(appendExecutionEvent(common, retry), /effect.*retry/)
  await resolveExecutionEffect({ common, runId: start.runId, effectId: 'external-1', resolution: 'unknown', reason: 'inspected' })
  await assert.rejects(appendExecutionEvent(common, retry), /effect.*retry/)
  await resolveExecutionEffect({ common, runId: start.runId, effectId: 'external-1', resolution: 'failed', reason: 'inspected' })
  await appendExecutionEvent(common, retry)
  assert.equal((await readExecutionEvents(common, start.runId)).filter(e => e.kind === 'step-started').length, 2)
})
test('strict journal rejects duplicate attempts, effect ordering and forged operator authority', async () => {
  const { executionEvent, strictExecutionAttempts } = await import('../scripts/execution-journal.mjs')
  const start = strictEvent('start', 'step-started'), external = { id: 'external-1', kind: 'pr', reference: 'example/project#12' }
  assert.throws(() => strictExecutionAttempts([start, strictEvent('other', 'step-started', { step: 'review' })]), /Duplicate.*attempt/)
  assert.throws(() => strictExecutionAttempts([start, strictEvent('effect-end', 'effect-completed', { effect: external })]), /ambiguous/)
  assert.throws(() => strictExecutionAttempts([start, strictEvent('effect-start', 'effect-started', { at: start.at + 2, effect: external }),
    strictEvent('effect-end', 'effect-completed', { at: start.at + 1, effect: external })]), /ordered/)
  assert.throws(() => executionEvent(strictEvent('forged', 'effect-resolved', { effect: external,
    resolution: { outcome: 'completed', reason: 'inspected', trust: 'authenticated', authenticatedAuthorization: true } })), /resolution/)
  assert.throws(() => executionEvent(strictEvent('url', 'effect-started', { effect: { ...external, reference: 'https://invalid/pr/12' } })), /effect/)
  assert.throws(() => executionEvent(strictEvent('artifact', 'step-completed', { artifacts: [{ version: 1, runId: 'other', kind: 'stdout', sha256: 'b'.repeat(64), byteLength: 0 }] })), /artifact/)
})
test('unsafe or busy storage never permits the required action', async t => {
  const { runAfterExecutionStart, executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { mkdir, symlink, writeFile } = await import('node:fs/promises')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-storage-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const event = strictEvent('start', 'step-started'), directory = await executionDirectory(common, event.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(path.join(directory, '.lock'))
  let actions = 0
  const request = { common, event, action: () => { actions++ } }
  await assert.rejects(runAfterExecutionStart(request), /busy/)
  await rm(path.join(directory, '.lock'), { recursive: true })
  await writeFile(path.join(directory, 'unexpected'), 'partial')
  await assert.rejects(runAfterExecutionStart(request), /Incomplete/)
  await rm(directory, { recursive: true })
  const target = path.join(common, 'target'); await mkdir(target, { mode: 0o700 }); await symlink(target, directory)
  await assert.rejects(runAfterExecutionStart(request), /Unsafe/)
  assert.equal(actions, 0)
})

test('operator resolution independently rejects authenticatedAuthorization while retaining valid local observations', async () => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const resolution = { outcome: 'completed', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false }
  const event = strictEvent('resolution', 'effect-resolved', { effect: { id: 'effect-1', kind: 'vault', reference: null }, resolution })
  assert.deepEqual(executionEvent(event).resolution, resolution)
  assert.throws(() => executionEvent({ ...event, resolution: { ...resolution, authenticatedAuthorization: true } }), /Invalid local effect resolution/)
})
test('operator resolution independently rejects foreign trust while retaining valid local observations', async () => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const resolution = { outcome: 'completed', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false }
  const event = strictEvent('resolution', 'effect-resolved', { effect: { id: 'effect-1', kind: 'vault', reference: null }, resolution })
  assert.deepEqual(executionEvent(event).resolution, resolution)
  assert.throws(() => executionEvent({ ...event, resolution: { ...resolution, trust: 'authenticated' } }), /Invalid local effect resolution/)
})

async function assertCompletedEffectBlocksAction(t, localResolution) {
  const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
  const { resolveExecutionEffect } = await import('../scripts/execution-recovery.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'strict-completed-retry-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started')
  const effect = { id: 'external-1', kind: 'publication', reference: null }
  await appendExecutionEvent(common, start)
  await appendExecutionEvent(common, strictEvent('effect-start', 'effect-started', { at: start.at + 1, effect }))
  if (localResolution) {
    await resolveExecutionEffect({ common, runId: start.runId, effectId: effect.id, resolution: 'completed', reason: 'inspected' })
  } else {
    await appendExecutionEvent(common, strictEvent('effect-end', 'effect-completed', { at: start.at + 2, effect }))
  }
  const before = await readExecutionEvents(common, start.runId)
  assert.equal(before.at(-1).kind, localResolution ? 'effect-resolved' : 'effect-completed')
  if (localResolution) assert.equal(before.at(-1).resolution.outcome, 'completed')
  const retry = strictEvent('fresh-retry', 'step-started', { attempt: 'attempt-2', at: before.at(-1).at + 1 })
  let actions = 0
  const rejection = await runAfterExecutionStart({ common, event: retry, action: () => { actions++ } })
    .then(() => null, error => error)
  const after = await readExecutionEvents(common, start.runId)
  assert.equal(actions, 0)
  assert.equal(after.some(event => event.id === retry.id || event.attempt === retry.attempt), false)
  assert.ok(rejection instanceof Error)
  assert.match(rejection.message, /External effect outcome refuses non-idempotent retry/)
  assert.deepEqual(after, before)
}
test('recorded completed effects reject a fresh attempt before persistence or action', async t => {
  await assertCompletedEffectBlocksAction(t, false)
})
test('locally resolved completed effects reject a fresh attempt before persistence or action', async t => {
  await assertCompletedEffectBlocksAction(t, true)
})

async function assertPrivateDirectoryRequired(t, scope) {
  const { mkdir, chmod } = await import('node:fs/promises')
  const journal = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'private-journal-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('private-required', 'step-started')
  const directory = await journal.executionDirectory(common, start.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(scope === 'parent' ? path.dirname(directory) : directory, 0o755)
  let actions = 0
  await assert.rejects(journal.runAfterExecutionStart({ common, event: start,
    action: () => { actions++ } }), /Unsafe execution directory/)
  assert.equal(actions, 0)
  await chmod(scope === 'parent' ? path.dirname(directory) : directory, 0o700)
  assert.equal((await journal.readExecutionEvents(common, start.runId)).some(e => e.id === start.id), false)
}
test('non-private journal parent refuses start persistence and action', async t => {
  await assertPrivateDirectoryRequired(t, 'parent')
})
test('non-private run journal refuses start persistence and action', async t => {
  await assertPrivateDirectoryRequired(t, 'run')
})

for (const scope of ['parent', 'run']) {
  test('journal reader rejects writable ' + scope + ' storage before trusting history', async t => {
    const { chmod } = await import('node:fs/promises')
    const { executionDirectory } = await import('../scripts/execution-journal.mjs')
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-read-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    await appendExecutionEvent(common, event('start', 'step-started'))
    assert.equal((await readExecutionEvents(common, 'r1'))[0].version, 1)
    const directory = await executionDirectory(common, 'r1')
    await chmod(scope === 'parent' ? path.dirname(directory) : directory, 0o777)
    await assert.rejects(readExecutionEvents(common, 'r1'), /Unsafe execution directory/)
  })
}
test('absent journal history is empty only beneath safe storage', async t => {
  const { mkdir, chmod, symlink } = await import('node:fs/promises')
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-absent-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const directory = await executionDirectory(common, 'r1'), parent = path.dirname(directory)
  assert.deepEqual(await readExecutionEvents(common, 'r1'), [])
  await mkdir(parent, { mode: 0o700 })
  assert.deepEqual(await readExecutionEvents(common, 'r1'), [])
  await chmod(parent, 0o777)
  await assert.rejects(readExecutionEvents(common, 'r1'), /Unsafe execution directory/)
  await chmod(parent, 0o700)
  await symlink(path.join(common, 'missing'), directory)
  await assert.rejects(readExecutionEvents(common, 'r1'), /Unsafe execution directory/)
})

for (const outcome of ['interrupted', 'unknown', 'completed', 'resolved-unknown', 'resolved-completed', 'failed', 'resolved-failed']) {
  test('overlapping attempt checks prior ' + outcome + ' effect before persistence or action', async t => {
    const journal = await import('../scripts/execution-journal.mjs')
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'overlapping-attempt-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const first = strictEvent('first', 'step-started')
    await journal.appendExecutionEvent(common, first)
    await journal.appendExecutionEvent(common, strictEvent('second', 'step-started', { attempt: 'attempt-2', at: first.at + 1 }))
    const effect = { id: 'external-1', kind: 'publication', reference: null }
    await journal.appendExecutionEvent(common, strictEvent('external-first', 'effect-started', { effect, at: first.at + 2 }))
    if (outcome.startsWith('resolved-')) {
      await journal.appendExecutionEvent(common, strictEvent('resolution-first', 'effect-resolved', { effect, at: first.at + 3,
        resolution: { outcome: outcome.slice(9), reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false } }))
    } else if (outcome !== 'interrupted') {
      await journal.appendExecutionEvent(common, strictEvent('end-first', 'effect-' + outcome, { effect, at: first.at + 3 }))
    }
    const before = await journal.readExecutionEvents(common, first.runId)
    const next = strictEvent('external-second', 'effect-started', { attempt: 'attempt-2', at: first.at + 4,
      effect: { id: 'external-2', kind: 'publication', reference: null } })
    let actions = 0
    const rejection = await journal.runAfterExecutionStart({ common, event: next, action: () => { actions++ } })
      .then(() => null, error => error)
    const after = await journal.readExecutionEvents(common, first.runId)
    const allowed = outcome === 'failed' || outcome === 'resolved-failed'
    assert.equal(actions, allowed ? 1 : 0)
    assert.equal(after.some(event => event.id === next.id), allowed)
    assert.deepEqual(after.filter(event => event.id !== next.id), before)
    if (allowed) assert.equal(rejection, null)
    else {
      assert.ok(rejection instanceof Error)
      assert.match(rejection.message, /External effect outcome refuses non-idempotent retry/)
      assert.deepEqual(after, before)
    }
  })
}

for (const outcome of ['interrupted', 'unknown', 'completed', 'resolved-completed']) {
  test('same attempt permits subsequent effects and outcomes after its own ' + outcome + ' effect', async t => {
    const journal = await import('../scripts/execution-journal.mjs')
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'same-attempt-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const start = strictEvent('start', 'step-started')
    const first = { id: 'external-1', kind: 'publication', reference: null }
    const second = { id: 'external-2', kind: 'publication', reference: null }
    await journal.appendExecutionEvent(common, start)
    await journal.appendExecutionEvent(common, strictEvent('first-effect', 'effect-started', { effect: first, at: start.at + 1 }))
    if (outcome === 'resolved-completed') {
      await journal.appendExecutionEvent(common, strictEvent('first-resolution', 'effect-resolved', { effect: first, at: start.at + 2,
        resolution: { outcome: 'completed', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false } }))
    } else if (outcome !== 'interrupted') {
      await journal.appendExecutionEvent(common, strictEvent('first-end', 'effect-' + outcome, { effect: first, at: start.at + 2 }))
    }
    let actions = 0
    const next = strictEvent('second-effect', 'effect-started', { effect: second, at: start.at + 3 })
    const rejection = await journal.runAfterExecutionStart({ common, event: next, action: () => { actions++ } })
      .then(() => null, error => error)
    assert.equal(rejection, null)
    assert.equal(actions, 1)
    const records = await journal.readExecutionEvents(common, start.runId)
    assert.ok(records.some(record => record.id === next.id))
    await journal.appendExecutionEvent(common, strictEvent('second-end', 'effect-completed', { effect: second, at: start.at + 4 }))
    await journal.appendExecutionEvent(common, strictEvent('later-resolution', 'effect-resolved', { effect: first, at: start.at + 5,
      resolution: { outcome: 'unknown', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false } }))
    await journal.appendExecutionEvent(common, strictEvent('step-end', 'step-failed', { at: start.at + 6 }))
    const after = await journal.readExecutionEvents(common, start.runId)
    assert.deepEqual(after.filter(record => record.at > next.at).map(record => record.kind), ['effect-completed', 'effect-resolved', 'step-failed'])
  })
}

for (const effectKind of ['pr', 'vault', 'publication']) {
  for (const outcome of ['interrupted', 'unknown', 'completed', 'failed']) {
    for (const kind of ['step-started', 'effect-started']) {
      test('historical ' + effectKind + ' ' + outcome + ' outcome gates strict ' + kind + ' before persistence and action', async t => {
        const journal = await import('../scripts/execution-journal.mjs')
        const common = await realpath(await mkdtemp(path.join(tmpdir(), 'historical-action-')))
        t.after(() => rm(common, { recursive: true, force: true }))
        const strict = strictEvent('new-start', 'step-started', { step: 'new-publish', attempt: 'new-attempt' })
        const old = { version: 1, runId: strict.runId, step: 'old-publish', attempt: 'old-attempt',
          at: strict.at, inputs: strict.inputs, branches: strict.branches }
        await journal.appendExecutionEvent(common, { ...old, id: 'old-start', kind: 'step-started' })
        if (kind === 'effect-started') await journal.appendExecutionEvent(common, { ...strict, at: strict.at + 1 })
        const effect = { id: 'old-effect', kind: effectKind, reference: effectKind === 'pr' ? 'example/project#12' : null }
        await journal.appendExecutionEvent(common, { ...old, id: 'old-effect-start', kind: 'effect-started', effect, at: strict.at + 2 })
        if (outcome !== 'interrupted') await journal.appendExecutionEvent(common,
          { ...old, id: 'old-effect-end', kind: 'effect-' + outcome, effect, at: strict.at + 3 })
        const next = kind === 'step-started' ? { ...strict, at: strict.at + 4 }
          : { ...strict, id: 'new-effect', kind, at: strict.at + 4, effect: { ...effect, id: 'new-effect' } }
        const before = await journal.readExecutionEvents(common, strict.runId)
        let actions = 0
        const rejection = await journal.runAfterExecutionStart({ common, event: next, action: () => { actions++ } })
          .then(() => null, error => error)
        const after = await journal.readExecutionEvents(common, strict.runId), allowed = outcome === 'failed'
        assert.equal(actions, allowed ? 1 : 0)
        assert.equal(after.some(event => event.id === next.id), allowed)
        assert.deepEqual(after.filter(event => event.id !== next.id), before)
        if (allowed) assert.equal(rejection, null)
        else {
          assert.ok(rejection instanceof Error)
          assert.match(rejection.message, /Historical external effect outcome refuses strict action/)
        }
      })
    }
  }
}
test('historical history without external effects permits a fresh strict action without promoting old receipts', async t => {
  const journal = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'historical-no-effect-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const strict = strictEvent('strict-start', 'step-started')
  const old = { version: 1, runId: strict.runId, step: strict.step, attempt: 'old-attempt',
    at: strict.at, inputs: strict.inputs, branches: strict.branches }
  await journal.appendExecutionEvent(common, { ...old, id: 'old-start', kind: 'step-started' })
  await journal.appendExecutionEvent(common, { ...old, id: 'old-end', kind: 'step-completed', at: strict.at + 1 })
  let actions = 0
  const rejection = await journal.runAfterExecutionStart({ common, event: { ...strict, at: strict.at + 2 }, action: () => { actions++ } })
    .then(() => null, error => error)
  assert.equal(rejection, null)
  assert.equal(actions, 1)
  const events = await journal.readExecutionEvents(common, strict.runId)
  assert.equal(events.filter(event => event.version === 1).length, 2)
  assert.equal(journal.strictExecutionAttempts(events).length, 1)
})

for (const contradiction of ['reference-mismatch', 'effect-before-step', 'effect-after-step-end']) {
  test('historical contradiction ' + contradiction + ' cannot authorize a strict action', async t => {
    const journal = await import('../scripts/execution-journal.mjs')
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'historical-contradiction-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const strict = strictEvent('new-start', 'step-started')
    const old = { version: 1, runId: strict.runId, step: 'old-publish', attempt: 'old-attempt',
      at: strict.at, inputs: strict.inputs, branches: strict.branches }
    const effect = { id: 'old-effect', kind: 'pr', reference: 'example/project#12' }
    await journal.appendExecutionEvent(common, { ...old, id: 'old-start', kind: 'step-started' })
    await journal.appendExecutionEvent(common, { ...old, id: 'old-effect', kind: 'effect-started', effect,
      at: strict.at + (contradiction === 'effect-before-step' ? -1 : 1) })
    if (contradiction === 'effect-after-step-end') await journal.appendExecutionEvent(common,
      { ...old, id: 'old-step-end', kind: 'step-completed', at: strict.at + 2 })
    await journal.appendExecutionEvent(common, { ...old, id: 'old-failed', kind: 'effect-failed', at: strict.at + 3,
      effect: contradiction === 'reference-mismatch' ? { ...effect, reference: 'example/project#99' } : effect })
    const before = await journal.readExecutionEvents(common, strict.runId)
    let actions = 0
    const rejection = await journal.runAfterExecutionStart({ common, event: { ...strict, at: strict.at + 4 }, action: () => { actions++ } })
      .then(() => null, error => error)
    assert.equal(actions, 0)
    assert.deepEqual(await journal.readExecutionEvents(common, strict.runId), before)
    assert.ok(rejection instanceof Error)
    assert.match(rejection.message, /Historical (?:execution requires ordered|effect requires matching)/)
  })
}

for (const contradiction of ['missing-step-start', 'duplicate-step-start', 'missing-effect-start', 'duplicate-effect-start', 'duplicate-effect-end', 'reversed-effect-end', 'duplicate-step-end']) {
  test('historical graph contradiction ' + contradiction + ' refuses strict persistence and action', async t => {
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'historical-graph-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const strict = strictEvent('new-start', 'step-started'), effect = { id: 'old-effect', kind: 'publication', reference: null }
    const old = { version: 1, runId: strict.runId, step: 'old-step', attempt: 'old-attempt', inputs: strict.inputs, branches: strict.branches }
    const records = []
    if (contradiction !== 'missing-step-start') records.push({ ...old, id: 'old-start', kind: 'step-started', at: strict.at })
    if (contradiction === 'duplicate-step-start') records.push({ ...old, id: 'duplicate-start', kind: 'step-started', at: strict.at + 1 })
    if (contradiction !== 'missing-effect-start') records.push({ ...old, id: 'old-effect-start', kind: 'effect-started', effect, at: strict.at + 2 })
    if (contradiction === 'duplicate-effect-start') records.push({ ...old, id: 'duplicate-effect', kind: 'effect-started', effect, at: strict.at + 1 })
    records.push({ ...old, id: 'old-effect-end', kind: 'effect-failed', effect, at: strict.at + (contradiction === 'reversed-effect-end' ? 1 : 3) })
    if (contradiction === 'duplicate-effect-end') records.push({ ...old, id: 'duplicate-end', kind: 'effect-failed', effect, at: strict.at + 4 })
    if (contradiction === 'duplicate-step-end') {
      records.push({ ...old, id: 'old-step-end', kind: 'step-completed', at: strict.at + 4 })
      records.push({ ...old, id: 'duplicate-step-end', kind: 'step-failed', at: strict.at + 4 })
    }
    for (const record of records) await appendExecutionEvent(common, record)
    const before = await readExecutionEvents(common, strict.runId)
    let actions = 0
    const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
    const rejection = await runAfterExecutionStart({ common, event: { ...strict, at: strict.at + 6 }, action: () => { actions++ } })
      .then(() => null, error => error)
    assert.equal(actions, 0)
    assert.deepEqual(await readExecutionEvents(common, strict.runId), before)
    assert.ok(rejection instanceof Error)
    assert.match(rejection.message, /Execution attempt requires|External effect history/)
  })
}
for (const scenario of ['equal-failed', 'stale-unknown', 'reused-effect-id']) {
  test('historical ' + scenario + ' retains per-attempt outcomes at the strict action boundary', async t => {
    const journal = await import('../scripts/execution-journal.mjs')
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'historical-outcome-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const strict = strictEvent('new-start', 'step-started'), effect = { id: 'old-effect', kind: 'vault', reference: null }
    const old = { version: 1, runId: strict.runId, step: 'old-step', attempt: 'old-attempt',
      inputs: scenario === 'stale-unknown' ? { ...strict.inputs, commit: 'c'.repeat(40) } : strict.inputs, branches: strict.branches }
    await appendExecutionEvent(common, { ...old, id: 'old-start', kind: 'step-started', at: strict.at })
    await appendExecutionEvent(common, { ...old, id: 'old-effect-start', kind: 'effect-started', effect, at: strict.at })
    if (scenario === 'equal-failed') await appendExecutionEvent(common,
      { ...old, id: 'old-effect-end', kind: 'effect-failed', effect, at: strict.at })
    if (scenario === 'reused-effect-id') {
      await appendExecutionEvent(common, { ...old, attempt: 'other-old', id: 'other-start', kind: 'step-started', at: strict.at + 1 })
      await appendExecutionEvent(common, { ...old, attempt: 'other-old', id: 'other-effect', kind: 'effect-started', effect, at: strict.at + 2 })
      await appendExecutionEvent(common, { ...old, attempt: 'other-old', id: 'other-end', kind: 'effect-failed', effect, at: strict.at + 3 })
    }
    const before = await readExecutionEvents(common, strict.runId)
    let actions = 0
    const rejection = await journal.runAfterExecutionStart({ common, event: { ...strict, at: strict.at + 4 }, action: () => { actions++ } })
      .then(() => null, error => error)
    const allowed = scenario === 'equal-failed'
    assert.equal(actions, allowed ? 1 : 0)
    const after = await readExecutionEvents(common, strict.runId)
    assert.equal(after.some(record => record.id === strict.id), allowed)
    assert.deepEqual(after.filter(record => record.id !== strict.id), before)
    if (allowed) assert.equal(rejection, null)
    else assert.match(rejection?.message ?? '', /Historical external effect outcome refuses strict action/)
  })
}
test('strict query and resolution APIs cannot clear historical unknown-effect refusal', async t => {
  const { writeFile } = await import('node:fs/promises')
  const { git, discover } = await import('../scripts/workflow-lifecycle.mjs')
  const { reconcileExecutionAttempt, resolveExecutionEffect } = await import('../scripts/execution-recovery.mjs')
  const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'historical-adapters-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'file'), 'baseline')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const common = discover(root).common, commit = git(['rev-parse', 'HEAD'], root)
  const strict = strictEvent('new-start', 'step-started', { inputs: { ...strictInputs, commit }, branches: { 'refs/heads/main': commit } })
  const old = { version: 1, runId: strict.runId, step: 'old-step', attempt: 'old-attempt', at: strict.at, inputs: strict.inputs, branches: strict.branches }
  await appendExecutionEvent(common, { ...old, id: 'old-start', kind: 'step-started' })
  await appendExecutionEvent(common, { ...old, id: 'old-effect', kind: 'effect-started', at: strict.at + 1,
    effect: { id: 'old-pr', kind: 'pr', reference: 'example/project#12' } })
  const before = await readExecutionEvents(common, strict.runId)
  let queries = 0
  const report = await reconcileExecutionAttempt({ common, runId: strict.runId, inputs: strict.inputs, branches: strict.branches,
    retention: { maxArtifactBytes: 1024, maxRunBytes: 4096, maxAgeMs: 86400000 }, effectQueries: {
      authorizedPrReferences: ['example/project#12'], queryPr: async () => { queries++; return { stdout: JSON.stringify({ number: 12, state: 'OPEN', headRefOid: commit }) } }
    } })
  assert.equal(queries, 0)
  assert.equal(report.queriesUsed, 0)
  assert.equal(report.verifiedComplete, false)
  assert.equal(report.attempts[0].state, 'historical-observation')
  assert.equal(report.attempts[0].retryAllowed, false)
  await assert.rejects(resolveExecutionEffect({ common, runId: strict.runId, effectId: 'old-pr', resolution: 'failed', reason: 'inspected' }), /one strict recorded/)
  let actions = 0
  const rejection = await runAfterExecutionStart({ common, event: { ...strict, at: strict.at + 2 }, action: () => { actions++ } })
    .then(() => null, error => error)
  assert.equal(actions, 0)
  assert.match(rejection?.message ?? '', /Historical external effect outcome refuses strict action/)
  assert.deepEqual(await readExecutionEvents(common, strict.runId), before)
})

async function journalBytes(common, runId) {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { readdir, readFile } = await import('node:fs/promises')
  const directory = await executionDirectory(common, runId)
  return Promise.all((await readdir(directory)).sort().map(async name => ({ name, bytes: await readFile(path.join(directory, name)) })))
}
async function endedAttemptFixture(t, outcome, precedingEffect = false) {
  const { retainExecutionArtifact, readExecutionArtifact } = await import('../scripts/execution-artifacts.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'ended-attempt-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started'), endAt = start.at + 4
  await appendExecutionEvent(common, start)
  const effect = { id: 'recorded-effect', kind: 'publication', reference: null }
  const first = { ...start, id: 'recorded-start', kind: 'effect-started', effect, at: start.at + 1 }
  if (precedingEffect) await appendExecutionEvent(common, first)
  let artifacts = []
  if (outcome === 'step-completed') {
    const retention = { maxArtifactBytes: 8192, maxRunBytes: 65536, maxAgeMs: 86400000 }
    const bytes = Buffer.from('observed step result')
    const { reference } = await retainExecutionArtifact({ common, runId: start.runId, kind: 'result', bytes, retention })
    assert.deepEqual(await readExecutionArtifact({ common, runId: start.runId, reference, retention }), bytes)
    artifacts = [reference]
  }
  if (outcome !== 'open') await appendExecutionEvent(common, { ...start, id: 'end', kind: outcome, at: endAt, artifacts })
  return { common, start, endAt, first, effect }
}
for (const outcome of ['step-failed', 'step-completed', 'open']) {
  for (const delta of [-1, 0, 1]) {
    test('persisted ' + outcome + ' attempt gates new effect at end offset ' + delta, async t => {
      const { common, start, endAt } = await endedAttemptFixture(t, outcome)
      const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
      const next = { ...start, id: 'late-effect', kind: 'effect-started', at: endAt + delta,
        effect: { id: 'new-publication', kind: 'publication', reference: null } }
      const before = await journalBytes(common, start.runId)
      let actions = 0
      const rejection = await runAfterExecutionStart({ common, event: next, action: () => { actions++ } })
        .then(() => null, error => error)
      const after = await journalBytes(common, start.runId)
      const allowed = outcome === 'open'
      assert.equal(actions, allowed ? 1 : 0)
      assert.equal((await readExecutionEvents(common, start.runId)).some(record => record.id === next.id), allowed)
      for (const record of before) assert.deepEqual(after.find(other => other.name === record.name), record)
      if (allowed) {
        assert.equal(rejection, null)
        assert.equal(after.length, before.length + 1)
      } else {
        assert.deepEqual(after, before)
        assert.match(rejection?.message ?? '', /Execution attempt already ended/)
      }
    })
  }
}
for (const dimension of ['executionId', 'task', 'step', 'attempt']) {
  test('closed attempt does not block an open action with distinct ' + dimension, async t => {
    const { common, start, endAt } = await endedAttemptFixture(t, 'step-completed')
    const { runAfterExecutionStart } = await import('../scripts/execution-journal.mjs')
    const changes = { executionId: { executionId: 'execution-2' }, task: { task: 'T2', attempt: 'other-attempt' },
      step: { step: 'review', attempt: 'other-attempt' }, attempt: { attempt: 'other-attempt' } }
    const other = { ...start, ...changes[dimension], id: 'other-start', at: endAt + 1 }
    await appendExecutionEvent(common, other)
    const before = await journalBytes(common, start.runId)
    let actions = 0
    const next = { ...other, id: 'other-effect', kind: 'effect-started', at: endAt + 2,
      effect: { id: 'other-publication', kind: 'publication', reference: null } }
    const rejection = await runAfterExecutionStart({ common, event: next, action: () => { actions++ } })
      .then(() => null, error => error)
    assert.equal(rejection, null)
    assert.equal(actions, 1)
    const after = await journalBytes(common, start.runId)
    for (const record of before) assert.deepEqual(after.find(other => other.name === record.name), record)
    assert.equal(after.length, before.length + 1)
  })
}
for (const observation of ['effect-completed', 'effect-failed', 'effect-unknown']) {
  test('closed attempt retains existing effect observations and local resolution after ' + observation, async t => {
    const { common, start, endAt, first, effect } = await endedAttemptFixture(t, 'step-completed', true)
    const before = await journalBytes(common, start.runId)
    await appendExecutionEvent(common, first)
    assert.deepEqual(await journalBytes(common, start.runId), before)
    const outcomeRejection = await appendExecutionEvent(common, { ...start, id: 'observed-outcome', kind: observation, effect, at: endAt })
      .then(() => null, error => error)
    assert.equal(outcomeRejection, null)
    const resolutionRejection = await appendExecutionEvent(common, { ...start, id: 'local-resolution', kind: 'effect-resolved', effect, at: endAt + 1,
      resolution: { outcome: 'completed', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false } })
      .then(() => null, error => error)
    assert.equal(resolutionRejection, null)
    const events = await readExecutionEvents(common, start.runId)
    assert.equal(events.find(record => record.id === 'observed-outcome').kind, observation)
    assert.equal(events.find(record => record.id === 'local-resolution').resolution.authenticatedAuthorization, false)
    const after = await journalBytes(common, start.runId)
    for (const record of before) assert.deepEqual(after.find(other => other.name === record.name), record)
    assert.equal(after.length, before.length + 2)
  })
}

// A pid that named a real process which has already exited and been reaped.
async function deadPid() {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 })
  assert.equal(result.status, 0)
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' })
  return result.pid
}
async function plantLock(directory, pid) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(path.join(directory, '.lock'), { mode: 0o700 })
  await writeFile(path.join(directory, '.lock', 'pid'), `${pid}\n`, { mode: 0o600 })
}
async function plantTemporary(directory, ageMs) {
  const { writeFile, utimes } = await import('node:fs/promises')
  const { randomUUID } = await import('node:crypto')
  const name = '.' + randomUUID() + '.tmp', file = path.join(directory, name), at = (Date.now() - ageMs) / 1000
  await writeFile(file, 'partial', { mode: 0o600 })
  await utimes(file, at, at)
  return name
}
test('a dead-pid lock and a stale temporary record are reconciled by the next append and reported', async t => {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { readdir } = await import('node:fs/promises')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-reconcile-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started'), directory = await executionDirectory(common, start.runId)
  const first = await appendExecutionEvent(common, start)
  assert.deepEqual(first.reconciled, [])
  const stale = await plantTemporary(directory, 61000)
  await plantLock(directory, await deadPid())
  const end = await appendExecutionEvent(common, strictEvent('end', 'step-failed', { at: start.at + 1 }))
  assert.deepEqual(end.reconciled, [{ path: '.lock', reason: 'dead-lock-holder' }, { path: stale, reason: 'stale-temporary' }])
  assert.equal(JSON.stringify(end).includes('reconciled'), false)
  assert.equal((await readExecutionEvents(common, start.runId)).length, 2)
  const { mkdir } = await import('node:fs/promises')
  const { randomUUID } = await import('node:crypto')
  const owned = `.lock.${process.pid}.${randomUUID()}.stale`
  await mkdir(path.join(directory, owned), { mode: 0o700 })
  assert.equal((await readExecutionEvents(common, start.runId)).length, 2)
  assert.deepEqual((await appendExecutionEvent(common, strictEvent('third', 'step-started', { attempt: 'attempt-3', at: start.at + 2 }))).reconciled, [])
  assert.ok((await readdir(directory)).includes(owned))
  await rm(path.join(directory, owned), { recursive: true })
  const young = await plantTemporary(directory, 59000)
  await assert.rejects(appendExecutionEvent(common, strictEvent('other', 'step-started', { attempt: 'attempt-2', at: start.at + 2 })), /Incomplete/)
  assert.ok((await readdir(directory)).includes(young))
})
test('a journal lock held by a live process is waited on with bounded backoff, then refused as busy', { timeout: 30000 }, async t => {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-live-lock-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const start = strictEvent('start', 'step-started'), directory = await executionDirectory(common, start.runId)
  await appendExecutionEvent(common, start)
  await plantLock(directory, process.pid)
  let began = Date.now()
  await assert.rejects(appendExecutionEvent(common, strictEvent('end', 'step-failed', { at: start.at + 1 })), /busy/)
  const waited = Date.now() - began
  assert.ok(waited >= 4500 && waited <= 6500, `waited ${waited} ms`)
  began = Date.now()
  const release = new Promise(resolve => setTimeout(resolve, 300)).then(() => rm(path.join(directory, '.lock'), { recursive: true }))
  const end = await appendExecutionEvent(common, strictEvent('end', 'step-failed', { at: start.at + 1 }))
  await release
  assert.ok(Date.now() - began >= 250)
  assert.deepEqual(end.reconciled, [])
})

async function plantRecords(common, runId, count, sizeOf = () => null) {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const directory = await executionDirectory(common, runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let base = 0; base < count; base += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - base) }, (_, offset) => {
      const i = base + offset, record = event('planted-' + i, 'step-started', i + 1, { runId, step: 'step-' + i })
      const json = JSON.stringify(record), size = sizeOf(i)
      const text = size === null ? json + '\n' : json + ' '.repeat(size - Buffer.byteLength(json) - 1) + '\n'
      return writeFile(path.join(directory, createHash('sha256').update(record.id).digest('hex') + '.json'), text, { mode: 0o600, flag: 'wx' })
    }))
  }
  return directory
}
test('the journal accepts exactly 1000 events and refuses the 1001st on read and on append', { timeout: 60000 }, async t => {
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-count-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await plantRecords(common, 'r1', 1000)
  assert.equal((await readExecutionEvents(common, 'r1')).length, 1000)
  await plantRecords(common, 'r2', 999)
  await appendExecutionEvent(common, event('appended-999', 'step-started', 5000, { runId: 'r2', step: 'last' }))
  assert.equal((await readExecutionEvents(common, 'r2')).length, 1000)
  await assert.rejects(appendExecutionEvent(common, event('appended-1000', 'step-started', 5001, { runId: 'r2', step: 'over' })), /Execution journal exceeds budget/)
  const { writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const extra = event('planted-extra', 'step-started', 9999, { runId: 'r1', step: 'extra' })
  await writeFile(path.join(await executionDirectory(common, 'r1'), createHash('sha256').update(extra.id).digest('hex') + '.json'), JSON.stringify(extra) + '\n', { mode: 0o600 })
  await assert.rejects(readExecutionEvents(common, 'r1'), /Execution journal exceeds budget/)
})
test('the journal read bound accepts exactly 1 MiB of records and refuses one byte more', { timeout: 60000 }, async t => {
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-bytes-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  // 128 records of 8128 bytes and one of 8192 bytes total exactly 1048576 bytes.
  await plantRecords(common, 'r1', 129, i => i === 128 ? 8192 : 8128)
  assert.equal((await readExecutionEvents(common, 'r1')).length, 129)
  await plantRecords(common, 'r2', 129, i => i === 128 ? 8192 : i === 0 ? 8129 : 8128)
  await assert.rejects(readExecutionEvents(common, 'r2'), /^Error: Execution journal exceeds budget$/)
})

test('agent-dispatch is a strict effect kind whose resolutions are not-started or completed, and unknown kinds stay refused', async t => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const { resolveExecutionEffect } = await import('../scripts/execution-recovery.mjs')
  const dispatch = { id: 'dispatch-1', kind: 'agent-dispatch', reference: null }
  const resolution = outcome => ({ outcome, reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false })
  assert.equal(executionEvent(strictEvent('d', 'effect-started', { effect: dispatch })).effect.kind, 'agent-dispatch')
  for (const kind of ['shell', 'agent', 'Agent-dispatch']) assert.throws(() => executionEvent(strictEvent('d', 'effect-started', { effect: { ...dispatch, kind } })), /effect/)
  assert.throws(() => executionEvent(strictEvent('d', 'effect-started', { effect: { ...dispatch, reference: 'example/project#12' } })), /effect/)
  for (const outcome of ['not-started', 'completed']) assert.equal(executionEvent(strictEvent('r', 'effect-resolved', { effect: dispatch, resolution: resolution(outcome) })).resolution.outcome, outcome)
  for (const outcome of ['failed', 'unknown', 'started']) assert.throws(() => executionEvent(strictEvent('r', 'effect-resolved', { effect: dispatch, resolution: resolution(outcome) })), /resolution/)
  assert.throws(() => executionEvent(strictEvent('r', 'effect-resolved', { effect: { id: 'v', kind: 'vault', reference: null }, resolution: resolution('not-started') })), /resolution/)
  for (const [outcome, retry] of [['completed', false], ['not-started', true]]) {
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-dispatch-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const start = strictEvent('start', 'step-started')
    await appendExecutionEvent(common, start)
    await appendExecutionEvent(common, strictEvent('dispatch', 'effect-started', { at: start.at + 1, effect: dispatch }))
    const again = strictEvent('again', 'step-started', { attempt: 'attempt-2', at: start.at + 2 })
    await assert.rejects(appendExecutionEvent(common, again), /effect.*retry/)
    await resolveExecutionEffect({ common, runId: start.runId, effectId: 'dispatch-1', resolution: outcome, reason: 'inspected' })
    if (retry) await appendExecutionEvent(common, { ...again, at: Date.now() + 10 })
    else await assert.rejects(appendExecutionEvent(common, { ...again, at: Date.now() + 10 }), /effect.*retry/)
  }
})
test('strict artifact references accept RETENTION_LIMITS.maxArtifactBytes and refuse one byte more', async () => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const { RETENTION_LIMITS } = await import('../scripts/execution-artifacts.mjs')
  const reference = byteLength => ({ version: 1, runId: 'strict-run', kind: 'stdout', sha256: 'c'.repeat(64), byteLength })
  assert.equal(executionEvent(strictEvent('end', 'step-completed', { artifacts: [reference(16 * 1024 * 1024)] })).artifacts[0].byteLength, RETENTION_LIMITS.maxArtifactBytes)
  assert.throws(() => executionEvent(strictEvent('end', 'step-completed', { artifacts: [reference(16 * 1024 * 1024 + 1)] })), /artifact identity/)
})

test('custom journal budgets may reach but not pass 1000 events, 1 MiB and one year', async t => {
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-policy-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  const upper = { maxEvents: 1000, maxBytes: 1024 * 1024, maxAgeMs: 365 * 86400000 }
  await appendExecutionEvent(common, strictEvent('start', 'step-started'), { retention: upper })
  for (const key of Object.keys(upper)) {
    await assert.rejects(appendExecutionEvent(common, strictEvent('next-' + key, 'step-failed'), { retention: { ...upper, [key]: upper[key] + 1 } }), /Invalid execution journal retention budget/)
  }
})
test('the append-side byte budget accepts a journal of exactly maxBytes and refuses one byte more', async t => {
  const { executionEvent } = await import('../scripts/execution-journal.mjs')
  const start = strictEvent('start', 'step-started'), end = strictEvent('end', 'step-failed', { at: start.at + 1 })
  const bytes = raw => Buffer.byteLength(JSON.stringify(executionEvent(raw))) + 1
  const total = bytes(start) + bytes(end)
  for (const [maxBytes, accepted] of [[total, true], [total - 1, false]]) {
    const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-append-bytes-')))
    t.after(() => rm(common, { recursive: true, force: true }))
    const retention = { maxEvents: 10, maxBytes, maxAgeMs: 86400000 }
    await appendExecutionEvent(common, start, { retention })
    const append = appendExecutionEvent(common, end, { retention })
    if (accepted) await append
    else await assert.rejects(append, /^Error: Execution journal exceeds budget$/)
  }
})
function eventOfSize(executionEvent, id, target) {
  const branches = {}, sha = 'b'.repeat(40)
  const record = () => event(id, 'step-started', 1, { branches })
  const size = () => Buffer.byteLength(JSON.stringify(executionEvent(record()))) + 1
  for (let i = 0; size() + 230 < target; i++) branches[`refs/heads/p${String(i).padStart(3, '0')}-${'x'.repeat(100)}`] = sha
  branches['refs/heads/zz-'] = sha
  const pad = target - size()
  delete branches['refs/heads/zz-']
  branches['refs/heads/zz-' + 'y'.repeat(pad)] = sha
  assert.equal(size(), target)
  return record()
}
test('an execution record of exactly 8192 bytes is accepted and one of 8193 bytes is refused', async t => {
  const { executionEvent, executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-record-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await appendExecutionEvent(common, eventOfSize(executionEvent, 'fits', 8192))
  assert.equal((await readExecutionEvents(common, 'r1')).length, 1)
  await assert.rejects(appendExecutionEvent(common, eventOfSize(executionEvent, 'over', 8193)), /^Error: Execution record exceeds budget$/)
  const over = eventOfSize(executionEvent, 'planted', 8193)
  await writeFile(path.join(await executionDirectory(common, 'r1'), createHash('sha256').update(over.id).digest('hex') + '.json'), JSON.stringify(executionEvent(over)) + '\n', { mode: 0o600 })
  await assert.rejects(readExecutionEvents(common, 'r1'), /Unsafe execution record/)
})
test('EFFECT_RESOLUTIONS lists the exact outcomes for every strict effect kind', async () => {
  const { EFFECT_RESOLUTIONS, executionEvent } = await import('../scripts/execution-journal.mjs')
  const shared = ['completed', 'failed', 'unknown']
  assert.deepEqual(JSON.parse(JSON.stringify(EFFECT_RESOLUTIONS)), { pr: shared, vault: shared, publication: shared, 'agent-dispatch': ['not-started', 'completed'] })
  const resolution = { outcome: 'unknown', reason: 'inspected', trust: 'local-operator-observation', authenticatedAuthorization: false }
  assert.equal(executionEvent(strictEvent('r', 'effect-resolved', { effect: { id: 'pr-1', kind: 'pr', reference: 'example/project#12' }, resolution })).resolution.outcome, 'unknown')
})

// Open item 14: an appender's `.<uuid>.tmp` exists between its write and its unlink, and an
// unlocked reader (the driver reads this way) listed it as unexpected storage.
const appenderTemporary = () => '.' + crypto.randomUUID() + '.tmp'
async function plantJournalEntry(common, runId, name, { ageMs = 0, kind = 'file' } = {}) {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { mkdir, writeFile, symlink, utimes, lutimes } = await import('node:fs/promises')
  const directory = await executionDirectory(common, runId), file = path.join(directory, name), at = (Date.now() - ageMs) / 1000
  if (kind === 'file') { await writeFile(file, 'partial', { mode: 0o600 }); await utimes(file, at, at) }
  else if (kind === 'symlink') { await writeFile(path.join(common, 'outside'), 'partial', { mode: 0o600 }); await symlink(path.join(common, 'outside'), file); await lutimes(file, at, at) }
  else { await mkdir(file, { mode: 0o700 }); await utimes(file, at, at) }
  return file
}
test('concurrent appenders in other processes never make an unlocked read fail on their in-flight temporary', { timeout: 60000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { readdir } = await import('node:fs/promises')
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-race-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await appendExecutionEvent(common, event('seed', 'step-started', 1, { runId: 'race', step: 'seed' }))
  const directory = await executionDirectory(common, 'race'), module = new URL('../scripts/execution-journal.mjs', import.meta.url).href
  const perChild = 12
  // Each appender holds its synced temporary in place for 25 ms before linking it, so the window
  // the reader must survive is wide and is hit on every run instead of by chance.
  const child = name => spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'
    const link = fs.promises.link
    fs.promises.link = async (...args) => { await new Promise(resolve => setTimeout(resolve, 25)); return link(...args) }
    syncBuiltinESMExports()
    const { appendExecutionEvent } = await import(${JSON.stringify(module)})
    for (let i = 0; i < ${perChild}; i++) await appendExecutionEvent(${JSON.stringify(common)}, { ...${JSON.stringify(event('x', 'step-started', 2, { runId: 'race' }))}, id: '${name}-' + i, step: '${name}-' + i })
  `], { stdio: ['ignore', 'ignore', 'pipe'] })
  const children = ['alpha', 'beta'].map(child)
  t.after(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') })
  const stderr = children.map(c => { const chunks = []; c.stderr.on('data', chunk => chunks.push(chunk)); return chunks })
  const exits = Promise.all(children.map(c => c.exitCode !== null ? [c.exitCode] : once(c, 'exit')))
  let done = false, sightings = 0, reads = 0
  const errors = []
  exits.finally(() => { done = true })
  while (!done) {
    if ((await readdir(directory)).some(name => /^\.[0-9a-f-]{36}\.tmp$/.test(name))) sightings++
    try { await readExecutionEvents(common, 'race'); reads++ } catch (error) { errors.push(error.message) }
  }
  assert.deepEqual((await exits).map(([code]) => code), [0, 0], Buffer.concat(stderr.flat()).toString())
  assert.deepEqual([...new Set(errors)], [])
  assert.ok(sightings > 0 && reads > 0, `sightings ${sightings}, reads ${reads}`)
  assert.equal((await readExecutionEvents(common, 'race')).length, 1 + 2 * perChild)
})
test('an unlocked read ignores only a young temporary of the exact appender name shape', async t => {
  const { lstat, rm: remove } = await import('node:fs/promises')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-tmp-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await appendExecutionEvent(common, event('start', 'step-started', 1, { runId: 'tmp' }))
  const young = await plantJournalEntry(common, 'tmp', appenderTemporary(), { ageMs: 59000 })
  assert.deepEqual((await readExecutionEvents(common, 'tmp')).map(e => e.id), ['start'])
  assert.equal((await lstat(young)).isFile(), true)
  await remove(young)
  const refused = [
    ['a stale temporary no lock holder reconciled', appenderTemporary(), { ageMs: 61000 }],
    ['a non-UUID temporary name', '.' + 'a'.repeat(36) + '.tmp', {}],
    ['a temporary name without the leading dot', crypto.randomUUID() + '.tmp', {}],
    ['an uppercase UUID temporary name', '.' + crypto.randomUUID().toUpperCase() + '.tmp', {}],
    ['an unrelated .tmp name', 'partial.tmp', {}],
    ['a symlink with the appender name shape', appenderTemporary(), { kind: 'symlink' }],
    ['a directory with the appender name shape', appenderTemporary(), { kind: 'directory' }],
    ['a non-matching name', 'unexpected', {}]
  ]
  for (const [label, name, options] of refused) {
    const file = await plantJournalEntry(common, 'tmp', name, options)
    await assert.rejects(readExecutionEvents(common, 'tmp'), /^Error: Incomplete execution journal storage$/, label)
    await remove(file, { recursive: true })
  }
  // Under the storage lock no live writer owns a temporary, so the append still refuses a young one.
  await plantJournalEntry(common, 'tmp', appenderTemporary())
  await assert.rejects(appendExecutionEvent(common, event('next', 'step-started', 2, { runId: 'tmp', step: 'next' })), /^Error: Incomplete execution journal storage$/)
})
test('an unlocked read accepts a record whose second link is a young appender temporary and no other second link', async t => {
  const { executionDirectory } = await import('../scripts/execution-journal.mjs')
  const { link, unlink, utimes, readdir } = await import('node:fs/promises')
  const common = await realpath(await mkdtemp(path.join(tmpdir(), 'journal-link-')))
  t.after(() => rm(common, { recursive: true, force: true }))
  await appendExecutionEvent(common, event('start', 'step-started', 1, { runId: 'link' }))
  const directory = await executionDirectory(common, 'link'), [name] = await readdir(directory), record = path.join(directory, name)
  const temporary = path.join(directory, appenderTemporary())
  await link(record, temporary)
  assert.deepEqual((await readExecutionEvents(common, 'link')).map(e => e.id), ['start'])
  const stale = (Date.now() - 61000) / 1000
  await utimes(temporary, stale, stale)
  await assert.rejects(readExecutionEvents(common, 'link'), /^Error: (Unsafe execution record|Incomplete execution journal storage)$/)
  await unlink(temporary)
  await link(record, path.join(common, 'outside-link'))
  await assert.rejects(readExecutionEvents(common, 'link'), /^Error: Unsafe execution record$/)
})
