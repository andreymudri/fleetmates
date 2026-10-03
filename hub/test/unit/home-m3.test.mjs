// M3 Task 13: Home cards answer within the tier rules (docs/deck/screens/home.md 4.2, 4.4, 6, ACs 5 and 7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(file) {
  const { module } = await runnerImport(path.join(hub, 'web/src', file), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 9, 2, 12, 0)
const MIN = 60_000

// Walk a tree of components, expanding function components, and collect host elements. CrewAvatar holds a
// hook, so it is left unexpanded (it renders no control).
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    if (node.type.name === 'CrewAvatar') return
    walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return node.type.name === 'CrewAvatar' ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const findButton = (tree, text) => {
  const out = []
  walk(tree, node => { if (node.type === 'button' && textOf(node.props.children) === text) out.push(node) })
  return out[0] ?? null
}

// Every <button ...>label</button> as { attrs, text }, nested markup stripped from the text.
const buttons = html => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attrs: match[1], inner: match[2], text: match[2].replace(/<[^>]+>/g, '') }))
const button = (html, text) => buttons(html).find(item => item.text === text)
const disabled = item => /\sdisabled=""/.test(item.attrs)

const OPTIONS = [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]
const REPO = { id: '/home/you/dev/rustot', name: 'rustot', crewSeed: 'rustot', crewSlot: 1 }

function session(extra = {}) {
  return { id: 's1', repoId: REPO.id, origin: 'launched', ptyId: 'p-s1', alive: true, task: 'combat', branch: 'combat-tick', state: 'needs_approval', stateSince: NOW - 3 * MIN, ...extra }
}

function request(extra = {}) {
  return { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: 'cargo test --release combat::', state: 'open', createdAt: NOW - 3 * MIN,
    delivery: 'idle', screenMatch: 'on_screen', options: OPTIONS, confirmLabel: null, ...extra }
}

function fakeApi() {
  const calls = []
  const reply = (method, url, body) => {
    calls.push(body === undefined ? [method, url] : [method, url, body])
    return Promise.resolve(url === '/api/rules' ? { rule: { pattern: body.pattern } } : {})
  }
  return { calls, get: url => reply('GET', url), post: (url, body) => reply('POST', url, body), del: url => reply('DELETE', url) }
}

// The Home answer state driven through the same functions Home's useState wiring calls.
async function harness() {
  const { homeAnswerActions } = await load('screens/home/Home.jsx')
  const api = fakeApi()
  let answers = {}
  const toasts = []
  const setAnswers = next => { answers = typeof next === 'function' ? next(answers) : next }
  const repos = [{ id: REPO.id, name: 'rustot', repoKey: 'rustot' }]
  const actions = homeAnswerActions({ api, setAnswers, show: toast => toasts.push(toast), repos })
  return { api, actions, toasts, get answers() { return answers } }
}

test('home AC5: Allow once sends choice "allow"; the button keeps its label with a spinner and Deny is disabled', async () => {
  const { SessionCard } = await load('components/SessionCard.jsx')
  const h = await harness()
  const props = { session: session(), repo: REPO, requests: [request()], now: NOW, onAnswer: h.actions.answer }
  const allow = findButton(SessionCard(props), 'Allow once')
  assert.ok(allow, 'a Safe card on a PTY session has Allow once')
  allow.props.onClick()
  assert.deepEqual(h.api.calls, [['POST', '/api/requests/r1/answer', { choice: 'allow' }]])
  assert.deepEqual(h.answers, { r1: { choice: 'allow' } }, 'the answer in flight is kept for the card')

  // Before the server's request.updated arrives, the card already shows the answer in flight.
  const html = render(SessionCard, { ...props, answers: h.answers })
  const sent = button(html, 'Allow once')
  assert.match(sent.inner, /^<span class="answer-spinner" aria-hidden="true"><\/span>Allow once$/, 'spinner inside, label kept')
  assert.match(sent.attrs, /aria-busy="true"/)
  assert.ok(disabled(button(html, 'Deny')), 'the other button is disabled')
  // Once the server says it is sending, the same holds.
  const server = render(SessionCard, { ...props, requests: [request({ delivery: 'sending' })], answers: h.answers })
  assert.match(button(server, 'Allow once').inner, /answer-spinner/)
  assert.ok(disabled(button(server, 'Deny')))
})

test('a refused answer clears the card\'s answer in flight; a closed request is pruned', async () => {
  const { homeAnswerActions, pruneAnswers } = await load('screens/home/Home.jsx')
  let answers = {}
  const api = { post: () => Promise.reject(Object.assign(new Error('nope'), { status: 409 })) }
  const actions = homeAnswerActions({ api, setAnswers: next => { answers = typeof next === 'function' ? next(answers) : next }, show: () => {}, repos: [] })
  await actions.answer(request(), { choice: 'deny' })
  assert.deepEqual(answers, {})
  assert.deepEqual(pruneAnswers({ r1: { choice: 'allow' }, r2: { choice: 'deny' } }, [request(), request({ id: 'r2', state: 'closed' })]), { r1: { choice: 'allow' } })
})

test('home AC7: a Destructive card has no Allow once, only "Review in Needs you", which opens the drawer on that request', async () => {
  const { SessionCard } = await load('components/SessionCard.jsx')
  const reviewed = []
  const props = { session: session(), repo: REPO, requests: [request({ tier: 'destructive', summary: 'git push --force', confirmLabel: 'I checked what this command will change' })], now: NOW,
    onAnswer: () => assert.fail('a card never answers Destructive'), onReview: id => reviewed.push(id) }
  const html = render(SessionCard, props)
  assert.equal(button(html, 'Allow once'), undefined, 'no Allow once')
  assert.equal(button(html, 'Deny'), undefined, 'no Deny')
  assert.doesNotMatch(html, /type="checkbox"/, 'no confirm checkbox on a card')
  assert.ok(button(html, 'Review in Needs you'))
  findButton(SessionCard(props), 'Review in Needs you').props.onClick()
  assert.deepEqual(reviewed, ['r1'])
})

test('the deckd-down card disables Allow once and Deny with "deckd is reconnecting"', async () => {
  const { SessionCard } = await load('components/SessionCard.jsx')
  const html = render(SessionCard, { session: session(), repo: REPO, requests: [request({ tier: 'caution' })], now: NOW, deckdDown: true })
  assert.ok(disabled(button(html, 'Allow once')))
  assert.ok(disabled(button(html, 'Deny')))
  assert.match(html, /deckd is reconnecting/)
  const up = render(SessionCard, { session: session(), repo: REPO, requests: [request({ tier: 'caution' })], now: NOW })
  assert.ok(!disabled(button(up, 'Allow once')) && !disabled(button(up, 'Deny')), 'enabled while deckd is up')
})

test('an observed card keeps the M1 request box: "Answer in your terminal", an Open link and no button', async () => {
  const { SessionCard } = await load('components/SessionCard.jsx')
  const html = render(SessionCard, { session: session({ origin: 'observed', ptyId: null }), repo: REPO, requests: [request()], now: NOW, ruleOffers: [{ repoId: REPO.id, pattern: 'Bash(cargo test:*)', count: 5 }] })
  assert.match(html, /<span class="request-terminal">Answer in your terminal<\/span>/)
  assert.doesNotMatch(html, /<button|<input/)
})

test('the rule suggestion line accepts the rule and toasts "Rule added to {repo}: {pattern}" with an Undo that revokes it', async () => {
  const { SessionCard } = await load('components/SessionCard.jsx')
  const h = await harness()
  const offers = [{ repoId: REPO.id, pattern: 'Bash(cargo test:*)', count: 5, ruleNote: 'anyFlags' }, { repoId: '/home/you/dev/other', pattern: 'Bash(ls)', count: 3 }]
  const props = { session: session(), repo: REPO, requests: [request()], now: NOW, ruleOffers: offers, onAcceptRule: h.actions.acceptRule }
  const html = render(SessionCard, props)
  assert.match(html, /Allowed 5 times\. Always allow in rustot\?/)
  assert.match(html, /Any flags\./, 'anyFlags adds the note')
  assert.doesNotMatch(html, /Allowed 3 times/, 'another repo\'s offer is not on this card')
  const plain = render(SessionCard, { ...props, ruleOffers: [{ ...offers[0], ruleNote: null }] })
  assert.doesNotMatch(plain, /Any flags\./)
  const accept = findButton(SessionCard(props), 'Allowed 5 times. Always allow in rustot? Any flags.')
  assert.ok(accept)
  await accept.props.onClick()
  assert.deepEqual(h.api.calls, [['POST', '/api/rules', { repoKey: 'rustot', pattern: 'Bash(cargo test:*)', source: 'suggested' }]])
  assert.equal(h.toasts.length, 1)
  assert.equal(h.toasts[0].text, 'Rule added to rustot: Bash(cargo test:*)')
  await h.actions.undo(h.toasts[0].undo)
  assert.deepEqual(h.api.calls.at(-1), ['DELETE', '/api/rules/rustot/Bash(cargo%20test%3A*)'])
})

test('the compact strip keeps two xs buttons per variant', async () => {
  const { CompactCard } = await load('components/CompactCard.jsx')
  const strip = props => {
    const html = render(CompactCard, { repo: REPO, now: NOW, tail: [], ...props })
    const part = html.match(/<div class="compact-strip">[\s\S]*<\/div>/)?.[0] ?? ''
    return [...part.matchAll(/<(a|button)[^>]*>([\s\S]*?)<\/\1>/g)].map(match => match[2].replace(/<[^>]+>/g, ''))
  }
  assert.deepEqual(strip({ session: session(), requests: [request()] }), ['Deny', 'Allow once'])
  assert.deepEqual(strip({ session: session(), requests: [request({ tier: 'destructive' })] }), ['Open', 'Review'])
  assert.deepEqual(strip({ session: session({ state: 'asked_you' }), requests: [request({ kind: 'question', tier: null, options: [] })] }), ['Open', 'Reply'])
  assert.deepEqual(strip({ session: session({ origin: 'observed', ptyId: null }), requests: [request()] }), ['Open'], 'observed: Open only')
  const team = { run: { repoId: REPO.id, runId: 'r-1' }, lead: session(), state: 'needs_approval', requests: [request(), request({ id: 'r2' })] }
  assert.deepEqual(strip({ team }), ['Open', 'Review 2'])

  const down = render(CompactCard, { repo: REPO, now: NOW, session: session(), requests: [request()], deckdDown: true })
  assert.ok(disabled(button(down, 'Allow once')) && disabled(button(down, 'Deny')), 'deckd down disables the compact answers')
  const sent = []
  const reviewed = []
  const tree = CompactCard({ repo: REPO, now: NOW, tail: [], session: session(), requests: [request()], onAnswer: (row, body) => sent.push([row.id, body]), onReview: id => reviewed.push(id) })
  findButton(tree, 'Allow once').props.onClick()
  assert.deepEqual(sent, [['r1', { choice: 'allow' }]])
  findButton(CompactCard({ repo: REPO, now: NOW, tail: [], session: session(), requests: [request({ tier: 'destructive' })], onReview: id => reviewed.push(id) }), 'Review').props.onClick()
  assert.deepEqual(reviewed, ['r1'])
})

test('HomeView passes the answer props to its cards and opens the drawer on a Destructive review', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const overlays = []
  const state = { loaded: true, view: { path: '/' }, data: { sessions: [session()], requests: [request({ tier: 'destructive' })], repos: [{ id: REPO.id, name: 'rustot' }], order: ['s1'], counts: null, runs: [], health: [], ruleOffers: [] } }
  const tree = HomeView({ state, now: NOW, navigate: () => {}, onOverlay: (overlay, detail) => overlays.push([overlay, detail]) })
  findButton(tree, 'Review in Needs you').props.onClick()
  assert.deepEqual(overlays, [['drawer', { request: 'r1' }]])
  const down = { ...state, data: { ...state.data, requests: [request()], health: [{ dep: 'deckd', state: 'down' }] } }
  const html = render(HomeView, { state: down, now: NOW, navigate: () => {} })
  assert.ok(disabled(button(html, 'Allow once')), 'HomeView hands its deckd state to the cards')
})
