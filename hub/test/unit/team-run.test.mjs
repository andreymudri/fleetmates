import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const screens = path.join(hub, 'web/src/screens')

async function load(name) {
  const { module } = await runnerImport(path.join(screens, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const MIN = 60_000
// Local wall-clock times so the rendered clock reads the same in every time zone.
const NOW = new Date(2026, 8, 30, 14, 14).getTime()
const GATE_AT = new Date(2026, 8, 30, 13, 2).getTime()
const REPO_ID = '/home/you/dev/fleetmates'

// Walk a tree of pure components, expanding function components; CrewAvatar (a memo object) is left as is.
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
const find = (tree, predicate) => {
  const out = []
  walk(tree, node => { if (predicate(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const strip = html => html.replace(/<[^>]+>/g, '')

function task(id, phase, state, extra = {}) {
  return { id, title: `Task ${id}`, state, phase, phaseLabel: `Phase ${phase}`, files: [], deps: [], tier: null, startedAt: null, blockedBy: null, ...extra }
}

// The canvas `team` run (team-run.md section 10): 9 tasks, gate 1 PASS at 13:02, derivedPhase 2.
function teamRun(overrides = {}) {
  return {
    repoId: REPO_ID,
    runId: 'gate-cli',
    kind: 'build',
    leadSessionId: 'L1',
    derivedPhase: 2,
    phaseDerivation: 'verified',
    // A stale status.phase stand-in: the page must never read it (fleetmates contract 3).
    phase: 1,
    totalPhases: 4,
    maxParallel: 4,
    planPath: 'docs/plans/2026-09-20-gate-cli.md',
    runBranch: 'run/gate-cli',
    tasks: [
      task('T1', 1, 'done', { files: ['a.mjs'] }),
      task('T2', 1, 'done', { files: ['b.mjs'] }),
      task('T3', 2, 'done', { title: 'Move verifyDelivery into packages/gate', files: ['1', '2', '3', '4'] }),
      task('T4', 2, 'running', { title: 'CLI entry: fleetmates-gate check', startedAt: NOW - 30 * MIN }),
      task('T5', 2, 'running', { startedAt: NOW - 20 * MIN }),
      task('T6', 2, 'running', { startedAt: NOW - 40 * MIN }),
      task('T7', 2, 'pending', { deps: ['T3'] }),
      task('T8', 3, 'pending', { title: 'end-to-end test of fleetmates-gate check' }),
      task('T9', 4, 'pending')
    ],
    gates: { 1: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [], phase: 1, phaseName: null, recordedAt: GATE_AT } },
    teammates: [],
    readError: null,
    ...overrides
  }
}

function teamState({ lead = true, requests = true, deckdOutage = false } = {}) {
  const sessions = lead ? [{
    id: 'L1', repoId: REPO_ID, role: 'lead', origin: 'wrapped', alive: true, state: 'needs_approval',
    task: 'Extract the phase gate into a CLI', startedAt: NOW - 72 * MIN, lastActivityAt: NOW - MIN,
    runRef: { repoId: REPO_ID, runId: 'gate-cli', taskId: 'T6' }
  }] : []
  return {
    loaded: true,
    deckdOutage,
    data: {
      sessions,
      requests: lead && requests ? [
        { id: 'R4', sessionId: 'L1', kind: 'permission', tier: 'caution', summary: 'npm install commander@14 -w packages/gate', state: 'open', taskId: 'T4', createdAt: NOW - 5 * MIN },
        { id: 'R5', sessionId: 'L1', kind: 'permission', tier: 'caution', summary: 'git push', state: 'open', taskId: 'T5', createdAt: NOW - 4 * MIN }
      ] : [],
      runs: [],
      repos: [{ id: REPO_ID, name: 'fleetmates', crew: { slot: 2, seed: 'fleetmates', hat: 'none' } }]
    }
  }
}

function viewProps(extra = {}) {
  return {
    state: teamState(),
    run: teamRun(),
    repoKey: 'fleetmates',
    now: NOW,
    navigate: () => {},
    crew: { lead: [], tasks: {} },
    ...extra
  }
}

test('team: the timeline shows 4 phases and 3 gates from derivedPhase, never status.phase (AC1, AC3)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const html = render(TeamRunView, viewProps())
  const phases = html.match(/<section[^>]*aria-label="Phases"[\s\S]*?<\/section>/)?.[0] ?? ''
  assert.equal((phases.match(/class="team-phase(?: [^"]*)?"/g) ?? []).length, 4)
  assert.equal((phases.match(/class="team-gate(?: [^"]*)?"/g) ?? []).length, 3)
  assert.match(phases, /Phase 1, done/)
  assert.match(phases, /Phase 2, active/)
  assert.match(phases, /Phase 4, pending/)
  assert.match(phases, /Gate 1 passed/)
  assert.match(phases, /Gate 2(?! passed)(?! failed)/)
  assert.doesNotMatch(phases, /checking/)
  assert.match(html, /<h2[^>]*>Phase 2 · tasks 3 to 7<\/h2>/)
  assert.match(strip(html), /Gate 1 passed at 13:02\./)
  assert.match(strip(html), /Gate 2 runs when tasks 3 to 7 are merged\./)
})

test('team: a solo gate record (phase null, key solo:<name>) never numbers the banner NaN', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const run = teamRun()
  const pass = run.gates[1]
  run.gates = { 1: { ...pass, recordedAt: GATE_AT }, 'solo:1': { verdict: 'PASS', phase: null, phaseName: '1', recordedAt: GATE_AT + 1000 } }
  const text = strip(render(TeamRunView, viewProps({ run })))
  assert.match(text, /Gate 1 passed at 13:02\./)
  assert.doesNotMatch(text, /NaN/)
})

test('team: task rows carry the literal state labels and the header pill counts who needs you (AC2)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const tree = TeamRunView(viewProps())
  const rows = find(tree, node => node.props?.['data-task'] && node.props?.className?.includes('team-task '))
  const label = id => textOf(find(rows.find(row => row.props['data-task'] === id), node => node.props?.className === 'status-label')[0])
  assert.deepEqual(rows.map(row => row.props['data-task']), ['T3', 'T4', 'T5', 'T6', 'T7'])
  assert.deepEqual(['T3', 'T4', 'T5', 'T6', 'T7'].map(label), ['Done', 'Needs approval', 'Needs approval', 'Running', 'Pending'])
  const html = render(TeamRunView, viewProps())
  assert.match(html, /2 of 4 need you/)
  assert.match(strip(html), /waiting on your approval \(npm install commander@14 -w packages\/gate, Caution\)/)
  assert.match(strip(html), /merged · 4 files/)
  assert.match(html, /Review 2 requests/)
  // TEAM-O8: "Done" stays a claim until a later gate PASS is recorded.
  assert.doesNotMatch(html.match(/<li[^>]*data-task="T3"[\s\S]*?<\/li>/)?.[0] ?? '', /verified by Gate/)
  const verified = teamRun()
  verified.gates = { ...verified.gates, 2: { ...verified.gates[1], phase: 2 } }
  const after = render(TeamRunView, viewProps({ run: verified }))
  assert.match(after.match(/<li[^>]*data-task="T3"[\s\S]*?<\/li>/)?.[0] ?? '', /title="Claimed by the teammate; verified by Gate 2"/)
})

test('team: a lead that claims no task is not a worker, so the canvas pill reads 2 of 4 need you (AC2, TEAM-O7)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const state = teamState()
  state.data.sessions[0].runRef = { ...state.data.sessions[0].runRef, taskId: null }
  const html = render(TeamRunView, viewProps({ state }))
  assert.match(html, /2 of 4 need you/)
  assert.doesNotMatch(html, /of 5 need you/)
})

test('team: a lead request with no task claim sets the header pill to needs you, counting task workers only (TEAM-O7)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const run = teamRun({ derivedPhase: 1, totalPhases: 1, gates: {}, tasks: [task('T1', 1, 'running', { startedAt: NOW - 10 * MIN })] })
  const state = teamState({ requests: false })
  state.data.sessions[0].runRef = { ...state.data.sessions[0].runRef, taskId: null }
  state.data.requests = [{ id: 'R1', sessionId: 'L1', kind: 'permission', tier: 'caution', summary: 'npm publish', state: 'open', taskId: null, createdAt: NOW - MIN }]
  const html = render(TeamRunView, viewProps({ state, run }))
  const header = html.match(/<header class="team-header">[\s\S]*?<\/header>/)?.[0] ?? ''
  const pills = header.match(/<span class="status-pill [^"]*">[\s\S]*?<span class="status-label">[^<]*<\/span><\/span>/g) ?? []
  assert.equal(pills.length, 1)
  assert.match(pills[0], /status-pill--needs-approval/)
  assert.match(pills[0], /<span class="status-label">Needs approval<\/span>/)
  // The lead is not a worker: its own request never turns into "1 of 1" or "1 of 2 need you".
  assert.doesNotMatch(html, /\d+ of \d+ need you/)
  assert.match(html.match(/<li[^>]*data-task="T1"[\s\S]*?<\/li>/)?.[0] ?? '', /Running/)
})

test('team: a task row with a request opens the drawer filtered to that task', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const seen = []
  const tree = TeamRunView(viewProps({ onReview: filter => seen.push(filter) }))
  const button = find(tree, node => node.type === 'button' && node.props?.['data-task'] === 'T4')[0]
  button.props.onClick({ preventDefault() {} })
  const review = find(tree, node => node.type === 'button' && textOf(node) === 'Review 2 requests')[0]
  review.props.onClick({ preventDefault() {} })
  assert.deepEqual(seen, [{ kind: 'task', runId: 'gate-cli', taskId: 'T4' }, { kind: 'run', runId: 'gate-cli' }])
})

test('team: a failed task reads Failed with the crashed tokens and the doctor sub line (AC5)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const run = teamRun()
  run.tasks = run.tasks.map(row => row.id === 'T6' ? { ...row, state: 'failed' } : row)
  const html = render(TeamRunView, viewProps({ run }))
  const row = html.match(/<li[^>]*data-task="T6"[\s\S]*?<\/li>/)?.[0] ?? ''
  assert.match(row, /status-pill--crashed/)
  assert.match(row, />Failed</)
  assert.match(strip(row), /failed · see fleetmates doctor/)
})

test('team: a task title holding HTML renders as text (AC9)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const run = teamRun()
  run.tasks = run.tasks.map(row => row.id === 'T4' ? { ...row, title: '<img src=x onerror=alert(1)>' } : row)
  const html = render(TeamRunView, viewProps({ run }))
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('team: a teammate crew panel header links to the lead Focus with the task filter (D-69)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const crew = { lead: [{ seq: 1, at: NOW - MIN, line: 'Read plan.json', status: 'ok', taskId: null }], tasks: { T4: [{ seq: 2, at: NOW - MIN, line: 'npm install commander@14', status: 'running', taskId: 'T4' }] } }
  const html = render(TeamRunView, viewProps({ crew }))
  const panels = html.match(/<section[^>]*aria-label="Crew activity"[\s\S]*<\/section>/)?.[0] ?? ''
  assert.match(panels, /href="\/s\/L1\?needs=task%3Agate-cli%3AT4"/)
  assert.match(panels, /href="\/s\/L1"/)
  assert.match(panels, /role="log" aria-live="off"/)
  assert.match(strip(panels), /lead · T6/)
  assert.match(strip(panels), /Tool steps only\. Teammate messages are not visible to the deck\./)
  assert.match(strip(panels), /npm install commander@14/)
})

test('team: elapsed comes from the lead, else the earliest task start, else it is hidden (TEAM-O3)', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  assert.match(render(TeamRunView, viewProps()), /running 1h 12m/)
  const noLead = viewProps({ state: teamState({ lead: false }) })
  assert.match(render(TeamRunView, noLead), /running 40m/)
  const run = teamRun({ leadSessionId: null })
  run.tasks = run.tasks.map(row => ({ ...row, startedAt: null }))
  const html = render(TeamRunView, viewProps({ run, state: teamState({ lead: false }) }))
  assert.doesNotMatch(strip(html), /running \d/)
  assert.doesNotMatch(html, /team-elapsed/)
})

test('team: Stop run is hidden without a lead and disabled with the reason while deckd is down', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  assert.match(render(TeamRunView, viewProps()), /<button[^>]*>Stop run…<\/button>/)
  const down = render(TeamRunView, viewProps({ state: teamState({ deckdOutage: true }) }))
  assert.match(down, /<button[^>]*disabled=""[^>]*>Stop run…<\/button>/)
  assert.match(strip(down), /deckd is reconnecting/)
  const noLead = render(TeamRunView, viewProps({ state: teamState({ lead: false }), run: teamRun({ leadSessionId: null }) }))
  assert.doesNotMatch(noLead, /Stop run/)
  assert.doesNotMatch(noLead, /Review \d/)
})

test('team: the Stop run dialog passes no cancelLabel, so its Cancel button reads confirm.cancel', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const { CONFIRM_COPY } = await runnerImport(path.join(hub, 'web/src/components/ConfirmDialog.jsx'), { configFile: false, logLevel: 'silent', root: hub }).then(r => r.module)
  const { messages: en, format } = await runnerImport(path.join(hub, 'web/src/i18n/en.js'), { configFile: false, logLevel: 'silent', root: hub }).then(r => r.module)
  // The shell's English translator (App.jsx): en.js first, then the screen's own copy through translate.
  const t = (key, params) => format(en[key] ?? key, params, 'en')
  const expected = en['confirm.cancel'] ?? CONFIRM_COPY['confirm.cancel']
  assert.equal(expected, 'Cancel')
  const html = render(TeamRunView, viewProps({ confirming: true, t }))
  assert.match(html, /role="dialog"/)
  const cancel = html.match(/<button[^>]*data-initial-focus="true"[^>]*>([^<]*)<\/button>/)
  assert.ok(cancel, 'the dialog renders its Cancel button')
  assert.equal(cancel[1], expected)
})

test('team: an unreadable status keeps the last good data dimmed with the error banner', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const run = teamRun({ readError: { file: 'status.json', message: 'Malformed JSON' } })
  const html = render(TeamRunView, viewProps({ run, asOf: GATE_AT }))
  assert.match(strip(html), /status\.json could not be read: Malformed JSON\. Retrying\./)
  assert.match(strip(html), /as of 13:02/)
  assert.match(html, /team-body--dim/)
  assert.match(html, /Phase 2 · tasks 3 to 7/)
})

test('team: integrated, empty-phase, derive-failure and not-found states', async () => {
  const { TeamRunView } = await load('team-run/TeamRun.jsx')
  const integrated = render(TeamRunView, viewProps({ run: teamRun({ derivedPhase: null }) }))
  assert.match(strip(integrated), /Run integrated\. Every phase is merged\./)
  assert.match(integrated, /Phase 4, done/)
  const unknown = render(TeamRunView, viewProps({ run: teamRun({ derivedPhase: null, phaseDerivation: 'unknown' }) }))
  assert.match(strip(unknown), /Phase unknown: /)
  assert.doesNotMatch(strip(unknown), /Run integrated/)
  const empty = teamRun({ totalPhases: 5 })
  empty.derivedPhase = 5
  assert.match(strip(render(TeamRunView, viewProps({ run: empty }))), /No tasks in this phase\./)
  assert.match(strip(render(TeamRunView, viewProps({ run: null, notFound: true }))), /This run is not on the deck\./)
  const loading = render(TeamRunView, viewProps({ run: null }))
  assert.match(loading, /aria-busy="true"/)
})

test('team: an unknown repoKey with ?repoId= redirects to that repo current key (API-O2)', async () => {
  const { teamRedirect } = await load('team-run/TeamRun.jsx')
  const repos = teamState().data.repos
  assert.equal(teamRedirect(repos, 'old-name', '2026/substop', `?repoId=${encodeURIComponent(REPO_ID)}`), '/runs/fleetmates/2026%2Fsubstop')
  assert.equal(teamRedirect(repos, 'fleetmates', 'gate-cli', `?repoId=${encodeURIComponent(REPO_ID)}`), null)
  assert.equal(teamRedirect(repos, 'old-name', 'gate-cli', '?repoId=%2Fhome%2Fyou%2Fdev%2Fnope'), null)
  assert.equal(teamRedirect(repos, 'old-name', 'gate-cli', ''), null)
  // A repoKey the deck knows is never redirected, even when ?repoId= names another repo.
  const two = [...repos, { id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 3, seed: 'rustot', hat: 'none' } }]
  assert.equal(teamRedirect(two, 'rustot', 'gate-cli', `?repoId=${encodeURIComponent(REPO_ID)}`), null)
})

test('plan: markdown renders as React text; HTML stays text, javascript: links and images are dropped', async () => {
  const { renderMarkdown, planHeading } = await load('team-run/PlanDrawer.jsx')
  const markdown = [
    '# Gate CLI plan',
    '',
    '<script>alert(1)</script>',
    '',
    'Inline <b>bold</b> and [bad](javascript:alert(1)) and [good](https://example.com/x) and [mail](mailto:you@example.com).',
    '',
    '![pixel](https://example.com/p.png)',
    '',
    '- one',
    '- `two`',
    '',
    '```js',
    'const x = "<b>"',
    '```'
  ].join('\n')
  const html = renderToStaticMarkup(createElement('div', null, renderMarkdown(markdown)))
  assert.match(html, /<h1>Gate CLI plan<\/h1>/)
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/)
  assert.doesNotMatch(html, /href="javascript:/)
  // markdown-it accepts mailto: links; the renderer keeps only http and https.
  assert.doesNotMatch(html, /href="mailto:/)
  assert.match(html, /and mail\./)
  assert.match(html, /<a href="https:\/\/example\.com\/x" rel="noreferrer noopener" target="_blank">good<\/a>/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /<li>one<\/li>/)
  assert.match(html, /<code>two<\/code>/)
  assert.match(html, /<pre><code>const x = &quot;&lt;b&gt;&quot;\n<\/code><\/pre>/)
  assert.equal(planHeading(markdown), 'Gate CLI plan')
  assert.equal(planHeading('no heading here'), null)
})

test('plan: escape, bell and bidi controls in text, inline code and fences render as visible tokens (qa 1.7)', async () => {
  const { renderMarkdown } = await load('team-run/PlanDrawer.jsx')
  const markdown = ['# Head \u202Eevil', '', 'text \u001b[31m and \u0007 and `co\u202Ede`', '', '```', 'fen\u001bce\u0007\tcol', 'line 2', '```', '', '    blo\u202Eck'].join('\n')
  const html = renderToStaticMarkup(createElement('div', null, renderMarkdown(markdown)))
  assert.doesNotMatch(html, /[\u001b\u0007\u202e]/, 'no raw ESC, BEL or U+202E reaches the markup')
  assert.match(html, /<h1>Head &lt;U\+202E&gt;evil<\/h1>/)
  assert.match(html, /text &lt;U\+001B&gt;\[31m and &lt;U\+0007&gt; and <code>co&lt;U\+202E&gt;de<\/code>/)
  assert.match(html, /<pre><code>fen&lt;U\+001B&gt;ce&lt;U\+0007&gt;\tcol\nline 2\n<\/code><\/pre>/, 'a fence keeps its tabs and line feeds')
  assert.match(html, /<pre><code>blo&lt;U\+202E&gt;ck\n<\/code><\/pre>/)
})

test('plan: prose keeps emoji sequences whole and still shows ESC, BEL and U+202E as tokens; code keeps shown', async () => {
  const { renderMarkdown } = await load('team-run/PlanDrawer.jsx')
  const emoji = '\u26A0\uFE0F Risk: \u{1F469}\u200D\u{1F4BB} owns the \u2764\uFE0F step'
  const html = renderToStaticMarkup(createElement('div', null, renderMarkdown(`${emoji}\n\n- ${emoji}\n\n\`a\u200Db\``)))
  assert.equal(html.split(emoji).length - 1, 2, 'the paragraph and the list item render the emoji unchanged')
  assert.match(html, /<code>a&lt;U\+200D&gt;b<\/code>/, 'inline code still shows the joiner')
  const controls = renderToStaticMarkup(createElement('div', null, renderMarkdown('pro\u001bse \u0007 and \u202Eend')))
  assert.doesNotMatch(controls, /[\u001b\u0007\u202E]/)
  assert.match(controls, /<p>pro&lt;U\+001B&gt;se &lt;U\+0007&gt; and &lt;U\+202E&gt;end<\/p>/)
})

test('plan: the drawer dialog is a section, a role axe allows (aria-allowed-role)', async () => {
  const { PlanDrawerView } = await load('team-run/PlanDrawer.jsx')
  const html = renderToStaticMarkup(PlanDrawerView({ plan: null, onClose: () => {}, onOpenInEditor: () => {} }))
  assert.match(html, /<section class="plan-drawer" role="dialog"/)
  assert.doesNotMatch(html, /<aside/)
})

test('plan: the drawer view shows the markdown read-only with Open in editor as the secondary action', async () => {
  const { PlanDrawerView } = await load('team-run/PlanDrawer.jsx')
  const opened = []
  const tree = PlanDrawerView({ plan: { path: 'docs/plans/x.md', markdown: '# X\n\nbody', truncated: true }, onClose: () => {}, onOpenInEditor: () => opened.push(1) })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /docs\/plans\/x\.md/)
  assert.match(html, /<h1>X<\/h1>/)
  assert.match(strip(html), /The plan is longer than 256 KiB/)
  const editor = find(tree, node => node.type === 'button' && textOf(node) === 'Open in editor')[0]
  editor.props.onClick()
  assert.deepEqual(opened, [1])
  assert.match(renderToStaticMarkup(PlanDrawerView({ plan: null, onClose: () => {}, onOpenInEditor: () => {} })), /aria-busy="true"/)
})
