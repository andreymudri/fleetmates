import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { fakeBin } from '../helpers/fake-bin.mjs'

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptsDir = path.join(hubDir, 'test', 'fixtures', 'scripts')
const captureCc = path.join(hubDir, 'test', 'capture', 'capture-cc.mjs')

/**
 * Make a temp dir removed by the returned cleanup.
 * @param {string} prefix
 */
async function tempDir (prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Run the fake `claude` in a PTY through the PATH that fakeBin() builds.
 * @param {{ env: NodeJS.ProcessEnv, args?: string[], cwd?: string, cols?: number, rows?: number }} opts
 */
function runFake ({ env, args = [], cwd = os.tmpdir(), cols = 80, rows = 24 }) {
  const p = pty.spawn('claude', args, { env: /** @type {Record<string, string>} */ (env), cwd, cols, rows, name: 'xterm-256color' })
  let output = ''
  p.onData(d => { output += d })
  /** @type {Promise<{ exitCode: number, signal?: number }>} */
  const exited = new Promise(resolve => p.onExit(resolve))
  return { p, exited, output: () => output }
}

/**
 * Poll until fn returns a truthy value or the timeout passes.
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor (fn, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * Read FAKE_CLAUDE_LOG as parsed JSON lines; missing file reads as empty.
 * @param {string} file
 * @returns {Promise<any[]>}
 */
async function readLog (file) {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

test('claude --version prints FAKE_CLAUDE_VERSION in the real format', async () => {
  const bin = await fakeBin({ version: '9.8.7' })
  try {
    const run = runFake({ env: bin.env, args: ['--version'] })
    const { exitCode } = await run.exited
    assert.equal(exitCode, 0)
    assert.equal(run.output().trim(), '9.8.7 (Claude Code)')
  } finally {
    await bin.cleanup()
  }
})

test('echo.json echoes input bytes and logs every chunk', async () => {
  const t = await tempDir('deck-fake-echo-')
  const log = path.join(t.dir, 'log.jsonl')
  const bin = await fakeBin({ script: path.join(scriptsDir, 'echo.json'), log })
  const run = runFake({ env: bin.env })
  try {
    await waitFor(async () => (await readLog(log)).some(e => e.ready))
    run.p.write('abc')
    await waitFor(() => run.output().includes('abc'))
    run.p.write('xyz')
    await waitFor(() => run.output().includes('xyz'))
    const inputs = await waitFor(async () => {
      const got = (await readLog(log)).filter(e => 'input' in e)
      return got.length >= 2 ? got : null
    })
    assert.equal(inputs.map(e => e.input).join(''), 'abcxyz')
    for (const e of inputs) assert.equal(typeof e.ts, 'number')
  } finally {
    run.p.kill()
    await run.exited
    await bin.cleanup()
    await t.cleanup()
  }
})

test('resize.json logs a resize after pty.resize', async () => {
  const t = await tempDir('deck-fake-resize-')
  const log = path.join(t.dir, 'log.jsonl')
  const bin = await fakeBin({ script: path.join(scriptsDir, 'resize.json'), log })
  const run = runFake({ env: bin.env, cols: 80, rows: 24 })
  try {
    await waitFor(async () => (await readLog(log)).some(e => e.ready))
    run.p.resize(100, 30)
    const entry = await waitFor(async () => (await readLog(log)).find(e => e.resize))
    assert.deepEqual(entry.resize, { cols: 100, rows: 30 })
  } finally {
    run.p.kill()
    await run.exited
    await bin.cleanup()
    await t.cleanup()
  }
})

test('idle.json fires a SessionStart hook from $HOME/.claude/settings.json and exits 0', async () => {
  const t = await tempDir('deck-fake-idle-')
  const home = path.join(t.dir, 'home')
  const cwd = path.join(t.dir, 'repo')
  const got = path.join(t.dir, 'session-start.json')
  await mkdir(path.join(home, '.claude'), { recursive: true })
  await mkdir(cwd)
  const settings = {
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `cat > '${got}'`, timeout: 5 }] }]
    }
  }
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings))
  const log = path.join(t.dir, 'log.jsonl')
  const bin = await fakeBin({ script: path.join(scriptsDir, 'idle.json'), log })
  try {
    const run = runFake({ env: { ...bin.env, HOME: home }, cwd })
    const { exitCode } = await run.exited
    assert.equal(exitCode, 0)
    const payload = JSON.parse(await readFile(got, 'utf8'))
    assert.equal(payload.hook_event_name, 'SessionStart')
    assert.equal(payload.source, 'startup')
    assert.equal(payload.cwd, cwd)
    assert.equal(typeof payload.session_id, 'string')
    assert.equal(typeof payload.transcript_path, 'string')
    const hooks = (await readLog(log)).filter(e => e.hook).map(e => e.hook)
    assert.deepEqual(hooks, ['SessionStart', 'Stop'])
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})

test('a script naming a missing frame exits 96', async () => {
  const t = await tempDir('deck-fake-frame-')
  const script = path.join(t.dir, 'nope.json')
  await writeFile(script, JSON.stringify({ steps: [{ frame: 'nope' }] }))
  const bin = await fakeBin({ script, log: path.join(t.dir, 'log.jsonl') })
  try {
    const run = runFake({ env: bin.env })
    const { exitCode } = await run.exited
    assert.equal(exitCode, 96)
    assert.match(run.output(), /missing frame nope for 2\.1\.282/)
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})

test('capture-cc refuses a claude version other than testedClaudeCode, starting nothing', async () => {
  const t = await tempDir('deck-capture-smoke-')
  const out = path.join(t.dir, 'out')
  const log = path.join(t.dir, 'log.jsonl')
  await mkdir(out)
  const bin = await fakeBin({ script: path.join(scriptsDir, 'echo.json'), log, version: '0.0.0' })
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [captureCc, '--unattended', '--out', out], { env: bin.env, timeout: 10000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /0\.0\.0/)
    assert.match(result.stderr, /2\.1\.282/)
    assert.deepEqual(await readdir(out), [])
    assert.deepEqual(await readLog(log), [], 'the fake never started a session')
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})
