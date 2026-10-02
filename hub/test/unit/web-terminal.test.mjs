import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'
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

test('motionReduced honours the OS query and Settings "Always reduce motion" (data-motion="reduce" on the root)', async () => {
  const { motionReduced } = await load('components/TerminalView.jsx')
  const media = matches => () => ({ matches })
  const root = motion => ({ getAttribute: name => name === 'data-motion' ? motion : null })
  assert.equal(motionReduced({ matchMedia: media(false), root: root('reduce') }), true, 'the Settings preference alone reduces motion')
  assert.equal(motionReduced({ matchMedia: media(true), root: root(null) }), true, 'the OS preference alone reduces motion')
  assert.equal(motionReduced({ matchMedia: media(false), root: root('system') }), false)
  assert.equal(motionReduced({ matchMedia: media(false), root: root(null) }), false)
  assert.equal(motionReduced({}), false, 'no window and no document reads as motion allowed')
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

test('handleLink opens http and https only, and asks before any host other than localhost', async () => {
  const { handleLink } = await load('components/TerminalView.jsx')
  const run = (uri, answer) => {
    const asked = []
    const opened = []
    const result = handleLink(uri, { confirmLink: url => { asked.push(url)
      return answer }, open: (...args) => opened.push(args) })
    return { result, asked, opened }
  }
  assert.deepEqual(run('https://example.com/a', false), { result: false, asked: ['https://example.com/a'], opened: [] }, 'a refused confirm opens nothing')
  assert.deepEqual(run('https://example.com/a', true), { result: true, asked: ['https://example.com/a'], opened: [['https://example.com/a', '_blank', 'noopener,noreferrer']] })
  assert.deepEqual(run('http://localhost:3000/x', false), { result: true, asked: [], opened: [['http://localhost:3000/x', '_blank', 'noopener,noreferrer']] }, 'localhost opens without asking')
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
    assert.deepEqual(run(bad, true), { result: false, asked: [], opened: [] }, bad)
  }
})

test('handleLink confirms and opens the parsed href, so the dialog shows the host the browser will open', async () => {
  const { handleLink } = await load('components/TerminalView.jsx')
  const run = uri => {
    const asked = []
    const opened = []
    handleLink(uri, { confirmLink: url => { asked.push(url)
      return true }, open: url => opened.push(url) })
    return { asked, opened }
  }
  const homograph = run('https://аpple.com/login')
  assert.equal(homograph.asked.length, 1)
  assert.equal(new URL(homograph.asked[0]).host, 'xn--pple-43d.com', 'the confirm shows the punycode host')
  assert.match(homograph.asked[0], /^https:\/\/xn--/)
  assert.deepEqual(homograph.opened, homograph.asked, 'the opened URL is the one confirmed')
  const backslash = run('https://evil.com\\@localhost/')
  assert.equal(backslash.asked.length, 1, 'a backslash does not make it a localhost link')
  assert.equal(new URL(backslash.asked[0]).host, 'evil.com')
  assert.doesNotMatch(backslash.asked[0], /\\/, 'the backslash is normalized in what the dialog shows')
  assert.deepEqual(backslash.opened, backslash.asked)
})

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

// A page that mounts the real TerminalView with a recording client; `window.h.show(id)` switches sessions.
const HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalView } from '@hub/web/src/components/TerminalView.jsx'
import '@hub/web/src/styles/terminal.css'

const decoder = new TextDecoder()
const h = window.h = { attaches: [], writes: [], detaches: [], handlers: {}, links: [], confirms: [], answer: false }
window.open = url => { h.links.push(url) }
const client = {
  attach(sessionId, size, handlers) {
    h.attaches.push(sessionId)
    h.handlers[sessionId] = handlers
    return {
      write: data => { h.writes.push([sessionId, typeof data === 'string' ? data : decoder.decode(data)])
        return true },
      resize: () => true,
      detach: () => { h.detaches.push(sessionId) }
    }
  }
}
function App() {
  const [id, setId] = useState('sessA')
  const [deckdUp, setDeckdUp] = useState(true)
  h.show = setId
  h.deckd = setDeckdUp
  return <><button id="outside" type="button">outside</button><span id="deckd">{String(deckdUp)}</span><TerminalView sessionId={id} label={id} client={client} deckdUp={deckdUp} confirmLink={url => { h.confirms.push(url)
    return h.answer }} /></>
}
createRoot(document.getElementById('root')).render(<App />)
`

test('a mounted TerminalView stays writable after a session switch and gates terminal links in Chromium', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the terminal browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'term-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root" style="width:800px;height:400px"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), HARNESS)
  const out = path.join(dir, 'dist')
  await build({
    root: dir, base: './', configFile: false, logLevel: 'silent',
    resolve: { alias: { '@hub': hub, react: path.join(hub, 'node_modules/react'), 'react-dom': path.join(hub, 'node_modules/react-dom') } },
    build: { outDir: out, emptyOutDir: true }
  })
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://x').pathname
    try {
      const body = await readFile(path.join(out, name === '/' ? 'index.html' : path.normalize(name)))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }).end(body)
    } catch { res.writeHead(404).end() }
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  // Closed on its own, before Chromium launches, so a launch error fails the test instead of hanging the file.
  t.after(() => server.close())
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const h = fn => page.evaluate(fn)
  // Toggle the deckd health prop and wait until React committed it.
  const deckd = async up => {
    await page.evaluate(value => window.h.deckd(value), up)
    await page.waitForFunction(value => document.getElementById('deckd')?.textContent === String(value), up, { timeout: 5000 })
  }
  const typeInto = async (keys) => {
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(keys)
  }

  await page.waitForFunction(() => window.h.handlers.sessA, null, { timeout: 10_000 })
  await h(() => { window.h.handlers.sessA.onAttached({ sessionId: 'sessA', ptyId: 'p1', cols: 80, rows: 24 }) })
  await typeInto('ab')
  assert.deepEqual(await h(() => window.h.writes.splice(0)), [['sessA', 'a'], ['sessA', 'b']])

  await h(() => window.h.show('sessB'))
  await page.waitForFunction(() => window.h.handlers.sessB, null, { timeout: 10_000 })
  assert.deepEqual(await h(() => window.h.detaches), ['sessA'])
  await typeInto('x')
  assert.deepEqual(await h(() => window.h.writes.splice(0)), [], 'no input before the new session is attached')
  await h(() => { window.h.handlers.sessB.onAttached({ sessionId: 'sessB', ptyId: 'p2', cols: 80, rows: 24 }) })
  await page.waitForFunction(() => !document.querySelector('.xterm-helper-textarea')?.readOnly, null, { timeout: 5000 })
  await typeInto('cd')
  assert.deepEqual(await h(() => window.h.writes.splice(0)), [['sessB', 'c'], ['sessB', 'd']], 'the terminal is writable for the new session')

  // The caret blinks while motion is allowed and stops, without a remount, when Settings sets data-motion="reduce"
  // or the OS preference turns to reduce.
  const caret = async blink => {
    await page.waitForFunction(on => {
      const cursor = document.querySelector('.xterm-rows .xterm-cursor:is(.xterm-cursor-block, .xterm-cursor-bar, .xterm-cursor-underline)')
      return !!cursor && cursor.classList.contains('xterm-cursor-blink') === on
    }, blink, { timeout: 5000 })
  }
  await caret(true)
  await h(() => document.documentElement.setAttribute('data-motion', 'reduce'))
  await caret(false)
  await h(() => document.documentElement.removeAttribute('data-motion'))
  await caret(true)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await caret(false)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await caret(true)

  // OSC 8 links: click each word and record what the handler did.
  await h(() => window.h.handlers.sessB.onOutput(new TextEncoder().encode(
    '\x1b]8;;https://example.com/x\x07EXT\x1b]8;;\x07 \x1b]8;;http://localhost:9/y\x07LOC\x1b]8;;\x07 \x1b]8;;javascript:alert(1)\x07JS\x1b]8;;\x07\r\n')))
  const click = async word => {
    const box = await page.evaluate(w => {
      const walker = document.createTreeWalker(document.querySelector('.xterm-rows'), NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent.indexOf(w)
        if (i === -1) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const r = range.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return null
    }, word)
    assert.ok(box, `${word} is on screen`)
    await page.mouse.move(box.x, box.y)
    await page.waitForTimeout(50)
    await page.mouse.click(box.x, box.y)
    await page.waitForTimeout(50)
  }
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('EXT'), null, { timeout: 5000 })
  await click('EXT')
  assert.deepEqual(await h(() => [window.h.confirms.splice(0), window.h.links.splice(0)]), [['https://example.com/x'], []], 'a remote link asks and a refusal opens nothing')
  await h(() => { window.h.answer = true })
  await click('EXT')
  assert.deepEqual(await h(() => [window.h.confirms.splice(0), window.h.links.splice(0)]), [['https://example.com/x'], ['https://example.com/x']])
  await click('LOC')
  assert.deepEqual(await h(() => [window.h.confirms.splice(0), window.h.links.splice(0)]), [[], ['http://localhost:9/y']], 'localhost opens without asking')
  await click('JS')
  assert.deepEqual(await h(() => [window.h.confirms.splice(0), window.h.links.splice(0)]), [[], []], 'javascript: never opens')

  // Data xterm emits on its own (here its reply to a device attributes query) while the terminal is not
  // focused never reaches the client.
  await page.locator('#outside').focus()
  await h(() => window.h.handlers.sessB.onOutput(new TextEncoder().encode('\x1b[cQUERY-DONE\r\n')))
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('QUERY-DONE'), null, { timeout: 5000 })
  assert.deepEqual(await h(() => window.h.writes.splice(0)), [], 'nothing is written while the terminal is unfocused')

  // deckd went down before the attach completed: the server dropped the tab, so the view attaches again
  // once the deckd health row is up, and only then.
  await h(() => window.h.show('sessC'))
  await page.waitForFunction(() => window.h.handlers.sessC, null, { timeout: 10_000 })
  await deckd(false)
  await h(() => window.h.handlers.sessC.onError({ code: 'deckd_unavailable' }))
  await page.waitForFunction(() => document.querySelector('.terminal-view')?.getAttribute('data-waiting') === 'deckd', null, { timeout: 5000 })
  assert.equal(await h(() => window.h.attaches.filter(id => id === 'sessC').length), 1, 'no re-attach while deckd is down')
  await deckd(true)
  await page.waitForFunction(() => window.h.attaches.filter(id => id === 'sessC').length === 2, null, { timeout: 5000 })
  await h(() => { window.h.handlers.sessC.onAttached({ sessionId: 'sessC', ptyId: 'p3', cols: 80, rows: 24 }) })
  await page.waitForFunction(() => !document.querySelector('.xterm-helper-textarea')?.readOnly, null, { timeout: 5000 })
  await typeInto('z')
  assert.deepEqual(await h(() => window.h.writes.splice(0)), [['sessC', 'z']], 'the re-attached view is writable')
  // An outage after the attach: the server keeps the tab and re-attaches it, so the view does not.
  await h(() => window.h.handlers.sessC.onError({ code: 'deckd_unavailable' }))
  await deckd(false)
  await deckd(true)
  // A barrier: React runs the effects of the deckd changes before it commits the session switch.
  await h(() => window.h.show('sessD'))
  await page.waitForFunction(() => window.h.handlers.sessD, null, { timeout: 10_000 })
  assert.equal(await h(() => window.h.attaches.filter(id => id === 'sessC').length), 2, 'an attached view leaves re-attaching to the server')

  // The health row can still read up when the error arrives: the view waits for a return to up, no attach loop.
  await h(() => window.h.handlers.sessD.onError({ code: 'deckd_unavailable' }))
  await page.waitForFunction(() => document.querySelector('.terminal-view')?.getAttribute('data-waiting') === 'deckd', null, { timeout: 5000 })
  // A barrier: the effects of the error's commit ran before React committed deckd going down.
  await deckd(false)
  assert.equal(await h(() => window.h.attaches.filter(id => id === 'sessD').length), 1, 'no re-attach while the row still read up')
  await deckd(true)
  await page.waitForFunction(() => window.h.attaches.filter(id => id === 'sessD').length === 2, null, { timeout: 5000 })
  assert.deepEqual(errors, [])
})
