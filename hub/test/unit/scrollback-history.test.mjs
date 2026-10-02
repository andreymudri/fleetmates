// The server stores deckd's serialized history at exit and serves a rendered history from
// `GET /api/sessions/:id/scrollback` (docs/deck/06-storage.md `session_scrollback`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import xtermHeadless from '@xterm/headless'
import { ScreenModel } from '../../deckd/screen-model.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector, SCROLLBACK_CAP } from '../../server/machines/projector.mjs'
import { createLauncher } from '../../server/launch/launch.mjs'
import { boundCounts, historySize, readStoredHistory, renderHistory, RENDER_BUDGET_MS, RENDER_INPUT_CAP } from '../../server/screen/history.mjs'

const { Terminal } = xtermHeadless
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

test('renderHistory stops at its time budget on crafted bytes, and the event loop keeps running meanwhile', async () => {
  let gap = 0
  let last = Date.now()
  const timer = setInterval(() => {
    const at = Date.now()
    gap = Math.max(gap, at - last)
    last = at
  }, 5)
  const started = Date.now()
  try {
    const out = await renderHistory('\x1b[40L'.repeat(Math.floor(RENDER_INPUT_CAP / 5)))
    const took = Date.now() - started
    assert.equal(out.truncated, true, 'the unrendered rest is reported')
    assert.ok(took < RENDER_BUDGET_MS * 3, `returned after ${took} ms`)
    assert.ok(gap < 250, `the longest event-loop gap was ${gap} ms`)
  } finally { clearInterval(timer) }
})

test('boundCounts clamps line, scroll and character counts to the screen so they cost what a screenful costs', () => {
  assert.equal(boundCounts('\x1b[999L\x1b[999M\x1b[999S\x1b[999T', 120, 40), '\x1b[40L\x1b[40M\x1b[40S\x1b[40T')
  assert.equal(boundCounts('\x1b[9999@\x1b[9999P\x1b[9999X', 120, 40), '\x1b[120@\x1b[120P\x1b[120X')
  assert.equal(boundCounts('a\x1b[65535b', 120, 40), 'a\x1b[4800b')
  assert.equal(boundCounts('\x1b[3L\x1b[10;150H\x1b[?999S\x1b[1;2T', 120, 40), '\x1b[3L\x1b[10;150H\x1b[?999S\x1b[1;2T', 'other sequences pass through')
})

test('16 KiB of insert-lines with a count of 999 renders whole within the budget', async () => {
  const out = await renderHistory('\x1b[999L'.repeat(Math.floor(16 * 1024 / 6)) + 'done')
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
