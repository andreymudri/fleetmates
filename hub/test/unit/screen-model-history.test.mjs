// ScreenModel.history(): the serialized scrollback and screen of a PTY, which
// replays as the screen looked at any terminal size (docs/deck/05-api.md 5.2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import xtermHeadless from '@xterm/headless'
import { ScreenModel, HISTORY_LINES, capHistory } from '../../deckd/screen-model.mjs'

const { Terminal } = xtermHeadless
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'fixtures', 'screens', '2.1.282', 'permission-edit.ansi')

/**
 * Write `data` into a fresh headless terminal and return every buffer row as text.
 * @param {string} data
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<string[]>}
 */
async function render (data, cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  try {
    await new Promise((resolve) => term.write(data, () => resolve(undefined)))
    const buf = term.buffer.active
    /** @type {string[]} */
    const out = []
    for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
    return out
  } finally {
    term.dispose()
  }
}

test('HISTORY_LINES is 1000', () => {
  assert.equal(HISTORY_LINES, 1000)
})

test('history() of the permission-edit fixture at 120x40 replays readable into 96x30', async () => {
  const model = new ScreenModel({ cols: 120, rows: 40 })
  try {
    model.write(await readFile(fixture))
    await model.flush()
    const history = model.history()
    assert.equal(history.cols, 120)
    assert.equal(history.rows, 40)
    assert.equal(typeof history.data, 'string')
    const rows = await render(history.data, 96, 30)
    assert.ok(rows.includes('   3. No'), JSON.stringify(rows))
    assert.ok(rows.includes(' Do you want to make this edit to notes.txt?'), JSON.stringify(rows))
    // the visible rows stay as they were
    assert.equal(model.lines().length, 40)
  } finally {
    model.dispose()
  }
})

test('history() keeps SGR colour', async () => {
  const model = new ScreenModel({ cols: 20, rows: 5 })
  try {
    model.write('\x1b[31mred\x1b[0m')
    await model.flush()
    const { data } = model.history()
    assert.match(data, /\x1b\[(?:[0-9;]*;)?31(?:;[0-9;]*)?mred/, JSON.stringify(data))
  } finally {
    model.dispose()
  }
})

test('history() reports the size of the model at that moment', async () => {
  const model = new ScreenModel({ cols: 80, rows: 24 })
  try {
    model.resize(100, 30)
    await model.flush()
    const { cols, rows } = model.history()
    assert.deepEqual({ cols, rows }, { cols: 100, rows: 30 })
  } finally {
    model.dispose()
  }
})

test('capHistory drops whole leading lines and the result still parses', async () => {
  // Each line: a colour, multi-byte text, a reset.
  /** @type {string[]} */
  const lines = []
  for (let i = 0; i < 400; i++) lines.push(`\x1b[3${i % 8}mção ${String(i).padStart(3, '0')} ${'é'.repeat(20)}\x1b[0m`)
  const data = lines.join('\r\n')
  const max = 4096
  const capped = capHistory(data, max)
  assert.ok(Buffer.byteLength(capped) <= max, `capped is ${Buffer.byteLength(capped)} bytes`)
  assert.ok(capped.length > 0)
  // starts exactly where a line of the input starts
  const start = data.length - capped.length
  assert.equal(data.slice(start), capped)
  assert.equal(data.slice(start - 2, start), '\r\n')
  assert.ok(capped.startsWith('\x1b[3'), JSON.stringify(capped.slice(0, 20)))
  // it parses: every row of the rendered result is a whole input line
  const rows = (await render(capped, 120, 10)).filter((r) => r !== '')
  assert.ok(rows.length > 10)
  for (const r of rows) assert.match(r, /^ção \d{3} é{20}$/)
  assert.equal(rows[rows.length - 1], `ção 399 ${'é'.repeat(20)}`)
  // under the cap: unchanged
  assert.equal(capHistory(data, Buffer.byteLength(data)), data)
})
