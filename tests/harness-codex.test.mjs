import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, chmod, stat, symlink, rename } from 'node:fs/promises'
import { tmpdir, constants as osConstants } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { defaultGitExec } from '../scripts/git.mjs'
import {
  buildSpawnArgv, buildResumeArgv, spawnCodex, resumeCodex,
  readResult, readUsage, probe, makeCodexSandbox, collectCodex, codexAdapter,
} from '../scripts/harnesses/codex.mjs'
import { FILES_PREAMBLE } from '../scripts/harnesses/files-sandbox.mjs'
import { getAdapter, HARNESS_NAMES } from '../scripts/harnesses/index.mjs'

// Fake harness binaries here are `#!/usr/bin/env node` scripts on PATH, which Windows cannot execute
// (no shebang support; a real CLI there is a .cmd shim). Tests that spawn one are skipped on win32.
const WIN32_FAKE_SKIP = process.platform === 'win32' ? 'shebang fake binaries do not execute on win32' : false

// A fake `codex` on PATH (Node, CommonJS so a bare shebang-invoked file with no extension runs
// without a nearby package.json "type": "module"). It:
//  - answers `login status` from FAKE_CODEX_LOGGED_IN (default logged in);
//  - for `exec`/`exec resume`, records the argv it received next to the `-o` file
//    (`<resultPath>.argv.json`), so a test can assert the built argv without a second process;
//  - BLOCKS reading stdin until it closes — a regression that leaves the adapter's stdin open
//    hangs any test that spawns it into that test's timeout, per spec §2 item 4;
//  - emits `thread.started` then FAKE_CODEX_TURNS `turn.completed` lines, and writes the `-o`
//    result file unless FAKE_CODEX_WITHHOLD_RESULT=1;
//  - when FAKE_CODEX_ENV_OUT points somewhere, records its OWN `GIT_DIR`/`GIT_WORK_TREE` there —
//    the only way to observe what `run()` actually put in the spawned process's environment,
//    as opposed to what argv says (see the GIT_DIR/GIT_WORK_TREE-never-inherited test below).
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

if (process.env.FAKE_CODEX_ENV_OUT) {
  writeFileSync(process.env.FAKE_CODEX_ENV_OUT, JSON.stringify({
    GIT_DIR: process.env.GIT_DIR ?? null,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE ?? null,
  }))
}

const threadId = process.env.FAKE_CODEX_THREAD_ID || 'thread-fixture-1'
const turns = Number(process.env.FAKE_CODEX_TURNS || '1')
const withhold = process.env.FAKE_CODEX_WITHHOLD_RESULT === '1'

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buffered += chunk })
process.stdin.on('end', () => {
  if (resultPath) writeFileSync(\`\${resultPath}.stdin.txt\`, buffered)
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
  // FAKE_CODEX_FLOOD: never finishes and never writes a result, only an unbounded stream.
  if (process.env.FAKE_CODEX_FLOOD === '1') { const target = process.env.FAKE_CODEX_FLOOD_STREAM === 'stderr' ? process.stderr : process.stdout; setInterval(() => target.write('x'.repeat(Number(process.env.FAKE_CODEX_FLOOD_CHUNK || 65536))), 1); return }
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

// Asserts a `-c key=value` pair appears as ADJACENT argv elements, in that order — a loose
// `.includes(value)` check would still pass if the pair were split apart or the value moved
// under a different flag. This pins the exact `['-c', <value>]` pair `baseArgs` (codex.mjs)
// builds for each security-relevant setting.
function hasPair(argv, flag, value) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === value) return true
  }
  return false
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
  assert.throws(() => getAdapter('bogus'), /unknown harness: bogus \(known: codex, cursor\)/)
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
  // --skip-git-repo-check: the clone's cwd carries no `.git` pointer (§7), so codex must not
  // refuse to start over that.
  assert.ok(argv.includes('--skip-git-repo-check'))
  // approval_policy="never": headless `codex exec` has no one to answer an interactive approval
  // prompt — without this pair the process blocks forever waiting on one.
  assert.ok(hasPair(argv, '-c', 'approval_policy="never"'), 'expected the pair -c approval_policy="never"')
  // The two sandbox_workspace_write excludes: without them /tmp and $TMPDIR read as
  // writable-by-default gaps in the workspace-write sandbox.
  assert.ok(
    hasPair(argv, '-c', 'sandbox_workspace_write.exclude_slash_tmp=true'),
    'expected the pair -c sandbox_workspace_write.exclude_slash_tmp=true',
  )
  assert.ok(
    hasPair(argv, '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'),
    'expected the pair -c sandbox_workspace_write.exclude_tmpdir_env_var=true',
  )
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

// The whole sandbox-SELECTION matrix, pinned explicitly per mode per builder, so a downgrade of
// `SANDBOX_FLAG.files` (or `buildResumeArgv`'s files/full branches) to the wrong flag cannot ship
// green. Clone mode is already exercised by the tests above via other assertions; repeated here
// with `hasPair` so every mode is proven the same way, in one place, and none is left unpinned.
test('buildSpawnArgv selects -s workspace-write for clone and files, and -s danger-full-access for full', () => {
  const argvFor = (mode) => buildSpawnArgv({
    sandbox: { cwd: '/sandboxes/clones/T5', meta: { mode, gitdir: '/sandboxes/gitdirs/T5' } },
    schemaPath: '/s.json', resultPath: '/r.json',
  })
  assert.ok(hasPair(argvFor('clone'), '-s', 'workspace-write'), 'clone mode: expected the pair -s workspace-write')
  assert.ok(hasPair(argvFor('files'), '-s', 'workspace-write'), 'files mode: expected the pair -s workspace-write')
  assert.ok(hasPair(argvFor('full'), '-s', 'danger-full-access'), 'full mode: expected the pair -s danger-full-access')
})

test('buildResumeArgv selects sandbox_mode="workspace-write" for clone and files, and sandbox_mode="danger-full-access" for full', () => {
  const argvFor = (mode) => buildResumeArgv({
    sandbox: { cwd: '/sandboxes/clones/T5', meta: { mode, gitdir: '/sandboxes/gitdirs/T5' } },
    sessionId: 'thread-abc',
    schemaPath: '/s.json', resultPath: '/r.json',
  })
  assert.ok(
    hasPair(argvFor('clone'), '-c', 'sandbox_mode="workspace-write"'),
    'clone mode: expected the pair -c sandbox_mode="workspace-write"',
  )
  assert.ok(
    hasPair(argvFor('files'), '-c', 'sandbox_mode="workspace-write"'),
    'files mode: expected the pair -c sandbox_mode="workspace-write"',
  )
  assert.ok(
    hasPair(argvFor('full'), '-c', 'sandbox_mode="danger-full-access"'),
    'full mode: expected the pair -c sandbox_mode="danger-full-access"',
  )
})

// --- spawnCodex/resumeCodex against the fake binary --------------------------------------

test('spawnCodex resolves the session id from the stream and closes stdin (a regression here hangs into the timeout)', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
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

// The core sandbox-escape defense (codex.mjs:36-40): GIT_DIR/GIT_WORK_TREE reach the agent's own
// shell tool calls only through `-c shell_environment_policy.set=…` — never the codex process's
// OWN environment. If they leaked into codex's env, its per-turn `git status` (§2 item 9) would
// inherit them and walk straight into whatever config the teammate plants in the sandbox git
// dir. The argv-shape tests above only count `GIT_DIR=` tokens in argv, which says nothing about
// the spawned process's actual environment — this test reads that environment back from the fake
// binary itself, the only way to observe what `run()` (codex.mjs) really passed to `spawn`.
test('spawnCodex never lets GIT_DIR/GIT_WORK_TREE reach the codex process\'s own environment', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-clone-'))
  const gitdir = await mkdtemp(path.join(tmpdir(), 'tm-codex-gitdir-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  try {
    const envOutPath = path.join(sessionsDir, 'T5.env.json')
    await withEnv({ FAKE_CODEX_ENV_OUT: envOutPath }, async () => {
      const sandbox = { cwd, meta: { mode: 'clone', gitdir } }
      const handle = await spawnCodex({
        sandbox, prompt: 'do the task',
        schemaPath: path.join(sessionsDir, 'T5.schema.json'),
        resultPath: path.join(sessionsDir, 'T5.json'),
        streamPath: path.join(sessionsDir, 'T5.jsonl'),
        errPath: path.join(sessionsDir, 'T5.err'),
      })
      await handle.sessionId
      await once(handle.child, 'close')
    })
    const seenEnv = JSON.parse(await readFile(envOutPath, 'utf8'))
    // GIT_DIR/GIT_WORK_TREE never live in THIS test's own process.env either — they exist only
    // inside the built `-c shell_environment_policy.set=…` argv value (asserted present there by
    // the test above). What this assertion actually catches: a buggy `run()` that added an `env`
    // override to its `spawn('codex', …)` call (e.g. `{ ...process.env, GIT_DIR: … }`) would make
    // the CHILD report a real value here; the correct `run()` passes no `env` override at all, so
    // the fake — which only ever sees what its own process.env carries — reports `null` for both.
    assert.equal(seenEnv.GIT_DIR, null)
    assert.equal(seenEnv.GIT_WORK_TREE, null)
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

test('readResult returns null (not a throw) when the -o file exists but is not valid JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-badjson-'))
  try {
    const resultPath = path.join(dir, 'bad.json')
    await writeFile(resultPath, 'not json at all {{{', 'utf8')
    const result = await readResult({ resultPath })
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

test('readUsage sums two turn.completed usages', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
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

test('resumeCodex builds a resume argv the fake receives, with exec/resume/session id and sandbox_mode', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
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

for (const mode of ['clone', 'full']) {
  test(`makeCodexSandbox (${mode} mode) writes the run repo's identity into the clone, so a commit there carries it and not the host global one`, async () => {
    const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
    const hostDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-host-'))
    try {
      const globalConfig = path.join(hostDir, 'gitconfig')
      await writeFile(globalConfig, '[user]\n\tname = Host Global\n\temail = host@example.invalid\n', 'utf8')
      await withEnv({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }, async () => {
        await initRepo(runRepo)
        const sandbox = await makeCodexSandbox(defaultGitExec, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T5', mode })
        const g = (args) => defaultGitExec(['--git-dir', sandbox.meta.gitdir, '--work-tree', sandbox.cwd, ...args], sandbox.cwd)
        await writeFile(path.join(sandbox.cwd, 'work.txt'), 'work\n', 'utf8')
        assert.equal((await g(['add', 'work.txt'])).code, 0)
        const committed = await g(['commit', '-m', 'work'])
        assert.equal(committed.code, 0, committed.stderr)
        const author = await g(['log', '-1', '--format=%an <%ae>|%cn <%ce>'])
        assert.equal(author.stdout.trim(), 'test <test@example.com>|test <test@example.com>')
      })
    } finally {
      await rm(runRepo, { recursive: true, force: true })
      await rm(hostDir, { recursive: true, force: true })
    }
  })
}

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

// A run repo whose checked-out branch ('main') and the branch handed to `makeCodexSandbox` as
// `runBranch` ('diverged') carry different trees — 'diverged' adds a file 'main' does not have.
// Content divergence is what makes index pollution OBSERVABLE: staging an identical tree onto
// an identical tree leaves no diff, which is exactly why the original defect (no `GIT_INDEX_FILE`)
// passed every prior test in this suite even though it was writing straight into the run repo's
// real index the whole time.
async function initDivergedRepo(runRepo) {
  await initRepo(runRepo)
  await defaultGitExec(['checkout', '-b', 'diverged'], runRepo)
  await writeFile(path.join(runRepo, 'only-in-work.txt'), 'diverged\n', 'utf8')
  await defaultGitExec(['add', '.'], runRepo)
  await defaultGitExec(['config', 'user.email', 'test@example.com'], runRepo)
  await defaultGitExec(['config', 'user.name', 'test'], runRepo)
  await defaultGitExec(['commit', '-m', 'diverged content'], runRepo)
  await defaultGitExec(['checkout', 'main'], runRepo)
}

test('makeCodexSandbox (files mode) leaves the run repo\'s own index and HEAD untouched, even when runBranch diverges from it', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initDivergedRepo(runRepo)
    const headBefore = (await defaultGitExec(['rev-parse', 'HEAD'], runRepo)).stdout.trim()
    const stagedBefore = await defaultGitExec(['diff', '--cached', '--name-only'], runRepo)
    assert.equal(stagedBefore.stdout.trim(), '')

    const sandbox = await makeCodexSandbox(defaultGitExec, {
      runRepo, runBranch: 'diverged', runId: 'r1', taskId: 'T9', mode: 'files',
    })
    // The sandbox itself does get the diverged branch's tree — that part is correct and expected.
    const content = await readFile(path.join(sandbox.cwd, 'only-in-work.txt'), 'utf8')
    assert.equal(content, 'diverged\n')

    // The assertion whose absence let the run repo's shared index get polluted: the
    // `--work-tree <cwd> checkout` in files mode must run against a PRIVATE index
    // (GIT_INDEX_FILE), never the run repo's own — otherwise this checkout stages
    // 'diverged''s tree (including a file 'main' never had) into runRepo's real index. Without
    // the fix this reproduces exactly the coordinator's own finding: `git diff --cached
    // --name-status` in runRepo shows `A only-in-work.txt`.
    const staged = await defaultGitExec(['diff', '--cached', '--name-only'], runRepo)
    assert.equal(staged.stdout.trim(), '', `expected the run repo's index to be unchanged, got staged: ${staged.stdout}`)
    const headAfter = (await defaultGitExec(['rev-parse', 'HEAD'], runRepo)).stdout.trim()
    assert.equal(headAfter, headBefore)
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

test('makeCodexSandbox (files mode) does not contend for the run repo\'s real index.lock, even while something else holds it', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initRepo(runRepo)
    // Simulates a concurrent git process already holding the run repo's own index lock — the
    // exact file a shared-index checkout would need and fail on
    // (`fatal: Unable to create '<runRepo>/.git/index.lock': File exists`). A files-mode build
    // using a private index (GIT_INDEX_FILE) never touches this file at all, so it must succeed
    // regardless.
    const gitDir = (await defaultGitExec(['rev-parse', '--git-dir'], runRepo)).stdout.trim()
    const lockPath = path.join(runRepo, gitDir, 'index.lock')
    await writeFile(lockPath, '', 'utf8')
    try {
      const sandbox = await makeCodexSandbox(defaultGitExec, {
        runRepo, runBranch: 'main', runId: 'r1', taskId: 'T10', mode: 'files',
      })
      const content = await readFile(path.join(sandbox.cwd, 'base.txt'), 'utf8')
      assert.equal(content, 'base\n')
      // The lock we planted is still exactly as we left it — nothing here ever tried to take it.
      const lockContent = await readFile(lockPath, 'utf8')
      assert.equal(lockContent, '')
    } finally {
      await rm(lockPath, { force: true })
    }
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

// runBranch is 'diverged' (content-divergent from the run repo's checked-out 'main', per
// initDivergedRepo above), not 'main' — with same-branch content, staging the tree onto itself
// leaves no diff, so this test would pass 15/15 even with GIT_INDEX_FILE removed and give false
// confidence. Divergent content is what makes the run repo's index actually OBSERVE pollution
// from either concurrent build.
test('makeCodexSandbox (files mode) — two concurrent builds on the same run repo both resolve, with distinct cwds and the diverged tree, and the run repo\'s index stays clean', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initDivergedRepo(runRepo)
    const [a, b] = await Promise.all([
      makeCodexSandbox(defaultGitExec, { runRepo, runBranch: 'diverged', runId: 'r1', taskId: 'TA', mode: 'files' }),
      makeCodexSandbox(defaultGitExec, { runRepo, runBranch: 'diverged', runId: 'r1', taskId: 'TB', mode: 'files' }),
    ])
    for (const sandbox of [a, b]) {
      const content = await readFile(path.join(sandbox.cwd, 'only-in-work.txt'), 'utf8')
      assert.equal(content, 'diverged\n')
    }
    assert.notEqual(a.cwd, b.cwd)
    const staged = await defaultGitExec(['diff', '--cached', '--name-only'], runRepo)
    assert.equal(staged.stdout.trim(), '', `expected the run repo's index to stay clean, got staged: ${staged.stdout}`)
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

// --- probe ---------------------------------------------------------------------------------

test('probe returns ok:false with the codex login fix when the fake reports Not logged in', { timeout: 5000 }, async () => {
  const res = await probe({ env: { ...process.env, FAKE_CODEX_LOGGED_IN: '0' } })
  assert.equal(res.ok, false)
  assert.equal(res.fix, 'run: codex login')
})

test('probe returns ok:true when the fake reports logged in and CODEX_HOME is writable', { timeout: 5000, skip: WIN32_FAKE_SKIP }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tm-codex-home-'))
  try {
    const res = await probe({ env: { ...process.env, FAKE_CODEX_LOGGED_IN: '1', CODEX_HOME: home } })
    assert.deepEqual(res, { ok: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// The writability guard (§2 item 15: codex dies without a writable CODEX_HOME) — pinned so
// deleting that block cannot leave the suite green. chmod 0o500 is ignored for the owner when
// running as root (same convention as tests/git.test.mjs), and win32 chmod semantics don't
// produce the same denial, so both are skipped there.
test('probe returns ok:false when the fake reports logged in but CODEX_HOME is not writable', {
  timeout: 5000,
  skip: process.platform === 'win32'
    ? 'win32 chmod does not deny directory writes the same way'
    : (process.getuid && process.getuid() === 0 ? 'chmod is ignored for root' : false),
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tm-codex-home-unwritable-'))
  try {
    await chmod(home, 0o500)
    const res = await probe({ env: { ...process.env, FAKE_CODEX_LOGGED_IN: '1', CODEX_HOME: home } })
    assert.equal(res.ok, false)
    assert.ok(res.reason && res.reason.length > 0, 'expected an actionable reason')
    assert.ok(res.fix && res.fix.includes(home), `expected the fix to name ${home}, got ${res.fix}`)
  } finally {
    await chmod(home, 0o700).catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
})

test('collectCodex (files mode) commits the teammate\'s edits on the task branch', async () => {
  const runRepo = await mkdtemp(path.join(tmpdir(), 'tm-codex-run-'))
  try {
    await initRepo(runRepo)
    const sandbox = await makeCodexSandbox(defaultGitExec, {
      runRepo, runBranch: 'main', runId: 'r1', taskId: 'T9', mode: 'files',
    })
    await writeFile(path.join(sandbox.cwd, 'base.txt'), 'edited\n', 'utf8')
    await writeFile(path.join(sandbox.cwd, 'new.txt'), 'new\n', 'utf8')
    await collectCodex(defaultGitExec, { runRepo, sandbox, branch: 'fleetmates/r1/T9' })
    const log = await defaultGitExec(['log', '--format=%s', 'main..fleetmates/r1/T9'], runRepo)
    assert.equal(log.code, 0, log.stderr)
    assert.equal(log.stdout.trim().split('\n').length, 1)
    const edited = await defaultGitExec(['show', 'fleetmates/r1/T9:base.txt'], runRepo)
    assert.equal(edited.stdout, 'edited\n')
    const added = await defaultGitExec(['show', 'fleetmates/r1/T9:new.txt'], runRepo)
    assert.equal(added.stdout, 'new\n')
  } finally {
    await rm(runRepo, { recursive: true, force: true })
  }
})

// A `files` checkout has no repository of its own: git run inside it walks up to the RUN repo, whose
// .git the workspace-write sandbox denies (spec 2026-09-14 §2 item 8). The implementer persona's
// branch/locate/commit/proof/complete steps cannot succeed there, so the prompt must lead with the
// override — the same one the Cursor adapter sends. A clone sandbox keeps git and gets no override.
test('spawnCodex and resumeCodex lead a files-mode prompt with FILES_PREAMBLE, and a clone prompt without it', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'tm-codex-sessions-'))
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-files-'))
  try {
    const paths = (name) => ({
      schemaPath: path.join(sessionsDir, `${name}.schema.json`),
      resultPath: path.join(sessionsDir, `${name}.json`),
      streamPath: path.join(sessionsDir, `${name}.jsonl`),
      errPath: path.join(sessionsDir, `${name}.err`),
    })
    const stdinOf = (name) => readFile(path.join(sessionsDir, `${name}.json.stdin.txt`), 'utf8')
    const files = { cwd, meta: { mode: 'files' } }
    let h = await spawnCodex({ sandbox: files, prompt: 'do the task', ...paths('F1') })
    await once(h.child, 'close')
    assert.equal(await stdinOf('F1'), `${FILES_PREAMBLE}do the task`)
    h = await resumeCodex({ sandbox: files, sessionId: 's', message: 'fix it', ...paths('F2') })
    await once(h.child, 'close')
    assert.equal(await stdinOf('F2'), `${FILES_PREAMBLE}fix it`)
    const clone = { cwd, meta: { mode: 'clone', gitdir: cwd } }
    h = await spawnCodex({ sandbox: clone, prompt: 'do the task', ...paths('C1') })
    await once(h.child, 'close')
    assert.equal(await stdinOf('C1'), 'do the task')
  } finally {
    await rm(sessionsDir, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('required Codex read-only enforcement reaches spawn and resume without writable roots', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'clone', gitdir: '/fixture/git' } }
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'clone', sandbox: 'read-only', mode: null, read: true, write: false, execute: true, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    const args = build({ sandbox, enforcement, network: true, sessionId: 'fixture', schemaPath: '/fixture/schema', resultPath: '/fixture/result' })
    if (build === buildSpawnArgv) assert.ok(hasPair(args, '-s', 'read-only'), 'spawn requires adjacent -s read-only')
    else assert.ok(hasPair(args, '-c', 'sandbox_mode="read-only"'), 'resume requires adjacent -c sandbox_mode="read-only"')
    assert.ok(!args.includes('--add-dir'))
    assert.ok(!args.some(arg => arg.includes('writable_roots') || arg.includes('network_access=true')))
    assert.ok(args.includes('hooks'))
    assert.ok(args.includes('sandbox_workspace_write.network_access=false'))
    assert.ok(args.includes('/fixture/result'))
    assert.throws(() => build({ sandbox, enforcement: { ...enforcement, sharedRefs: true } }), /enforcement/i)
  }
})

test('Codex required enforcement cannot downgrade malformed contracts to legacy', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'clone' } }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    for (const enforcement of [null, {}, false, { kind: 'legacy' }]) assert.throws(() => build({ sandbox, enforcement }), /enforcement/i)
  }
})

test('Codex runtime spawn and resume carry required read-only enforcement and retain host results', { skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'fm-required-codex-'))
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'clone', sandbox: 'read-only', mode: null, read: true, write: false, execute: true, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  const sandbox = { cwd, meta: { mode: 'clone', gitdir: '/fixture/git' } }
  const paths = { schemaPath: path.join(cwd, 'schema'), resultPath: path.join(cwd, 'result'), streamPath: path.join(cwd, 'stream') }
  try {
    for (const run of [spawnCodex, resumeCodex]) {
      const handle = await run({ sandbox, enforcement, network: true, prompt: 'fixture', message: 'fixture', sessionId: 'fixture', ...paths })
      const closed = once(handle.child, 'close')
      await handle.sessionId
      assert.equal((await closed)[0], 0)
      await handle.flushed
      const args = JSON.parse(await readFile(`${paths.resultPath}.argv.json`, 'utf8'))
      if (run === spawnCodex) assert.ok(hasPair(args, '-s', 'read-only'), 'runtime spawn requires adjacent -s read-only')
      else assert.ok(hasPair(args, '-c', 'sandbox_mode="read-only"'), 'runtime resume requires adjacent -c sandbox_mode="read-only"')
      assert.ok(!args.includes('--add-dir'))
      assert.ok(!args.some(arg => arg.includes('writable_roots') || arg.includes('network_access=true')))
      assert.equal((await readResult(paths)).status, 'done')
    }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('Codex required network access cannot exceed the host approval on spawn or resume', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'clone', gitdir: '/fixture/git' } }
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'clone', sandbox: 'workspace-write', mode: null, read: true, write: true, execute: true, network: true, sharedRefs: false, publication: false, addWritableRoots: true }
  for (const build of [buildSpawnArgv, buildResumeArgv]) assert.throws(() => build({ sandbox, enforcement, network: false }), /enforcement/i)
})


test('Codex builders refuse a bound required policy with missing enforcement', () => {
  const sandbox = { cwd: '/fixture/repo', meta: { mode: 'clone', prerequisites: { version: 1, rolePolicy: 'policy.json' } } }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    assert.throws(() => build({ sandbox, sessionId: 'fixture' }), /enforcement/i)
  }
})

test('verification broker construction uses host configuration, structured argv and a filtered environment', { skip: process.platform === 'win32' && 'native verification is POSIX-only' }, async () => {
  const module = await import('../scripts/harnesses/codex.mjs')
  assert.equal(typeof module.buildVerificationInvocation, 'function')
  const request = module.buildVerificationInvocation({ executable: '/fixture/codex', broker: '/fixture/broker', home: '/fixture/config', worker: '/fixture/worker', temp: '/fixture/worker/temp', write: true,
    command: 'node', argv: ['-e', 'console.log("fixture")'], env: { PATH: '/usr/bin:/fixture/worker/bin', SECRET: 'dummy', NODE_OPTIONS: '--inspect', GIT_DIR: '/fixture/shared' } })
  assert.equal(request.command, '/usr/bin/env')
  assert.equal(request.cwd, '/fixture/broker')
  assert.ok(request.argv.includes('-i'))
  assert.ok(hasPair(request.argv, '-P', 'worker'))
  assert.ok(hasPair(request.argv, '-C', '/fixture/broker'))
  assert.ok(!request.argv.join('\n').includes('SECRET='))
  assert.ok(!request.argv.join('\n').includes('NODE_OPTIONS='))
  assert.ok(!request.argv.join('\n').includes('GIT_DIR='))
  const payload = JSON.parse(request.argv.at(-1))
  assert.equal(payload.cwd, '/fixture/worker')
  assert.equal(payload.env.TMPDIR, '/fixture/worker/temp')
  assert.equal(payload.env.PATH, '/usr/bin')
  assert.equal(payload.env.HOME, '/fixture/config')
  assert.equal(payload.env.CODEX_HOME, '/fixture/config')
  for (const key of ['SECRET', 'NODE_OPTIONS', 'GIT_DIR']) assert.equal(payload.env[key], undefined)
  assert.deepEqual(payload.argv, ['-e', 'console.log("fixture")'])
  assert.match(request.config, /default_permissions="worker"/)
  assert.match(request.config, /extends=":read-only"/)
  assert.match(request.config, /"\/fixture\/worker"="write"/)
  assert.match(request.config, /":tmpdir"="read"/)
  assert.match(request.config, /":slash_tmp"="read"/)
  assert.match(request.config, /"\/fixture\/broker"="read"/)
  assert.match(request.config, /"\/fixture\/worker\/\.git"="read"/)
  assert.match(request.config, /enabled=false/)
  const readonly = module.buildVerificationInvocation({ executable: '/fixture/codex', broker: '/fixture/broker', home: '/fixture/config', worker: '/fixture/worker', temp: '/fixture/worker/temp', write: false, command: 'true' })
  assert.match(readonly.config, /"\/fixture\/worker"="read"/)
  assert.match(readonly.config, /"\/fixture\/worker"=false/)

})

test('required verification refuses unsupported platforms and network authority', async () => {
  const module = await import('../scripts/harnesses/codex.mjs')
  assert.equal(typeof module.createVerificationExecutor, 'function')
  const sandbox = { cwd: '/fixture/worker', meta: { mode: 'files' } }
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'files', sandbox: 'workspace-write', mode: null, read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  await assert.rejects(module.createVerificationExecutor({ sandbox, enforcement, platform: 'unsupported' }), /unsupported/i)
  await assert.rejects(module.createVerificationExecutor({ sandbox, enforcement: { ...enforcement, network: true }, platform: 'linux' }), /unsupported|enforcement/i)
})

test('required verification rejects a runtime without independent restriction receipts and cleans private files', async () => {
  const { createVerificationExecutor } = await import('../scripts/harnesses/codex.mjs')
  const { mkdir, readdir } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-runtime-refusal-'))
  const worker = path.join(root, 'worker'), bin = path.join(root, 'bin')
  await mkdir(worker); await mkdir(bin)
  await writeFile(path.join(bin, 'codex'), 'dummy'); await chmod(path.join(bin, 'codex'), 0o755)
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'files', sandbox: 'workspace-write', mode: null, read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  let requests = 0, home
  try {
    await assert.rejects(createVerificationExecutor({ sandbox: { cwd: worker, meta: { mode: 'files' } }, enforcement, platform: 'linux', env: { PATH: bin, SECRET: 'dummy' }, run: async (command, cwd, options) => {
      requests++
      assert.equal(command, '/usr/bin/env')
      assert.ok(!cwd.startsWith(worker + path.sep))
      assert.ok(hasPair(options.argv, '-P', 'worker'))
      assert.equal(options.timeoutMs, 6000)
      assert.equal(JSON.parse(options.argv.at(-1)).timeoutMs, 5000)
      assert.equal(options.maxOutputBytes, 65536)
      assert.equal(options.maxCaptureBytes, 65536)
      home = options.argv.find(arg => arg.startsWith('CODEX_HOME=')).slice(11)
      assert.match(await readFile(path.join(home, 'config.toml'), 'utf8'), /extends=":read-only"/)
      assert.equal(JSON.parse(options.argv.at(-1)).env.SECRET, undefined)
      return { code: 0, output: 'unsupported native command; no receipt' }
    } }), /not independently observed/)
    assert.equal(requests, 1)
    assert.deepEqual(await readdir(worker), [])
    await assert.rejects(stat(home), { code: 'ENOENT' })
    await assert.rejects(createVerificationExecutor({ sandbox: { cwd: worker, meta: { mode: 'files' } }, enforcement, platform: 'linux', env: { PATH: worker } }), /unavailable/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function injectedVerification(fn, alter = () => {}) {
  const { createVerificationExecutor } = await import('../scripts/harnesses/codex.mjs')
  const { mkdir } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-injected-receipt-'))
  const worker = path.join(root, 'worker'), bin = path.join(root, 'bin')
  await mkdir(worker); await mkdir(bin)
  await writeFile(path.join(bin, 'codex'), 'dummy', { mode: 0o700 })
  const enforcement = { kind: 'required', harness: 'codex', sandboxMode: 'files', sandbox: 'workspace-write', mode: null, read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false, addWritableRoots: false }
  let executor
  let alterCommand = () => {}
  const factory = () => createVerificationExecutor({ sandbox: { cwd: worker, meta: { mode: 'files' } }, enforcement, platform: 'linux', env: { PATH: bin }, run: async (_command, _cwd, options) => {
    const payload = JSON.parse(options.argv.at(-1))
    const program = payload.argv[1]
    if (!program?.includes('Object.entries(')) {
      const receipt = { code: 0, signal: null, output: '', outputLimited: false, completed: true, runnerCode: 0,
        pipelineCode: 0, pipelineSignal: null, launchError: null, runtimeError: null }
      const result = { code: 0 }
      alterCommand(receipt, result)
      return { output: payload.marker + JSON.stringify(receipt) + '\n', ...result }
    }
    const paths = JSON.parse(program.match(/Object.entries\((\{.*?\})\)/)[1])
    const marker = program.match(/FM_VERIFY_[a-f0-9]+ /)[0]
    await writeFile(paths.inside, 'dummy')
    const observed = { inside: true, outside: false, broker: false, git: false, temporary: false, network: 'EPERM' }
    const receipt = { code: 0, signal: null, output: Buffer.from(marker + JSON.stringify(observed) + '\n').toString('base64'), outputLimited: false,
      completed: true, runnerCode: 0, pipelineCode: 0, pipelineSignal: null, launchError: null, runtimeError: null }
    const result = { code: 0, output: '' }
    const originalOutput = receipt.output
    await alter({ paths, observed, receipt, result, payload, options })
    if (receipt.output === originalOutput) receipt.output = Buffer.from(marker + JSON.stringify(observed) + '\n').toString('base64')
    result.output ||= payload.marker + JSON.stringify(receipt) + '\n'
    return result
  } })
  try { await fn(async () => { executor = await factory(); return executor }, worker, change => { alterCommand = change }) }
  finally { await executor?.close(); await rm(root, { recursive: true, force: true }) }
}

test('injected valid independently checked restriction receipt requires a successful executor', async () => {
  await injectedVerification(async create => {
    const executor = await create()
    assert.equal(executor.evidence.observed, true)
    assert.equal(typeof executor.exec, 'function')
    assert.equal(typeof executor.close, 'function')
  })
})

test('injected executor rejects invalid finite limits before running a command', async () => {
  await injectedVerification(async (create, worker) => {
    const executor = await create()
    for (const key of ['timeoutMs', 'maxOutputBytes']) {
      for (const value of [0, -1, NaN, Infinity, 1.5]) {
        await assert.rejects(executor.exec(process.execPath, worker, { argv: ['-e', ''], [key]: value }), /Invalid verification limits/)
      }
    }
  })
})

test('injected command completion requires successful independently observed runner and pipeline outcomes', async () => {
  await injectedVerification(async (create, worker, change) => {
    const executor = await create()
    for (const alter of [
      receipt => { delete receipt.completed }, receipt => { receipt.completed = false },
      receipt => { delete receipt.runnerCode }, receipt => { receipt.runnerCode = 7 },
      receipt => { delete receipt.pipelineCode }, receipt => { receipt.pipelineCode = 7 },
      receipt => { delete receipt.pipelineSignal }, receipt => { receipt.pipelineSignal = 'SIGTERM' },
      receipt => { delete receipt.launchError }, receipt => { receipt.launchError = 'ENOENT' },
      receipt => { delete receipt.runtimeError }, receipt => { receipt.runtimeError = 'ENOBUFS' },
      receipt => { receipt.timedOut = true },
    ]) {
      change(alter)
      const result = await executor.exec(process.execPath, worker, { argv: ['-e', ''] })
      assert.notEqual(result.code, 0)
      assert.equal(result.completed, false)
    }
  })
})

test('injected command receipts reject malformed exit, signal and output observations', async () => {
  await injectedVerification(async (create, worker, change) => {
    const executor = await create()
    for (const alter of [
      receipt => { receipt.code = -1 }, receipt => { receipt.code = 256 }, receipt => { receipt.code = 1.5 },
      receipt => { receipt.output = null }, receipt => { receipt.outputLimited = null },
      receipt => { delete receipt.signal },
      receipt => { receipt.signal = 'invented' }, receipt => { receipt.signal = 'SIGTERM'; receipt.code = 0 },
      receipt => { receipt.signal = ['SIGTERM']; receipt.code = 143 },
      receipt => { receipt.output = Buffer.from('x'.repeat(33)).toString('base64') },
      receipt => { receipt.output = Buffer.from('x'.repeat(34)).toString('base64') },
    ]) {
      change(alter)
      const result = await executor.exec(process.execPath, worker, { argv: ['-e', ''], maxOutputBytes: 32 })
      assert.equal(result.code, 1)
      assert.match(result.output, /receipt is (missing|invalid)/)
    }
    change(receipt => { receipt.output = Buffer.from('x'.repeat(32)).toString('base64') })
    assert.equal((await executor.exec(process.execPath, worker, { argv: ['-e', ''], maxOutputBytes: 32 })).output.length, 32)
    change(receipt => { receipt.output = Buffer.from('x'.repeat(32769)).toString('base64') })
    assert.equal((await executor.exec(process.execPath, worker, { argv: ['-e', ''], maxOutputBytes: 65536 })).code, 1)
  })
})

for (const [name, alter] of [
  ['missing command receipt', ({ result }) => { result.output = 'no receipt' }],
  ['malformed command receipt', ({ result, payload }) => { result.output = payload.marker + '{' }],
  ['incomplete command receipt', ({ receipt }) => { delete receipt.code }],
  ['limited command receipt', ({ receipt }) => { receipt.outputLimited = true }],
  ['failed command receipt', ({ receipt }) => { receipt.code = 9 }],
  ['noncanonical output encoding', ({ receipt }) => { receipt.output += '!' }],
  ['oversized receipt output', ({ receipt }) => { receipt.output = Buffer.concat([Buffer.from(receipt.output, 'base64'), Buffer.alloc(32768, 32)]).toString('base64') }],
  ['missing inside file', async ({ paths }) => { await rm(paths.inside) }],
  ['observed inside denial', ({ observed }) => { observed.inside = false }],
  ...['outside', 'broker', 'git', 'temporary'].map(key => [`observed ${key} write`, ({ observed }) => { observed[key] = true }]),
  ...['outside', 'broker', 'git', 'temporary'].map(key => [`actual ${key} write`, async ({ paths }) => { await writeFile(paths[key], 'dummy') }]),
  ['network allowed', ({ observed }) => { observed.network = 'allowed' }],
]) test(`injected restriction fixture rejects ${name}`, { skip: process.platform === 'win32' && 'native verification is POSIX-only' }, async () => {
  await injectedVerification(async create => { await assert.rejects(create(), /not independently observed/) }, alter)
})

test('verification trampoline preserves child exits and bounded output without claiming confinement', { skip: process.platform === 'win32' }, async () => {
  const { buildVerificationInvocation } = await import('../scripts/harnesses/codex.mjs')
  const { defaultExec } = await import('../scripts/gate-runner.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-trampoline-'))
  try {
    const invoke = async (source, { innerTimeoutMs = 5000 } = {}) => {
      const request = buildVerificationInvocation({ executable: '/fixture/codex', broker: root, home: root, worker: root, temp: root, write: false,
        command: process.execPath, argv: ['-e', source], env: { PATH: process.env.PATH }, marker: 'fixture-receipt ', maxOutputBytes: 32, timeoutMs: innerTimeoutMs })
      const result = await defaultExec(process.execPath, root, { argv: request.argv.slice(-3), timeoutMs: innerTimeoutMs + 5000, maxOutputBytes: 4096 })
      assert.equal(result.code, 0)
      assert.ok(result.output.startsWith('fixture-receipt '), result.output)
      return JSON.parse(result.output.slice('fixture-receipt '.length))
    }
    const failed = await invoke('require("node:fs").writeSync(1,"fixture");process.exit(9)')
    assert.equal(failed.code, 9)
    assert.equal(Buffer.from(failed.output, 'base64').toString(), 'fixture')
    assert.equal(failed.outputLimited, false)
    const consoleOutput = await invoke('console.log("stdout");console.error("stderr")')
    assert.equal(Buffer.from(consoleOutput.output, 'base64').toString(), 'stdout\nstderr\n')
    const boundary = await invoke('process.stdout.write("x".repeat(32))')
    assert.equal(Buffer.from(boundary.output, 'base64').length, 32)
    assert.equal(boundary.outputLimited, false)
    const limited = await invoke('require("node:fs").writeSync(1,"x".repeat(100))')
    assert.equal(limited.outputLimited, true)
    assert.ok(Buffer.from(limited.output, 'base64').length <= 32)
    const overflow = await invoke('require("node:fs").writeSync(1,"x".repeat(100000))')
    assert.equal(overflow.outputLimited, true)
    assert.ok(Buffer.from(overflow.output, 'base64').length <= 32)
    if (process.platform !== 'win32') {
      const signalled = await invoke('process.kill(process.pid,"SIGTERM")')
      assert.equal(signalled.code, 143)
      assert.equal(signalled.signal, 'SIGTERM')
    }
    // The INNER bound (the trampoline's own timer) is the one under test, so the outer bound stays
    // larger: an outer kill reaches only the trampoline, never the detached command group.
    const token = leakToken()
    const timedOut = await invoke(`setInterval(()=>{},1000)//${token}`, { innerTimeoutMs: 200 })
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.completed, false)
    assert.notEqual(timedOut.code, 0)
    assert.deepEqual(await survivorsAfter(() => processesWith(token)), [])
  } finally { await rm(root, { recursive: true, force: true }); reapToken(leakTokens) }
})

// --- verification trampoline termination from outside (execution recovery audit T2) ------------

// Every fixture command carries a unique token in its own argv, so `pgrep -f` finds the command,
// its runner and its shells, and nothing any other test or run started.
const leakTokens = []
function leakToken() { const token = `fm-leak-${randomBytes(8).toString('hex')}`; leakTokens.push(token); return token }
function pgrep(args) { return spawnSync('pgrep', args, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean) }
function processesWith(token) { return pgrep(['-f', token]) }
// Waits up to `ms` for `list` to come back empty (a SIGKILL is delivered, not instant), then returns it.
async function survivorsAfter(list, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    const left = list()
    if (left.length === 0 || Date.now() > deadline) return left
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
// Cleanup for a failing run, so a red test does not leave its own leak behind for the next one.
function reapToken(tokens) { for (const token of tokens.splice(0)) spawnSync('pkill', ['-KILL', '-f', token]) }

async function startedTrampoline(root, { innerTimeoutMs = 30000 } = {}) {
  const { buildVerificationInvocation } = await import('../scripts/harnesses/codex.mjs')
  const token = leakToken()
  const ready = path.join(root, 'ready')
  const source = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)//${token}`
  const request = buildVerificationInvocation({ executable: '/fixture/codex', broker: root, home: root, worker: root, temp: root, write: true,
    command: process.execPath, argv: ['-e', source], env: { PATH: process.env.PATH }, marker: 'fixture-outside ', timeoutMs: innerTimeoutMs })
  return { token, ready, argv: request.argv.slice(-3) }
}

async function commandGroup(ready) {
  let pid = ''
  const deadline = Date.now() + 5000
  while (!pid && Date.now() < deadline) {
    pid = await readFile(ready, 'utf8').catch(() => '')
    if (!pid) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(pid, 'the fixture command never started')
  const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).stdout.trim()
  assert.match(pgid, /^\d+$/)
  return pgid
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`verification trampoline terminated by ${signal} from outside leaves no process of its command group`, { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fm-outside-'))
    let pgid
    try {
      const { token, ready, argv } = await startedTrampoline(root)
      const trampoline = spawn(process.execPath, argv, { cwd: root, stdio: 'ignore' })
      const exited = once(trampoline, 'exit')
      pgid = await commandGroup(ready)
      // The command runs in its own group, so a signal to the trampoline alone never reaches it.
      assert.notEqual(pgid, String(trampoline.pid))
      assert.ok(pgrep(['-g', pgid]).length > 0)
      trampoline.kill(signal)
      // The handler exits with 128+signal itself, so the exit is a code, not a signal death.
      assert.deepEqual(await exited, [128 + osConstants.signals[signal], null])
      assert.deepEqual(await survivorsAfter(() => pgrep(['-g', pgid])), [])
      assert.deepEqual(await survivorsAfter(() => processesWith(token)), [])
    } finally {
      if (pgid) spawnSync('kill', ['-KILL', '--', `-${pgid}`])
      reapToken(leakTokens)
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('an outer timeout shorter than the trampoline\'s own leaves no process of the command group', { skip: process.platform === 'win32' }, async () => {
  const { defaultExec } = await import('../scripts/gate-runner.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-outer-timeout-'))
  let pgid
  try {
    const { token, ready, argv } = await startedTrampoline(root, { innerTimeoutMs: 5000 })
    const pending = defaultExec(process.execPath, root, { argv, timeoutMs: 1000, graceMs: 500, maxOutputBytes: 4096 })
    pgid = await commandGroup(ready)
    const result = await pending
    assert.equal(result.timedOut, true)
    assert.deepEqual(await survivorsAfter(() => pgrep(['-g', pgid])), [])
    assert.deepEqual(await survivorsAfter(() => processesWith(token)), [])
  } finally {
    if (pgid) spawnSync('kill', ['-KILL', '--', `-${pgid}`])
    reapToken(leakTokens)
    await rm(root, { recursive: true, force: true })
  }
})

async function completionFixture({ timeoutMs = 5000, command = process.execPath, source = '', runnerSource = null, missingSink = false,
  missingShell = false, missingRunnerStatus = false, incompleteRunner = false, terminatedShell = false,
  runnerExit = null, terminatedRunnerAfterObservation = false } = {}) {
  const { buildVerificationInvocation } = await import('../scripts/harnesses/codex.mjs')
  const { defaultExec } = await import('../scripts/gate-runner.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-completion-'))
  try {
    const request = buildVerificationInvocation({ executable: '/fixture/codex', broker: root, home: root, worker: root,
      temp: root, write: false, command, argv: ['-e', source], marker: 'fixture-completion ', maxOutputBytes: 32, timeoutMs })
    const argv = request.argv.slice(-3)
    if (runnerSource !== null || incompleteRunner || runnerExit !== null || terminatedRunnerAfterObservation) {
      const literal = argv[1].match(/process.execPath,'-e',("(?:\\.|[^"\\])*"),JSON.stringify\(r\)/)?.[1]
      assert.ok(literal, 'fixture must locate the trusted runner program')
      runnerSource ??= JSON.parse(literal)
      if (incompleteRunner) runnerSource = runnerSource.replace('completed:!child.error&&(Number.isInteger(child.status)||child.signal!==null)', 'completed:false')
      if (runnerExit !== null) runnerSource += `\nprocess.exitCode=${runnerExit};`
      if (terminatedRunnerAfterObservation) runnerSource += "\nprocess.kill(process.pid,'SIGTERM');"
      argv[1] = argv[1].replace(literal, JSON.stringify(runnerSource))
    }
    if (missingSink) argv[1] = argv[1].replace('/bin/cat', '/fm-missing-sink')
    if (missingShell) argv[1] = argv[1].replace("cp.spawn('/bin/sh'", "cp.spawn('/fm-missing-shell'")
    if (missingRunnerStatus) argv[1] = argv[1].replace(/printf "%s\\n" "\$status" >&4;/, ':;')
    if (terminatedShell) argv[1] = argv[1].replace(/'-c','[^']*'/, () => "'-c','kill -TERM $$'")
    const result = await defaultExec(process.execPath, root, { argv, timeoutMs: 5000, maxOutputBytes: 4096 })
    assert.equal(result.code, 0, result.output)
    assert.ok(result.output.startsWith('fixture-completion '), result.output)
    return JSON.parse(result.output.slice('fixture-completion '.length))
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const [name, fixture, expected] of [
  ['missing runner receipt', { runnerSource: 'process.exit(0)' }, { runnerCode: 0, pipelineCode: 0 }],
  ['missing runner wait status', { missingRunnerStatus: true }, { runnerCode: null, pipelineCode: 0 }],
  ['incomplete runner observation', { incompleteRunner: true }, { runnerCode: 0, pipelineCode: 0 }],
  ['failed runner', { runnerSource: 'process.exit(7)' }, { runnerCode: 7, pipelineCode: 0 }],
  ['failed runner after ordinary command observation', { runnerExit: 7 }, { runnerCode: 7, pipelineCode: 0 }],
  ['terminated runner after ordinary command observation', { terminatedRunnerAfterObservation: true }, { runnerCode: 143, pipelineCode: 0 }],
  ['terminated runner', { runnerSource: "process.kill(process.pid,'SIGTERM')" }, { runnerCode: 143, pipelineCode: 0 }],
  ['command launch error', { command: '/fm-missing-command' }, { runnerCode: 1, pipelineCode: 0, launchError: 'ENOENT' }],
  ['pipeline sink launch error', { missingSink: true }, { pipelineCode: 127 }],
  ['pipeline shell launch error', { missingShell: true }, { pipelineCode: null, runtimeError: 'ENOENT' }],
  ['terminated pipeline shell', { terminatedShell: true }, { pipelineCode: null, pipelineSignal: 'SIGTERM', signal: 'SIGTERM', code: 143 }],
]) test(`ordinary completion fixture rejects ${name}`, { skip: process.platform === 'win32' }, async () => {
  const receipt = await completionFixture(fixture)
  assert.notEqual(receipt.code, 0)
  assert.equal(receipt.completed, false)
  for (const [key, value] of Object.entries(expected)) assert.equal(receipt[key], value)
})

test('ordinary completion fixture observes successful runner and pipeline termination separately from command output', { skip: process.platform === 'win32' }, async () => {
  const receipt = await completionFixture({ source: "console.log('ordinary');process.exitCode=9" })
  assert.equal(receipt.completed, true)
  assert.equal(receipt.code, 9)
  assert.equal(receipt.signal, null)
  assert.equal(receipt.runnerCode, 0)
  assert.equal(receipt.pipelineCode, 0)
  assert.equal(receipt.pipelineSignal, null)
  assert.equal(receipt.launchError, null)
  assert.equal(receipt.runtimeError, null)
  assert.equal(Buffer.from(receipt.output, 'base64').toString(), 'ordinary\n')
})


test('ordinary timeout retains bounded partial stdout and stderr with incomplete completion', { skip: process.platform === 'win32' }, async () => {
  const receipt = await completionFixture({ timeoutMs: 500, source: "require('fs').writeSync(1,'started stdout\\n');require('fs').writeSync(2,'started stderr\\n');setInterval(()=>{},1000)" })
  assert.equal(Buffer.from(receipt.output, 'base64').toString(), 'started stdout\nstarted stderr\n')
  assert.equal(receipt.timedOut, true)
  assert.equal(receipt.completed, false)
  assert.equal(receipt.code, 137)
  assert.equal(receipt.signal, 'SIGKILL')
  assert.equal(receipt.runtimeError, 'ETIMEDOUT')
  assert.equal(receipt.outputLimited, false)
})


test('injected outer execution failures remain incomplete and nonzero while retaining captured output', async () => {
  await injectedVerification(async (create, worker, change) => {
    const executor = await create()
    for (const observation of [{ code: 9 }, { code: 0, timedOut: true }, { code: 0, outputLimited: true }]) {
      change((_receipt, result) => Object.assign(result, observation, { output: 'partial outer output' }))
      const result = await executor.exec(process.execPath, worker, { argv: ['-e', ''] })
      assert.equal(result.completed, false)
      assert.notEqual(result.code, 0)
      assert.equal(result.output, 'partial outer output')
      if (observation.code) assert.equal(result.code, observation.code)
    }
  })
})

test('ordinary pipeline timeout stops its own delayed child fixture', { skip: process.platform === 'win32' }, async () => {
  const { buildVerificationInvocation } = await import('../scripts/harnesses/codex.mjs')
  const { defaultExec } = await import('../scripts/gate-runner.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-timeout-child-'))
  try {
    const late = path.join(root, 'late')
    const program = `require('fs').writeSync(1,'started\\n');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'late effect'),800)`
    const request = buildVerificationInvocation({ executable: '/fixture/codex', broker: root, home: root, worker: root, temp: root, write: true,
      command: process.execPath, argv: ['-e', program], marker: 'fixture-timeout ', timeoutMs: 200 })
    const result = await defaultExec(process.execPath, root, { argv: request.argv.slice(-3), timeoutMs: 3000, maxOutputBytes: 4096 })
    assert.equal(result.code, 0, result.output)
    const receipt = JSON.parse(result.output.slice('fixture-timeout '.length))
    assert.equal(Buffer.from(receipt.output, 'base64').toString(), 'started\n')
    assert.equal(receipt.timedOut, true)
    assert.equal(receipt.completed, false)
    await new Promise(resolve => setTimeout(resolve, 900))
    await assert.rejects(stat(late), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

// --- explicit model/effort and bounded capture (execution recovery T8) ------------------------

// A model or effort reaches codex as its own argv element, `-m <model>` and
// `-c model_reasoning_effort=<effort>`. Anything that is not one bounded token is refused before a
// process exists: a leading dash reads as a flag, and a comma or quote would change what the `-c`
// value means. The accepted spellings still carry `--disable hooks`.
test('codex argv builders refuse model and effort values that are not single bounded tokens and keep hooks disabled', () => {
  const sandbox = { cwd: '/fixture/worker', meta: { mode: 'full' } }
  const base = { sandbox, schemaPath: '/fixture/s.json', resultPath: '/fixture/r.json', sessionId: 'fixture-session' }
  for (const build of [buildSpawnArgv, buildResumeArgv]) {
    for (const model of ['-m', '--dangerously-bypass-approvals-and-sandbox', 'gpt 5', 'gpt"5', 'a\nb', 'x'.repeat(200)]) {
      assert.throws(() => build({ ...base, model }), /model/i, `${build.name} accepted model ${JSON.stringify(model)}`)
    }
    for (const effort of ['high,sandbox_mode="danger-full-access"', '-c', 'HIGH', 'a b', 'x'.repeat(40)]) {
      assert.throws(() => build({ ...base, effort }), /effort/i, `${build.name} accepted effort ${JSON.stringify(effort)}`)
    }
    const argv = build({ ...base, model: 'gpt-5.1-codex', effort: 'xhigh' })
    assert.ok(hasPair(argv, '--disable', 'hooks'))
    assert.ok(hasPair(argv, '-m', 'gpt-5.1-codex'))
    assert.ok(hasPair(argv, '-c', 'model_reasoning_effort=xhigh'))
  }
})

test('spawnCodex stops an oversized stream, kills the process and reports the capture as limited', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-flood-'))
  try {
    // 1000-byte chunks, so the bound is crossed inside the stream rather than by one huge chunk.
    await withEnv({ FAKE_CODEX_FLOOD: '1', FAKE_CODEX_FLOOD_CHUNK: '1000' }, async () => {
      const streamPath = path.join(cwd, 'T1.jsonl')
      const handle = await spawnCodex({
        sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'flood', maxStreamBytes: 4096,
        schemaPath: path.join(cwd, 'T1.schema.json'), resultPath: path.join(cwd, 'T1.json'), streamPath, errPath: path.join(cwd, 'T1.err'),
      })
      const exited = once(handle.child, 'exit')
      assert.equal(await handle.sessionId, 'thread-fixture-1')
      const [, signal] = await exited
      await handle.flushed
      assert.equal(signal, 'SIGKILL')
      assert.equal(handle.outputLimited, true)
      const size = (await stat(streamPath)).size
      assert.equal(size, 4096, 'the stream file holds exactly what fit within its bound')
      assert.equal(await readResult({ resultPath: path.join(cwd, 'T1.json') }), null)
    })
    // stderr draws on the same budget: a flood there stops the process just the same.
    await withEnv({ FAKE_CODEX_FLOOD: '1', FAKE_CODEX_FLOOD_CHUNK: '1000', FAKE_CODEX_FLOOD_STREAM: 'stderr' }, async () => {
      const streamPath = path.join(cwd, 'T2.jsonl'), errPath = path.join(cwd, 'T2.err')
      const handle = await spawnCodex({
        sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'flood', maxStreamBytes: 4096,
        schemaPath: path.join(cwd, 'T2.schema.json'), resultPath: path.join(cwd, 'T2.json'), streamPath, errPath,
      })
      const exited = once(handle.child, 'exit')
      await handle.sessionId
      const [, signal] = await exited
      await handle.flushed
      assert.equal(signal, 'SIGKILL')
      assert.equal(handle.outputLimited, true)
      assert.equal((await stat(streamPath)).size + (await stat(errPath)).size, 4096, 'stdout and stderr share one budget')
    })
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('spawnCodex exposes a flushed promise and an unlimited capture for an ordinary run', { timeout: 10000, skip: WIN32_FAKE_SKIP }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tm-codex-flushed-'))
  try {
    const streamPath = path.join(cwd, 'T1.jsonl')
    const handle = await spawnCodex({
      sandbox: { cwd, meta: { mode: 'full' } }, prompt: 'ordinary',
      schemaPath: path.join(cwd, 'T1.schema.json'), resultPath: path.join(cwd, 'T1.json'), streamPath, errPath: path.join(cwd, 'T1.err'),
    })
    const exited = once(handle.child, 'exit')
    await handle.sessionId
    await exited
    assert.ok(handle.flushed instanceof Promise, 'codex handles must carry a flushed promise like cursor handles')
    await handle.flushed
    assert.equal(handle.outputLimited, false)
    assert.match(await readFile(streamPath, 'utf8'), /turn\.completed/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('readResult refuses a result file larger than its bound rather than parsing it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-big-'))
  try {
    const resultPath = path.join(dir, 'T1.json')
    const result = (summary) => JSON.stringify({ status: 'done', branch: 'fleetmates/r1/T1', filesChanged: [], summary, blockers: [] })
    await writeFile(resultPath, result('x'.repeat(1024 * 1024)))
    assert.equal(await readResult({ resultPath }), null)
    await writeFile(resultPath, result('within bound'))
    assert.equal((await readResult({ resultPath })).summary, 'within bound')
    // Not followed through a symlink, even to a valid result.
    const linked = path.join(dir, 'T2.json')
    await symlink(resultPath, linked)
    assert.equal(await readResult({ resultPath: linked }), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readResult without O_NOFOLLOW still refuses a symlinked result file and reads a regular one', async () => {
  // `noFollow: null` forces the path win32 takes, where O_NOFOLLOW is undefined.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-nofollow-'))
  try {
    const resultPath = path.join(dir, 'T1.json')
    await writeFile(resultPath, JSON.stringify({ status: 'done', branch: 'fleetmates/r1/T1', filesChanged: [], summary: 'within bound', blockers: [] }))
    assert.equal((await readResult({ resultPath, noFollow: null })).summary, 'within bound')
    const linked = path.join(dir, 'T2.json')
    await symlink(resultPath, linked)
    assert.equal(await readResult({ resultPath: linked, noFollow: null }), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('readResult without O_NOFOLLOW refuses a result file replaced between its lstat and its open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-codex-swap-'))
  try {
    const resultPath = path.join(dir, 'T1.json')
    const result = (summary) => JSON.stringify({ status: 'done', branch: 'fleetmates/r1/T1', filesChanged: [], summary, blockers: [] })
    await writeFile(resultPath, result('seen by lstat'))
    const other = path.join(dir, 'other.json')
    await writeFile(other, result('swapped in'))
    // A different regular file renamed over the path after lstat: the opened handle is not the file lstat saw.
    const beforeOpen = () => rename(other, resultPath)
    assert.equal(await readResult({ resultPath, noFollow: null, beforeOpen }), null)
    assert.match(await readFile(resultPath, 'utf8'), /swapped in/, 'the swap ran, so null is the dev/ino refusal')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
