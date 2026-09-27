import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { createRedactor, redactTokens, REDACTIONS } from '../capture/capture-cc.mjs'

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
  const tmp = path.join(t.dir, 'tmp')
  await mkdir(out)
  await mkdir(tmp)
  const bin = await fakeBin({ script: path.join(scriptsDir, 'echo.json'), log, version: '0.0.0' })
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [captureCc, '--unattended', '--out', out], { env: { ...bin.env, TMPDIR: tmp }, timeout: 10000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /0\.0\.0/)
    assert.match(result.stderr, /2\.1\.282/)
    assert.deepEqual(await readdir(out), [])
    assert.deepEqual(await readdir(tmp), [], 'no throwaway repo or raw dir was created')
    assert.deepEqual(await readLog(log), [], 'the fake never started a session')
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})

// Redaction in capture-cc.mjs (docs/deck/09-testing.md section 4). Importing the script
// does not start a capture; these tests run the exported functions directly.
const SESSION_A = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const SESSION_B = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4'
const redactorFor = () => createRedactor({
  repo: '/tmp/deck-capture-repo-Ab12Cd',
  home: '/var/lib/u1000',
  user: 'alice',
  prompts: { bash: 'Run this exact Bash command with the Bash tool and nothing else: echo capture-ok' }
})

test('redaction: $HOME, the throwaway repo and the username become placeholders', () => {
  const { redactText } = redactorFor()
  assert.equal(
    redactText('cwd /tmp/deck-capture-repo-Ab12Cd/notes.txt, config /var/lib/u1000/.claude/settings.json, by alice'),
    'cwd /home/you/fixture-repo/notes.txt, config /home/you/.claude/settings.json, by you')
})

test('redaction: session ids become fixed ULIDs and transcript_path a fixed path', () => {
  const { redactPayload } = redactorFor()
  const a = redactPayload({
    session_id: SESSION_A,
    transcript_path: `/var/lib/u1000/.claude/projects/-tmp-deck-capture-repo-Ab12Cd/${SESSION_A}.jsonl`,
    note: `resumed ${SESSION_A}`
  })
  assert.deepEqual(a, {
    session_id: '01J00000000000000000000001',
    transcript_path: '/home/you/.claude/projects/fixture/01J00000000000000000000001.jsonl',
    note: 'resumed 01J00000000000000000000001'
  })
  assert.equal(redactPayload({ session_id: SESSION_B }).session_id, '01J00000000000000000000002')
  assert.equal(redactPayload({ session_id: SESSION_A }).session_id, '01J00000000000000000000001')
})

test('redaction: typed prompts become "fixture prompt: <step>", nested values included', () => {
  const { redactValue } = redactorFor()
  assert.deepEqual(
    redactValue({ prompt: 'Run this exact Bash command with the Bash tool and nothing else: echo capture-ok', list: ['/var/lib/u1000'] }),
    { prompt: 'fixture prompt: bash', list: ['/home/you'] })
})

test('redaction: token-like runs, standard base64 with / and =, and JWTs become REDACTED', () => {
  const { redactText } = redactorFor()
  const cases = [
    'sk-ant-api03-Zq8xV2mN4bL6kJ9hG1fD3sA5pO7iU0yT2rE4wQ6',
    '0123456789abcdef0123456789abcdef01234567',
    'Q2xhdWRlQ29kZVNlY3JldFRva2VuVmFsdWUxMjM0/NTY3ODkwYWJjZGVmZ2hpams=',
    'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0/xY2zA4bC6dE8fG0hJ1kL3mN5pQ7rS9/tU1vW3xY5zA7bC9dE2fG4hJ6kL==',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  ]
  assert.equal(cases[3].length, 90)
  for (const c of cases) {
    assert.equal(redactText(c), 'REDACTED', c)
    assert.equal(redactText(`"token": "${c}",`), '"token": "REDACTED",', c)
    assert.equal(redactTokens(`Bearer ${c}`), 'Bearer REDACTED', c)
  }
})

test('redaction: ordinary paths and file names are kept', () => {
  const { redactText } = redactorFor()
  const kept = [
    '/home/you/.claude/projects/fixture/01J00000000000000000000001.jsonl',
    '/home/you/.claude/projects/-home-you-work-fixture-repo/01J00000000000000000000001.jsonl',
    'hub/test/fixtures/screens/2.1.282/bash-approval.ansi',
    'transcript at /home/you/.claude/projects/fixture/01J00000000000000000000002.jsonl ok'
  ]
  for (const k of kept) assert.equal(redactText(k), k)
})

test('redaction: MANIFEST.redactions names every rule pinned above', () => {
  for (const want of [/\$HOME -> \/home\/you/, /session ids -> fixed ULIDs/, /transcript_path ->/, /JWTs/, /token-like runs/]) {
    assert.ok(REDACTIONS.some(r => want.test(r)), String(want))
  }
})
