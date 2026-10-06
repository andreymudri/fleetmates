import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load() {
  const { module } = await runnerImport(path.join(hub, 'web/src/components/AnswerControls.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const session = (extra = {}) => ({ id: 's1', repoId: '/home/you/dev/rustot', origin: 'deck', state: 'needs_approval', ...extra })
const permission = (extra = {}) => ({
  id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', summary: 'cargo test', state: 'open', delivery: 'idle', screenMatch: 'on_screen',
  options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], allowAlways: false, confirmLabel: null, ...extra
})
const destructive = (extra = {}) => permission({ tier: 'destructive', summary: 'rm -rf build', confirmLabel: 'Delete build and everything in it', ...extra })

// Every <button ...>label</button> as { attrs, text }, with nested markup (a spinner) stripped from the text.
function buttons(html) {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attrs: match[1], text: match[2].replace(/<[^>]+>/g, '') }))
}
const button = (html, text) => buttons(html).find(item => item.text === text)
const disabled = item => /\sdisabled=""/.test(item.attrs)

test('a Destructive request on the drawer renders the confirm checkbox and a disabled Allow once that is never default or autofocused', async () => {
  const { AnswerControls } = await load()
  const html = renderToStaticMarkup(createElement(AnswerControls, { request: destructive(), session: session(), surface: 'drawer', deckd: { down: false }, confirmed: false }))
  assert.match(html, /<input type="checkbox"[^>]*>/, 'a real checkbox')
  assert.ok(html.includes('Delete build and everything in it'), 'labelled by request.confirmLabel')
  assert.match(html, /<label[^>]*>[\s\S]*<input type="checkbox"[\s\S]*Delete build and everything in it[\s\S]*<\/label>/, 'the label wraps the checkbox')
  const allow = button(html, 'Allow once')
  assert.ok(allow, html)
  assert.ok(disabled(allow), 'Allow once is disabled until the box is ticked')
  assert.match(allow.attrs, /type="button"/)
  assert.doesNotMatch(html, /type="submit"/, 'no answer button is the form default')
  assert.doesNotMatch(html, /autofocus/i, 'nothing is autofocused')
  assert.ok(button(html, 'Deny') && !disabled(button(html, 'Deny')), 'Deny stays available')
  assert.ok(buttons(html).findIndex(item => item.text === 'Deny') < buttons(html).findIndex(item => item.text === 'Allow once'), 'Deny comes first')

  const ticked = renderToStaticMarkup(createElement(AnswerControls, { request: destructive(), session: session(), surface: 'focus', deckd: { down: false }, confirmed: true }))
  assert.ok(!disabled(button(ticked, 'Allow once')), 'confirmed enables Allow once')
  assert.match(ticked, /<input type="checkbox"[^>]*checked=""/, 'the checkbox reflects confirmed')
})

test('a Destructive request on a card offers only "Review in Needs you"', async () => {
  const { AnswerControls } = await load()
  const html = renderToStaticMarkup(createElement(AnswerControls, { request: destructive(), session: session(), surface: 'card', deckd: { down: false }, confirmed: true }))
  assert.deepEqual(buttons(html).map(item => item.text), ['Review in Needs you'])
  assert.doesNotMatch(html, /checkbox/)
})

test('Safe and Caution render Deny and Allow once; the labels come from the surface copy', async () => {
  const { AnswerControls } = await load()
  for (const tier of ['safe', 'caution']) {
    const html = renderToStaticMarkup(createElement(AnswerControls, { request: permission({ tier }), session: session(), surface: 'card', deckd: { down: false } }))
    assert.deepEqual(buttons(html).map(item => [item.text, disabled(item)]), [['Deny', false], ['Allow once', false]], tier)
  }
  const labels = { deny: 'Recusar', allowOnce: 'Permitir uma vez' }
  const html = renderToStaticMarkup(createElement(AnswerControls, { request: permission(), session: session(), surface: 'drawer', deckd: { down: false }, labels }))
  assert.deepEqual(buttons(html).map(item => item.text), ['Recusar', 'Permitir uma vez'])
})

test('an observed session renders "Answer in your terminal" and "Open", never an answer button', async () => {
  const { AnswerControls } = await load()
  for (const surface of ['card', 'drawer', 'focus']) {
    const html = renderToStaticMarkup(createElement(AnswerControls, { request: permission(), session: session({ origin: 'observed' }), surface, deckd: { down: false } }))
    assert.ok(html.includes('Answer in your terminal'), surface)
    assert.deepEqual(buttons(html).map(item => item.text), ['Open'], surface)
  }
})

test('deckd down and a queued prompt disable both buttons with their reason', async () => {
  const { AnswerControls } = await load()
  const down = renderToStaticMarkup(createElement(AnswerControls, { request: permission(), session: session(), surface: 'drawer', deckd: { down: true } }))
  assert.ok(down.includes('deckd is reconnecting. Answer in your terminal for now.'))
  assert.deepEqual(buttons(down).map(item => [item.text, disabled(item)]), [['Deny', true], ['Allow once', true]])

  const queued = renderToStaticMarkup(createElement(AnswerControls, { request: permission({ screenMatch: 'queued' }), session: session(), surface: 'drawer', deckd: { down: false } }))
  assert.ok(queued.includes('Queued behind another prompt in this session'))
  assert.deepEqual(buttons(queued).map(item => [item.text, disabled(item)]), [['Deny', true], ['Allow once', true]])
})

test('a PTY permission with no parsed options says "Answer in the terminal" and never guesses a button', async () => {
  const { AnswerControls } = await load()
  const html = renderToStaticMarkup(createElement(AnswerControls, { request: permission({ options: [] }), session: session(), surface: 'focus', deckd: { down: false } }))
  assert.ok(html.includes('Answer in the terminal'))
  assert.deepEqual(buttons(html), [])
})

test('a question renders its option buttons as text and a Reply field', async () => {
  const { AnswerControls } = await load()
  const request = { id: 'q1', sessionId: 's1', kind: 'question', tier: null, summary: 'Which?', state: 'open', delivery: 'idle', screenMatch: 'on_screen', options: [{ key: '1', label: '<img src=x onerror=alert(1)>' }, { key: '2', label: 'Keep it' }] }
  const html = renderToStaticMarkup(createElement(AnswerControls, { request, session: session(), surface: 'drawer', deckd: { down: false } }))
  assert.doesNotMatch(html, /<img/i, 'option labels are text')
  assert.deepEqual(buttons(html).map(item => item.text), ['&lt;img src=x onerror=alert(1)&gt;', 'Keep it', 'Reply'])
  assert.match(html, /<input type="text"[^>]*aria-label="Reply"/)
})

test('delivery states: a spinner in the chosen button, "Sent · checking…", and did_not_land with Try again only on screen', async () => {
  const { AnswerControls } = await load()
  const props = { session: session(), surface: 'drawer', deckd: { down: false } }
  const sending = renderToStaticMarkup(createElement(AnswerControls, { ...props, request: permission({ delivery: 'sending' }), busy: { choice: 'allow' } }))
  const allow = button(sending, 'Allow once')
  assert.ok(allow, 'the chosen button keeps its label')
  assert.match(allow.attrs, /aria-busy="true"/)
  assert.match(sending, /<button[^>]*aria-busy="true"[^>]*>[^]*?class="answer-spinner"[^]*?Allow once<\/button>/, 'the spinner is inside the chosen button')
  assert.ok(disabled(button(sending, 'Deny')), 'the others are disabled')

  const verifying = renderToStaticMarkup(createElement(AnswerControls, { ...props, request: permission({ delivery: 'verifying' }), busy: { choice: 'allow' } }))
  assert.ok(verifying.includes('Sent · checking…'))

  const missed = renderToStaticMarkup(createElement(AnswerControls, { ...props, request: permission({ delivery: 'did_not_land' }), busy: { choice: 'allow' } }))
  assert.ok(missed.includes('Your answer did not reach rustot. The prompt is still open in its terminal.'))
  assert.deepEqual(buttons(missed).map(item => item.text), ['Try again', 'Open terminal'])

  const queued = renderToStaticMarkup(createElement(AnswerControls, { ...props, request: permission({ delivery: 'did_not_land', screenMatch: 'queued' }), busy: { choice: 'allow' } }))
  assert.ok(queued.includes('Your answer did not reach rustot.'))
  assert.deepEqual(buttons(queued).map(item => item.text), ['Open terminal'], 'Try again is hidden unless the prompt is on screen')
})

test('buttons call onAnswer with the AnswerBody, Destructive with confirm, and the checkbox reports clicks through onConfirm', async () => {
  const { AnswerControls } = await load()
  const calls = []
  const tree = AnswerControls({
    request: destructive(), session: session(), surface: 'drawer', deckd: { down: false }, confirmed: true,
    onAnswer: body => calls.push(['answer', body]), onConfirm: checked => calls.push(['confirm', checked]), onOpen: () => calls.push(['open'])
  })
  const found = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'button' || node.type === 'input') found.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  for (const node of found) {
    if (node.type === 'input') node.props.onChange({ target: { checked: false } })
    else node.props.onClick()
  }
  assert.deepEqual(calls, [['confirm', false], ['answer', { choice: 'deny' }], ['answer', { choice: 'allow', confirm: true }]])
  assert.equal(found.some(node => node.props.onKeyDown), false, 'no keyboard handler of its own')
})
