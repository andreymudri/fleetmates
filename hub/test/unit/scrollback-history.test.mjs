// The server stores deckd's serialized history at exit and serves a rendered history from
// `GET /api/sessions/:id/scrollback` (docs/deck/06-storage.md `session_scrollback`).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import xtermHeadless from '@xterm/headless'
import { ScreenModel } from '../../deckd/screen-model.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector, SCROLLBACK_CAP } from '../../server/machines/projector.mjs'
import { createLauncher } from '../../server/launch/launch.mjs'
import { boundCounts, closeSharedRenderer, createHistoryRenderer, fallbackHistory, historySize, newestInput, readStoredHistory, renderHistory, RENDER_INPUT_CAP, RENDER_OUTPUT_CAP, spawnHistoryWorker, stripControls } from '../../server/screen/history.mjs'

const { Terminal } = xtermHeadless

// The shared renderHistory worker is unreferenced; closing it here keeps the file exiting even when a
// test that pins the unref fails.
after(() => closeSharedRenderer())
const fixture = readFileSync(new URL('../fixtures/screens/2.1.282/permission-edit.ansi', import.meta.url))
const hookFixture = new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)

/**
 * Write `data` into a fresh headless terminal and return every buffer row as text.
 * @param {string} data
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<string[]>}
 */
async function render (data, cols, rows, scrollback = 1000) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  try {
    await new Promise((resolve) => term.write(data, () => resolve(undefined)))
    const buf = term.buffer.active
    const out = []
    for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
    return out
  } finally {
    term.dispose()
  }
}

/** The permission-edit fixture as deckd serializes it at 120x40. */
async function serializedFixture () {
  const model = new ScreenModel({ cols: 120, rows: 40 })
  try {
    model.write(fixture)
    await model.flush()
    return model.history()
  } finally {
    model.dispose()
  }
}

/**
 * `text` written into a deckd ScreenModel of `cols` x `rows`, and its history.
 * @param {string} text
 * @param {number} cols
 * @param {number} rows
 */
async function historyOf (text, cols, rows) {
  const model = new ScreenModel({ cols, rows })
  try {
    model.write(text)
    await model.flush()
    return model.history()
  } finally {
    model.dispose()
  }
}

function harness ({ render: renderer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-history-'))
  const file = path.join(dir, 'deck.db')
  const store = openDeckDb(file)
  const projector = createProjector({ store, now: () => 1000 })
  const hook = JSON.parse(readFileSync(hookFixture, 'utf8'))
  const envelope = { v: 1, hook: { ...hook, hook_event_name: 'SessionStart', cwd: dir }, hookTs: 1000, ptyId: 'pty_history', claudePid: null, pidChain: [], truncated: false, receivedAt: 1000, via: 'socket' }
  projector.applyHooks([envelope])
  const id = projector.snapshot().sessions[0].id
  const launcher = createLauncher({ store, projector, preferences: () => ({ prefs: { claudeCommand: 'claude' } }), ...(renderer ? { render: renderer } : {}) })
  return {
    store,
    projector,
    id,
    launcher,
    stored: () => store.get('SELECT text,truncated FROM session_scrollback WHERE session_id=?', id),
    close () { launcher.close(); store.close(); rmSync(dir, { recursive: true, force: true }) }
  }
}

test('an exit carrying history stores it, and the stored row reads at 96x30 as the screen looked', async () => {
  const h = harness()
  try {
    const history = await serializedFixture()
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, tail: fixture.toString('base64'), history }, 2000)
    assert.deepEqual(readStoredHistory(h.stored().text), { text: history.data, size: { cols: 120, rows: 40 } },
      'session_scrollback.text holds history.data and its size, not the raw tail')
    const { data } = await h.launcher.scrollback(h.id, 1000)
    assert.equal(data.source, 'stored')
    const rows = await render(data.text, 96, 30)
    assert.ok(rows.includes('   3. No'), 'the "3. No" row survives a 96x30 replay')
    assert.ok(rows.includes(' Do you want to make this edit to notes.txt?'), 'the question row survives a 96x30 replay')
  } finally { h.close() }
})

test('a legacy raw row is rendered before it is served, so it reads at 96x30', async () => {
  const h = harness()
  try {
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, tail: fixture.toString('base64') }, 2000)
    const { data } = await h.launcher.scrollback(h.id, 1000)
    const rows = await render(data.text, 96, 30)
    assert.ok(rows.includes('   3. No'), 'the "3. No" row survives a 96x30 replay of a rendered raw row')
  } finally { h.close() }
})

test('an exit without history stores the raw tail', () => {
  const h = harness()
  try {
    const tail = Buffer.from('raw \x1b[31mbytes\x1b[0m\r\nlast line\r\n')
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, tail: tail.toString('base64') }, 2000)
    assert.deepEqual({ ...h.stored() }, { text: tail.toString('utf8'), truncated: 0 })
  } finally { h.close() }
})

test('renderHistory replays serialized history to the same screen and carries no modes or buffer switch', async () => {
  const history = await serializedFixture()
  const { data: rendered } = await renderHistory(history.data)
  assert.deepEqual(await render(rendered, 120, 40), await render(history.data, 120, 40))
  const { data: raw } = await renderHistory('\x1b[?1000h\x1b[?2004h\x1b[?1049hfull screen')
  assert.ok(!raw.includes('\x1b[?1049h'), 'no alternate-buffer switch')
  assert.ok(!raw.includes('\x1b[?1000h') && !raw.includes('\x1b[?2004h'), 'no terminal modes')
  assert.ok((await render(raw, 120, 40)).includes('full screen'))
})

test('the served stored text keeps the newest lines, cut on CRLF boundaries', async () => {
  const h = harness()
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, tail: Buffer.from(lines.join('\r\n')).toString('base64') }, 2000)
    const { data } = await h.launcher.scrollback(h.id, 5)
    assert.equal(data.truncated, true)
    const shown = (await render(data.text, 120, 40)).filter(Boolean)
    assert.deepEqual(shown, lines.slice(-5))
  } finally { h.close() }
})

test('a live PTY serves the history deckd sends with screen history: true, else its raw ring', async () => {
  const h = harness()
  try {
    const asked = []
    let reply = { scrollback: Buffer.from('raw ring\r\n').toString('base64'), history: { data: 'serialized\r\nhistory', cols: 120, rows: 40 } }
    const link = { connected: true, request: async (op, fields) => { asked.push({ op, fields }); return reply } }
    const launcher = createLauncher({ store: h.store, projector: h.projector, link, preferences: () => ({ prefs: { claudeCommand: 'claude' } }) })
    try {
      assert.deepEqual((await launcher.scrollback(h.id, 1)).data, { text: 'history', source: 'deckd', truncated: true })
      assert.equal(asked[0].op, 'screen')
      assert.equal(asked[0].fields.history, true)
      reply = { scrollback: reply.scrollback }
      assert.deepEqual((await launcher.scrollback(h.id, 50)).data, { text: 'raw ring\r\n', source: 'deckd', truncated: false })
    } finally { launcher.close() }
  } finally { h.close() }
})

test('a 200-column history serves text placed at column 150 by a cursor move at column 150', async () => {
  const h = harness()
  try {
    const history = await historyOf('header\r\n' + 'A'.repeat(100) + '|' + 'B'.repeat(99) + '\r\n\x1b[10;150HRIGHT\r\nlast', 200, 50)
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, history }, 2000)
    const { data } = await h.launcher.scrollback(h.id, 1000)
    const rows = await render(data.text, 200, 50)
    const right = rows.find(row => row.includes('RIGHT'))
    assert.equal(right?.indexOf('RIGHT'), 149, 'RIGHT starts at column 150 as it did on the PTY')
    assert.deepEqual(rows.filter(row => row.trim()), (await render(history.data, 200, 50)).filter(row => row.trim()))
  } finally { h.close() }
})

test('a full-width 200-column history of 1040 lines serves all 1040 lines', async () => {
  const h = harness()
  try {
    const lines = Array.from({ length: 1040 }, (_, i) => `L${String(i).padStart(4, '0')}`.padEnd(200, '='))
    const history = await historyOf(lines.join('\r\n'), 200, 40)
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, history }, 2000)
    const { data } = await h.launcher.scrollback(h.id, 5000)
    const labels = new Set((await render(data.text, 200, 40, 5000)).map(row => /^L\d{4}/.exec(row)?.[0]).filter(Boolean))
    assert.equal(labels.size, 1040)
    assert.equal(data.truncated, false)
  } finally { h.close() }
})

test('historySize clamps a stored size to 20..500 columns and 5..200 rows, and refuses a non-number', () => {
  assert.deepEqual(historySize({ cols: 9999, rows: 1 }), { cols: 500, rows: 5 })
  assert.deepEqual(historySize({ cols: 3, rows: 900 }), { cols: 20, rows: 200 })
  assert.deepEqual(historySize({ cols: 160.7, rows: 48 }), { cols: 160, rows: 48 })
  assert.equal(historySize({ cols: 'x', rows: 40 }), null)
  assert.equal(historySize(undefined), null)
})

test('a rendered history that overflows its scrollback says truncated', async () => {
  const lines = Array.from({ length: 6000 }, (_, i) => `n${i}`)
  const out = await renderHistory(lines.join('\r\n'))
  assert.equal(out.truncated, true)
  const short = await renderHistory(lines.slice(0, 100).join('\r\n'))
  assert.equal(short.truncated, false)
})

test('a stored history over SCROLLBACK_CAP keeps its newest whole lines and is flagged truncated', () => {
  const h = harness()
  try {
    const count = Math.ceil(SCROLLBACK_CAP / 1024) + 10
    const data = Array.from({ length: count }, (_, i) => String(i).padStart(6, '0').padEnd(1022, 'x')).join('\r\n')
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, history: { data, cols: 120, rows: 40 } }, 2000)
    const row = h.stored()
    assert.equal(row.truncated, 1)
    assert.ok(Buffer.byteLength(row.text) <= SCROLLBACK_CAP, 'the stored row fits the cap')
    const { text } = readStoredHistory(row.text)
    assert.ok(data.endsWith(text), 'the newest lines are kept')
    assert.equal(text.slice(0, 6), String(count - text.split('\r\n').length).padStart(6, '0'), 'the cut falls on a line start')
  } finally { h.close() }
})

test('a live text ending in CRLF and longer than lines keeps its newest line', async () => {
  const h = harness()
  try {
    const link = { connected: true, request: async () => ({ scrollback: Buffer.from('a\r\nb\r\n').toString('base64') }) }
    const launcher = createLauncher({ store: h.store, projector: h.projector, link, preferences: () => ({ prefs: { claudeCommand: 'claude' } }) })
    try {
      assert.deepEqual((await launcher.scrollback(h.id, 1)).data, { text: 'b\r\n', source: 'deckd', truncated: true })
    } finally { launcher.close() }
  } finally { h.close() }
})

test('boundCounts clamps line, scroll and character counts to the screen, and REP to a screenful', () => {
  assert.equal(boundCounts('\x1b[999L\x1b[999M\x1b[999S\x1b[999T', 120, 40), '\x1b[40L\x1b[40M\x1b[40S\x1b[40T')
  assert.equal(boundCounts('\x1b[9999@\x1b[9999P\x1b[9999X\x1b[9999I\x1b[9999Z', 120, 40), '\x1b[120@\x1b[120P\x1b[120X\x1b[120I\x1b[120Z')
  assert.equal(boundCounts('a\x1b[65535b', 120, 40), 'a\x1b[4800b')
  assert.equal(boundCounts('a\x1b[239b', 120, 40), 'a\x1b[239b', 'a REP that wraps onto the next row is kept')
  assert.equal(boundCounts('\x1b[3L\x1b[10;150H\x1b[?999S\x1b[1;2T\x1b[999 @', 120, 40), '\x1b[3L\x1b[10;150H\x1b[?999S\x1b[1;2T\x1b[999 @', 'other sequences pass through')
})

test('boundCounts clamps the first parameter whatever follows it, after a C1 CSI, and with controls inside the sequence', () => {
  assert.equal(boundCounts('\x1b[99999;1L', 120, 40), '\x1b[40;1L', 'a second parameter')
  assert.equal(boundCounts('\x1b[999:1L', 120, 40), '\x1b[40:1L', 'a subparameter')
  assert.equal(boundCounts('\x1b[999;0S', 120, 40), '\x1b[40;0S', 'a zero second parameter')
  assert.equal(boundCounts('a\x1b[65535;1b', 120, 40), 'a\x1b[4800;1b', 'REP with a second parameter')
  assert.equal(boundCounts('\x9b99999M\x9b9999;2P', 120, 40), '\x1b[40M\x1b[120;2P', 'the C1 introducer')
  assert.equal(boundCounts('\x1b[9\n99T', 120, 40), '\n\x1b[40T', 'a line feed inside the parameters, executed first')
  assert.equal(boundCounts('\x1b\x00[\x7f999S', 120, 40), '\x00\x1b[40S', 'controls between ESC and [')
  assert.equal(boundCounts('x\x1b[' + '\x00'.repeat(5) + 'é\x1b[999L', 120, 40), 'x\x1b[' + '\x00'.repeat(5) + 'é\x1b[40L', 'a CSI cut short by a non-final')
})

test('the first parameter xterm hands IL is at most the screen height for every crafted form', async () => {
  const forms = ['\x1b[99999;1L', '\x1b[999:1L', '\x9b99999L', '\x1b[9\n9999L', '\x1b\n[99999L', '\x1b[2147483647;5L', '\x1b[0099999L']
  for (const form of forms) {
    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    const seen = []
    term.parser.registerCsiHandler({ final: 'L' }, params => {
      seen.push(params[0])
      return true
    })
    try {
      await new Promise(resolve => term.write(boundCounts(form, 120, 40), () => resolve(undefined)))
      assert.deepEqual(seen, [40], JSON.stringify(form))
    } finally { term.dispose() }
  }
})

test('a REP longer than a row wraps onto the next row as it does on the PTY', async () => {
  const { data } = await renderHistory('x\x1b[239b', { timeoutMs: 30_000 })
  const rows = await render(data, 120, 40)
  assert.deepEqual(rows.slice(0, 2), ['x'.repeat(120), 'x'.repeat(120)])
})

/** The `\x1b#8` (DECALN) fill of a 500x200 screen and its scrollback, then the alternate screen filled too. */
const DECALN_ALT_FILL = ('\x1b#8\x1b[200H' + '\n'.repeat(200)).repeat(26) + '\x1b[?1049h\x1b#8'
/** The round 1 insert-lines piece, as much of it as one render feeds. */
const IL_FILL = '\x1b[99999;1L'.repeat(Math.floor((RENDER_INPUT_CAP - 64) / 11))

/**
 * A renderer whose workers count their `terminate()` calls in `spy.terminated`.
 * @param {object} options passed to `createHistoryRenderer`
 */
function spiedRenderer (options) {
  const spy = { spawned: 0, terminated: 0 }
  const renderer = createHistoryRenderer({
    ...options,
    spawn: () => {
      const worker = spawnHistoryWorker()
      const terminate = worker.terminate.bind(worker)
      worker.terminate = () => {
        spy.terminated++
        return terminate()
      }
      spy.spawned++
      return worker
    }
  })
  return { renderer, spy }
}

test('a render past its time limit ends the worker and answers the stripped text, truncated', async () => {
  const { renderer, spy } = spiedRenderer({ timeoutMs: 50 })
  try {
    const cases = [
      ['DECALN and the alternate screen at 500x200', DECALN_ALT_FILL, { cols: 500, rows: 200 }],
      ['the round 1 insert-lines piece', 'last words\r\n' + IL_FILL, {}]
    ]
    for (const [name, text, size] of cases) {
      const before = spy.terminated
      const out = await renderer.render(text, size)
      assert.equal(out.truncated, true, name)
      assert.equal(spy.terminated, before + 1, `${name}: the worker was ended`)
      assert.ok(!/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(out.data), `${name}: no control or escape is left`)
    }
    assert.ok((await renderer.render('last words\r\n' + IL_FILL)).data.startsWith('last words'), 'the fallback keeps the text')
    assert.equal(spy.spawned, 3, 'every render after a timeout starts a fresh worker')
    const after = await renderer.render('fine\r\n', { timeoutMs: 30_000 })
    assert.deepEqual({ truncated: after.truncated, rows: (await render(after.data, 120, 40)).filter(Boolean) }, { truncated: false, rows: ['fine'] }, 'the fresh worker renders')
  } finally { renderer.close() }
})

test('a worker that fails to start or crashes answers the fallback, and the next render starts another', async () => {
  let spawned = 0
  const renderer = createHistoryRenderer({
    spawn: () => ++spawned === 1 ? new Worker('throw new Error("boom")', { eval: true }) : spawnHistoryWorker()
  })
  try {
    assert.deepEqual(await renderer.render('a\x1b[31mred\x1b[0m\r\nb'), { data: 'ared\r\nb', truncated: true })
    const out = await renderer.render('ok', { timeoutMs: 30_000 })
    assert.equal(out.truncated, false)
    assert.equal(spawned, 2)
  } finally { renderer.close() }
})

test('the main thread keeps running while the worker renders a costly history', async () => {
  let gap = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const at = performance.now()
    gap = Math.max(gap, at - last)
    last = at
  }, 5)
  try {
    const out = await renderHistory(DECALN_ALT_FILL, { cols: 500, rows: 200, timeoutMs: 30_000 })
    gap = Math.max(gap, performance.now() - last)
    assert.ok(out.data.length > 1_000_000, 'the costly render ran to its end')
  } finally { clearInterval(timer) }
  assert.ok(gap < 250, `the longest main-thread gap was ${Math.round(gap)} ms`)
})

/** Where history.mjs lives, for workers and child processes that import it. */
const HISTORY_URL = new URL('../../server/screen/history.mjs', import.meta.url).href

/**
 * The source of a worker that builds 1 MiB of input made to make a backtracking scanner explode (CSI
 * introducers followed by long control runs, nested ESC, strings left open, and a lone ESC at the end), runs
 * the named scan of history.mjs on it once, and posts how long the scan took.
 */
const SCAN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.url).then(h => {
  const unit = '\\x1b[' + '\\x00'.repeat(2000) + 'é' + '\\x1b[' + '\\r\\n'.repeat(1000) + '\\x1b\\x1b\\x1b[' + ';'.repeat(500) + '\\x1b]' + '\\x01'.repeat(500)
  const input = unit.repeat(Math.ceil(1024 * 1024 / unit.length)).slice(0, 1024 * 1024 - 1) + '\\x1b'
  const scans = {
    stripControls: () => h.stripControls(input),
    fallbackHistory: () => h.fallbackHistory(input),
    boundCounts: () => h.boundCounts(input, 500, 200),
    newestInput: () => h.newestInput(input),
    readStoredHistory: () => h.readStoredHistory('\\x1b[8;' + input)
  }
  const started = performance.now()
  scans[workerData.scan]()
  parentPort.postMessage(performance.now() - started)
})
`

/** Hard limit on one scan worker; a scan that has not answered by then is ended and the test fails. */
const SCAN_LIMIT_MS = 5000

/**
 * Run the named scan in a worker; resolve with its time in ms, or reject when the worker has not answered
 * within `SCAN_LIMIT_MS` (the worker is ended) or fails.
 * @param {string} scan
 * @returns {Promise<number>}
 */
function timedScan (scan) {
  const worker = new Worker(SCAN_WORKER, { eval: true, workerData: { url: HISTORY_URL, scan } })
  let timer
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${scan} did not finish within ${SCAN_LIMIT_MS} ms`)), SCAN_LIMIT_MS)
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error(`${scan} worker exited without an answer`)))
  }).finally(() => {
    clearTimeout(timer)
    return worker.terminate()
  })
}

test('every main-thread scan of stored text is linear on 1 MiB of adversarial input', async () => {
  for (const scan of ['stripControls', 'fallbackHistory', 'boundCounts', 'newestInput', 'readStoredHistory']) {
    const took = await timedScan(scan)
    assert.ok(took < 250, `${scan} took ${Math.round(took)} ms`)
  }
})

/**
 * `promise`, or a rejection when it has not settled within `ms`, so a hang fails the test.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function within (promise, ms, what) {
  let timer
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

test('a worker that never says ready is ended after the startup limit, and the next render starts another', async () => {
  let spawned = 0
  // Only the never-ready first worker gets the 100 ms limit; the real second one gets 30 s, so a loaded
  // machine cannot make it miss its start and turn the next render into a fallback.
  const renderer = createHistoryRenderer({
    startupMs: () => spawned === 1 ? 100 : 30_000,
    spawn: () => ++spawned === 1 ? new Worker('setInterval(() => {}, 1000)', { eval: true }) : spawnHistoryWorker()
  })
  try {
    const started = performance.now()
    const out = await within(renderer.render('a\x1b[31mred\x1b[0m\r\nb', { timeoutMs: 30_000 }), 5000, 'the render on a worker that never starts')
    assert.ok(performance.now() - started < 5000, `the fallback came after ${Math.round(performance.now() - started)} ms`)
    assert.deepEqual(out, { data: 'ared\r\nb', truncated: true })
    const next = await within(renderer.render('ok', { timeoutMs: 30_000 }), 30_000, 'the next render')
    assert.equal(next.truncated, false)
    assert.equal(spawned, 2)
  } finally { renderer.close() }
})

test('one render at a time: a cheap render issued beside a costly one that times out still renders', async () => {
  const renderer = createHistoryRenderer({ timeoutMs: 200 })
  try {
    const costly = renderer.render(DECALN_ALT_FILL, { cols: 500, rows: 200 })
    const cheap = renderer.render('a\x1b[31mred\x1b[0m', { timeoutMs: 30_000 })
    assert.equal((await costly).truncated, true, 'the costly render fell back')
    const out = await cheap
    assert.equal(out.truncated, false, 'the cheap render was not the fallback')
    assert.ok(out.data.includes('\x1b[31m'), 'its colour survives')
  } finally { renderer.close() }
})

/**
 * Send `worker` the env probe once it says ready, and answer the probe's reply.
 * @param {Worker} worker
 * @returns {Promise<any>}
 */
function probeEnv (worker) {
  return within(new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message?.ready) worker.postMessage({ probe: 'env' })
      else if (message?.probe === 'env') resolve(message)
    })
    worker.once('error', reject)
  }), 30_000, 'the env probe')
}

test('the render worker sees an empty environment, no exec arguments and a bounded heap', async () => {
  process.env.DECK_HISTORY_ENV_MARKER = '1'
  const worker = spawnHistoryWorker()
  try {
    const answer = await probeEnv(worker)
    assert.deepEqual(answer.envNames, [], 'the worker sees no environment variable')
    assert.deepEqual(answer.execArgv, [])
    assert.equal(answer.resourceLimits.maxOldGenerationSizeMb, 512)
  } finally {
    delete process.env.DECK_HISTORY_ENV_MARKER
    await worker.terminate()
  }
})

test('the env probe answers variable names, never their values', async () => {
  const value = 'deck-history-probe-value-7f3a'
  const worker = spawnHistoryWorker({ env: { DECK_PROBE_MARKER: value } })
  try {
    const answer = await probeEnv(worker)
    assert.deepEqual(answer.envNames, ['DECK_PROBE_MARKER'], 'the probe names the variable')
    assert.ok(!JSON.stringify(answer).includes(value), 'the probe reply carries no value')
  } finally { await worker.terminate() }
})

test('a process that renders once exits on its own: the idle worker does not hold it open', async () => {
  const { execFile } = await import('node:child_process')
  const script = `import { renderHistory } from ${JSON.stringify(HISTORY_URL)}\nconst out = await renderHistory('hi\\r\\n', { timeoutMs: 30000 })\nprocess.stdout.write(String(out.truncated))\n`
  const result = await new Promise(resolve => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: {}, timeout: 10_000, killSignal: 'SIGKILL' }, (error, stdout) => resolve({ error, stdout }))
  })
  assert.equal(result.error?.killed ?? false, false, 'the process had to be killed: it did not exit on its own')
  assert.equal(result.error, null)
  assert.equal(result.stdout, 'false', 'the render ran')
})

test('a REP count cut to a screenful says truncated; one within a screenful does not', async () => {
  assert.equal((await renderHistory('y\r\nx\x1b[400b', { cols: 20, rows: 5, timeoutMs: 30_000 })).truncated, true)
  assert.equal((await renderHistory('y\r\nx\x1b[100b', { cols: 20, rows: 5, timeoutMs: 30_000 })).truncated, false)
  const seen = { rep: false }
  boundCounts('\x1b[999L', 120, 40, seen)
  assert.equal(seen.rep, false, 'clamping another count is not a REP loss')
})

test('stripControls drops escape sequences and controls but keeps text, CR and LF', () => {
  assert.equal(stripControls('a\x1b[31;1mb\x1b]0;title\x07c\x1b]8;;u\x1b\\d\x1bPq#\x1b\\e\x1b(Bf\x9b2Jg\x07\x08h\r\n'), 'abcdefgh\r\n')
  assert.equal(stripControls('x\x1b[' + '\x00'.repeat(10) + 'éy'), 'xéy', 'a CSI cut short keeps the character that ended it')
  assert.equal(stripControls('tail\x1b'), 'tail')
  assert.equal(stripControls('a\x7fb'), 'ab', 'DEL is removed')
  assert.deepEqual(fallbackHistory('one\r\nprogress 10%\rprogress 99%\r\ntwo'), { data: 'one\r\nprogress 99%\r\ntwo', truncated: true })
})

test('a row longer than the input cap with no CRLF in reach is not cut inside an escape sequence', () => {
  const head = 'zzz\x1b[38;5;196m'
  const text = head + 'a'.repeat(RENDER_INPUT_CAP + 5 - head.length)
  const fed = newestInput(text)
  assert.ok(text.endsWith(fed))
  assert.match(fed, /^a+$/, 'no parameter of the cut sequence is fed as text')
  const multibyte = 'xx' + 'é'.repeat(140_000)
  assert.match(newestInput(multibyte), /^é+$/, 'the cut falls between characters')
})

test('REP of a long cluster is dropped rather than copied a row long, after a narrow or a wide character', async () => {
  for (const base of ['e', '一']) {
    const out = await renderHistory(base + '́'.repeat(80000) + '\x1b[120b', { timeoutMs: 30_000 })
    assert.equal(out.truncated, false, `${JSON.stringify(base)}: the render was whole`)
    assert.ok(out.data.length < 2 * 80001, `${JSON.stringify(base)}: the cluster is printed once, not 120 times (${out.data.length} characters)`)
  }
  const { data } = await renderHistory('ab\x1b[3b')
  assert.ok((await render(data, 120, 40)).includes('abbbb'), 'REP of one character still repeats it')
})

test('a render whose output passes RENDER_OUTPUT_CAP keeps its newest whole lines and says truncated', async () => {
  const cluster = 'e' + '́'.repeat(30)
  const lines = Array.from({ length: 200 }, (_, i) => `L${String(i).padStart(3, '0')}${cluster}\x1b[490b`)
  const out = await renderHistory(lines.join('\r\n'), { cols: 500, rows: 200, timeoutMs: 30_000 })
  assert.equal(out.truncated, true)
  assert.ok(Buffer.byteLength(out.data) <= RENDER_OUTPUT_CAP, `${Buffer.byteLength(out.data)} bytes`)
  assert.match(out.data, /^L\d{3}e/, 'the output starts at a line start')
  assert.ok(out.data.includes('L199'), 'the newest line is kept')
  assert.ok(!out.data.includes('L000'), 'the oldest line is not')
})

test('16 KiB of insert-lines with a count of 999 renders whole', async () => {
  const out = await renderHistory('\x1b[999L'.repeat(Math.floor(16 * 1024 / 6)) + 'done', { timeoutMs: 30_000 })
  assert.equal(out.truncated, false)
  assert.ok((await render(out.data, 120, 40)).some(row => row.includes('done')))
})

test('a raw row feeds only its newest 256 KiB, cut at a line start', async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `R${String(i).padStart(4, '0')}`.padEnd(100, '-'))
  const out = await renderHistory(lines.join('\r\n'))
  assert.equal(out.truncated, true)
  const labels = (await render(out.data, 120, 40, 5000)).map(row => /^R\d{4}/.exec(row)?.[0]).filter(Boolean)
  assert.ok(!labels.includes('R0000'), 'the oldest lines are not rendered')
  assert.equal(labels.at(-1), 'R2999')
  assert.ok(labels.length * 102 <= RENDER_INPUT_CAP + 102)
  const first = (await render(out.data, 120, 40, 5000)).find(Boolean)
  assert.match(first, /^R\d{4}-{95}$/, 'the first served row is a whole labelled line')
})

test('a stored row is rendered once: a second read is served from the cache', async () => {
  let calls = 0
  const h = harness({
    render: async (...args) => {
      calls++
      return renderHistory(...args)
    }
  })
  try {
    h.projector.signal(h.id, { type: 'exit', code: 0, signal: null, tail: Buffer.from('one\r\ntwo\r\n').toString('base64') }, 2000)
    const first = await h.launcher.scrollback(h.id, 1000)
    const second = await h.launcher.scrollback(h.id, 1000)
    assert.deepEqual(second, first)
    assert.equal(calls, 1)
  } finally { h.close() }
})

test('the render cache keeps the 64 most recently read rows', async () => {
  let calls = 0
  const rows = new Map()
  const store = {
    get: (sql, id) => sql.includes('FROM sessions') ? { id, alive: 0 } : rows.get(id)
  }
  const launcher = createLauncher({
    store,
    projector: {},
    preferences: () => ({ prefs: { claudeCommand: 'claude' } }),
    render: async text => {
      calls++
      return { data: text, truncated: false }
    }
  })
  try {
    for (let i = 0; i <= 64; i++) rows.set(`s${i}`, { captured_at: 1, text: `row ${i}`, truncated: 0 })
    for (let i = 1; i <= 64; i++) await launcher.scrollback(`s${i}`, 10)
    await launcher.scrollback('s1', 10)
    assert.equal(calls, 64, 'a cached row is not rendered again')
    await launcher.scrollback('s0', 10)
    assert.equal(calls, 65)
    await launcher.scrollback('s1', 10)
    assert.equal(calls, 65, 'the row read most recently before the 65th stays cached')
    await launcher.scrollback('s2', 10)
    assert.equal(calls, 66, 'the least recently read row was dropped')
  } finally { launcher.close() }
})

/**
 * A launcher over a stub store holding `rows` (session id to stored scrollback row); every session has ended.
 * @param {Map<string, object>} rows
 * @param {Function} [renderer]
 */
function storedLauncher (rows, renderer) {
  const store = { get: (sql, id) => sql.includes('FROM sessions') ? { id, alive: 0 } : rows.get(id) }
  return createLauncher({ store, projector: {}, preferences: () => ({ prefs: { claudeCommand: 'claude' } }), ...(renderer ? { render: renderer } : {}) })
}

test('a relaunched session that exits again serves its second run, not the cached first one', async () => {
  const h = harness()
  try {
    const link = { connected: true, request: async () => ({ ptyId: 'pty_second' }) }
    const launcher = createLauncher({ store: h.store, projector: h.projector, link, preferences: () => ({ prefs: { claudeCommand: 'claude' } }) })
    try {
      h.projector.signal(h.id, { type: 'exit', code: 1, signal: null, tail: Buffer.from('FIRST RUN!\r\n').toString('base64') }, 2000)
      const first = (await launcher.scrollback(h.id, 100)).data.text
      assert.ok((await render(first, 120, 40)).includes('FIRST RUN!'))
      await launcher.relaunch(h.id)
      h.projector.signal(h.id, { type: 'exit', code: 1, signal: null, tail: Buffer.from('SECOND RUN\r\n').toString('base64') }, 3000)
      const second = (await launcher.scrollback(h.id, 100)).data.text
      const rows = await render(second, 120, 40)
      assert.ok(rows.includes('SECOND RUN') && !rows.includes('FIRST RUN!'), 'the same id and length, a later capture time')
    } finally { launcher.close() }
  } finally { h.close() }
})

test('a render that leaves input out answers truncated even when the stored row was whole', async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `R${String(i).padStart(4, '0')}`.padEnd(100, '-')).join('\r\n')
  const launcher = storedLauncher(new Map([['s1', { captured_at: 1, text, truncated: 0 }]]))
  try {
    const { data } = await launcher.scrollback('s1', 5000)
    assert.ok(data.text.split('\r\n').length < 5000, 'lines did not cut it')
    assert.equal(data.truncated, true)
  } finally { launcher.close() }
})

test('a render that failed is not cached: the next read renders again', async () => {
  let calls = 0
  const launcher = storedLauncher(new Map([['s1', { captured_at: 1, text: 'row', truncated: 0 }]]), async text => {
    if (++calls === 1) throw new Error('render failed')
    return { data: text, truncated: false }
  })
  try {
    await assert.rejects(launcher.scrollback('s1', 10), /render failed/)
    assert.deepEqual((await launcher.scrollback('s1', 10)).data, { text: 'row', source: 'stored', truncated: false })
    assert.equal(calls, 2)
  } finally { launcher.close() }
})
