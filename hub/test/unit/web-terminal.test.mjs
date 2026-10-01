import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import {
  encodeFrame, encodeInput, decodeServerFrame, createTerminalClient, sanitizePaste, pasteNeedsConfirm, pasteSizeText, FRAME_KIND
} from '../../web/src/state/terminal.js'
import { isGlobalChord } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(relative) {
  const { module } = await runnerImport(path.join(hub, 'web/src', relative), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const bytes = text => new TextEncoder().encode(text)
const text = view => new TextDecoder().decode(view)

// A connection double with the createConnection surface the terminal client uses.
function fakeConnection() {
  const term = new Set()
  const binary = new Set()
  const live = new Set()
  const sent = []
  const sentBinary = []
  let isLive = true
  const on = set => fn => { set.add(fn)
    return () => set.delete(fn) }
  return {
    sent,
    sentBinary,
    setLive(value) { isLive = value },
    onTerm: on(term),
    onBinary: on(binary),
    onLive: on(live),
    send(message) { if (!isLive) return false
      sent.push(message)
      return true },
    sendBinary(data) { if (!isLive) return false
      sentBinary.push(data)
      return true },
    emitTerm(message) { for (const fn of term) fn(message) },
    emitBinary(data) { for (const fn of binary) fn(data) },
    emitLive() { for (const fn of live) fn() }
  }
}

test('frames round trip for the 05-api 3.5 layout, including 26- and 36-character ids', () => {
  const ulid = '01J9ZQ4X7K3M5N8P2R6T0V1W3Y'
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  assert.equal(ulid.length, 26)
  assert.equal(uuid.length, 36)
  for (const id of [ulid, uuid, 'a']) {
    const input = encodeInput(id, 'ls -la\r')
    assert.ok(input instanceof Uint8Array)
    assert.equal(input[0], FRAME_KIND.input)
    assert.equal(input[1], id.length)
    assert.equal(input.length, 2 + id.length + 7)
    const decoded = decodeServerFrame(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
    assert.equal(decoded.kind, FRAME_KIND.input)
    assert.equal(decoded.sessionId, id)
    assert.equal(text(decoded.payload), 'ls -la\r')
    for (const kind of [FRAME_KIND.output, FRAME_KIND.snapshot]) {
      const frame = encodeFrame(kind, id, bytes('\u001b[31mred\u001b[0m é'))
      const back = decodeServerFrame(frame)
      assert.deepEqual({ kind: back.kind, sessionId: back.sessionId, payload: text(back.payload) }, { kind, sessionId: id, payload: '\u001b[31mred\u001b[0m é' })
    }
  }
  const empty = decodeServerFrame(encodeFrame(FRAME_KIND.output, ulid, new Uint8Array(0)))
  assert.equal(empty.payload.length, 0)
  for (const bad of [new Uint8Array([1]), new Uint8Array([1, 0]), new Uint8Array([1, 65, ...bytes('a'.repeat(65))]), new Uint8Array([1, 5, ...bytes('ab')]), new Uint8Array([1, 2, ...bytes('a/')])]) {
    assert.equal(decodeServerFrame(bad), null)
  }
  assert.throws(() => encodeInput('bad id', 'x'))
  assert.throws(() => encodeInput('', 'x'))
})

test('the terminal client attaches, routes frames by session and re-attaches after onLive and output_dropped', () => {
  const connection = fakeConnection()
  const client = createTerminalClient(connection)
  const seen = []
  const handlers = name => ({
    onAttached: message => seen.push([name, 'attached', message.ptyId]),
    onSnapshot: data => seen.push([name, 'snapshot', text(data)]),
    onOutput: data => seen.push([name, 'output', text(data)]),
    onExit: message => seen.push([name, 'exit', message.code]),
    onError: error => seen.push([name, 'error', error.code])
  })
  const a = client.attach('sa', { cols: 80, rows: 24 }, handlers('a'))
  client.attach('sb', { cols: 100, rows: 30 }, handlers('b'))
  assert.deepEqual(connection.sent, [{ t: 'term.attach', sessionId: 'sa', cols: 80, rows: 24 }, { t: 'term.attach', sessionId: 'sb', cols: 100, rows: 30 }])

  connection.emitTerm({ t: 'term.attached', sessionId: 'sa', ptyId: 'p1', cols: 80, rows: 24 })
  connection.emitBinary(encodeFrame(FRAME_KIND.snapshot, 'sa', bytes('screen')))
  connection.emitBinary(encodeFrame(FRAME_KIND.output, 'sb', bytes('b-out')).buffer)
  connection.emitBinary(encodeFrame(FRAME_KIND.output, 'zz', bytes('nobody')))
  connection.emitBinary(new Uint8Array([9, 9]))
  assert.deepEqual(seen, [['a', 'attached', 'p1'], ['a', 'snapshot', 'screen'], ['b', 'output', 'b-out']])

  assert.equal(a.write('pwd\r'), true)
  const frame = decodeServerFrame(connection.sentBinary[0])
  assert.deepEqual([frame.kind, frame.sessionId, text(frame.payload)], [FRAME_KIND.input, 'sa', 'pwd\r'])
  a.resize(120, 40)
  assert.deepEqual(connection.sent.at(-1), { t: 'term.resize', sessionId: 'sa', cols: 120, rows: 40 })

  connection.sent.length = 0
  connection.emitLive()
  assert.deepEqual(connection.sent, [
    { t: 'term.attach', sessionId: 'sa', cols: 120, rows: 40 },
    { t: 'term.attach', sessionId: 'sb', cols: 100, rows: 30 }
  ], 'every attached session is attached again, with its latest size, when the socket is live again')

  connection.sent.length = 0
  connection.emitTerm({ t: 'term.error', sessionId: 'sb', error: { code: 'output_dropped' } })
  assert.deepEqual(connection.sent, [{ t: 'term.attach', sessionId: 'sb', cols: 100, rows: 30 }], 'output_dropped re-attaches to resend the screen')
  connection.emitTerm({ t: 'term.error', sessionId: 'sa', error: { code: 'no_pty' } })
  connection.emitTerm({ t: 'term.exit', sessionId: 'sa', code: 1, signal: null })
  assert.deepEqual(seen.slice(-2), [['a', 'error', 'no_pty'], ['a', 'exit', 1]])

  connection.sent.length = 0
  a.detach()
  assert.deepEqual(connection.sent, [{ t: 'term.detach', sessionId: 'sa' }])
  assert.equal(a.write('late'), false, 'a detached handle writes nothing')
  connection.sent.length = 0
  connection.emitLive()
  assert.deepEqual(connection.sent, [{ t: 'term.attach', sessionId: 'sb', cols: 100, rows: 30 }], 'a detached session is not attached again')

  connection.setLive(false)
  assert.equal(client.attach('sc', { cols: 80, rows: 24 }, handlers('c')).write('x'), false, 'nothing is sent while the socket is not live')
})

test('tail subscriptions are sent, capped at 50 ids and sent again on onLive', () => {
  const connection = fakeConnection()
  const client = createTerminalClient(connection)
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`)
  client.subscribeTails(ids)
  assert.deepEqual(connection.sent, [{ t: 'sub.tails', sessionIds: ids.slice(0, 50) }])
  connection.sent.length = 0
  connection.emitLive()
  assert.deepEqual(connection.sent, [{ t: 'sub.tails', sessionIds: ids.slice(0, 50) }])
  client.close()
  connection.sent.length = 0
  connection.emitLive()
  assert.deepEqual(connection.sent, [], 'a closed client no longer listens')
})

test('sanitizePaste strips the bracketed-paste end marker and C0 controls but keeps tab and newline', () => {
  assert.equal(sanitizePaste('a\u001b[201~b'), 'ab')
  assert.equal(sanitizePaste('x\u001b[20\u001b[201~1~y'), 'xy', 'a marker rebuilt by removing an inner marker is removed too')
  assert.equal(sanitizePaste('1\u001b2\u00073\u00004\r5'), '12345')
  assert.equal(sanitizePaste('col1\tcol2\nline2'), 'col1\tcol2\nline2')
  assert.equal(sanitizePaste('café ✓'), 'café ✓')
})

test('the paste confirmation threshold counts UTF-8 bytes, not characters', () => {
  assert.equal(pasteNeedsConfirm('a'.repeat(4096)), false)
  assert.equal(pasteNeedsConfirm('a'.repeat(4097)), true)
  const accented = 'é'.repeat(2049)
  assert.equal(accented.length, 2049)
  assert.equal(pasteNeedsConfirm(accented), true, '2049 characters are 4098 bytes')
  assert.equal(pasteSizeText('a'.repeat(12 * 1024)), '12 KB')
  assert.equal(pasteSizeText('a'.repeat(5000)), '5 KB')
})

test('isGlobalChord matches the keyboard.md global set by event.code and leaves the rest to the PTY', () => {
  const key = (code, extra = {}) => ({ code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...extra })
  for (const code of ['KeyK', 'KeyN', 'KeyU', 'KeyI', 'Escape', 'Digit1', 'Digit3', 'Digit9']) assert.equal(isGlobalChord(key(code)), true, code)
  for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) assert.equal(isGlobalChord(key(code, { shiftKey: true })), true, `Alt Shift ${code}`)
  for (const code of ['KeyP', 'KeyB', 'KeyF', 'KeyT', 'Digit0']) assert.equal(isGlobalChord(key(code)), false, code)
  assert.equal(isGlobalChord(key('Digit5', { shiftKey: true })), false, 'Alt Shift 5 is not a section')
  assert.equal(isGlobalChord(key('KeyK', { shiftKey: true })), false)
  assert.equal(isGlobalChord({ code: 'Tab', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }), false)
  assert.equal(isGlobalChord({ code: 'KeyK', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }), false)
  assert.equal(isGlobalChord(key('KeyK', { ctrlKey: true })), false)
})

test('TerminalView renders its labelled section and skeleton under renderToStaticMarkup without loading xterm', async () => {
  const { TerminalView, linkDecision, terminalOptions } = await load('components/TerminalView.jsx')
  const html = renderToStaticMarkup(createElement(TerminalView, { sessionId: 's1', label: 'rustot · combat-tick', client: null }))
  assert.match(html, /<section[^>]*aria-label="Terminal, rustot · combat-tick"/)
  assert.match(html, /class="terminal-skeleton"[^>]*aria-hidden="true"/)
  assert.ok((html.match(/terminal-skeleton-line/g) ?? []).length >= 3)
  assert.doesNotMatch(html, /xterm/, 'xterm only loads in the browser effect')
  const hostile = renderToStaticMarkup(createElement(TerminalView, { sessionId: 's1', label: '<img src=x>‮', client: null }))
  assert.doesNotMatch(hostile, /<img/)
  assert.match(hostile, /&lt;img src=x&gt;&lt;U\+202E&gt;/)

  assert.equal(linkDecision('http://localhost:3000/x'), 'open')
  assert.equal(linkDecision('http://127.0.0.1:47800/'), 'open')
  assert.equal(linkDecision('https://[::1]/'), 'open')
  assert.equal(linkDecision('https://example.com/a'), 'confirm')
  assert.equal(linkDecision('http://localhost.evil.example/'), 'confirm')
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', 'obsidian://open', 'not a url']) assert.equal(linkDecision(bad), 'refuse', bad)

  const options = terminalOptions({ readOnly: false, connected: true, screenReaderMode: true, reducedMotion: false })
  assert.equal(options.fontSize, 14)
  assert.equal(options.lineHeight, 1.2)
  assert.equal(options.scrollback, 5000)
  assert.equal(options.allowProposedApi, false)
  assert.equal(options.screenReaderMode, true)
  assert.equal(options.cursorBlink, true)
  assert.equal(options.disableStdin, false)
  assert.equal(terminalOptions({ readOnly: false, connected: true, reducedMotion: true }).cursorBlink, false)
  assert.equal(terminalOptions({ readOnly: true, connected: true }).disableStdin, true)
  assert.equal(terminalOptions({ readOnly: false, connected: false }).disableStdin, true)
})

test('ConfirmDialog is a labelled modal dialog with Cancel first and marked for initial focus', async () => {
  const { ConfirmDialog } = await load('components/ConfirmDialog.jsx')
  const html = renderToStaticMarkup(createElement(ConfirmDialog, {
    title: 'Stop rustot · combat-tick?', body: 'The process gets SIGTERM.', confirmLabel: 'Stop session', cancelLabel: 'Cancel', tone: 'danger',
    onConfirm: () => {}, onCancel: () => {}
  }))
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  const labelled = /aria-labelledby="([^"]+)"/.exec(html)[1]
  const described = /aria-describedby="([^"]+)"/.exec(html)[1]
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(html, new RegExp(`id="${escape(labelled)}"[^>]*>(?:<bdi>)?Stop rustot · combat-tick\\?<`))
  assert.match(html, new RegExp(`id="${escape(described)}"[^>]*>The process gets SIGTERM.<`))
  const cancel = html.indexOf('>Cancel<')
  const confirm = html.indexOf('>Stop session<')
  assert.ok(cancel > 0 && confirm > cancel, 'Cancel comes before Confirm')
  assert.match(html, /<button[^>]*data-initial-focus="true"[^>]*>Cancel</)
  assert.doesNotMatch(html, /<button[^>]*data-initial-focus="true"[^>]*>Stop session</)
  assert.match(html, /button--danger/)
  const plain = renderToStaticMarkup(createElement(ConfirmDialog, { title: 't', body: 'b', confirmLabel: 'Paste', onConfirm: () => {}, onCancel: () => {} }))
  assert.match(plain, />Cancel</, 'Cancel is the default cancel label')
  assert.doesNotMatch(plain, /button--danger/)
})
