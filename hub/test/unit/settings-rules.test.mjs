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

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const rules = await load('screens/settings/ApprovalRules.jsx')
const settings = await load('screens/settings/Settings.jsx')
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

// Walk a tree of pure components (no hooks), expanding function components.
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const elements = (tree, type) => {
  const out = []
  walk(tree, node => { if (node.type === type) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}

const SEP_26 = Date.UTC(2026, 8, 26, 12)
const SEP_12 = Date.UTC(2026, 8, 12, 12)
const rule = (pattern, extra = {}) => ({ pattern, source: 'manual', approvalsBefore: null, createdAt: null, tier: 'safe', ...extra })
// settings.md AC1 `rules5`: three repos holding 2, 2 and 1 rules, placeholder paths only.
const rules5 = Object.freeze({
  threshold: 5,
  tiersError: null,
  repos: [
    { repoKey: 'rustot', repoId: '/home/you/dev/rustot', settingsPath: '/home/you/dev/rustot/.claude/settings.local.json', rules: [
      rule('Bash(cargo test:*)', { source: 'suggested', approvalsBefore: 5, createdAt: SEP_26, repoId: '/home/you/dev/rustot' }),
      rule('Bash(cargo clippy:*)', { createdAt: SEP_12, repoId: '/home/you/dev/rustot' })
    ] },
    { repoKey: 'api', repoId: '/home/you/dev/api', settingsPath: '/home/you/dev/api/.claude/settings.local.json', rules: [
      rule('WebFetch(domain:docs.nestjs.com)', { tier: 'caution', repoId: '/home/you/dev/api' }),
      rule('Bash(npm run test)', { repoId: '/home/you/dev/api' })
    ] },
    { repoKey: 'notes', repoId: '/home/you/dev/notes', settingsPath: '/home/you/dev/notes/.claude/settings.local.json', rules: [
      rule('mcp__vault__vault_search', { repoId: '/home/you/dev/notes' })
    ] }
  ]
})
const noop = () => {}
const view = (props = {}) => ({ data: rules5, onThreshold: noop, onRevoke: noop, onAdd: noop, onRetry: noop, ...props })

test('settings AC1: rules5 renders three repo sections of 2, 2 and 1 rules and the nav reads "5 rules in 3 repos"', () => {
  const html = render(rules.ApprovalRulesView, view())
  const sections = html.split('<section class="rules-repo"').slice(1)
  assert.equal(sections.length, 3)
  assert.deepEqual(sections.map(part => (part.match(/<li class="rule-row/g) ?? []).length), [2, 2, 1])
  assert.match(sections[0], /~\/dev\/rustot/, 'the repo path is shown with ~')
  assert.doesNotMatch(html, /\/home\/you/, 'no home path is rendered')
  assert.match(sections[0], /2 rules/)
  assert.match(sections[2], /1 rule</)
  assert.equal(settings.settingsNav({}, undefined, rules5)[1].sub, '5 rules in 3 repos')
  // A repo whose settings file holds no rule is listed, but it is not one of the repos that have rules.
  const withEmpty = { ...rules5, repos: [...rules5.repos, { repoKey: 'empty', repoId: '/home/you/dev/empty', settingsPath: '/home/you/dev/empty/.claude/settings.local.json', rules: [] }] }
  assert.equal(settings.settingsNav({}, undefined, withEmpty)[1].sub, '5 rules in 3 repos')
  assert.equal(settings.settingsNav({}, undefined, { repos: [{ repoKey: 'one', repoId: '/x/one', rules: [rule('Bash(ls)')] }] })[1].sub, '1 rule in 1 repo')
  const nav = render(settings.SettingsView, { section: 'rules', prefs: {}, rules: rules5, navigate: noop, children: 'BODY' })
  assert.match(nav, /5 rules in 3 repos/)
  assert.match(nav, /BODY/, 'Approval rules is a rendered section')
})

test('a rule with a null createdAt reads "added by hand" with no date; dated rules carry their source and date', () => {
  assert.equal(rules.ruleMeta(rule('Bash(ls)')), 'added by hand')
  assert.equal(rules.ruleMeta(rule('Bash(ls)', { createdAt: SEP_12 })), 'added by hand · 12 Sep')
  assert.equal(rules.ruleMeta(rule('Bash(ls)', { source: 'suggested', approvalsBefore: 5, createdAt: SEP_26 })), 'from 5 approvals · 26 Sep')
  const html = render(rules.ApprovalRulesView, view())
  assert.match(html, /<span class="rule-meta">added by hand<\/span>/)
  assert.match(html, /<span class="rule-meta">from 5 approvals · 26 Sep<\/span>/)
})

test('the revoke confirm has Cancel first and focused, and "Revoke rule" is the only red control and not the default', () => {
  const html = render(rules.RevokeDialog, { repo: rules5.repos[0], rule: rules5.repos[0].rules[0], onConfirm: noop, onCancel: noop })
  assert.match(html, /Revoke Bash\(cargo test:\*\) in rustot\?/)
  assert.match(html, /Removes the rule from ~\/dev\/rustot\/\.claude\/settings\.local\.json\./)
  const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({ attrs, label }))
  assert.deepEqual(buttons.map(button => button.label), ['Cancel', 'Revoke rule'])
  assert.match(buttons[0].attrs, /data-initial-focus="true"/)
  assert.doesNotMatch(buttons[1].attrs, /data-initial-focus|autofocus/i)
  assert.match(buttons[1].attrs, /type="button"/, '"Revoke rule" is not a submit default')
  assert.equal((html.match(/button--danger/g) ?? []).length, 1)
  assert.match(buttons[1].attrs, /button--danger/)
  // The row button is neutral.
  const row = elements(rules.ApprovalRulesView(view()), 'button').find(node => textOf(node) === 'Revoke…')
  assert.match(row.props.className, /button--secondary/)
  assert.doesNotMatch(row.props.className, /danger/)
})

test('a destructive_rule refusal from the server renders the Decided copy in the Add dialog', () => {
  const refusal = Object.assign(new Error('pattern matches a Destructive entry'), { code: 'destructive_rule', details: {} })
  const text = rules.ruleErrorText(refusal, rules5.repos[0])
  assert.equal(text, 'Destructive commands can never become rules.')
  const html = render(rules.AddRuleDialog, { repo: rules5.repos[0], pattern: 'Bash(git push --force:*)', error: text, onPattern: noop, onSubmit: noop, onCancel: noop })
  assert.match(html, /role="alert"[^>]*><bdi>Destructive commands can never become rules\.<\/bdi>/)
  const io = Object.assign(new Error('EACCES'), { code: 'settings_io_failed', details: { path: '/home/you/dev/rustot/.claude/settings.local.json', errno: 'EACCES' } })
  assert.equal(rules.ruleErrorText(io, rules5.repos[0]), 'Could not write ~/dev/rustot/.claude/settings.local.json: EACCES. Nothing changed.')
})

test('the threshold Select is labelled, offers 5, 3 and Never, and sends null for "Never suggest"', () => {
  const sent = []
  const tree = rules.ApprovalRulesView(view({ onThreshold: value => sent.push(value) }))
  const [select] = elements(tree, 'select')
  assert.equal(select.props['aria-label'], 'Approvals before suggesting')
  assert.deepEqual(elements(select, 'option').map(textOf), ['5 times', '3 times', 'Never suggest'])
  assert.equal(select.props.value, '5')
  select.props.onChange({ target: { value: 'never' } })
  select.props.onChange({ target: { value: '3' } })
  select.props.onChange({ target: { value: '5' } })
  assert.deepEqual(sent, [null, 3, 5])
  assert.equal(elements(rules.ApprovalRulesView(view({ threshold: null })), 'select')[0].props.value, 'never')
})

test('the section shows the intro, tier aside, tracked note, Destructive line, tiers.json error, read error and empty text, all as text', () => {
  const data = {
    threshold: 5,
    tiersError: { line: 7, message: 'Unexpected token <b>' },
    repos: [
      { repoKey: 'rustot', repoId: '/home/you/dev/rustot', settingsPath: '/home/you/dev/rustot/.claude/settings.local.json', rules: [
        rule('Bash(rm -rf <script>:*)', { tier: 'destructive', destructive: true, tracked: true })
      ] },
      { repoKey: 'api', repoId: '/home/you/dev/api', settingsPath: '/home/you/dev/api/.claude/settings.local.json', readError: { file: '/home/you/dev/api/.claude/settings.local.json', message: 'Unexpected end of JSON input' }, rules: [] },
      { repoKey: 'empty', repoId: '/home/you/dev/empty', settingsPath: '/home/you/dev/empty/.claude/settings.local.json', rules: [] }
    ]
  }
  const html = render(rules.ApprovalRulesView, view({ data }))
  assert.match(html, /Rules live in each repo&#x27;s \.claude\/settings\.local\.json/)
  assert.match(html, /<aside class="rules-tiers" aria-label="Risk tiers"><h3[^>]*>How the deck sorts requests<\/h3>/)
  assert.match(html, /tiers\.json has an error on line 7: Unexpected token &lt;b&gt; Using the previous tiers\./)
  assert.match(html, /tier-badge--destructive">Destructive<\/span><code class="rule-pattern">Bash\(rm -rf &lt;script&gt;:\*\)<\/code>/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /This rule lets Claude run a Destructive command without asking\./)
  assert.match(html, /This file is tracked by git in rustot; the rule will be committed with it\./)
  assert.match(html, /Could not read ~\/dev\/api\/\.claude\/settings\.local\.json: Unexpected end of JSON input\.<\/bdi><\/p><button[^>]*>Retry<\/button>/)
  assert.equal((html.match(/No approval rules yet\./g) ?? []).length, 1, 'the empty text shows for the readable repo without rules only')
  assert.equal((html.match(/Add a rule…/g) ?? []).length, 3, 'one "Add a rule…" per repo')
  assert.match(render(rules.ApprovalRulesView, view({ data: { threshold: 5, repos: [] } })), /No approval rules yet\./)
})

test('the Add dialog warns "Allows every {tool} call in {repo}" for a tool-wide pattern before saving', () => {
  assert.equal(rules.toolWideOf('WebFetch'), 'WebFetch')
  assert.equal(rules.toolWideOf('WebFetch(domain:docs.nestjs.com)'), null)
  assert.equal(rules.toolWideOf('mcp__vault__vault_search'), null)
  assert.equal(rules.toolWideOf('Edit'), null, 'refused by the server, so no warning')
  const html = render(rules.AddRuleDialog, { repo: rules5.repos[0], pattern: 'WebFetch', onPattern: noop, onSubmit: noop, onCancel: noop })
  assert.match(html, /Allows every WebFetch call in rustot/)
  assert.doesNotMatch(render(rules.AddRuleDialog, { repo: rules5.repos[0], pattern: 'Bash(ls)', onPattern: noop, onSubmit: noop, onCancel: noop }), /Allows every/)
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

// A page that mounts the stateful Settings on /settings/rules with a recording api; `window.h.bump()` raises rulesRev.
const HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Settings } from '@hub/web/src/screens/settings/Settings.jsx'

const h = window.h = { calls: [], toasts: [], rules: ${JSON.stringify(rules5)} }
const refuse = (code, message, details = {}) => Promise.reject(Object.assign(new Error(message), { code, details }))
const api = {
  get: url => {
    h.calls.push(['GET', url])
    return Promise.resolve(url === '/api/rules' ? h.rules : { prefs: {}, sources: {} })
  },
  patch: (url, body) => { h.calls.push(['PATCH', url, body])
    return Promise.resolve({}) },
  post: (url, body) => {
    h.calls.push(['POST', url, body])
    return body?.pattern?.startsWith('Bash(git push') ? refuse('destructive_rule', 'pattern matches a Destructive entry') : Promise.resolve({ rule: {} })
  },
  del: url => { h.calls.push(['DELETE', url])
    return Promise.resolve({ removed: true }) }
}
function App() {
  const [rev, setRev] = useState(0)
  h.bump = () => setRev(n => n + 1)
  const state = { data: { prefs: { ruleSuggestAfter: 5 }, health: [], repos: [], rulesRev: rev } }
  return <Settings route={{ params: { section: 'rules' } }} state={state} navigate={() => {}} api={api} dispatch={action => h.toasts.push(action)} />
}
createRoot(document.getElementById('root')).render(<App />)
`

test('in the browser: Cancel takes focus, a revoke toasts and re-reads, rulesRev re-fetches, Never saves null, and Add shows the refusal', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Approval rules browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'rules-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>')
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
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    server.close() })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForSelector('.rule-row', { timeout: 10_000 })
  assert.equal(await page.locator('.settings-nav-link[aria-current="page"] .settings-nav-sub').textContent(), '5 rules in 3 repos')
  const rulesGets = () => page.evaluate(() => window.h.calls.filter(call => call[0] === 'GET' && call[1] === '/api/rules').length)
  assert.equal(await rulesGets(), 1)

  await page.evaluate(() => window.h.bump())
  await page.waitForFunction(() => window.h.calls.filter(call => call[1] === '/api/rules').length === 2, null, { timeout: 5000 })

  await page.getByLabel('Approvals before suggesting').selectOption('never')
  await page.waitForFunction(() => window.h.calls.some(call => call[0] === 'PATCH'), null, { timeout: 5000 })
  assert.deepEqual(await page.evaluate(() => window.h.calls.filter(call => call[0] === 'PATCH')), [['PATCH', '/api/prefs', { ruleSuggestAfter: null }]])

  await page.locator('.rule-row', { hasText: 'Bash(cargo test:*)' }).getByRole('button', { name: 'Revoke…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Revoke Bash(cargo test:*) in rustot?' })
  await dialog.waitFor({ timeout: 5000 })
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel takes the initial focus')
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'detached', timeout: 5000 })
  assert.equal(await page.evaluate(() => window.h.calls.some(call => call[0] === 'DELETE')), false, 'Enter on the initial focus cancels')
  await page.locator('.rule-row', { hasText: 'Bash(cargo test:*)' }).getByRole('button', { name: 'Revoke…' }).click()
  await dialog.getByRole('button', { name: 'Revoke rule' }).click()
  await page.waitForFunction(() => window.h.toasts.length === 1, null, { timeout: 5000 })
  assert.deepEqual(await page.evaluate(() => window.h.calls.filter(call => call[0] === 'DELETE')), [['DELETE', '/api/rules/rustot/Bash(cargo%20test%3A*)']])
  assert.deepEqual(await page.evaluate(() => window.h.toasts), [{ type: 'toast.push', tone: 'success', title: 'Rule revoked in rustot', body: 'Running sessions may keep the old rule until they restart.' }])
  await page.waitForFunction(() => window.h.calls.filter(call => call[1] === '/api/rules').length === 3, null, { timeout: 5000 })

  await page.locator('.rules-repo', { hasText: 'rustot' }).getByRole('button', { name: 'Add a rule…' }).click()
  await page.getByLabel('Pattern').fill('Bash(git push --force:*)')
  await page.getByRole('button', { name: 'Add rule' }).click()
  // The intro carries the same sentence, so read the dialog's own alert line.
  const alert = page.locator('.rules-add-dialog [role="alert"]')
  await alert.waitFor({ timeout: 5000 })
  assert.equal(await alert.textContent(), 'Destructive commands can never become rules.')
  assert.deepEqual(await page.evaluate(() => window.h.calls.filter(call => call[0] === 'POST')), [['POST', '/api/rules', { repoKey: 'rustot', pattern: 'Bash(git push --force:*)', source: 'manual' }]])
  assert.deepEqual(errors, [])
})
