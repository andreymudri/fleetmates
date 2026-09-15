import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { defaultGitExec } from '../scripts/git.mjs'
import {
  buildSpawnArgv, buildResumeArgv, spawnCodex, resumeCodex,
  readResult, readUsage, probe, makeCodexSandbox, collectCodex, codexAdapter,
} from '../scripts/harnesses/codex.mjs'
import { getAdapter, HARNESS_NAMES } from '../scripts/harnesses/index.mjs'

// A fake `codex` on PATH (Node, CommonJS so a bare shebang-invoked file with no extension runs
// without a nearby package.json "type": "module"). It:
//  - answers `login status` from FAKE_CODEX_LOGGED_IN (default logged in);
//  - for `exec`/`exec resume`, records the argv it received next to the `-o` file
//    (`<resultPath>.argv.json`), so a test can assert the built argv without a second process;
//  - BLOCKS reading stdin until it closes — a regression that leaves the adapter's stdin open
//    hangs any test that spawns it into that test's timeout, per spec §2 item 4;
//  - emits `thread.started` then FAKE_CODEX_TURNS `turn.completed` lines, and writes the `-o`
//    result file unless FAKE_CODEX_WITHHOLD_RESULT=1.
const FAKE_CODEX_SRC = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')

const argv = process.argv.slice(2)

if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_IN === '0') {
    process.stdout.write('Not logged in\\n')
    process.exit(1)
  }
  process.stdout.write('Logged in\\n')
  process.exit(0)
}

const oIndex = argv.indexOf('-o')
const resultPath = oIndex !== -1 ? argv[oIndex + 1] : null
if (resultPath) writeFileSync(\`\${resultPath}.argv.json\`, JSON.stringify(argv))

const threadId = process.env.FAKE_CODEX_THREAD_ID || 'thread-fixture-1'
const turns = Number(process.env.FAKE_CODEX_TURNS || '1')
const withhold = process.env.FAKE_CODEX_WITHHOLD_RESULT === '1'

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buffered += chunk })
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
  for (let i = 0; i < turns; i++) {
    process.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 1,
        cache_write_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 3,
      },
    }) + '\\n')
  }
  if (resultPath && !withhold) {
    writeFileSync(resultPath, JSON.stringify({
      status: 'done',
      branch: 'fleetmates/r1/T5',
      filesChanged: [],
      summary: 'ok',
      blockers: [],
    }))
  }
  process.exit(0)
})
process.stdin.resume()
void buffered
`

let pathDir
let originalPath

before(async () => {
  pathDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-fake-bin-'))
  const bin = path.join(pathDir, 'codex')
  await writeFile(bin, FAKE_CODEX_SRC, 'utf8')
  await chmod(bin, 0o755)
  originalPath = process.env.PATH
  // node:test runs each test FILE in its own process, so mutating PATH here is scoped to this
  // file's process and does not leak into other test files.
  process.env.PATH = `${pathDir}${path.delimiter}${originalPath}`
})

after(async () => {
  process.env.PATH = originalPath
  await rm(pathDir, { recursive: true, force: true })
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

async function initRepo(root) {
  await defaultGitExec(['init', '--initial-branch=main'], root)
  await defaultGitExec(['config', 'user.email', 'test@example.com'], root)
  await defaultGitExec(['config', 'user.name', 'test'], root)
  await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
  await defaultGitExec(['add', '.'], root)
  await defaultGitExec(['commit', '-m', 'base'], root)
}

// --- index.mjs: the registry -------------------------------------------------------------

test('getAdapter resolves the codex adapter, and HARNESS_NAMES lists it', () => {
  assert.equal(getAdapter('codex'), codexAdapter)
  assert.ok(HARNESS_NAMES.includes('codex'))
})

test('getAdapter refuses an unknown harness, naming the known ones', () => {
  assert.throws(() => getAdapter('bogus'), /unknown harness: bogus \(known: codex\)/)
})

// --- argv builders (spec §5), pure -------------------------------------------------------

test('buildSpawnArgv (clone mode) carries --disable hooks, -s workspace-write, --add-dir, and GIT_DIR only via shell_environment_policy.set', () => {
  const argv = buildSpawnArgv({
    sandbox: { cwd: '/sandboxes/clones/T5', meta: { mode: 'clone', gitdir: '/sandboxes/gitdirs/T5' } },
    model: 'gpt-5', effort: 'high', network: false,
    schemaPath: '/sandboxes/T5.schema.json', resultPath: '/sessions/T5.json',
  })
  assert.equal(argv[0], 'exec')
  assert.ok(argv.includes('--disable'))
  assert.ok(argv.includes('hooks'))
  const sIndex = argv.indexOf('-s')
  assert.equal(argv[sIndex + 1], 'workspace-write')
  const addDirIndex = argv.indexOf('--add-dir')
  assert.equal(argv[addDirIndex + 1], '/sandboxes/gitdirs/T5')
  const envSet = argv.find((a) => typeof a === 'string' && a.startsWith('shell_environment_policy.set='))
  assert.ok(envSet, 'expected a shell_environment_policy.set entry')
  assert.ok(envSet.includes('GIT_DIR="/sandboxes/gitdirs/T5"'))
  assert.ok(envSet.includes('GIT_WORK_TREE="/sandboxes/clones/T5"'))
  // "GIT_DIR=" appears exactly once in the whole argv — inside that one -c value — so it never
  // reaches the codex process's own environment (this module never passes an `env` override to
  // the spawned process at all; see spawnCodex/run).
  const gitDirTokens = argv.filter((a) => typeof a === 'string' && a.includes('GIT_DIR='))
  assert.deepEqual(gitDirTokens, [envSet])
})

test('buildSpawnArgv (full mode) omits --add-dir and shell_environment_policy.set', () => {
  const argv = buildSpawnArgv({
    sandbox: { cwd: '/sandboxes/clones/T5', meta: { mode: 'full', gitdir: '/sandboxes/gitdirs/T5' } },
    schemaPath: '/s.json', resultPath: '/r.json',
  })
  const sIndex = argv.indexOf('-s')
  assert.equal(argv[sIndex + 1], 'danger-full-access')
  assert.ok(!argv.includes('--add-dir'))
  assert.ok(!argv.some((a) => typeof a === 'string' && a.startsWith('shell_environment_policy.set=')))
})

test('buildResumeArgv (clone mode) carries exec, resume, the session id, sandbox_mode and writable_roots, and takes no -C', () => {
  const argv = buildResumeArgv({
    sandbox: { cwd: '/sandboxes/clones/T5', meta: { mode: 'clone', gitdir: '/sandboxes/gitdirs/T5' } },
    sessionId: 'thread-abc',
    schemaPath: '/s.json', resultPath: '/r.json',
  })
  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thread-abc'])
  assert.ok(argv.some((a) => a === 'sandbox_mode="workspace-write"'))
  assert.ok(argv.some((a) => typeof a === 'string' && a.startsWith('sandbox_workspace_write.writable_roots=') && a.includes('/sandboxes/gitdirs/T5')))
  assert.ok(argv.some((a) => typeof a === 'string' && a.startsWith('shell_environment_policy.set=') && a.includes('GIT_DIR')))
  assert.ok(!argv.includes('-C'))
})

// --- spawnCodex/resumeCodex against the fake binary --------------------------------------

test('spawnCodex resolves the session id from the stream and closes stdin (a regression here hangs into the timeout)', { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-clone-'))
  const gitdir = await mkdtemp(path.join(tmpdir(), 'tm-codex-gitdir-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  try {
    const sandbox = { cwd, meta: { mode: 'clone', gitdir } }
    const handle = await spawnCodex({
      sandbox, prompt: 'do the task',
      schemaPath: path.join(sessionsDir, 'T5.schema.json'),
      resultPath: path.join(sessionsDir, 'T5.json'),
      streamPath: path.join(sessionsDir, 'T5.jsonl'),
      errPath: path.join(sessionsDir, 'T5.err'),
    })
    const sessionId = await handle.sessionId
    assert.equal(sessionId, 'thread-fixture-1')
    const [code] = await once(handle.child, 'close')
    assert.equal(code, 0)
    const result = await readResult({ resultPath: path.join(sessionsDir, 'T5.json') })
    assert.deepEqual(result, { status: 'done', branch: 'fleetmates/r1/T5', filesChanged: [], summary: 'ok', blockers: [] })
    const recordedArgv = JSON.parse(await readFile(path.join(sessionsDir, 'T5.json.argv.json'), 'utf8'))
    assert.ok(recordedArgv.includes('--disable'))
    assert.ok(recordedArgv.includes('hooks'))
    const sIndex = recordedArgv.indexOf('-s')
    assert.equal(recordedArgv[sIndex + 1], 'workspace-write')
    assert.ok(recordedArgv.includes('--add-dir'))
    assert.ok(recordedArgv.some((a) => typeof a === 'string' && a.startsWith('shell_environment_policy.set=') && a.includes('GIT_DIR')))
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(gitdir, { recursive: true, force: true })
    await rm(sessionsDir, { recursive: true, force: true })
  }
})

test('readResult returns null when the -o file was never written', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-noresult-'))
  try {
    const result = await readResult({ resultPath: path.join(dir, 'absent.json') })
    assert.equal(result, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('spawnCodex withholding the -o file: readResult is null, not a throw', { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-clone-'))
  const gitdir = await mkdtemp(path.join(tmpdir(), 'tm-codex-gitdir-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  try {
    await withEnv({ FAKE_CODEX_WITHHOLD_RESULT: '1' }, async () => {
      const sandbox = { cwd, meta: { mode: 'clone', gitdir } }
      const resultPath = path.join(sessionsDir, 'T6.json')
      const handle = await spawnCodex({
        sandbox, prompt: 'no result this time',
        schemaPath: path.join(sessionsDir, 'T6.schema.json'),
        resultPath,
        streamPath: path.join(sessionsDir, 'T6.jsonl'),
        errPath: path.join(sessionsDir, 'T6.err'),
      })
      await handle.sessionId
      await once(handle.child, 'close')
      assert.equal(await readResult({ resultPath }), null)
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(gitdir, { recursive: true, force: true })
    await rm(sessionsDir, { recursive: true, force: true })
  }
})

test('readUsage sums two turn.completed usages', { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-clone-'))
  const gitdir = await mkdtemp(path.join(tmpdir(), 'tm-codex-gitdir-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  try {
    await withEnv({ FAKE_CODEX_TURNS: '2' }, async () => {
      const sandbox = { cwd, meta: { mode: 'clone', gitdir } }
      const streamPath = path.join(sessionsDir, 'T7.jsonl')
      const handle = await spawnCodex({
        sandbox, prompt: 'two turns',
        schemaPath: path.join(sessionsDir, 'T7.schema.json'),
        resultPath: path.join(sessionsDir, 'T7.json'),
        streamPath,
        errPath: path.join(sessionsDir, 'T7.err'),
      })
      await handle.sessionId
      await once(handle.child, 'close')
      const usage = await readUsage({ streamPath })
      assert.deepEqual(usage, { input: 20, cachedInput: 2, cacheWrite: 4, output: 10, reasoning: 6 })
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(gitdir, { recursive: true, force: true })
    await rm(sessionsDir, { recursive: true, force: true })
  }
})

test('readUsage returns null when the stream carries no turn.completed event', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-stream-'))
  try {
    const streamPath = path.join(dir, 'empty.jsonl')
    await writeFile(streamPath, JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\n', 'utf8')
    assert.equal(await readUsage({ streamPath }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resumeCodex builds a resume argv the fake receives, with exec/resume/session id and sandbox_mode', { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-clone-'))
  const gitdir = await mkdtemp(path.join(tmpdir(), 'tm-codex-gitdir-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  try {
    const sandbox = { cwd, meta: { mode: 'clone', gitdir } }
    const resultPath = path.join(sessionsDir, 'T8.json')
    const handle = await resumeCodex({
      sandbox, sessionId: 'thread-fixture-1', message: 'please fix the fileset finding',
      schemaPath: path.join(sessionsDir, 'T8.schema.json'),
      resultPath,
      streamPath: path.join(sessionsDir, 'T8.jsonl'),
      errPath: path.join(sessionsDir, 'T8.err'),
    })
    await handle.sessionId
    await once(handle.child, 'close')
    const recordedArgv = JSON.parse(await readFile(`${resultPath}.argv.json`, 'utf8'))
    assert.deepEqual(recordedArgv.slice(0, 3), ['exec', 'resume', 'thread-fixture-1'])
    assert.ok(recordedArgv.includes('sandbox_mode="workspace-write"'))
    assert.ok(recordedArgv.some((a) => typeof a === 'string' && a.startsWith('sandbox_workspace_write.writable_roots=')))
    assert.ok(!recordedArgv.includes('-C'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(gitdir, { recursive: true, force: true })
    await rm(sessionsDir, { recursive: true, force: true })
  }
})

// --- makeCodexSandbox (spec §7), against real git ------------------------------------------

test('makeCodexSandbox (clone mode) leaves no .git under the clone and builds a populated separate git dir with the branch checked out', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initRepo(runRepo)
    const sandbox = await makeCodexSandbox(defaultGitExec, {
      runRepo, runBranch: 'main', runId: 'r1', taskId: 'T5', mode: 'clone',
    })
    assert.equal(sandbox.meta.mode, 'clone')
    assert.equal(sandbox.meta.branch, 'fleetmates/r1/T5')
    await assert.rejects(stat(path.join(sandbox.cwd, '.git')), /ENOENT/)
    const gitdirStat = await stat(path.join(sandbox.meta.gitdir, 'HEAD'))
    assert.ok(gitdirStat.isFile())
    const objectsStat = await stat(path.join(sandbox.meta.gitdir, 'objects'))
    assert.ok(objectsStat.isDirectory())
    const branchName = await defaultGitExec(
      ['--git-dir', sandbox.meta.gitdir, '--work-tree', sandbox.cwd, 'symbolic-ref', '--short', 'HEAD'],
    )
    assert.equal(branchName.stdout.trim(), 'fleetmates/r1/T5')
    const tracked = await defaultGitExec(['--git-dir', sandbox.meta.gitdir, '--work-tree', sandbox.cwd, 'ls-files'])
    assert.ok(tracked.stdout.includes('base.txt'))
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

test('makeCodexSandbox (files mode) produces a git-less checkout of the branch tree', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initRepo(runRepo)
    const sandbox = await makeCodexSandbox(defaultGitExec, {
      runRepo, runBranch: 'main', runId: 'r1', taskId: 'T9', mode: 'files',
    })
    assert.equal(sandbox.meta.mode, 'files')
    const content = await readFile(path.join(sandbox.cwd, 'base.txt'), 'utf8')
    assert.equal(content, 'base\n')
    await assert.rejects(stat(path.join(sandbox.cwd, '.git')), /ENOENT/)
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

// --- collectCodex: the only host-side git touch against teammate material -----------------

test('collectCodex (clone mode) fetches the task branch from the sandbox git dir into the run repo', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initRepo(runRepo)
    const sandbox = await makeCodexSandbox(defaultGitExec, {
      runRepo, runBranch: 'main', runId: 'r1', taskId: 'T5', mode: 'clone',
    })
    const gd = sandbox.meta.gitdir
    const wt = sandbox.cwd
    await defaultGitExec(['--git-dir', gd, '--work-tree', wt, 'config', 'user.email', 'test@example.com'])
    await defaultGitExec(['--git-dir', gd, '--work-tree', wt, 'config', 'user.name', 'test'])
    await writeFile(path.join(wt, 'task.txt'), 'work\n', 'utf8')
    await defaultGitExec(['--git-dir', gd, '--work-tree', wt, 'add', '.'])
    await defaultGitExec(['--git-dir', gd, '--work-tree', wt, 'commit', '-m', 'task work'])
    const tip = (await defaultGitExec(['--git-dir', gd, 'rev-parse', 'HEAD'])).stdout.trim()

    await collectCodex(defaultGitExec, { runRepo, sandbox, branch: sandbox.meta.branch })

    const landed = await defaultGitExec(['rev-parse', sandbox.meta.branch], runRepo)
    assert.equal(landed.stdout.trim(), tip)
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

test('collectCodex (files mode) is a no-op — nothing to fetch, the driver commits the diff itself', async () => {
  let called = false
  const spy = async (args, opts) => { called = true; return defaultGitExec(args, opts) }
  await collectCodex(spy, { runRepo: '/irrelevant', sandbox: { meta: { mode: 'files' } }, branch: 'fleetmates/r1/T9' })
  assert.equal(called, false)
})

// --- probe ---------------------------------------------------------------------------------

test('probe returns ok:false with the codex login fix when the fake reports Not logged in', { timeout: 5000 }, async () => {
  const res = await probe({ env: { ...process.env, FAKE_CODEX_LOGGED_IN: '0' } })
  assert.equal(res.ok, false)
  assert.equal(res.fix, 'run: codex login')
})

test('probe returns ok:true when the fake reports logged in and CODEX_HOME is writable', { timeout: 5000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tm-codex-home-'))
  try {
    const res = await probe({ env: { ...process.env, FAKE_CODEX_LOGGED_IN: '1', CODEX_HOME: home } })
    assert.deepEqual(res, { ok: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
