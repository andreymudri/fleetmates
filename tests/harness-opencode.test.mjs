import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { defaultGitExec } from '../scripts/git.mjs'
import { getAdapter, HARNESS_NAMES } from '../scripts/harnesses/index.mjs'
import {
  buildSpawnArgv, buildResumeArgv, assertSafeArgv, configContent, childEnv, spawnOpenCode,
  resumeOpenCode, readResult, readError, readUsage, probe, makeOpenCodeSandbox, collectOpenCode,
  cleanup, opencodeAdapter, opencodeCheckoutRoot, RESULT_INSTRUCTION, TURN_MARKER, MEASURED_VERSION,
  FILES_PREAMBLE,
} from '../scripts/harnesses/opencode.mjs'

// Fake harness binaries here are `#!/usr/bin/env node` scripts on PATH, which Windows cannot execute.
const WIN32_FAKE_SKIP = process.platform === 'win32' ? 'shebang fake binaries do not execute on win32' : false

// A fake `opencode` on PATH, replaying the shapes measured in
// docs/specs/2026-11-02-headless-driver-opencode-design.md §1. It:
//  - answers `--version` from FAKE_OC_VERSION (default the measured one) and `auth list` from
//    FAKE_OC_AUTH;
//  - writes its argv, cwd and the OPENCODE_* environment it received to FAKE_OC_ARGV_OUT;
//  - FAILS if anything is piped on its stdin, so an adapter that sends the prompt there is caught;
//  - emits an early error line whose `sessionID` is EMPTY, then the real session id, then a plain
//    text line that is not JSON, then a `text` part holding FAKE_OC_TEXT and a `step_finish`.
const FAKE_SRC = `#!/usr/bin/env node
const { writeFileSync, fstatSync } = require('node:fs')
const argv = process.argv.slice(2)
// Measured: a non-TTY stdin is read to EOF and concatenated to the prompt, so the adapter must
// hand the child /dev/null (stdio 'ignore'), never a pipe. A pipe here is a failed run.
if (argv[0] === 'run' && fstatSync(0).isFIFO()) {
  process.stdout.write(JSON.stringify({ type: 'error', timestamp: 0, sessionID: '', error: { type: 'unknown', message: 'stdin is a pipe' } }) + '\\n')
  process.exit(1)
}
if (argv[0] === '--version') { process.stdout.write((process.env.FAKE_OC_VERSION || 'opencode v2.2.5') + '\\n'); process.exit(0) }
if (argv[0] === 'auth') {
  process.stdout.write((process.env.FAKE_OC_AUTH || 'No authenticated integrations') + '\\n')
  process.exit(Number(process.env.FAKE_OC_AUTH_CODE || 0))
}
if (process.env.FAKE_OC_ARGV_OUT) {
  const env = {}
  for (const key of Object.keys(process.env)) if (key.startsWith('OPENCODE_')) env[key] = process.env[key]
  writeFileSync(process.env.FAKE_OC_ARGV_OUT, JSON.stringify({ argv, env, cwd: process.cwd() }))
}
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const sessionID = process.env.FAKE_OC_SESSION || 'ses_fake1'
if (process.env.FAKE_OC_FLOOD === '1') {
  w({ type: 'step_start', timestamp: 1, sessionID, part: { type: 'step-start' } })
  setInterval(() => process.stdout.write('x'.repeat(Number(process.env.FAKE_OC_FLOOD_CHUNK || 65536))), 1)
} else if (process.env.FAKE_OC_ERROR) {
  w({ type: 'error', timestamp: 1, sessionID: '', error: { type: 'unknown', message: 'early' } })
  w({ type: 'error', timestamp: 2, sessionID, error: { type: process.env.FAKE_OC_ERROR, message: 'boom', status: 429, retryAfterMs: 1000 } })
  process.exit(1)
} else {
  // An early error with no session id, exactly as measured: the id must come from a later line.
  w({ type: 'error', timestamp: 1, sessionID: '', error: { type: 'unknown', message: 'ignored by the id reader' } })
  w({ type: 'step_start', timestamp: 2, sessionID, part: { type: 'step-start' } })
  process.stdout.write('plain text on stdout, not JSON\\n')
  w({ type: 'text', timestamp: 3, sessionID, part: { type: 'text', text: process.env.FAKE_OC_TEXT || '' } })
  w({ type: 'step_finish', timestamp: 4, sessionID, part: { type: 'step-finish', tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } } } })
  process.exit(0)
}
`

let pathDir
let originalPath
let scratch

before(async () => {
  pathDir = await mkdtemp(path.join(tmpdir(), 'fm-opencode-fake-bin-'))
  const bin = path.join(pathDir, 'opencode')
  await writeFile(bin, FAKE_SRC, 'utf8')
  await chmod(bin, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${pathDir}${path.delimiter}${originalPath}`
  scratch = await mkdtemp(path.join(tmpdir(), 'fm-opencode-scratch-'))
})

after(async () => {
  process.env.PATH = originalPath
  await rm(pathDir, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

async function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k] }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

const good = { status: 'done', branch: 'fleetmates/r1/T1', filesChanged: ['a.txt'], summary: 'ok', blockers: [] }

async function initRepo(root) {
  await defaultGitExec(['init', '--initial-branch=main'], root)
  await defaultGitExec(['config', 'user.email', 'test@example.com'], root)
  await defaultGitExec(['config', 'user.name', 'test'], root)
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  await writeFile(path.join(root, 'base.txt'), 'base\n')
  await defaultGitExec(['add', '.'], root)
  await defaultGitExec(['commit', '-m', 'base'], root)
}

async function freshDir(name) {
  const dir = path.join(scratch, `${name}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function runToExit(handle) {
  const exit = once(handle.child, 'exit')
  const sessionId = await handle.sessionId
  await exit
  await handle.flushed
  return sessionId
}

// --- argv -----------------------------------------------------------------------------------

test('buildSpawnArgv and buildResumeArgv are exact, with and without a model', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  assert.deepEqual(buildSpawnArgv({ sandbox, prompt: 'do it' }),
    ['run', '--standalone', '--format', 'json', '--auto', '--', 'do it'])
  assert.deepEqual(buildSpawnArgv({ sandbox, model: 'anthropic/claude-sonnet-5-5', prompt: 'do it' }),
    ['run', '--standalone', '--format', 'json', '--auto', '-m', 'anthropic/claude-sonnet-5-5', '--', 'do it'])
  assert.deepEqual(buildResumeArgv({ sandbox, sessionId: 'ses_1', message: 'again' }),
    ['run', '--standalone', '--format', 'json', '--auto', '-s', 'ses_1', '--', 'again'])
})

test('the model token accepts the measured provider/model#variant and refuses anything unbounded', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  assert.ok(buildSpawnArgv({ sandbox, model: 'anthropic/claude-sonnet-5-5#thinking', prompt: 'p' })
    .includes('anthropic/claude-sonnet-5-5#thinking'))
  for (const model of ['--server', '-m', 'a b', 'a\nb', 'x'.repeat(200)]) {
    assert.throws(() => buildSpawnArgv({ sandbox, model, prompt: 'p' }), /model/i, JSON.stringify(model))
  }
})

test('assertSafeArgv refuses every session- or server-stealing flag and demands --standalone and --format json', () => {
  const base = ['run', '--standalone', '--format', 'json', '--auto']
  for (const flag of ['--server', '--continue', '-c', '--fork', '--agent', '--wizard']) {
    assert.throws(() => assertSafeArgv([...base, flag]), /forbidden/, flag)
  }
  assert.throws(() => assertSafeArgv(['run', '--format', 'json']), /--standalone/)
  assert.throws(() => assertSafeArgv(['run', '--standalone']), /--format json/)
  assert.throws(() => assertSafeArgv(['run', '--standalone', '--format', 'default']), /--format json/)
  assert.doesNotThrow(() => assertSafeArgv(base))
})

test('an empty prompt is refused rather than sent as an argument-less run', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  assert.throws(() => buildSpawnArgv({ sandbox, prompt: '' }), /prompt/)
  assert.throws(() => buildResumeArgv({ sandbox, sessionId: 'ses_1', message: undefined }), /prompt/)
  assert.throws(() => buildResumeArgv({ sandbox, sessionId: 'not a session id', message: 'm' }), /session id/)
})

test('a required role policy is refused rather than downgraded to an unverified run', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  const bound = { cwd: '/w', meta: { mode: 'files', prerequisites: { version: 1, rolePolicy: 'policy.json' } } }
  for (const enforcement of [{ kind: 'required' }, { kind: 'legacy' }, null]) {
    assert.throws(() => buildSpawnArgv({ sandbox, prompt: 'p', enforcement }), /enforcement/i)
  }
  assert.throws(() => buildSpawnArgv({ sandbox: bound, prompt: 'p' }), /enforcement/i)
  assert.throws(() => buildSpawnArgv({ sandbox: { cwd: '/w', meta: { mode: 'files', enforcement: { kind: 'required' } } }, prompt: 'p' }), /enforcement/i)
})

// --- policy ---------------------------------------------------------------------------------

test('the files policy denies every ref-moving git command, external directories and the snapshot', () => {
  const policy = JSON.parse(configContent({ mode: 'files', network: false }))
  assert.equal(policy.snapshot, false)
  assert.equal(policy.permission.external_directory, 'deny')
  assert.equal(policy.permission.webfetch, 'deny')
  assert.equal(policy.permission.websearch, 'deny')
  assert.equal(policy.permission.bash['*'], 'allow')
  for (const command of ['git commit', 'git push', 'git checkout', 'git branch', 'git reset', 'git update-ref']) {
    assert.equal(policy.permission.bash[command], 'deny', command)
    assert.equal(policy.permission.bash[`${command} *`], 'deny', `${command} *`)
  }
})

test('network: true lifts only the fetch denies, and "none" drops every rule', () => {
  const online = JSON.parse(configContent({ mode: 'files', network: true }))
  assert.equal(online.permission.webfetch, undefined)
  assert.equal(online.permission.websearch, undefined)
  assert.equal(online.permission.bash['git commit'], 'deny')
  const none = JSON.parse(configContent({ mode: 'none', network: false }))
  assert.deepEqual(none, { snapshot: false })
})

test('childEnv disables the teammate-writable config layers in a checkout and keeps them in full', () => {
  const checkout = childEnv({ mode: 'files', network: false, env: {} })
  assert.equal(checkout.OPENCODE_CONFIG_CONTENT, configContent({ mode: 'files', network: false }))
  assert.equal(checkout.OPENCODE_DISABLE_AUTOUPDATE, '1')
  assert.equal(checkout.OPENCODE_DISABLE_PROJECT_CONFIG, '1')
  assert.equal(checkout.OPENCODE_DISABLE_CLAUDE_CODE, '1')
  const full = childEnv({ mode: 'full', network: false, env: {} })
  assert.equal(full.OPENCODE_DISABLE_PROJECT_CONFIG, undefined)
  assert.equal(full.OPENCODE_DISABLE_CLAUDE_CODE, undefined)
  assert.deepEqual(JSON.parse(full.OPENCODE_CONFIG_CONTENT), { snapshot: false })
})

// --- spawn / resume -------------------------------------------------------------------------

test('spawn scrubs the checkout, sends the prompt in argv with a closed stdin, and takes the id from the first NON-EMPTY sessionID', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('ws')
  await mkdir(path.join(cwd, '.opencode'), { recursive: true })
  await writeFile(path.join(cwd, '.opencode', 'plugin.js'), 'planted')
  await writeFile(path.join(cwd, 'opencode.json'), '{}')
  const sessions = await freshDir('sessions')
  const argvOut = path.join(sessions, 'argv.json')
  const sandbox = { cwd, meta: { mode: 'files' } }
  await withEnv({ FAKE_OC_ARGV_OUT: argvOut, FAKE_OC_SESSION: 'ses_42', FAKE_OC_TEXT: JSON.stringify(good) }, async () => {
    const handle = await spawnOpenCode({
      sandbox, prompt: 'do it', model: 'anthropic/x', network: false,
      streamPath: path.join(sessions, 's.jsonl'), errPath: path.join(sessions, 'e.log'),
    })
    assert.equal(await runToExit(handle), 'ses_42')
  })
  await assert.rejects(stat(path.join(cwd, '.opencode', 'plugin.js')), /ENOENT/)
  await assert.rejects(stat(path.join(cwd, 'opencode.json')), /ENOENT/)
  const seen = JSON.parse(await readFile(argvOut, 'utf8'))
  const prompt = seen.argv[seen.argv.length - 1]
  assert.deepEqual(seen.argv, buildSpawnArgv({ sandbox, model: 'anthropic/x', prompt }))
  assert.ok(prompt.startsWith(FILES_PREAMBLE))
  assert.ok(prompt.includes('do it'))
  assert.ok(prompt.endsWith(RESULT_INSTRUCTION))
  assert.equal(seen.cwd, cwd)
  assert.equal(seen.env.OPENCODE_CONFIG_CONTENT, configContent({ mode: 'files', network: false }))
})

test('resume continues the recorded session, appends to the stream, and re-scrubs a replanted control path', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('ws')
  const sessions = await freshDir('sessions')
  const streamPath = path.join(sessions, 's.jsonl')
  const argvOut = path.join(sessions, 'argv.json')
  const sandbox = { cwd, meta: { mode: 'files' } }
  await withEnv({ FAKE_OC_ARGV_OUT: argvOut, FAKE_OC_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnOpenCode({ sandbox, prompt: 'p', network: false, streamPath }))
    await writeFile(path.join(cwd, 'opencode.json'), '{"plugin":["./evil.js"]}')
    await runToExit(await resumeOpenCode({ sandbox, sessionId: 'ses_fake1', message: 'again', network: false, streamPath }))
  })
  await assert.rejects(stat(path.join(cwd, 'opencode.json')), /ENOENT/)
  const seen = JSON.parse(await readFile(argvOut, 'utf8'))
  assert.deepEqual(seen.argv.slice(0, 7), ['run', '--standalone', '--format', 'json', '--auto', '-s', 'ses_fake1'])
  const raw = await readFile(streamPath, 'utf8')
  assert.equal(raw.split('\n').filter((l) => l.includes('"step_finish"')).length, 2)
  assert.equal(raw.split('\n').filter((l) => l.includes(TURN_MARKER.type)).length, 2)
})

test('a full sandbox is neither scrubbed nor sent the files instruction', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('repo')
  await writeFile(path.join(cwd, 'opencode.json'), '{"user":true}')
  const sessions = await freshDir('sessions')
  const argvOut = path.join(sessions, 'argv.json')
  await withEnv({ FAKE_OC_ARGV_OUT: argvOut, FAKE_OC_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnOpenCode({
      sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'p', network: false, streamPath: path.join(sessions, 's.jsonl'),
    }))
  })
  const seen = JSON.parse(await readFile(argvOut, 'utf8'))
  assert.equal(seen.argv[seen.argv.length - 1], 'p')
  assert.equal(await readFile(path.join(cwd, 'opencode.json'), 'utf8'), '{"user":true}')
})

// --- readResult / readError / readUsage -------------------------------------------------------

const marker = () => ({ ...TURN_MARKER, bytes: 1 })
const textEvent = (text) => ({ type: 'text', timestamp: 1, sessionID: 'ses_1', part: { type: 'text', text } })
const finishEvent = (tokens) => ({ type: 'step_finish', timestamp: 2, sessionID: 'ses_1', part: { type: 'step-finish', tokens } })

async function streamWith(events) {
  const dir = await freshDir('stream')
  const streamPath = path.join(dir, 's.jsonl')
  await writeFile(streamPath, events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n')
  return streamPath
}

test('readResult parses raw JSON, a fenced block after prose, and skips a plain-text line between events', async () => {
  assert.deepEqual(await readResult({ streamPath: await streamWith([marker(), textEvent(JSON.stringify(good))]) }), good)
  const fenced = `Done.\n\n\`\`\`json\n${JSON.stringify({ ...good, summary: 'old' })}\n\`\`\`\nthen\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``
  assert.deepEqual(await readResult({ streamPath: await streamWith([marker(), 'help text, not JSON', textEvent(fenced)]) }), good)
})

test('readResult returns null for prose, a schema violation, an empty turn or a missing stream', async () => {
  assert.equal(await readResult({ streamPath: await streamWith([marker(), textEvent('all done!')]) }), null)
  assert.equal(await readResult({ streamPath: await streamWith([marker(), textEvent(JSON.stringify({ ...good, extra: 1 }))]) }), null)
  assert.equal(await readResult({ streamPath: await streamWith([marker()]) }), null)
  assert.equal(await readResult({ streamPath: path.join(scratch, 'missing.jsonl') }), null)
})

// The exit code is not the signal (spec §1 item 7): the `error` event is.
test('readResult returns null when the turn holds an error event, even with a valid-looking text', async () => {
  const streamPath = await streamWith([
    marker(), textEvent(JSON.stringify(good)),
    { type: 'error', timestamp: 3, sessionID: 'ses_1', error: { type: 'provider.free-limit', message: 'limit', status: 429, retryAfterMs: 80668000 } },
  ])
  assert.equal(await readResult({ streamPath }), null)
})

test('readResult never returns a previous turn\'s answer after a resume that produced none', async () => {
  const streamPath = await streamWith([marker(), textEvent(JSON.stringify(good)), marker()])
  assert.equal(await readResult({ streamPath }), null)
  const second = await streamWith([marker(), textEvent(JSON.stringify(good)), marker(), textEvent(JSON.stringify({ ...good, status: 'blocked' }))])
  assert.equal((await readResult({ streamPath: second })).status, 'blocked')
})

test('readError names the measured taxonomy and marks a free-limit retriable with its retryAfterMs', async () => {
  const limit = await streamWith([marker(), { type: 'error', timestamp: 1, sessionID: 'ses_1', error: { type: 'provider.free-limit', message: 'Free usage limit reached', status: 429, retryAfterMs: 80668000 } }])
  assert.deepEqual(await readError({ streamPath: limit }),
    { type: 'provider.free-limit', message: 'Free usage limit reached', retriable: true, retryAfterMs: 80668000 })
  const unknown = await streamWith([marker(), { type: 'error', timestamp: 1, sessionID: '', error: { type: 'unknown', message: 'Invalid model reference: lixo' } }])
  assert.deepEqual(await readError({ streamPath: unknown }),
    { type: 'unknown', message: 'Invalid model reference: lixo', retriable: false, retryAfterMs: null })
  assert.equal(await readError({ streamPath: await streamWith([marker(), textEvent('hi')]) }), null)
  // An error from the previous turn is not this turn's error.
  assert.equal(await readError({ streamPath: await streamWith([marker(), { type: 'error', sessionID: '', error: { type: 'unknown', message: 'old' } }, marker(), textEvent('hi')]) }), null)
})

test('readUsage sums every step_finish across turns and returns null when there is none', async () => {
  const streamPath = await streamWith([
    marker(), finishEvent({ input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } }),
    marker(), finishEvent({ input: 1, output: 1 }),
  ])
  assert.deepEqual(await readUsage({ streamPath }), { input: 11, cachedInput: 2, cacheWrite: 3, output: 6, reasoning: 1 })
  assert.equal(await readUsage({ streamPath: await streamWith([marker(), textEvent('hi')]) }), null)
})

// --- sandbox / collect ------------------------------------------------------------------------

test('makeOpenCodeSandbox refuses clone and full, and puts the checkout outside the run repo', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  for (const mode of ['clone', 'full']) {
    await assert.rejects(
      makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode }),
      /OpenCode has no operating system sandbox; only "files" and the opt-in "none" are supported/,
    )
  }
  const cache = await freshDir('cache')
  const sandbox = await makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'none', env: { XDG_CACHE_HOME: cache } })
  assert.equal(sandbox.meta.mode, 'none')
  assert.ok(sandbox.cwd.startsWith(opencodeCheckoutRoot({ runRepo, runId: 'r1', env: { XDG_CACHE_HOME: cache } })))
  assert.ok(!sandbox.cwd.startsWith(runRepo))
  assert.equal(await readFile(path.join(sandbox.cwd, 'base.txt'), 'utf8'), 'base\n')
})

test('makeOpenCodeSandbox refuses a checkout inside a git repository, naming it', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const dotfiles = await freshDir('dotfiles')
  await defaultGitExec(['init'], dotfiles)
  await assert.rejects(
    makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: path.join(dotfiles, 'cache') } }),
    (err) => err.message.includes('must not live inside a git repository') && err.message.includes(dotfiles),
  )
})

test('collectOpenCode commits a clean checkout and keeps the run branch\'s own opencode.json', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  await writeFile(path.join(runRepo, 'opencode.json'), '{"owner":"user"}')
  await defaultGitExec(['add', '.'], runRepo)
  await defaultGitExec(['commit', '-m', 'config'], runRepo)
  const sandbox = await makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
  // The scrub removes the run branch's own control file from the checkout; the commit must put it back.
  await (await import('../scripts/harnesses/files-sandbox.mjs')).scrubControlPaths(sandbox.cwd)
  await writeFile(path.join(sandbox.cwd, 'a.txt'), 'a\n')
  await collectOpenCode(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' })
  const tree = await defaultGitExec(['ls-tree', '-r', '--name-only', 'fleetmates/r1/T1'], runRepo)
  assert.match(tree.stdout, /^a\.txt$/m)
  assert.match(tree.stdout, /^opencode\.json$/m)
  const kept = await defaultGitExec(['show', 'fleetmates/r1/T1:opencode.json'], runRepo)
  assert.equal(kept.stdout, '{"owner":"user"}')
})

test('collectOpenCode refuses a planted .opencode plugin or opencode.json, creates no branch, and the refusal survives the scrub', { timeout: 10000 }, async () => {
  for (const plant of [
    async (cwd) => {
      await mkdir(path.join(cwd, '.opencode'), { recursive: true })
      await writeFile(path.join(cwd, '.opencode', 'plugin.js'), 'evil')
    },
    async (cwd) => writeFile(path.join(cwd, 'opencode.json'), '{"plugin":["./evil.js"]}'),
  ]) {
    const runRepo = await freshDir('run')
    await initRepo(runRepo)
    const sandbox = await makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
    await plant(sandbox.cwd)
    await assert.rejects(collectOpenCode(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' }), /^Error: control-path: /)
    const ref = await defaultGitExec(['rev-parse', '--verify', '--quiet', 'refs/heads/fleetmates/r1/T1'], runRepo)
    assert.notEqual(ref.code, 0)
    // The plant is scrubbed now; the refusal must not be.
    await assert.rejects(collectOpenCode(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' }), /control-path: /)
    await assert.rejects(spawnOpenCode({ sandbox, prompt: 'p', network: false, streamPath: path.join(runRepo, 's.jsonl') }), /control-path/)
    await assert.rejects(resumeOpenCode({ sandbox, sessionId: 'ses_1', message: 'm', network: false, streamPath: path.join(runRepo, 's.jsonl') }), /control-path/)
  }
})

test('cleanup removes the checkout and its empty run and repo directories, but keeps a sibling task', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const cache = await freshDir('cache')
  const env = { XDG_CACHE_HOME: cache }
  const a = await makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env })
  const b = await makeOpenCodeSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T2', mode: 'files', env })
  await cleanup({ sandbox: a })
  await assert.rejects(stat(a.cwd), /ENOENT/)
  await stat(b.cwd)
  await cleanup({ sandbox: b })
  await assert.rejects(stat(path.dirname(path.dirname(b.cwd))), /ENOENT/)
  await stat(path.join(cache, 'fleetmates', 'opencode'))
  await cleanup({ sandbox: { cwd: runRepo, meta: { mode: 'full' } } })
  await stat(runRepo)
})

// --- probe ------------------------------------------------------------------------------------

test('probe: an authenticated measured version is ok, and still warns that there is no sandbox', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home, FAKE_OC_AUTH: 'anthropic', FLEETMATES_OPENCODE_MANAGED_DIR: path.join(home, 'absent') } })
  assert.equal(res.ok, true)
  assert.match(res.warning, /no operating system sandbox/)
  assert.doesNotMatch(res.warning, /differs from the measured/)
})

test('probe: sandbox "none" says the permission rules are off as well', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home, FAKE_OC_AUTH: 'anthropic', FLEETMATES_OPENCODE_MANAGED_DIR: path.join(home, 'absent') }, sandboxMode: 'none' })
  assert.equal(res.ok, true)
  assert.match(res.warning, /full access of the user/)
})

test('probe: no authenticated integrations names the login fix', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home } })
  assert.equal(res.ok, false)
  assert.equal(res.fix, 'run: opencode auth login')
})

test('probe: the 1.x CLI is refused by name and a 2.x drift only warns', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const base = { ...process.env, OPENCODE_CONFIG_DIR: home, FAKE_OC_AUTH: 'anthropic', FLEETMATES_OPENCODE_MANAGED_DIR: path.join(home, 'absent') }
  const old = await probe({ env: { ...base, FAKE_OC_VERSION: 'opencode v1.19.5' } })
  assert.equal(old.ok, false)
  assert.match(old.reason, /1\.19\.5 is not the OpenCode 2 CLI/)
  assert.match(old.fix, new RegExp(MEASURED_VERSION.replace(/\./g, '\\.')))
  const drift = await probe({ env: { ...base, FAKE_OC_VERSION: 'opencode v2.3.0' } })
  assert.equal(drift.ok, true)
  assert.match(drift.warning, /2\.3\.0 differs from the measured/)
})

test('probe: a managed config directory is warned about, because it outranks the adapter policy', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const managed = await freshDir('managed')
  const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home, FAKE_OC_AUTH: 'anthropic', FLEETMATES_OPENCODE_MANAGED_DIR: managed } })
  assert.equal(res.ok, true)
  assert.match(res.warning, /can re-allow what it denies/)
})

test('probe: a missing binary names the install fix', { timeout: 5000 }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home, PATH: '/nonexistent' } })
  assert.equal(res.ok, false)
  assert.match(res.fix, /npm i -g @opencode\/cli/)
})

test('probe: an unwritable config home is not ok', {
  timeout: 5000,
  skip: WIN32_FAKE_SKIP || (process.getuid && process.getuid() === 0 ? 'chmod is ignored for root' : false),
}, async () => {
  const home = await freshDir('home')
  await chmod(home, 0o500)
  try {
    const res = await probe({ env: { ...process.env, OPENCODE_CONFIG_DIR: home, FAKE_OC_AUTH: 'anthropic' } })
    assert.equal(res.ok, false)
    assert.ok(res.fix.includes(home))
  } finally {
    await chmod(home, 0o700)
  }
})

// --- registry and bounded capture ---------------------------------------------------------------

test('opencodeAdapter exposes the adapter interface and its OpenCode defaults, and the registry resolves it', () => {
  for (const fn of ['probe', 'makeSandbox', 'collect', 'cleanup', 'spawn', 'resume', 'readResult', 'readUsage']) {
    assert.equal(typeof opencodeAdapter[fn], 'function', fn)
  }
  assert.equal(opencodeAdapter.name, 'opencode')
  assert.equal(opencodeAdapter.defaultSandbox, 'files')
  assert.equal(opencodeAdapter.supportsEffort, false)
  assert.equal(opencodeAdapter.cleanupOnResult, true)
  assert.equal(getAdapter('opencode'), opencodeAdapter)
  assert.ok(HARNESS_NAMES.includes('opencode'))
})

test('OpenCode refuses required non-model verification rather than claiming native confinement', async () => {
  await assert.rejects(opencodeAdapter.createVerificationExecutor({ sandbox: { cwd: '/fixture/worker', meta: { mode: 'files' } } }), /unsupported/i)
})

test('spawnOpenCode stops an oversized stream, counting what is already on disk, and reports the capture as limited', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('flood')
  const streamPath = path.join(scratch, `${path.basename(cwd)}.jsonl`)
  await writeFile(streamPath, 'p'.repeat(3000))
  await withEnv({ FAKE_OC_FLOOD: '1', FAKE_OC_FLOOD_CHUNK: '500' }, async () => {
    const handle = await spawnOpenCode({ sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'flood', streamPath, maxStreamBytes: 4096 })
    const exited = once(handle.child, 'exit')
    await handle.sessionId
    const [, signal] = await exited
    await handle.flushed
    assert.equal(signal, 'SIGKILL')
    assert.equal(handle.outputLimited, true)
    assert.equal((await stat(streamPath)).size, 4096)
    assert.equal((await readFile(streamPath, 'utf8')).slice(0, 3000), 'p'.repeat(3000))
  })
})

test('readResult refuses a stream file larger than its bound, and never follows a symlink', async () => {
  const streamPath = await streamWith([marker(), textEvent(JSON.stringify(good))])
  assert.deepEqual(await readResult({ streamPath }), good)
  assert.equal(await readResult({ streamPath, maxStreamBytes: 8 }), null)
  const linked = path.join(path.dirname(streamPath), 'linked.jsonl')
  await (await import('node:fs/promises')).symlink(streamPath, linked)
  assert.equal(await readResult({ streamPath: linked }), null)
  assert.equal(await readResult({ streamPath: linked, noFollow: null }), null)
})
