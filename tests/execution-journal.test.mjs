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
