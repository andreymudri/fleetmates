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

const HARNESS = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import '@hub/web/src/styles/tokens.css'
import '@hub/web/src/styles/shell.css'
import '@hub/web/src/styles/components.css'
import '@hub/web/src/styles/unlock.css'
import '@hub/web/src/styles/mobile.css'
import { Unlock } from '@hub/web/src/screens/unlock/Unlock.jsx'
createRoot(document.getElementById('root')).render(<Unlock host="deck.example.ts.net" onUnlocked={() => {}} fetch={() => new Promise(() => {})} />)
`

// The Unlock screen is the one screen designed phone first. An element wider than the viewport makes a phone lay
// the page out wider and zoom it out, which is how the passphrase field once pushed the whole card off centre.
test('the Unlock screen fits a phone viewport: nothing wider than the screen, the card inside its gutters', async t => {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Unlock layout test')
  const dir = await mkdtemp(path.join(tmpdir(), 'unlock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>t</title></head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>')
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
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForSelector('#unlock-pass')
    const layout = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).map(e => `${e.tagName}#${e.id}.${e.className}`),
      card: (({ left, right }) => ({ left, right }))(document.querySelector('.unlock-card').getBoundingClientRect())
    }))
    assert.equal(layout.inner, width, `the page is laid out at the device width ${width}, not zoomed out`)
    assert.equal(layout.scroll, width, `nothing scrolls sideways at ${width}`)
    assert.deepEqual(layout.wide, [], `no element is wider than the screen at ${width}`)
    assert.ok(layout.card.left >= 16 && layout.card.right <= width - 16, `the card keeps its gutters at ${width}: ${JSON.stringify(layout.card)}`)
    await context.close()
  }
})
