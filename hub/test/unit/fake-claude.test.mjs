import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { fakeBin } from '../helpers/fake-bin.mjs'
import {
  acceptTrust, captureSettings, CAPTURE_TEST, childEnv, CMD, createRedactor, LONG_CMD, option2Rule, PROMPTS,
  readAccount, redactTokens, REDACTIONS, STEP_ORDER
} from '../capture/capture-cc.mjs'

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

test('redaction: a run with one 40+ char secret piece is redacted whole, leading / included', () => {
  assert.equal(redactTokens('GET /v1/keys/ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0 done'), 'GET REDACTED done')
  assert.equal(redactTokens('at /Q2xhdWRlQ29kZVNlY3JldFRva2VuVmFsdWUxMjM0/NTY3 x'), 'at REDACTED x')
})

test('redaction: token runs split by escape sequences are redacted, the escapes kept', () => {
  const { redactText } = redactorFor()
  const split = 'sk-ant-api03-AbCdEfGhIjKlMnOp\x1b[39mQrStUvWxYz0123456789_abcdefghijk\x1b[2Clmnopqrstuvwxyz'
  assert.equal(redactText(`key ${split} end`), 'key REDACTED\x1b[39m\x1b[2C end')
  assert.equal(redactText('\x1b[1mplain words\x1b[0m'), '\x1b[1mplain words\x1b[0m')
})

test('redaction: the account email, display name and org become placeholders, username any case', () => {
  const { redactText } = createRedactor({
    repo: '/tmp/deck-capture-repo-Ab12Cd',
    home: '/var/lib/u1000',
    user: 'alice',
    account: { emailAddress: 'Alice.Smith@Example.org', displayName: 'Alice Smith', organizationName: 'Acme Research' }
  })
  assert.equal(
    redactText('alice.smith@example.org | Alice Smith | ACME RESEARCH | Alice | ALICE'),
    'you@example.com | You | Example Org | you | you')
})

test('redaction: readAccount takes oauthAccount from <home>/.claude.json, else nothing', async () => {
  const t = await tempDir('deck-capture-account-')
  try {
    assert.deepEqual(await readAccount(t.dir), {})
    await writeFile(path.join(t.dir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.example', displayName: 'Ann', organizationName: 'Org X', accountUuid: 'u' }
    }))
    assert.deepEqual(await readAccount(t.dir), { emailAddress: 'a@b.example', displayName: 'Ann', organizationName: 'Org X' })
  } finally {
    await t.cleanup()
  }
})

test('redaction: MANIFEST.redactions names every rule pinned above', () => {
  for (const want of [/\$HOME -> \/home\/you/, /session ids -> fixed ULIDs/, /transcript_path ->/, /JWTs/, /token-like runs/, /email/, /display name/, /organization/]) {
    assert.ok(REDACTIONS.some(r => want.test(r)), String(want))
  }
})

/**
 * Put a stub `claude` first on PATH: `--version` prints 2.1.282, anything else appends
 * `hookLine` to $CAPTURE_OUT/hooks.jsonl and exits 0.
 * @param {string} dir
 * @param {string} hookLine
 */
async function captureStub (dir, hookLine) {
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const js = path.join(bin, 'stub.mjs')
  await writeFile(js, [
    "import { appendFileSync } from 'node:fs'",
    "if (process.argv.includes('--version')) { process.stdout.write('2.1.282 (Claude Code)\\n'); process.exit(0) }",
    `appendFileSync(process.env.CAPTURE_OUT + '/hooks.jsonl', ${JSON.stringify(hookLine)}.replaceAll('@CWD@', process.cwd()) + '\\n')`
  ].join('\n'))
  await writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 })
  return bin
}

/**
 * Run capture-cc unattended with a fake HOME and TMPDIR under dir.
 * @param {string} dir
 * @param {string} bin
 */
async function runCapture (dir, bin) {
  const home = path.join(dir, 'home')
  const tmp = path.join(dir, 'tmp')
  const out = path.join(dir, 'out')
  await mkdir(home)
  await mkdir(tmp)
  await mkdir(out)
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'alice.smith@example.org', displayName: 'Alice Smith', organizationName: 'Acme Research' }
  }))
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: tmp, CAPTURE_STEP_TIMEOUT_MS: '3000' }
  const result = await new Promise(resolve => {
    execFile(process.execPath, [captureCc, '--unattended', '--out', out], { env, timeout: 60000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })
  return { ...result, home, tmp, out }
}

test('capture-cc past the version gate writes redacted hooks and MANIFEST, leaving no temp dirs', async () => {
  const t = await tempDir('deck-capture-e2e-')
  try {
    const payload = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'abc-123',
      cwd: '@CWD@',
      transcript_path: '/x/abc-123.jsonl',
      banner: 'Alice.Smith@example.org | Alice Smith | Acme Research'
    }
    const bin = await captureStub(t.dir, JSON.stringify({ receivedAt: 1, payload }))
    const run = await runCapture(t.dir, bin)
    assert.equal(run.code, 0, run.stderr)
    const dir = path.join(run.out, 'hooks', '2.1.282')
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'SessionStart.startup.json'), 'utf8')), {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: '01J00000000000000000000001',
      cwd: '/home/you/fixture-repo',
      transcript_path: '/home/you/.claude/projects/fixture/01J00000000000000000000001.jsonl',
      banner: 'you@example.com | You | Example Org'
    })
    const manifest = JSON.parse(await readFile(path.join(dir, 'MANIFEST.json'), 'utf8'))
    assert.equal(manifest.version, '2.1.282')
    assert.deepEqual(manifest.hooks, ['SessionStart.startup.json'])
    assert.deepEqual(await readdir(run.tmp), [], 'no deck-capture-* dirs left behind')
  } finally {
    await t.cleanup()
  }
})

test('capture-cc removes its temp dirs when the capture throws', async () => {
  const t = await tempDir('deck-capture-throw-')
  try {
    const bin = await captureStub(t.dir, '{ not json')
    const run = await runCapture(t.dir, bin)
    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /SyntaxError/)
    assert.deepEqual(await readdir(run.tmp), [], 'no deck-capture-* dirs left behind')
  } finally {
    await t.cleanup()
  }
})

/**
 * A trust dialog laid out as 2.1.282 renders it, with the ❯ marker on `selected`.
 * Test stimulus for the startup step, not a captured frame.
 * @param {'no' | 'yes'} selected
 */
const trustDialog = selected => [
  '\x1b[2J\x1b[H',
  'Accessing workspace:\r\n\r\n',
  'Quick safety check: Is this a project you created or one you trust?\r\n\r\n',
  `${selected === 'no' ? '❯' : ' '} No, exit\r\n`,
  `${selected === 'yes' ? '❯' : ' '} Yes, I trust this folder\r\n\r\n`,
  'Enter to confirm · Esc to cancel\r\n'
].join('')

test('capture-cc startup moves ❯ to "Yes, I trust" when the dialog preselects "No, exit"', async () => {
  const t = await tempDir('deck-capture-trust-')
  /** @type {Awaited<ReturnType<typeof fakeBin>> | undefined} */
  let bin
  try {
    const log = path.join(t.dir, 'fake.jsonl')
    const script = path.join(t.dir, 'trust.json')
    await writeFile(script, JSON.stringify({
      steps: [
        { print: trustDialog('no') },
        { expectKey: { '\r': 'enter', B: 'down', A: 'up', timeoutMs: 20000 } },
        {
          branch: {
            enter: [{ exit: { code: 1, stderr: 'declined trust' } }],
            up: [{ exit: { code: 1, stderr: 'moved away from Yes' } }],
            down: [
              { print: trustDialog('yes') },
              { expectKey: { '\r': 'enter', B: 'down', A: 'up', timeoutMs: 20000 } },
              {
                branch: {
                  enter: [{ hook: 'SessionStart', with: { source: 'startup' } }, { print: '> \r\n' }, { sleep: 500 }, { exit: { code: 0 } }],
                  down: [{ exit: { code: 1, stderr: 'moved past Yes' } }],
                  up: [{ exit: { code: 1, stderr: 'moved back to No' } }]
                }
              }
            ]
          }
        }
      ]
    }))
    bin = await fakeBin({ script, log })
    const home = path.join(t.dir, 'home')
    const tmp = path.join(t.dir, 'tmp')
    const out = path.join(t.dir, 'out')
    for (const d of [home, tmp, out]) await mkdir(d)
    const env = { ...bin.env, HOME: home, TMPDIR: tmp, FAKE_CLAUDE_FIXTURES: path.join(t.dir, 'fixtures'), CAPTURE_STEP_TIMEOUT_MS: '5000' }
    const run = await new Promise(resolve => {
      execFile(process.execPath, [captureCc, '--unattended', '--out', out], { env, timeout: 60000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    })
    assert.equal(run.code, 0, run.stderr)
    const entries = await readLog(log)
    const ready = entries.find(e => e.ready)
    assert.deepEqual(ready?.argv, ['--permission-mode', 'manual'], 'claude is spawned in the prompting permission mode')
    const inputs = entries.filter(e => 'input' in e).map(e => e.input)
    assert.equal(inputs[0], '\x1b[B', 'the first key moves the marker down, not Enter on "No, exit"')
    assert.ok(inputs.includes('\r'), 'Enter confirms once ❯ is on "Yes, I trust"')
    const dir = path.join(out, 'hooks', '2.1.282')
    assert.equal(JSON.parse(await readFile(path.join(dir, 'SessionStart.startup.json'), 'utf8')).source, 'startup')
    const manifest = JSON.parse(await readFile(path.join(dir, 'MANIFEST.json'), 'utf8'))
    assert.ok(!manifest.skipped.some(s => s.step === 'startup'), JSON.stringify(manifest.skipped))
    assert.ok(manifest.frames['trust-folder'], 'the dialog was saved as the trust-folder frame')
  } finally {
    await bin?.cleanup()
    await t.cleanup()
  }
})

test('acceptTrust fails, sending nothing, when no option starts with "Yes, I trust"', async () => {
  /** @type {string[]} */
  const sent = []
  const r = await acceptTrust({ screen: () => '❯ No, exit\n  Maybe later', write: s => { sent.push(s) }, settle: async () => {} })
  assert.match(String(r), /Yes, I trust/)
  assert.deepEqual(sent, [])
})

test('acceptTrust gives up when the marker never reaches "Yes, I trust"', async () => {
  /** @type {string[]} */
  const sent = []
  const r = await acceptTrust({ screen: () => '❯ No, exit\n  Yes, I trust this folder', write: s => { sent.push(s) }, settle: async () => {} })
  assert.notEqual(r, true)
  assert.ok(!sent.includes('\r'), 'never confirms while ❯ is on "No, exit"')
})

test('childEnv drops the parent session variables and keeps the rest', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_PID: '42',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    CLAUDE_CODE_MESSAGING_TOKEN: 't',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
    CLAUDE_CODE_EXECPATH: '/x',
    CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: 'm'
  }
  assert.deepEqual(childEnv(parent), { PATH: '/usr/bin', HOME: '/home/x', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'm' })
})

test('fake claude exits 97 when expectInput times out', async () => {
  const t = await tempDir('deck-fake-97-')
  const script = path.join(t.dir, 's.json')
  await writeFile(script, JSON.stringify({ steps: [{ expectInput: { match: 'never', timeoutMs: 100 } }] }))
  const bin = await fakeBin({ script, log: path.join(t.dir, 'log.jsonl') })
  try {
    const run = runFake({ env: bin.env })
    assert.equal((await run.exited).exitCode, 97)
    assert.match(run.output(), /expectInput timed out after 100 ms/)
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})

test('fake claude exits 98 on -p', async () => {
  const bin = await fakeBin({})
  try {
    const run = runFake({ env: bin.env, args: ['-p', 'x'] })
    assert.equal((await run.exited).exitCode, 98)
    assert.match(run.output(), /no -p/)
  } finally {
    await bin.cleanup()
  }
})

test('fake claude exits 2 on a bad script', async () => {
  const t = await tempDir('deck-fake-2-')
  const script = path.join(t.dir, 'bad.json')
  await writeFile(script, JSON.stringify({ steps: [{ nonsense: true }] }))
  const bin = await fakeBin({ script, log: path.join(t.dir, 'log.jsonl') })
  try {
    const run = runFake({ env: bin.env })
    assert.equal((await run.exited).exitCode, 2)
    assert.match(run.output(), /unknown step/)
  } finally {
    await bin.cleanup()
    await t.cleanup()
  }
})

/** Events from docs/deck/04-integrations.md section 2.1, listed here independently of the script. */
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop',
  'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact', 'PostCompact',
  'WorktreeCreate', 'WorktreeRemove'
]

test('captureSettings asks for Bash, Edit, Write and WebFetch and registers the hook for every event', () => {
  const text = captureSettings('run-hook')
  assert.ok(text.endsWith('\n'))
  const settings = JSON.parse(text)
  assert.deepEqual(settings.permissions, { ask: ['Bash', 'Edit', 'Write', 'WebFetch'] })
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort())
  for (const e of HOOK_EVENTS) {
    assert.deepEqual(settings.hooks[e], [{ hooks: [{ type: 'command', command: 'run-hook', timeout: 10 }] }], e)
  }
  assert.equal(captureSettings('run-hook'), text, 'the same text every call, so bash-2 restores it exactly')
})

test('capture steps: Bash runs node --test, write, webfetch and bash-long follow edit', () => {
  assert.deepEqual(STEP_ORDER, [
    'startup', 'bash-1', 'bash-2', 'bash-3', 'edit', 'write', 'webfetch', 'bash-long',
    'ask', 'question', 'compact', 'clear', 'exit'
  ])
  assert.equal(CMD, 'node --test capture.test.mjs')
  assert.match(LONG_CMD, /^node --test --test-name-pattern="[a-z]{200}" capture\.test\.mjs$/)
  assert.ok(PROMPTS.bash.endsWith(`: ${CMD}`))
  assert.ok(PROMPTS['bash-long'].endsWith(`: ${LONG_CMD}`))
  assert.equal(PROMPTS.write, 'Use the Write tool to create capture-write.txt containing capture. Do nothing else.')
  assert.equal(PROMPTS.webfetch, 'Use the WebFetch tool to fetch https://example.com and reply with its title only.')
})

test('option2Rule keeps only the permissions object, redacted', () => {
  const { redactValue } = redactorFor()
  const settings = JSON.stringify({
    permissions: { allow: ['Bash(node --test:*)', 'Read(/var/lib/u1000/notes)'], ask: ['Bash', 'Edit', 'Write', 'WebFetch'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'CAPTURE_OUT=/tmp/deck-capture-raw-x hook' }] }] }
  })
  assert.deepEqual(option2Rule(settings, redactValue), {
    allow: ['Bash(node --test:*)', 'Read(/home/you/notes)'],
    ask: ['Bash', 'Edit', 'Write', 'WebFetch']
  })
})

test('capture-cc starts claude in a repo with the capture settings and a passing, committed capture.test.mjs', async () => {
  const t = await tempDir('deck-capture-repo-state-')
  try {
    const bin = path.join(t.dir, 'bin')
    await mkdir(bin)
    const dump = path.join(t.dir, 'repo-state.json')
    const js = path.join(bin, 'stub.mjs')
    // The stub records the repo it was started in, runs the Bash steps' command there, and exits.
    await writeFile(js, [
      "import { execFileSync, spawnSync } from 'node:child_process'",
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "if (process.argv.includes('--version')) { process.stdout.write('2.1.282 (Claude Code)\\n'); process.exit(0) }",
      `const run = spawnSync(process.execPath, ${JSON.stringify(CMD.split(' ').slice(1))}, { encoding: 'utf8' })`,
      `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({`,
      "  settings: readFileSync('.claude/settings.local.json', 'utf8'),",
      "  testFile: readFileSync('capture.test.mjs', 'utf8'),",
      "  tracked: execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\\n').filter(Boolean),",
      '  status: run.status',
      '}))'
    ].join('\n'))
    await writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 })
    const run = await runCapture(t.dir, bin)
    assert.equal(run.code, 0, run.stderr)
    const state = JSON.parse(await readFile(dump, 'utf8'))
    const settings = JSON.parse(state.settings)
    assert.deepEqual(settings.permissions, { ask: ['Bash', 'Edit', 'Write', 'WebFetch'] })
    const hookCommand = settings.hooks.Stop[0].hooks[0].command
    assert.equal(state.settings, captureSettings(hookCommand), 'the repo settings are captureSettings output')
    assert.equal(state.testFile, CAPTURE_TEST)
    assert.ok(state.tracked.includes('capture.test.mjs'), JSON.stringify(state.tracked))
    assert.equal(state.status, 0, `${CMD} passes in the throwaway repo`)
    assert.deepEqual(await readdir(run.tmp), [], 'no deck-capture-* dirs left behind')
  } finally {
    await t.cleanup()
  }
})

/**
 * One Bash permission prompt as a fake claude script: wait for the typed prompt, fire
 * PreToolUse and PermissionRequest, show three options, and branch on the key.
 * Test stimulus, not a captured frame.
 * @param {Record<string, string>} keys key -> branch label
 */
const bashPrompt = keys => [
  { expectInput: { match: '\r', timeoutMs: 20000 } },
  { hook: 'PreToolUse', with: { tool_name: 'Bash' } },
  { hook: 'PermissionRequest', with: { tool_name: 'Bash' } },
  { print: '❯ 1. Yes\r\n  2. Yes, and don\'t ask again\r\n  3. No\r\n' },
  { expectKey: { ...keys, timeoutMs: 20000 } }
]

test('capture-cc bash-2 saves the rule option 2 wrote as option2-rule.json, redacted, and lists it in MANIFEST', async () => {
  const t = await tempDir('deck-capture-opt2-')
  /** @type {Awaited<ReturnType<typeof fakeBin>> | undefined} */
  let bin
  try {
    const home = path.join(t.dir, 'home')
    const tmp = path.join(t.dir, 'tmp')
    const out = path.join(t.dir, 'out')
    for (const d of [path.join(home, '.claude'), tmp, out]) await mkdir(d, { recursive: true })
    // Stands in for claude writing its "don't ask again" rule: a user-level CwdChanged hook,
    // fired by the script below only after key 2, adds an allow rule to the repo settings.
    const restored = path.join(t.dir, 'settings-after-bash-2.json')
    const writeRule = path.join(t.dir, 'write-rule.mjs')
    await writeFile(writeRule, [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const file = '.claude/settings.local.json'",
      "const s = JSON.parse(readFileSync(file, 'utf8'))",
      "s.permissions.allow = ['Bash(node --test:*)', `Read(${process.env.HOME}/notes)`]",
      'writeFileSync(file, JSON.stringify(s))'
    ].join('\n'))
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        CwdChanged: [{ hooks: [{ type: 'command', command: `'${process.execPath}' '${writeRule}'`, timeout: 10 }] }],
        // Fired after bash-2 has finished: copies the repo settings out for the restore check.
        WorktreeRemove: [{ hooks: [{ type: 'command', command: `cp .claude/settings.local.json '${restored}'`, timeout: 10 }] }]
      }
    }))
    const script = path.join(t.dir, 'opt2.json')
    const answered = [{ hook: 'PostToolUse', with: { tool_name: 'Bash' } }, { print: 'ok\r\n' }, { hook: 'Stop' }]
    await writeFile(script, JSON.stringify({
      steps: [
        { hook: 'SessionStart', with: { source: 'startup' } },
        { print: '> \r\n' },
        ...bashPrompt({ 1: 'one' }),
        { branch: { one: answered } },
        ...bashPrompt({ 2: 'two' }),
        { branch: { two: [{ hook: 'CwdChanged' }, ...answered] } },
        { sleep: 4000 },
        { hook: 'WorktreeRemove' },
        { exit: { code: 0 } }
      ]
    }))
    bin = await fakeBin({ script, log: path.join(t.dir, 'fake.jsonl') })
    const env = { ...bin.env, HOME: home, TMPDIR: tmp, FAKE_CLAUDE_FIXTURES: path.join(t.dir, 'fixtures'), CAPTURE_STEP_TIMEOUT_MS: '5000' }
    const run = await new Promise(resolve => {
      execFile(process.execPath, [captureCc, '--unattended', '--out', out], { env, timeout: 90000 },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    })
    assert.equal(run.code, 0, run.stderr)
    const dir = path.join(out, 'hooks', '2.1.282')
    const manifest = JSON.parse(await readFile(path.join(dir, 'MANIFEST.json'), 'utf8'))
    for (const s of ['startup', 'bash-1', 'bash-2']) assert.ok(!manifest.skipped.some(k => k.step === s), JSON.stringify(manifest.skipped))
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'option2-rule.json'), 'utf8')), {
      ask: ['Bash', 'Edit', 'Write', 'WebFetch'],
      allow: ['Bash(node --test:*)', 'Read(/home/you/notes)']
    })
    assert.ok(manifest.hooks.includes('option2-rule.json'), JSON.stringify(manifest.hooks))
    assert.deepEqual(manifest.steps, STEP_ORDER)
    const settingsAfter = await readFile(restored, 'utf8')
    const hookCommand = JSON.parse(settingsAfter).hooks.Stop[0].hooks[0].command
    assert.equal(settingsAfter, captureSettings(hookCommand), 'bash-2 restored the exact capture settings')
    assert.deepEqual(await readdir(tmp), [], 'no deck-capture-* dirs left behind')
  } finally {
    await bin?.cleanup()
    await t.cleanup()
  }
})

// Fixture consistency: every captured set under test/fixtures/hooks/<version> keeps its
// MANIFEST true and its hand redactions in place.
const fixturesDir = path.join(hubDir, 'test', 'fixtures')
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Versions that have a hooks/<version>/MANIFEST.json.
 * @returns {Promise<string[]>}
 */
async function capturedVersions () {
  const dirs = await readdir(path.join(fixturesDir, 'hooks')).catch(() => [])
  const out = []
  for (const d of dirs) {
    if (await readFile(path.join(fixturesDir, 'hooks', d, 'MANIFEST.json')).then(() => true, () => false)) out.push(d)
  }
  return out
}

/** Files in hooks/<version> that are not hook payloads. */
const NOT_PAYLOADS = new Set(['MANIFEST.json', 'option2-rule.json'])

/**
 * Assert one captured set under `root` (hooks/<v> and screens/<v>) matches its MANIFEST and keeps
 * its redactions. A recapture merged into an existing set lists its new files in
 * `MANIFEST.recapture.added`, as paths relative to `root`; those count as listed hook files.
 * @param {string} root
 * @param {string} v
 */
async function assertFixtureSet (root, v) {
  const hooksDir = path.join(root, 'hooks', v)
  const screensDir = path.join(root, 'screens', v)
  const manifest = JSON.parse(await readFile(path.join(hooksDir, 'MANIFEST.json'), 'utf8'))
  for (const [name, frame] of Object.entries(manifest.frames ?? {})) {
    const bytes = (await readFile(path.join(screensDir, `${name}.ansi`))).length
    assert.equal(frame.bytes, bytes, `${v} MANIFEST frames.${name}.bytes vs ${name}.ansi`)
  }
  /** @type {string[]} */
  const added = manifest.recapture?.added ?? []
  for (const rel of added) {
    assert.ok(await readFile(path.join(root, rel)).then(() => true, () => false), `${v} MANIFEST recapture.added ${rel} exists`)
  }
  const addedHooks = added.filter(rel => path.dirname(rel) === path.join('hooks', v)).map(rel => path.basename(rel))
  const listed = [...new Set([...manifest.hooks, ...addedHooks])].filter(f => f.endsWith('.json') && !NOT_PAYLOADS.has(f)).sort()
  const hookFiles = (await readdir(hooksDir)).filter(f => f.endsWith('.json') && f !== 'MANIFEST.json').sort()
  const payloadFiles = hookFiles.filter(f => !NOT_PAYLOADS.has(f))
  assert.deepEqual(listed, payloadFiles, `${v} MANIFEST hooks vs files`)
  for (const f of hookFiles) {
    const text = await readFile(path.join(hooksDir, f), 'utf8')
    const payload = JSON.parse(text)
    if (!NOT_PAYLOADS.has(f)) assert.equal(payload.hook_event_name, f.split('.')[0], `${v}/${f} hook_event_name`)
    assert.doesNotMatch(text, UUID_RE, `${v}/${f} holds a UUID`)
    assert.doesNotMatch(text, /\/home\/(?!you\b)/, `${v}/${f} holds a /home/ path other than /home/you`)
  }
  const screenFiles = await readdir(screensDir).catch(() => [])
  for (const [dir, files] of [[hooksDir, await readdir(hooksDir)], [screensDir, screenFiles]]) {
    for (const f of files) {
      const text = (await readFile(path.join(dir, f))).toString('latin1')
      assert.doesNotMatch(text, /deck-capture-repo/, `${v}/${f} holds the throwaway repo name`)
      if (dir !== screensDir) continue
      for (const m of text.matchAll(/claude\.ai\/code\/session_/g)) {
        const at = /** @type {number} */ (m.index) + m[0].length
        assert.equal(text.slice(at, at + 8), 'REDACTED', `${v}/${f} session URL`)
      }
    }
  }
}

test('fixture sets: MANIFEST matches the files and the redactions hold', async () => {
  const versions = await capturedVersions()
  assert.ok(versions.length > 0, 'at least one captured fixture set')
  for (const v of versions) await assertFixtureSet(fixturesDir, v)
})

test('fixture sets: recapture.added lists merged files, and option2-rule.json is not a hook payload', async () => {
  const t = await tempDir('deck-fixture-set-')
  try {
    const hooksDir = path.join(t.dir, 'hooks', '9.9.9')
    await mkdir(hooksDir, { recursive: true })
    await mkdir(path.join(t.dir, 'screens', '9.9.9'), { recursive: true })
    await writeFile(path.join(hooksDir, 'Stop.json'), JSON.stringify({ hook_event_name: 'Stop' }))
    await writeFile(path.join(hooksDir, 'PermissionRequest.Bash.json'), JSON.stringify({ hook_event_name: 'PermissionRequest' }))
    await writeFile(path.join(hooksDir, 'option2-rule.json'), JSON.stringify({ allow: ['Bash(node --test:*)'] }))
    const manifest = {
      hooks: ['Stop.json'],
      frames: {},
      recapture: { added: ['hooks/9.9.9/PermissionRequest.Bash.json', 'hooks/9.9.9/option2-rule.json'] }
    }
    await writeFile(path.join(hooksDir, 'MANIFEST.json'), JSON.stringify(manifest))
    await assertFixtureSet(t.dir, '9.9.9')
    await writeFile(path.join(hooksDir, 'PermissionDenied.Bash.json'), JSON.stringify({ hook_event_name: 'PermissionDenied' }))
    await assert.rejects(assertFixtureSet(t.dir, '9.9.9'), /MANIFEST hooks vs files/, 'a payload listed nowhere fails')
  } finally {
    await t.cleanup()
  }
})
