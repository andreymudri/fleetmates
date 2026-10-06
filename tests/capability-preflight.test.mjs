import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { probeCapabilities } from '../scripts/capability-preflight.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'

const success = output => ({ code: 0, output })
const request = (required, exec, extra = {}) => probeCapabilities({ required, harness: 'codex', env: {}, exec, ...extra })
const auth = 'Logged in using ChatGPT\n'
const ci = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: 'PRIVATE_LOGIN', token: 'PRIVATE_TOKEN' }] } })

test('unrequested services make no calls', async () => {
  const calls = []
  const report = await request([], async (...args) => { calls.push(args); return success(auth) })
  assert.deepEqual(calls, [])
  assert.deepEqual(report, { version: 1, ready: true, observations: [], blocked: [] })
})

test('invalid requests are rejected before any probe', async () => {
  const calls = []
  const exec = async (...args) => { calls.push(args); return success(auth) }
  for (const required of [null, 'harness', ['unknown'], [1], Array(21).fill('harness'), Array(1)]) {
    await assert.rejects(request(required, exec), /required/)
  }
  for (const harness of ['claude', '__proto__', '', null]) {
    await assert.rejects(request(['ci'], exec, { harness }), /harness/)
  }
  assert.deepEqual(calls, [])
})

test('duplicate capabilities use fixed argv and finite budgets once', async () => {
  const calls = []
  const env = { PATH: '/fixture/bin' }
  const report = await request(['harness', 'harness'], async (...args) => { calls.push(args); return success(auth) }, { env })
  assert.equal(report.ready, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'codex')
  assert.equal(calls[0][1], process.cwd())
  assert.deepEqual(calls[0][2], { argv: ['login', 'status'], env, timeoutMs: 5000, graceMs: 250, maxOutputBytes: 65536, maxCaptureBytes: 65536 })
  assert.equal(report.observations.length, 1)
  assert.deepEqual(report.blocked, [])
})

test('Cursor uses its supported authentication status interface', async () => {
  const report = await request(['harness'], async (command, cwd, options) => {
    assert.equal(command, 'cursor-agent')
    assert.deepEqual(options.argv, ['status'])
    return success('Logged in as PRIVATE_LOGIN\n')
  }, { harness: 'cursor' })
  assert.equal(report.ready, true)
  assert.equal(report.observations[0].state, 'available')
  assert.ok(!JSON.stringify(report).includes('PRIVATE_LOGIN'))
})

test('required malformed authentication blocks without reflecting output', async () => {
  const report = await request(['harness'], async () => success('PRIVATE_TOKEN PRIVATE_LOGIN'))
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unknown')
  assert.equal(report.blocked.length, 1)
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('negative authentication overrides positive-looking text', async () => {
  const report = await request(['harness'], async () => success('Not logged in; Logged in PRIVATE_TOKEN'))
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unavailable')
})

test('browser requires an observed numeric installed version', async () => {
  const report = await request(['render'], async (command, cwd, options) => {
    assert.equal(command, '/fixture/browser with spaces')
    assert.deepEqual(options.argv, ['--version'])
    return success('Chromium 123.0.6312.4 PRIVATE_TOKEN\n')
  }, { env: { CHROMIUM_PATH: '/fixture/browser with spaces' } })
  assert.equal(report.ready, true)
  assert.deepEqual(report.observations[0], { capability: 'render', state: 'available', reason: 'Installed browser version observed', version: '123.0.6312.4' })
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('default browser command is chromium', async () => {
  const calls = []
  const report = await request(['render'], async (command) => {
    calls.push(command)
    assert.equal(command, 'chromium')
    return success('Chromium 123.0.0.1')
  })
  assert.equal(report.ready, true)
  assert.deepEqual(calls, ['chromium'])
})

test('malformed browser version cannot establish rendering', async () => {
  for (const output of ['installed', 'Chromium PRIVATE_TOKEN', `Chromium ${'1'.repeat(40)}.0`, 'PRIVATE_TOKEN\nChromium 123.0']) {
    const report = await request(['render'], async () => success(output))
    assert.equal(report.ready, false)
    assert.equal(report.observations[0].state, 'unknown')
  }
})

test('CI uses gh authenticated JSON and projects no account fields', async () => {
  const report = await request(['ci'], async (command, cwd, options) => {
    assert.equal(command, 'gh')
    assert.deepEqual(options.argv, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
    return success(ci)
  })
  assert.equal(report.ready, true)
  assert.deepEqual(report.observations, [{ capability: 'ci', state: 'available', reason: 'Authenticated GitHub CLI observed' }])
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('CI JSON authentication failures with exit zero remain unavailable', async () => {
  for (const account of [{ state: 'error', active: true }, { state: 'success', active: false }]) {
    const report = await request(['ci'], async () => success(JSON.stringify({ hosts: { 'github.com': [account] } })))
    assert.equal(report.ready, false)
    assert.equal(report.observations[0].state, 'unavailable')
  }
})

test('CI malformed schemas remain unknown', async () => {
  for (const output of ['PRIVATE_TOKEN', '{}', 'null', '{"hosts":[]}', '{"hosts":{"github.com":[{"state":"success","active":"true"}]}}']) {
    const report = await request(['ci'], async () => success(output))
    assert.equal(report.ready, false)
    assert.equal(report.observations[0].state, 'unknown')
    assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  }
})

test('Vault refuses absent supported adapter without accepting declared status', async () => {
  const calls = []
  const report = await request(['vault'], async (...args) => { calls.push(args); return success('available') }, {
    env: { VAULT_AVAILABLE: 'true', VAULT_TOKEN: 'PRIVATE_TOKEN' }, available: { vault: true },
  })
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unavailable')
  assert.match(report.observations[0].reason, /supported read-only Vault adapter/)
  assert.deepEqual(calls, [])
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('one failed required capability blocks a mixed request', async () => {
  const report = await request(['harness', 'render'], async command => success(command === 'codex' ? auth : 'broken'))
  assert.equal(report.ready, false)
  assert.deepEqual(report.observations.map(o => o.state), ['available', 'unknown'])
  assert.equal(report.blocked.length, 1)
  assert.match(report.blocked[0], /render/)
})

test('spawn errors and malformed executor receipts cannot become available', async () => {
  for (const exec of [async () => { throw new Error('PRIVATE_TOKEN') }, async () => null, async () => ({ code: 0 }), async () => ({ code: '0', output: auth })]) {
    const report = await request(['harness'], exec)
    assert.equal(report.ready, false)
    assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  }
})

test('timeout and output-limit flags override successful-looking receipts', async () => {
  for (const flags of [{ timedOut: true }, { outputLimited: true }]) {
    const report = await request(['harness'], async () => ({ ...success(auth), ...flags }))
    assert.equal(report.ready, false)
    assert.equal(report.observations[0].state, 'unknown')
    assert.match(report.observations[0].reason, /execution limits/)
  }
})

test('oversized injected output is refused before parsing', async () => {
  const report = await request(['harness'], async () => success(auth + ' '.repeat(65536)))
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unknown')
})

const child = source => (command, cwd, options) => defaultExec(process.execPath, cwd, { ...options, argv: ['-e', source] })

test('real hanging required probe is killed within its timeout and cleanup budget', { timeout: 15000 }, async () => {
  const start = performance.now()
  const report = await request(['harness'], child("process.stdout.write('Logged in'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"))
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unknown')
  assert.match(report.observations[0].reason, /execution limits/)
  assert.ok(performance.now() - start < 8000)
})

test('real excessive output cannot establish authentication', async () => {
  const report = await request(['harness'], child("process.stdout.write('Logged in' + ' '.repeat(65536))"))
  assert.equal(report.ready, false)
  assert.match(report.observations[0].reason, /execution limits/)
})

test('real nonzero exit cannot establish authentication', async () => {
  const report = await request(['harness'], child("process.stdout.write('Logged in PRIVATE_TOKEN'); process.exitCode = 7"))
  assert.equal(report.ready, false)
  assert.equal(report.observations[0].state, 'unavailable')
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('real child status output can establish authentication', async () => {
  const report = await request(['harness'], child("process.stdout.write('Logged in using ChatGPT')"))
  assert.equal(report.ready, true)
  assert.equal(report.observations[0].state, 'available')
})
