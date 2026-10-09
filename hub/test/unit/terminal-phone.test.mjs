import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright-core'
import { findChromium } from '../helpers/chromium.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))

const HARNESS = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalView } from '@hub/web/src/components/TerminalView.jsx'
import '@hub/web/src/styles/tokens.css'
import '@hub/web/src/styles/terminal.css'
import '@hub/web/src/styles/mobile.css'

const h = window.h = { sizes: [], resizes: [], handlers: null }
const client = {
  attach(sessionId, size, handlers) {
    h.sizes.push(size)
    h.handlers = handlers
    return { write: () => true, resize: (cols, rows) => { h.resizes.push([cols, rows])
      return true }, detach: () => {} }
  }
}
createRoot(document.getElementById('root')).render(<div style={{ height: '600px' }}><TerminalView sessionId="s1" label="s1" client={client} /></div>)
`

async function serve(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'phone-term-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>')
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
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}/`
}

// Remote access, decision (b): full control from a phone, except the PTY's size, which belongs to the terminal on
// the machine. The phone's xterm therefore takes the PTY's size from term.attached and scrolls, instead of fitting
// itself to the phone: a 120-column screen written into a 37-column xterm rewraps into nonsense.
test('on a phone the terminal never resizes the PTY and lays the screen out at the PTY width', async t => {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the phone terminal test')
  const url = await serve(t)
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await page.goto(url)
  await page.waitForFunction(() => window.h.handlers !== null)
  const size = await page.evaluate(() => window.h.sizes[0])
  assert.equal(size.resize, false, 'the attach asks the server not to fit the PTY to the phone')
  const line = 'A'.repeat(100) + 'B'
  await page.evaluate(line => {
    window.h.handlers.onAttached({ sessionId: 's1', ptyId: 'p1', cols: 120, rows: 40 })
    window.h.handlers.onSnapshot(new TextEncoder().encode(line + '\r\n'))
  }, line)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('B'))
  const firstRow = await page.evaluate(() => document.querySelector('.xterm-rows > div').textContent.trimEnd())
  assert.equal(firstRow, line, 'a 101-character line stays on one row of the 120-column screen')
  await page.setViewportSize({ width: 360, height: 700 })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(await page.evaluate(() => window.h.resizes), [], 'turning or resizing the phone sends no resize')
  const scrolls = await page.evaluate(() => { const host = document.querySelector('.terminal-host'); host.scrollLeft = 100; return host.scrollLeft > 0 })
  assert.ok(scrolls, 'the PTY width scrolls sideways inside the terminal')
})
