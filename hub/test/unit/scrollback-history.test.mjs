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
import { createProjector } from '../../server/machines/projector.mjs'
import { createLauncher } from '../../server/launch/launch.mjs'
import { renderHistory } from '../../server/screen/history.mjs'

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
async function render (data, cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
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

function harness () {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-history-'))
  const file = path.join(dir, 'deck.db')
  const store = openDeckDb(file)
  const projector = createProjector({ store, now: () => 1000 })
  const hook = JSON.parse(readFileSync(hookFixture, 'utf8'))
  const envelope = { v: 1, hook: { ...hook, hook_event_name: 'SessionStart', cwd: dir }, hookTs: 1000, ptyId: 'pty_history', claudePid: null, pidChain: [], truncated: false, receivedAt: 1000, via: 'socket' }
  projector.applyHooks([envelope])
  const id = projector.snapshot().sessions[0].id
  const launcher = createLauncher({ store, projector, preferences: () => ({ prefs: { claudeCommand: 'claude' } }) })
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
    assert.equal(h.stored().text, history.data, 'session_scrollback.text holds history.data, not the raw tail')
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
  const rendered = await renderHistory(history.data)
  assert.deepEqual(await render(rendered, 120, 40), await render(history.data, 120, 40))
  const raw = await renderHistory('\x1b[?1000h\x1b[?2004h\x1b[?1049hfull screen')
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
