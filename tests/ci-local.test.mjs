import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLocalCi, decideIf, evaluate, parseEnvFile, shellInvocation, freshHomeEnv } from '../scripts/ci-local.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs')

// ci-local runs the platform simulator, which makes fm-platform-sim-* scratch directories in the
// temp dir; platform-sim.test.mjs counts those in the shared one. This file gets its own, so the
// two never race when the suite runs files in parallel.
const PRIVATE_TMP = mkdtempSync(path.join(tmpdir(), 'fm-ci-local-tmp-'))
process.env.TMPDIR = process.env.TMP = process.env.TEMP = PRIVATE_TMP
after(() => rmSync(PRIVATE_TMP, { recursive: true, force: true }))
const POSIX = process.platform !== 'win32'

async function repo(t, workflows) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-ci-local-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true })
  for (const [name, text] of Object.entries(workflows)) await writeFile(path.join(root, '.github', 'workflows', name), text)
  return root
}

// A spawn seam that records each step and answers with scripted exit codes (0 by default).
function recorder(codes = {}) {
  const calls = []
  const spawnFn = async (inv) => {
    const script = await readFile(inv.args.at(-1), 'utf8').catch(() => null)
    calls.push({ ...inv, script })
    return { code: codes[calls.length] ?? 0 }
  }
  return { calls, spawnFn }
}

const quiet = { write: () => {}, onOutput: () => {} }
const linux = { platform: 'linux', ...quiet }
// The user's own shell, unchanged: what the env and spawn assertions below are about.
const plain = { keepHome: true, platformSim: false }

const MATRIX = `on:
  push:
    branches: ['**']
  pull_request:
env:
  LEVEL: workflow
  SHARED: workflow
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    env:
      SHARED: job
    steps:
      - uses: actions/checkout@v4
      - name: first
        run: |
          echo one # a comment the script keeps
          echo "on \${{ matrix.os }}"
        env:
          STEP: step
      - name: posix only
        if: runner.os != 'Windows'
        run: echo posix
      - name: windows only
        if: runner.os == 'Windows'
        run: echo windows
      - name: secret
        run: echo \${{ secrets.TOKEN }}
      - name: odd if
        if: github.event_name == 'push'
        run: echo odd
  mac:
    runs-on: macos-latest
    steps:
      - run: echo mac
`

test('only the jobs whose runner is this OS run, uses steps and undecidable steps are skipped and named', async (t) => {
  const root = await repo(t, { 'ci.yml': MATRIX })
  const { calls, spawnFn } = recorder()
  const lines = []
  const r = await runLocalCi(root, { ...linux, spawnFn, write: (l) => lines.push(l) })
  assert.equal(r.code, 0)
  assert.deepEqual(calls.map((c) => c.script.trim()), ['echo one # a comment the script keeps\necho "on ubuntu-latest"', 'echo posix'])
  assert.deepEqual(r.skipped.map((s) => s.reason), [
    'uses actions/checkout@v4',
    "if: runner.os == 'Windows' is false here",
    'run uses an expression that cannot be evaluated locally',
    "if: cannot be evaluated locally (github.event_name == 'push')",
  ])
  assert.ok(lines.includes('ci-local: 2 step(s) passed here; 4 skipped, left to the remote CI'), lines.join('\n'))
  assert.ok(!lines.some((l) => l.includes(' mac ')), 'the macOS job does not run on Linux')
})

test('the macOS job runs on macOS, and matrix.os becomes the label that matched', async (t) => {
  const root = await repo(t, { 'ci.yml': MATRIX })
  const { calls, spawnFn } = recorder()
  const r = await runLocalCi(root, { platform: 'darwin', spawnFn, ...quiet })
  assert.equal(r.code, 0)
  assert.deepEqual(calls.map((c) => c.script.trim()), ['echo mac'])
})

test('env is workflow, then job, then step, and with keepHome and no simulator the user environment passes through unchanged', async (t) => {
  const root = await repo(t, { 'ci.yml': MATRIX })
  const { calls, spawnFn } = recorder()
  await runLocalCi(root, { ...linux, ...plain, spawnFn, env: { PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/home/you/.gitconfig' } })
  const env = calls[0].env
  assert.equal(env.LEVEL, 'workflow')
  assert.equal(env.SHARED, 'job')
  assert.equal(env.STEP, 'step')
  assert.equal(env.RUNNER_OS, 'Linux')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/home/you/.gitconfig', 'a runner adds no git config variable, and neither does this')
  assert.equal(calls[1].env.STEP, undefined, 'a step env stays with its step')
})

test('a workflow that runs only on tags is not mirrored: it is a release, not CI', async (t) => {
  const root = await repo(t, { 'release.yml': "on:\n  push:\n    tags: ['v*']\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n" })
  const { calls, spawnFn } = recorder()
  const r = await runLocalCi(root, { ...linux, spawnFn })
  assert.equal(r.code, 3)
  assert.equal(calls.length, 0)
})

test('it stops at the first failing step, exits 1 and runs nothing after it', async (t) => {
  const root = await repo(t, { 'ci.yml': "on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo 1\n      - run: exit 4\n      - run: echo 3\n" })
  const { calls, spawnFn } = recorder({ 2: 4 })
  const lines = []
  const r = await runLocalCi(root, { ...linux, spawnFn, write: (l) => lines.push(l) })
  assert.equal(r.code, 1)
  assert.equal(calls.length, 2)
  assert.match(r.failed, /\[2\] exit 4$/)
  assert.ok(lines.some((l) => /\[2\] exit 4: failed with exit 4/.test(l)), lines.join('\n'))
})

test('nothing to run: no workflow directory, or no job for this OS, is exit 3', async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), 'fm-ci-local-'))
  t.after(() => rm(empty, { recursive: true, force: true }))
  assert.equal((await runLocalCi(empty, linux)).code, 3)
  const root = await repo(t, { 'ci.yml': 'on: [push]\njobs:\n  w:\n    runs-on: windows-latest\n    steps:\n      - run: echo w\n' })
  assert.equal((await runLocalCi(root, { ...linux, spawnFn: recorder().spawnFn })).code, 3)
})

test('a dry run lists what would run and spawns nothing', async (t) => {
  const root = await repo(t, { 'ci.yml': MATRIX })
  const { calls, spawnFn } = recorder()
  const lines = []
  const r = await runLocalCi(root, { ...linux, spawnFn, dryRun: true, write: (l) => lines.push(l) })
  assert.equal(r.code, 0)
  assert.equal(calls.length, 0)
  assert.equal(lines.filter((l) => l.endsWith(': would run')).length, 2)
})

test('working-directory and a job default shell reach the spawn', async (t) => {
  const root = await repo(t, { 'ci.yml': "on: [pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: sh\n        working-directory: sub\n    steps:\n      - run: pwd\n      - run: pwd\n        shell: bash\n        working-directory: other\n" })
  const { calls, spawnFn } = recorder()
  await runLocalCi(root, { ...linux, ...plain, spawnFn })
  assert.deepEqual(calls.map((c) => [c.file, c.cwd]), [['sh', path.join(root, 'sub')], ['bash', path.join(root, 'other')]])
})

test('decideIf, evaluate, parseEnvFile and shellInvocation', () => {
  const ctx = { os: 'linux', temp: '/t', matrixOs: null }
  assert.equal(decideIf("${{ runner.os == 'linux' }}", ctx), true)
  assert.equal(decideIf("runner.os != 'Linux'", ctx), false)
  assert.equal(decideIf('success()', ctx), true)
  assert.equal(decideIf("contains(github.ref, 'x')", ctx), null)
  assert.equal(evaluate('a ${{ runner.temp }} b', ctx), 'a /t b')
  assert.equal(evaluate('${{ matrix.os }}', ctx), null, 'no matrix: matrix.os is not known')
  assert.deepEqual(parseEnvFile('A=1\nB<<EOF\nx\ny\nEOF\nC=a=b\n'), { A: '1', B: 'x\ny', C: 'a=b' })
  assert.equal(shellInvocation(null, 'windows', 'f').file, 'pwsh')
  assert.deepEqual(shellInvocation(null, 'linux', 'f'), { file: 'bash', args: ['-e', 'f'], ext: '.sh' })
  assert.equal(shellInvocation('python', 'linux', 'f'), null)
})

test('with the user HOME, a real run carries GITHUB_ENV and GITHUB_PATH to the next step, and a git config --global write is undone after its step', { skip: !POSIX && 'bash steps' }, async (t) => {
  // The job must name the host's own runner: this test runs its steps for real.
  const runsOn = process.platform === 'darwin' ? 'macos-latest' : 'ubuntu-latest'
  const root = await repo(t, { 'ci.yml': `on: [push]
jobs:
  a:
    runs-on: ${runsOn}
    steps:
      - run: |
          echo "CARRIED=yes" >> "$GITHUB_ENV"
          mkdir -p "$RUNNER_TEMP/bin" && printf '#!/bin/sh\\necho tool-ran\\n' > "$RUNNER_TEMP/bin/fm-tool" && chmod +x "$RUNNER_TEMP/bin/fm-tool"
          echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"
          git config --global user.name "CI"
      - run: |
          test "$CARRIED" = yes
          test "$(fm-tool)" = tool-ran
          test "$(git config --global fm.mark)" = kept
          test "$(git config --global user.name)" = Someone
` })
  const userGlobal = path.join(root, 'user-gitconfig')
  await writeFile(userGlobal, '[fm]\n\tmark = kept\n[user]\n\tname = Someone\n')
  const out = []
  const r = await runLocalCi(root, { platform: process.platform, ...plain, env: { ...process.env, GIT_CONFIG_GLOBAL: userGlobal }, write: (l) => out.push(`${l}\n`), onOutput: (c) => out.push(String(c)) })
  assert.equal(r.code, 0, out.join(''))
  assert.equal(r.ran, 2)
  assert.equal(await readFile(userGlobal, 'utf8'), '[fm]\n\tmark = kept\n[user]\n\tname = Someone\n', 'the user global config is back as it was')
  assert.ok(out.some((l) => l.includes(`changed ${userGlobal}; restored it`)), out.join(''))
})

test('cli ci-local --dry-run lists the steps; a value on --dry-run is refused', async (t) => {
  const root = await repo(t, { 'ci.yml': MATRIX })
  const env = { ...process.env, FLEETMATES_PLATFORM: undefined }
  const r = spawnSync(process.execPath, [CLI, 'ci-local', '--dry-run', '--root', root], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /would run/)
  const bad = spawnSync(process.execPath, [CLI, 'ci-local', '--dry-run=yes', '--root', root], { encoding: 'utf8', env })
  assert.equal(bad.status, 2, bad.stdout + bad.stderr)
})

test('by default a job gets a fresh HOME and the platform simulator, and the workflow env still wins over them', async (t) => {
  const root = await repo(t, { 'ci.yml': "on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      FROM_JOB: job\n    steps:\n      - run: echo 1\n      - run: echo 2\n        env:\n          TMP: from-step\n" })
  const { calls, spawnFn } = recorder()
  const lines = []
  const r = await runLocalCi(root, { platform: 'linux', spawnFn, write: (l) => lines.push(l), onOutput: () => {}, env: { PATH: '/usr/bin', HOME: '/home/you', XDG_CONFIG_HOME: '/home/you/.config', GIT_CONFIG_GLOBAL: '/home/you/.gitconfig' } })
  assert.equal(r.code, 0)
  const env = calls[0].env
  assert.notEqual(env.HOME, '/home/you')
  assert.ok(env.XDG_CONFIG_HOME.startsWith(env.HOME), env.XDG_CONFIG_HOME)
  assert.notEqual(env.GIT_CONFIG_GLOBAL, '/home/you/.gitconfig', 'the simulator owns the global git config')
  assert.match(env.TMPDIR, /sim link/)
  assert.equal(env.FROM_JOB, 'job')
  assert.equal(calls[1].env.TMP, 'from-step', 'a step env overrides the simulated temp dir')
  assert.equal(calls[0].env.HOME, calls[1].env.HOME, 'one HOME per job, kept across its steps')
  assert.equal(calls[0].file, process.execPath, 'the umask trampoline runs the shell')
  assert.ok(lines.some((l) => /runner environment: fresh HOME; platform-sim applied symlinked-tmpdir, space-in-tmpdir, autocrlf, umask-077/.test(l)), lines.join('\n'))
})

test('freshHomeEnv hides the user config and keeps the toolchain directories that exist', () => {
  const real = '/home/you'
  const exists = (p) => [path.join(real, '.local', 'share', 'mise'), path.join(real, '.npm'), path.join(real, '.cargo')].includes(p)
  const env = freshHomeEnv({ HOME: real, PATH: '/bin', XDG_CONFIG_HOME: '/home/you/.config', GIT_CONFIG_GLOBAL: '/x', CARGO_HOME: '/opt/cargo' }, '/scratch/home', { exists })
  assert.equal(env.HOME, '/scratch/home')
  assert.equal(env.XDG_CONFIG_HOME, path.join('/scratch/home', '.config'))
  assert.equal(env.GIT_CONFIG_GLOBAL, undefined)
  assert.equal(env.MISE_DATA_DIR, path.join(real, '.local', 'share', 'mise'))
  assert.equal(env.npm_config_cache, path.join(real, '.npm'))
  assert.equal(env.CARGO_HOME, '/opt/cargo', 'a toolchain variable the user set is kept')
  assert.equal(env.RUSTUP_HOME, undefined, 'a toolchain directory that does not exist is not invented')
  assert.equal(env.PATH, '/bin')
})

test('a real default run does not see the user config, leaves the user git config alone and runs under the simulator', { skip: !POSIX && 'bash steps' }, async (t) => {
  const root = await repo(t, { 'ci.yml': `on: [push]
jobs:
  a:
    runs-on: ${process.platform === 'darwin' ? 'macos-latest' : 'ubuntu-latest'}
    steps:
      - run: |
          test ! -e "$HOME/.config/fm-tool/settings"
          git config --global user.name CI
          test "$(git config user.name)" = CI
          test "$(git config core.autocrlf)" = true
          test "$(cd "$TMPDIR" && pwd -P)" != "$TMPDIR"
          touch "$TMPDIR/probe" && test "$(ls -l "$TMPDIR/probe" | cut -c1-10)" = "-rw-------"
` })
  const userHome = path.join(root, 'user-home')
  await mkdir(path.join(userHome, '.config', 'fm-tool'), { recursive: true })
  await writeFile(path.join(userHome, '.config', 'fm-tool', 'settings'), 'mine\n')
  const userGit = path.join(userHome, '.gitconfig')
  await writeFile(userGit, '[user]\n\tname = Someone\n')
  const out = []
  const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') }
  delete env.GIT_CONFIG_GLOBAL
  const r = await runLocalCi(root, { platform: process.platform, env, write: (l) => out.push(`${l}\n`), onOutput: (c) => out.push(String(c)) })
  assert.equal(r.code, 0, out.join(''))
  assert.equal(await readFile(userGit, 'utf8'), '[user]\n\tname = Someone\n')
  assert.ok(!out.some((l) => l.includes('restored it')), 'nothing of the user was touched, so nothing needed restoring')
})

test('cli ci-local --keep-home and --no-platform-sim each turn their part of the runner environment off', { skip: !POSIX && 'bash steps' }, async (t) => {
  const root = await repo(t, { 'ci.yml': "on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n" })
  const plainRun = spawnSync(process.execPath, [CLI, 'ci-local', '--keep-home', '--no-platform-sim', '--root', root], { encoding: 'utf8' })
  assert.equal(plainRun.status, 0, plainRun.stdout + plainRun.stderr)
  assert.match(plainRun.stdout, /runner environment: this shell, unchanged/)
  const simOnly = spawnSync(process.execPath, [CLI, 'ci-local', '--keep-home', '--root', root], { encoding: 'utf8' })
  assert.match(simOnly.stdout, /runner environment: platform-sim applied/)
  const homeOnly = spawnSync(process.execPath, [CLI, 'ci-local', '--no-platform-sim', '--root', root], { encoding: 'utf8' })
  assert.match(homeOnly.stdout, /runner environment: fresh HOME\n/)
})
