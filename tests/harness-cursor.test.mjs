import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { defaultGitExec } from '../scripts/git.mjs'
import { getAdapter, HARNESS_NAMES } from '../scripts/harnesses/index.mjs'
import {
  buildSpawnArgv, buildResumeArgv, assertSafeArgv, spawnCursor, resumeCursor, readResult,
  readUsage, probe, makeCursorSandbox, collectCursor, cleanup, cursorAdapter, RESULT_INSTRUCTION,
  cursorCheckoutRoot, enclosingGitRoot, FILES_PREAMBLE,
} from '../scripts/harnesses/cursor.mjs'

// Fake harness binaries here are `#!/usr/bin/env node` scripts on PATH, which Windows cannot execute
// (no shebang support; a real CLI there is a .cmd shim). Tests that spawn one are skipped on win32.
const WIN32_FAKE_SKIP = process.platform === 'win32' ? 'shebang fake binaries do not execute on win32' : false

// A fake `cursor-agent` on PATH (CommonJS so a shebang file with no extension runs). It:
//  - answers `status` from FAKE_CURSOR_LOGGED_IN (default logged in);
//  - writes its argv and the stdin it received to FAKE_CURSOR_ARGV_OUT when set;
//  - BLOCKS until stdin closes, so an adapter that leaves stdin open hangs the test;
//  - prints system/init, one assistant line and (unless FAKE_CURSOR_NO_RESULT=1) a result line
//    whose `result` is FAKE_CURSOR_RESULT_TEXT; FAKE_CURSOR_IS_ERROR=1 sets is_error.
const FAKE_SRC = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === 'status') {
  if (process.env.FAKE_CURSOR_LOGGED_IN === '0') { process.stdout.write('Not logged in\\n'); process.exit(0) }
  process.stdout.write('Logged in as someone\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  if (process.env.FAKE_CURSOR_ARGV_OUT) writeFileSync(process.env.FAKE_CURSOR_ARGV_OUT, JSON.stringify({ argv, input }))
  const session_id = process.env.FAKE_CURSOR_SESSION || 'sess-1'
  const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  w({ type: 'system', subtype: 'init', session_id, cwd: process.cwd() })
  // FAKE_CURSOR_FLOOD: never finishes and never prints a result, only an unbounded stream.
  if (process.env.FAKE_CURSOR_FLOOD === '1') { setInterval(() => process.stdout.write('x'.repeat(Number(process.env.FAKE_CURSOR_FLOOD_CHUNK || 65536))), 1); return }
  w({ type: 'assistant', session_id, message: { content: [] } })
  if (process.env.FAKE_CURSOR_NO_RESULT !== '1') {
    w({
      type: 'result', subtype: 'success', is_error: process.env.FAKE_CURSOR_IS_ERROR === '1',
      result: process.env.FAKE_CURSOR_RESULT_TEXT || '', session_id,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })
  }
  process.exit(0)
})
process.stdin.resume()
`

let pathDir
let originalPath
let scratch

before(async () => {
  pathDir = await mkdtemp(path.join(tmpdir(), 'fm-cursor-fake-bin-'))
  const bin = path.join(pathDir, 'cursor-agent')
  await writeFile(bin, FAKE_SRC, 'utf8')
  await chmod(bin, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${pathDir}${path.delimiter}${originalPath}`
  scratch = await mkdtemp(path.join(tmpdir(), 'fm-cursor-scratch-'))
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

// --- argv ------------------------------------------------------------------------------------

test('buildSpawnArgv is exact, with a model and with none (explicit auto)', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  assert.deepEqual(buildSpawnArgv({ sandbox }),
    ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', '/w', '--model', 'auto'])
  assert.deepEqual(buildSpawnArgv({ sandbox, model: 'claude-opus-5-high' }),
    ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', '/w', '--model', 'claude-opus-5-high'])
})

test('buildResumeArgv adds --resume <id>', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  assert.deepEqual(buildResumeArgv({ sandbox, sessionId: 's1', model: 'm' }),
    ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', '/w', '--model', 'm', '--resume', 's1'])
})

test('assertSafeArgv refuses every sandbox-weakening flag', () => {
  for (const flag of ['--force', '-f', '--yolo', '--approve-mcps', '--worktree', '-w', '--api-key']) {
    assert.throws(() => assertSafeArgv(['-p', flag]), /forbidden/, flag)
  }
  assert.throws(() => assertSafeArgv(['--sandbox', 'disabled']), /forbidden/)
  assert.throws(() => assertSafeArgv(['--sandbox']), /forbidden/)
  assert.doesNotThrow(() => assertSafeArgv(['--sandbox', 'enabled']))
})

// --- spawn / resume ----------------------------------------------------------------------------

test('spawn scrubs a files sandbox, writes a deny-network sandbox.json, closes stdin and records the session id', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('ws')
  await mkdir(path.join(cwd, '.cursor'), { recursive: true })
  await writeFile(path.join(cwd, '.cursor', 'hooks.json'), '{}')
  const sessions = await freshDir('sessions')
  const argvOut = path.join(sessions, 'argv.json')
  const sandbox = { cwd, meta: { mode: 'files' } }
  await withEnv({ FAKE_CURSOR_ARGV_OUT: argvOut, FAKE_CURSOR_SESSION: 'sess-42', FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    const handle = await spawnCursor({
      sandbox, prompt: 'do it', model: 'm', network: false,
      streamPath: path.join(sessions, 's.jsonl'), errPath: path.join(sessions, 'e.log'),
    })
    assert.equal(await runToExit(handle), 'sess-42')
  })
  await assert.rejects(stat(path.join(cwd, '.cursor', 'hooks.json')), /ENOENT/)
  const policy = JSON.parse(await readFile(path.join(cwd, '.cursor', 'sandbox.json'), 'utf8'))
  assert.deepEqual(policy, { type: 'workspace_readwrite', networkPolicy: { default: 'deny' } })
  assert.equal(sandbox.meta.sandboxJson, JSON.stringify(policy))
  const seen = JSON.parse(await readFile(argvOut, 'utf8'))
  assert.deepEqual(seen.argv, buildSpawnArgv({ sandbox, model: 'm' }))
  assert.ok(seen.input.startsWith(FILES_PREAMBLE))
  assert.ok(seen.input.includes('do it'))
  assert.ok(seen.input.endsWith(RESULT_INSTRUCTION))
})

test('resume re-scrubs, rewrites sandbox.json (allow with network) and appends to the stream', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('ws')
  const sessions = await freshDir('sessions')
  const streamPath = path.join(sessions, 's.jsonl')
  const argvOut = path.join(sessions, 'argv.json')
  const sandbox = { cwd, meta: { mode: 'files' } }
  await withEnv({ FAKE_CURSOR_ARGV_OUT: argvOut, FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnCursor({ sandbox, prompt: 'p', network: false, streamPath }))
    await writeFile(path.join(cwd, '.cursor', 'sandbox.json'), '{"additionalReadwritePaths":["/"]}')
    await mkdir(path.join(cwd, '.claude'), { recursive: true })
    await writeFile(path.join(cwd, '.claude', 'settings.local.json'), '{}')
    await runToExit(await resumeCursor({ sandbox, sessionId: 'sess-1', message: 'again', network: true, streamPath }))
  })
  await assert.rejects(stat(path.join(cwd, '.claude', 'settings.local.json')), /ENOENT/)
  const policy = JSON.parse(await readFile(path.join(cwd, '.cursor', 'sandbox.json'), 'utf8'))
  assert.deepEqual(policy, { type: 'workspace_readwrite', networkPolicy: { default: 'allow' } })
  const seen = JSON.parse(await readFile(argvOut, 'utf8'))
  assert.deepEqual(seen.argv.slice(-2), ['--resume', 'sess-1'])
  const lines = (await readFile(streamPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.filter((l) => l.type === 'result').length, 2)
})

test('a full sandbox (reviewers, integrator) is neither scrubbed, given a sandbox.json, nor sent the files instruction', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('repo')
  await mkdir(path.join(cwd, '.claude'), { recursive: true })
  await writeFile(path.join(cwd, '.claude', 'settings.json'), '{"user":true}')
  const sessions = await freshDir('sessions')
  const argvOut = path.join(sessions, 'argv.json')
  await withEnv({ FAKE_CURSOR_ARGV_OUT: argvOut, FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnCursor({
      sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'p', network: false, streamPath: path.join(sessions, 's.jsonl'),
    }))
  })
  assert.equal(JSON.parse(await readFile(argvOut, 'utf8')).input, 'p')
  assert.equal(await readFile(path.join(cwd, '.claude', 'settings.json'), 'utf8'), '{"user":true}')
  await assert.rejects(stat(path.join(cwd, '.cursor', 'sandbox.json')), /ENOENT/)
})

// --- readResult / readUsage ----------------------------------------------------------------------

async function streamWith(results) {
  const dir = await freshDir('stream')
  const streamPath = path.join(dir, 's.jsonl')
  const lines = [{ type: 'system', subtype: 'init', session_id: 's' }, ...results]
  await writeFile(streamPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return streamPath
}

const resultLine = (text, extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }, ...extra,
})

test('the handle\'s flushed promise resolves with the result line on disk', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('ws')
  const streamPath = path.join(await freshDir('sessions'), 's.jsonl')
  await withEnv({ FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    const handle = await spawnCursor({ sandbox: { cwd, meta: { mode: 'files' } }, prompt: 'p', network: false, streamPath })
    await handle.flushed
    assert.deepEqual(await readResult({ streamPath }), good)
  })
})

test('readResult parses raw JSON and a fenced json block after prose', async () => {
  assert.deepEqual(await readResult({ streamPath: await streamWith([resultLine(JSON.stringify(good))]) }), good)
  const fenced = `Done.\n\n\`\`\`json\n${JSON.stringify({ ...good, summary: 'old' })}\n\`\`\`\nthen\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``
  assert.deepEqual(await readResult({ streamPath: await streamWith([resultLine(fenced)]) }), good)
})

test('readResult returns null for prose, is_error, no result line, a schema violation, or a missing stream', async () => {
  assert.equal(await readResult({ streamPath: await streamWith([resultLine('all done!')]) }), null)
  assert.equal(await readResult({ streamPath: await streamWith([resultLine(JSON.stringify(good), { is_error: true })]) }), null)
  assert.equal(await readResult({ streamPath: await streamWith([]) }), null)
  assert.equal(await readResult({ streamPath: await streamWith([resultLine(JSON.stringify({ ...good, extra: 1 }))]) }), null)
  assert.equal(await readResult({ streamPath: path.join(scratch, 'missing.jsonl') }), null)
})

test('readResult reads the final assistant message when result concatenates the whole turn', async () => {
  // Measured shape: `result` joins every assistant message of the turn.
  const streamPath = await streamWith([
    { type: 'user', message: { content: [{ type: 'text', text: 'task' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Creating hello.txt, then the JSON.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(good) }] } },
    resultLine(`Creating hello.txt, then the JSON.${JSON.stringify(good)}`),
  ])
  assert.deepEqual(await readResult({ streamPath }), good)
  const onlyResult = await streamWith([resultLine(`Creating hello.txt, then the JSON.${JSON.stringify(good)}`)])
  assert.deepEqual(await readResult({ streamPath: onlyResult }), good)
})

test('readResult never returns a previous session\'s answer after a resume that produced none', async () => {
  const streamPath = await streamWith([
    { type: 'user', message: {} }, resultLine(JSON.stringify(good)),
    { type: 'system', subtype: 'init', session_id: 's' }, { type: 'user', message: {} },
  ])
  assert.equal(await readResult({ streamPath }), null)
})

test('readResult uses the last result line', async () => {
  const streamPath = await streamWith([resultLine(JSON.stringify(good)), resultLine(JSON.stringify({ ...good, status: 'blocked' }))])
  assert.equal((await readResult({ streamPath })).status, 'blocked')
})

test('readUsage sums every result line and returns null when there is none', async () => {
  const streamPath = await streamWith([resultLine('a'), resultLine('b')])
  assert.deepEqual(await readUsage({ streamPath }), { input: 20, cachedInput: 4, cacheWrite: 2, output: 10, reasoning: 0 })
  assert.equal(await readUsage({ streamPath: await streamWith([]) }), null)
})

// --- sandbox / collect ----------------------------------------------------------------------------

test('makeCursorSandbox refuses clone and full', async () => {
  for (const mode of ['clone', 'full']) {
    await assert.rejects(
      makeCursorSandbox(defaultGitExec, { runRepo: '/x', runBranch: 'main', runId: 'r1', taskId: 'T1', mode }),
      /Cursor runs git outside its sandbox; only "files" is supported/,
    )
  }
})

test('collectCursor commits a clean checkout, keeping the driver-written sandbox.json out of the branch', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const sandbox = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
  const sessions = await freshDir('sessions')
  await withEnv({ FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnCursor({ sandbox, prompt: 'p', network: false, streamPath: path.join(sessions, 's.jsonl') }))
  })
  await writeFile(path.join(sandbox.cwd, 'a.txt'), 'a\n')
  await collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' })
  const tree = await defaultGitExec(['ls-tree', '-r', '--name-only', 'fleetmates/r1/T1'], runRepo)
  assert.match(tree.stdout, /^a\.txt$/m)
  assert.doesNotMatch(tree.stdout, /\.cursor/)
})

// Cursor has no clone path (the test above): the host commits its checkout through the run repo,
// so the task branch carries the run repo's identity and not the host global one.
test('collectCursor commits the checkout as the run repo\'s identity, not the host global one', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  const globalConfig = path.join(await freshDir('host'), 'gitconfig')
  await writeFile(globalConfig, '[user]\n\tname = Host Global\n\temail = host@example.invalid\n')
  await withEnv({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }, async () => {
    await initRepo(runRepo)
    const sandbox = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
    await writeFile(path.join(sandbox.cwd, 'a.txt'), 'a\n')
    await collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' })
    const author = await defaultGitExec(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'fleetmates/r1/T1'], runRepo)
    assert.equal(author.stdout.trim(), 'test <test@example.com>|test <test@example.com>')
  })
})

test('collectCursor refuses a modified sandbox.json or a planted control file and creates no branch', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  for (const plant of [
    async (cwd) => writeFile(path.join(cwd, '.cursor', 'sandbox.json'), '{"additionalReadwritePaths":["/"]}'),
    async (cwd) => {
      await mkdir(path.join(cwd, '.claude'), { recursive: true })
      await writeFile(path.join(cwd, '.claude', 'settings.local.json'), '{}')
    },
  ]) {
    const runRepo = await freshDir('run')
    await initRepo(runRepo)
    const sandbox = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
    await withEnv({ FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
      await runToExit(await spawnCursor({ sandbox, prompt: 'p', network: false, streamPath: path.join(runRepo, 's.jsonl') }))
    })
    await plant(sandbox.cwd)
    await assert.rejects(collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' }), /^Error: control-path: /)
    const ref = await defaultGitExec(['rev-parse', '--verify', '--quiet', 'refs/heads/fleetmates/r1/T1'], runRepo)
    assert.notEqual(ref.code, 0)
  }
})

test('collectCursor and cleanup leave a full sandbox alone', async () => {
  const cwd = await freshDir('repo')
  await writeFile(path.join(cwd, 'keep.txt'), 'k')
  let called = false
  const spy = async (...a) => { called = true; return defaultGitExec(...a) }
  await collectCursor(spy, { runRepo: cwd, sandbox: { cwd, meta: { mode: 'full' } }, branch: 'b' })
  await cleanup({ sandbox: { cwd, meta: { mode: 'full' } } })
  assert.equal(called, false)
  assert.equal(await readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'k')
})

// --- probe -------------------------------------------------------------------------------------------

test('probe: logged in with a writable home and no global policy is ok', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  assert.deepEqual(await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home } }), { ok: true })
})

test('probe: logged out names the login fix', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home, FAKE_CURSOR_LOGGED_IN: '0' } })
  assert.equal(res.ok, false)
  assert.equal(res.fix, 'run: cursor-agent login')
})

test('probe: a missing binary names the install fix', { timeout: 5000 }, async () => {
  const home = await freshDir('home')
  const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home, PATH: '/nonexistent' } })
  assert.equal(res.ok, false)
  assert.equal(res.fix, 'install the Cursor CLI')
})

test('probe: an unwritable home is not ok', {
  timeout: 5000,
  skip: WIN32_FAKE_SKIP || (process.getuid && process.getuid() === 0 ? 'chmod is ignored for root' : false),
}, async () => {
  const home = await freshDir('home')
  await chmod(home, 0o500)
  try {
    const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home } })
    assert.equal(res.ok, false)
    assert.ok(res.fix.includes(home))
  } finally {
    await chmod(home, 0o700)
  }
})

test('probe: a widening global sandbox.json is refused', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  for (const policy of [{ additionalReadwritePaths: ['/srv'] }, { networkPolicy: { default: 'allow' } }, { type: 'insecure_none' }]) {
    const home = await freshDir('home')
    await writeFile(path.join(home, 'sandbox.json'), JSON.stringify(policy))
    const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home } })
    assert.equal(res.ok, false, JSON.stringify(policy))
    assert.match(res.reason, /sandbox\.json/)
  }
})

test('probe: a global hooks.json is ok with a warning', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await freshDir('home')
  await writeFile(path.join(home, 'hooks.json'), '{}')
  const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home } })
  assert.equal(res.ok, true)
  assert.match(res.warning, /hooks\.json/)
})

test('cursorAdapter exposes the adapter interface and its Cursor defaults', () => {
  for (const fn of ['probe', 'makeSandbox', 'collect', 'cleanup', 'spawn', 'resume', 'readResult', 'readUsage']) {
    assert.equal(typeof cursorAdapter[fn], 'function', fn)
  }
  assert.equal(cursorAdapter.name, 'cursor')
  assert.equal(cursorAdapter.defaultSandbox, 'files')
  assert.equal(cursorAdapter.supportsEffort, false)
  assert.equal(cursorAdapter.cleanupOnResult, true)
})

test('the registry resolves cursor', () => {
  assert.equal(getAdapter('cursor'), cursorAdapter)
  assert.ok(HARNESS_NAMES.includes('cursor'))
})

test('cursorCheckoutRoot is keyed by run repo and run, under XDG_CACHE_HOME', () => {
  const a = cursorCheckoutRoot({ runRepo: '/r/one', runId: 'r1', env: { XDG_CACHE_HOME: '/c' } })
  const b = cursorCheckoutRoot({ runRepo: '/r/two', runId: 'r1', env: { XDG_CACHE_HOME: '/c' } })
  const prefix = path.join('/c', 'fleetmates', 'cursor') + path.sep
  assert.ok(a.startsWith(prefix), a)
  assert.match(a.slice(prefix.length), /^[0-9a-f]{16}[\\/]r1$/)
  assert.notEqual(a, b)
})

test('makeCursorSandbox puts the checkout outside the run repo and outside any git repository', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const cache = await freshDir('cache')
  const sandbox = await makeCursorSandbox(defaultGitExec, {
    runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: cache },
  })
  assert.ok(sandbox.cwd.startsWith(cache))
  assert.ok(!sandbox.cwd.startsWith(runRepo))
  assert.equal(await enclosingGitRoot(sandbox.cwd), null)
  assert.equal(await readFile(path.join(sandbox.cwd, 'base.txt'), 'utf8'), 'base\n')
})

// A sandbox (Codex's bwrap, for one) can mount an EMPTY `.git` in an ancestor such as `/tmp` for
// the length of a command. That is not a repository: a `.git` directory counts only with a `HEAD`
// inside, and a `.git` file only when it starts with `gitdir:`. The fixture plants its markers in
// a private temp ancestor, never in `/tmp` itself.
test('an empty .git directory or a non-pointer .git file in an ancestor is not a repository, and does not refuse the cache', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const ancestor = await mkdtemp(path.join(tmpdir(), 'fm-cgit-'))
  try {
    await mkdir(path.join(ancestor, '.git'))
    const cache = path.join(ancestor, 't', 'cache')
    await mkdir(cache, { recursive: true })
    assert.equal(await enclosingGitRoot(cache), null)
    const sandbox = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: cache } })
    assert.equal(await readFile(path.join(sandbox.cwd, 'base.txt'), 'utf8'), 'base\n')
    const fileMarker = path.join(ancestor, 'f')
    await mkdir(path.join(fileMarker, 'cache'), { recursive: true })
    await writeFile(path.join(fileMarker, '.git'), 'not a pointer\n')
    assert.equal(await enclosingGitRoot(path.join(fileMarker, 'cache')), null)
  } finally { await rm(ancestor, { recursive: true, force: true }) }
})

test('a .git directory holding HEAD, or a gitdir: pointer file, in an ancestor still refuses the cache', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const ancestor = await mkdtemp(path.join(tmpdir(), 'fm-cgit-'))
  try {
    for (const [name, plant] of [
      ['dir', async dir => { await mkdir(path.join(dir, '.git')); await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n') }],
      ['pointer', async dir => { await writeFile(path.join(dir, '.git'), 'gitdir: /home/you/elsewhere/.git/worktrees/x\n') }],
      // A HEAD that is a dangling symlink is still a repository's HEAD: read with lstat, not stat.
      ['dangling', async dir => { await mkdir(path.join(dir, '.git')); await symlink(path.join(dir, 'missing-head-target'), path.join(dir, '.git', 'HEAD')) }],
    ]) {
      const repo = path.join(ancestor, name)
      const cache = path.join(repo, 't', 'cache')
      await mkdir(cache, { recursive: true })
      await plant(repo)
      assert.equal(await enclosingGitRoot(cache), repo)
      await assert.rejects(
        makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: cache } }),
        (err) => err.message.includes('must not live inside a git repository') && err.message.includes(repo),
      )
    }
  } finally { await rm(ancestor, { recursive: true, force: true }) }
})

test('makeCursorSandbox refuses a cache inside a git repository, naming it', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const dotfiles = await freshDir('dotfiles')
  await defaultGitExec(['init'], dotfiles)
  await assert.rejects(
    makeCursorSandbox(defaultGitExec, {
      runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: path.join(dotfiles, 'cache') },
    }),
    (err) => err.message.includes('must not live inside a git repository') && err.message.includes(dotfiles),
  )
})

test('cleanup removes the checkout and its empty run and repo directories, but keeps a sibling task', { timeout: 10000 }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const cache = await freshDir('cache')
  const env = { XDG_CACHE_HOME: cache }
  const a = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env })
  const b = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T2', mode: 'files', env })
  await cleanup({ sandbox: a })
  await assert.rejects(stat(a.cwd), /ENOENT/)
  await stat(b.cwd)
  await cleanup({ sandbox: b })
  await assert.rejects(stat(path.dirname(path.dirname(b.cwd))), /ENOENT/)
  await stat(path.join(cache, 'fleetmates', 'cursor'))
})

// Review finding 3: a control-path refusal must survive the scrub it performs — a re-dispatch that
// resumes the same checkout is refused again, before any turn is spent.
test('a control-path refusal is permanent for that checkout: spawn, resume and collect all refuse afterwards', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const runRepo = await freshDir('run')
  await initRepo(runRepo)
  const sandbox = await makeCursorSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: await freshDir('cache') } })
  const streamPath = path.join(await freshDir('sessions'), 's.jsonl')
  await withEnv({ FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    await runToExit(await spawnCursor({ sandbox, prompt: 'p', network: false, streamPath }))
  })
  await mkdir(path.join(sandbox.cwd, '.claude'), { recursive: true })
  await writeFile(path.join(sandbox.cwd, '.claude', 'settings.local.json'), '{}')
  await assert.rejects(collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' }), /control-path/)
  // The planted file is gone now; the refusal must not be.
  await assert.rejects(collectCursor(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T1' }), /control-path: .*\.claude\/settings\.local\.json/)
  await assert.rejects(resumeCursor({ sandbox, sessionId: 's', message: 'm', network: false, streamPath }), /control-path/)
  await assert.rejects(spawnCursor({ sandbox, prompt: 'p', network: false, streamPath }), /control-path/)
})

// Review finding 6: valid JSON that is not an object must not crash the probe.
test('probe: a global sandbox.json that is valid JSON but not an object is refused, not thrown', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  for (const raw of ['null', '[]', '"x"', '3']) {
    const home = await freshDir('home')
    await writeFile(path.join(home, 'sandbox.json'), raw)
    const res = await probe({ env: { ...process.env, CURSOR_CONFIG_DIR: home } })
    assert.equal(res.ok, false, raw)
    assert.match(res.fix, /fix or remove/)
  }
})

// The implementer persona is written for a git worktree (commit, `locate`, prove the commit with
// `git log`, run `complete`). A files checkout has no git, so the override must come BEFORE that
// persona and name every step it cancels — a trailing note alone left real teammates reporting
// `failed` for work they could not "prove".
test('FILES_PREAMBLE cancels every git-bound step of the implementer persona by name', () => {
  for (const step of ['git', 'worktree', 'commit', 'locate', 'complete', 'branch']) {
    assert.match(FILES_PREAMBLE, new RegExp(step, 'i'), step)
  }
  assert.match(FILES_PREAMBLE, /overrides/i)
})

test('required Cursor ask enforcement reaches spawn and resume and refuses unsupported execution', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'files' } }
  const enforcement = { kind: 'required', harness: 'cursor', sandboxMode: 'files', sandbox: 'enabled', mode: 'ask', read: true, write: false, execute: false, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    const args = build({ sandbox, enforcement, sessionId: 'fixture' })
    assert.equal(args[args.indexOf('--mode') + 1], 'ask')
    assert.ok(args.includes('enabled'))
    assert.throws(() => build({ sandbox, enforcement: { ...enforcement, execute: true } }), /enforcement/i)
  }
})

test('Cursor required enforcement cannot downgrade malformed contracts to legacy', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'files' } }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    for (const enforcement of [null, {}, false, { kind: 'legacy' }]) assert.throws(() => build({ sandbox, enforcement }), /enforcement/i)
  }
})

test('Cursor runtime spawn and resume carry required ask enforcement and deny host network widening', { skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('required')
  const sessions = await freshDir('required-sessions')
  const streamPath = path.join(sessions, 'stream')
  const argvOut = path.join(sessions, 'argv')
  const enforcement = { kind: 'required', harness: 'cursor', sandboxMode: 'files', sandbox: 'enabled', mode: 'ask', read: true, write: false, execute: false, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  const sandbox = { cwd, meta: { mode: 'files' } }
  await withEnv({ FAKE_CURSOR_ARGV_OUT: argvOut, FAKE_CURSOR_RESULT_TEXT: JSON.stringify(good) }, async () => {
    for (const run of [spawnCursor, resumeCursor]) {
      await runToExit(await run({ sandbox, enforcement, network: true, prompt: 'fixture', message: 'fixture', sessionId: 'fixture', streamPath }))
      const args = JSON.parse(await readFile(argvOut, 'utf8')).argv
      assert.equal(args[args.indexOf('--mode') + 1], 'ask')
      assert.equal(JSON.parse(await readFile(path.join(cwd, '.cursor', 'sandbox.json'), 'utf8')).networkPolicy.default, 'deny')
      assert.deepEqual(await readResult({ streamPath }), good)
    }
  })
})

test('Cursor required network access cannot exceed the host approval on spawn or resume', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'files' } }
  const enforcement = { kind: 'required', harness: 'cursor', sandboxMode: 'files', sandbox: 'enabled', mode: null, read: true, write: true, execute: true, network: true, sharedRefs: false, publication: false, addWritableRoots: false }
  for (const build of [buildSpawnArgv, buildResumeArgv]) assert.throws(() => build({ sandbox, enforcement, network: false }), /enforcement/i)
})


test('Cursor builders refuse a bound required policy with missing enforcement', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'files', prerequisites: { version: 1, rolePolicy: 'policy.json' } } }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    assert.throws(() => build({ sandbox, sessionId: 'fixture' }), /enforcement/i)
  }
})

test('Cursor refuses required non-model verification rather than claiming native confinement', async () => {
  assert.equal(typeof cursorAdapter.createVerificationExecutor, 'function')
  await assert.rejects(cursorAdapter.createVerificationExecutor({ sandbox: { cwd: '/fixture/worker', meta: { mode: 'files' } } }), /unsupported/i)
})

// --- explicit model and bounded capture (execution recovery T8) -------------------------------

test('cursor argv builders refuse a model that is not one bounded token', () => {
  const sandbox = { cwd: '/w', meta: { mode: 'files' } }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    for (const model of ['--yolo', '-f', 'gpt 5', 'a\nb', 'x'.repeat(200)]) {
      assert.throws(() => build({ sandbox, sessionId: 'sess-1', model }), /model/i, `${build.name} accepted model ${JSON.stringify(model)}`)
    }
    assert.ok(build({ sandbox, sessionId: 'sess-1', model: 'sonnet-4.5' }).includes('sonnet-4.5'))
  }
})

test('spawnCursor stops an oversized stream, counting what a resume appends to, and reports the capture as limited', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await freshDir('flood')
  const streamPath = path.join(scratch, `${path.basename(cwd)}.jsonl`)
  // A resume appends to the session's stream, so its bound covers what is already on disk.
  await writeFile(streamPath, 'p'.repeat(3000))
  // 500-byte chunks, so the bound is crossed inside the stream rather than by one huge chunk.
  await withEnv({ FAKE_CURSOR_FLOOD: '1', FAKE_CURSOR_FLOOD_CHUNK: '500' }, async () => {
    const handle = await resumeCursor({ sandbox: { cwd, meta: { mode: 'full' } }, sessionId: 'sess-1', message: 'flood', streamPath, maxStreamBytes: 4096 })
    const exited = once(handle.child, 'exit')
    await handle.sessionId
    const [, signal] = await exited
    await handle.flushed
    assert.equal(signal, 'SIGKILL')
    assert.equal(handle.outputLimited, true)
    const size = (await stat(streamPath)).size
    assert.equal(size, 4096, 'the appended stream holds exactly what fit, counting the earlier session')
    assert.equal((await readFile(streamPath, 'utf8')).slice(0, 3000), 'p'.repeat(3000), 'the earlier session stream was kept')
  })
})

test('readResult refuses a stream file larger than its bound rather than parsing it', async () => {
  const dir = await freshDir('big-stream')
  const streamPath = path.join(dir, 's.jsonl')
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(good), session_id: 's' })
  await writeFile(streamPath, `${line}\n`)
  assert.deepEqual(await readResult({ streamPath }), good)
  assert.equal(await readResult({ streamPath, maxStreamBytes: line.length - 1 }), null)
  // Not followed through a symlink, even to a valid stream.
  const linked = path.join(dir, 'linked.jsonl')
  await symlink(streamPath, linked)
  assert.equal(await readResult({ streamPath: linked }), null)
})

test('readResult without O_NOFOLLOW still refuses a symlinked stream file and reads a regular one', async () => {
  // `noFollow: null` forces the path win32 takes, where O_NOFOLLOW is undefined.
  const dir = await freshDir('nofollow-stream')
  const streamPath = path.join(dir, 's.jsonl')
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(good), session_id: 's' })
  await writeFile(streamPath, `${line}\n`)
  // `beforeOpen` runs only once lstat has accepted the path, right before the open.
  let opens = 0
  const beforeOpen = () => { opens += 1 }
  assert.deepEqual(await readResult({ streamPath, noFollow: null, beforeOpen }), good)
  assert.equal(opens, 1, 'a regular file reaches the open')
  const linked = path.join(dir, 'linked.jsonl')
  await symlink(streamPath, linked)
  assert.equal(await readResult({ streamPath: linked, noFollow: null, beforeOpen }), null)
  assert.equal(opens, 1, 'a symlink is refused by lstat before it is ever opened')
})

test('readResult without O_NOFOLLOW refuses a stream file replaced between its lstat and its open', async () => {
  const dir = await freshDir('swap-stream')
  const streamPath = path.join(dir, 's.jsonl')
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(good), session_id: 's' })
  await writeFile(streamPath, `${line}\n`)
  const other = path.join(dir, 'other.jsonl')
  await writeFile(other, `${line}\n`)
  // A different regular file renamed over the path after lstat: the opened handle is not the file lstat saw.
  let swapped = false
  const beforeOpen = async () => { await rename(other, streamPath); swapped = true }
  assert.equal(await readResult({ streamPath, noFollow: null, beforeOpen }), null)
  assert.equal(swapped, true, 'the swap ran, so null is the dev/ino refusal')
})
