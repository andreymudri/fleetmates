import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchSession, stopSession, nudgeSession, relaunchSession, fetchScrollback, patchCrew, fetchRunPlan, openRunPlan,
  answerRequest, answerBatch, sendFollowup, fetchRules, addRule, revokeRule, dismissRuleOffer, fetchDiff,
  archiveSession, unarchiveSession, archiveFinished, fetchArchived
} from '../../web/src/state/actions.js'
import { createApiClient } from '../../web/src/state/api.js'

// Records calls in the createApiClient shape; `fail` makes the next call throw an ApiError.
function recordingApi() {
  const calls = []
  let fail = null
  const call = method => async (path, body) => {
    calls.push(body === undefined ? [method, path] : [method, path, body])
    if (fail) { const error = fail
      fail = null
      throw error }
    return { ok: method, path }
  }
  return { calls, get: call('GET'), post: call('POST'), patch: call('PATCH'), del: call('DELETE'), failNext(error) { fail = error } }
}

test('each action helper calls the right method and path with encoded segments', async () => {
  const api = recordingApi()
  const id = 'a/b?c#d'
  assert.deepEqual(await launchSession(api, { repoKey: 'work/api', task: 'fix it', mode: 'plain' }), { ok: 'POST', path: '/api/sessions' })
  await stopSession(api, id)
  await nudgeSession(api, id)
  await relaunchSession(api, id)
  await fetchScrollback(api, id, 200)
  await fetchScrollback(api, id)
  await patchCrew(api, 'work/api', { hat: 'cap' })
  await fetchRunPlan(api, 'work/api', '2026/substop')
  await openRunPlan(api, '/home/you/dev/work/api', '2026/substop')
  assert.deepEqual(api.calls, [
    ['POST', '/api/sessions', { repoKey: 'work/api', task: 'fix it', mode: 'plain' }],
    ['POST', '/api/sessions/a%2Fb%3Fc%23d/stop'],
    ['POST', '/api/sessions/a%2Fb%3Fc%23d/nudge'],
    ['POST', '/api/sessions/a%2Fb%3Fc%23d/relaunch'],
    ['GET', '/api/sessions/a%2Fb%3Fc%23d/scrollback?lines=200'],
    ['GET', '/api/sessions/a%2Fb%3Fc%23d/scrollback'],
    ['PATCH', '/api/repos/work%2Fapi/crew', { hat: 'cap' }],
    ['GET', '/api/runs/work%2Fapi/2026%2Fsubstop/plan'],
    ['POST', '/api/open', { kind: 'runPlan', ref: { repoId: '/home/you/dev/work/api', runId: '2026/substop' } }]
  ])
})

test('the archive helpers call the archive routes with the id as one encoded segment', async () => {
  const api = recordingApi()
  const id = 'a/b?c#d'
  assert.deepEqual(await archiveSession(api, id), { ok: 'POST', path: '/api/sessions/a%2Fb%3Fc%23d/archive' })
  await unarchiveSession(api, id)
  await archiveFinished(api)
  await fetchArchived(api)
  await fetchArchived(api, { limit: 50 })
  await fetchArchived(api, { before: 'c/1&x', limit: 20 })
  assert.deepEqual(api.calls, [
    ['POST', '/api/sessions/a%2Fb%3Fc%23d/archive'],
    ['POST', '/api/sessions/a%2Fb%3Fc%23d/unarchive'],
    ['POST', '/api/sessions/archive-finished'],
    ['GET', '/api/sessions?archived=1'],
    ['GET', '/api/sessions?archived=1&limit=50'],
    ['GET', '/api/sessions?archived=1&before=c%2F1%26x&limit=20']
  ])

  const failure = Object.assign(new Error('needs you'), { status: 409, code: 'needs_you' })
  api.failNext(failure)
  await assert.rejects(archiveSession(api, 's1'), error => error === failure)
})

test('a helper returns the API body and throws its ApiError unchanged', async () => {
  const responses = [
    { status: 201, body: { session: { id: 's1' }, warning: { kind: 'repo_busy', sessionIds: ['s0'] } } },
    { status: 409, body: { error: { code: 'invalid_state', message: 'not stale or idle', retryable: false } } }
  ]
  const seen = []
  const api = createApiClient({ token: 'abc', fetch: async (url, init) => { seen.push([url, init.method])
    const next = responses.shift()
    return { status: next.status, ok: next.status < 300, json: async () => next.body } } })
  const result = await launchSession(api, { repoKey: 'rustot', task: '' })
  assert.deepEqual(result.warning, { kind: 'repo_busy', sessionIds: ['s0'] })
  await assert.rejects(nudgeSession(api, 's1'), error => error.status === 409 && error.code === 'invalid_state')
  assert.deepEqual(seen, [['/api/sessions', 'POST'], ['/api/sessions/s1/nudge', 'POST']])

  const recording = recordingApi()
  const failure = Object.assign(new Error('slot taken'), { status: 409, code: 'slot_taken' })
  recording.failNext(failure)
  await assert.rejects(patchCrew(recording, 'rustot', { slot: 2 }), error => error === failure)
})

test('the M3 answer, rule and diff helpers call the right method and path with encoded segments', async () => {
  const api = recordingApi()
  const id = 'a/b?c#d'
  assert.deepEqual(await answerRequest(api, id, { choice: 'allow', confirm: true }), { ok: 'POST', path: '/api/requests/a%2Fb%3Fc%23d/answer' })
  await answerBatch(api, ['r1', 'r2'])
  await sendFollowup(api, id, 'use the other file')
  await fetchRules(api)
  await fetchRules(api, 'work/api')
  await addRule(api, { repoKey: 'work/api', pattern: 'Bash(cargo test:*)', source: 'suggested' })
  await revokeRule(api, 'work/api', 'Bash(npm run test:*)')
  await dismissRuleOffer(api, { repoKey: 'work/api', pattern: 'Bash(cargo test:*)' })
  await fetchDiff(api, id, 'src/a b?.rs')
  assert.deepEqual(api.calls, [
    ['POST', '/api/requests/a%2Fb%3Fc%23d/answer', { choice: 'allow', confirm: true }],
    ['POST', '/api/requests/answer-batch', { ids: ['r1', 'r2'], choice: 'allow' }],
    ['POST', '/api/requests/a%2Fb%3Fc%23d/followup', { text: 'use the other file' }],
    ['GET', '/api/rules'],
    ['GET', '/api/rules?repoKey=work%2Fapi'],
    ['POST', '/api/rules', { repoKey: 'work/api', pattern: 'Bash(cargo test:*)', source: 'suggested' }],
    ['DELETE', '/api/rules/work%2Fapi/Bash(npm%20run%20test%3A*)'],
    ['POST', '/api/rules/suggestions/dismiss', { repoKey: 'work/api', pattern: 'Bash(cargo test:*)' }],
    ['GET', '/api/sessions/a%2Fb%3Fc%23d/diff?path=src%2Fa%20b%3F.rs']
  ])
  const [, revokePath] = api.calls[6]
  assert.equal(revokePath.split('/').length, 5, 'the pattern is one path segment')
  assert.equal(decodeURIComponent(revokePath.split('/')[4]), 'Bash(npm run test:*)')
})

test('del sends DELETE with no body, and an M3 helper throws the ApiError unchanged', async () => {
  const seen = []
  const api = createApiClient({ token: 'abc', fetch: async (url, init) => { seen.push([url, init.method, init.body])
    return { status: 200, ok: true, json: async () => ({ removed: false, reason: 'already_removed' }) } } })
  assert.deepEqual(await revokeRule(api, 'rustot', 'Bash(ls)'), { removed: false, reason: 'already_removed' })
  assert.deepEqual(seen, [['/api/rules/rustot/Bash(ls)', 'DELETE', undefined]])

  const recording = recordingApi()
  const failure = Object.assign(new Error('confirm'), { status: 409, code: 'confirm_required' })
  recording.failNext(failure)
  await assert.rejects(answerRequest(recording, 'r1', { choice: 'allow' }), error => error === failure)
})
