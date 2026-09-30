import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const components = path.join(hub, 'web/src/components')

async function load(name) {
  const { module } = await runnerImport(path.join(components, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 8, 30, 18, 42)
const MIN = 60_000

// Every SessionState from docs/deck/02-domain.md section 3 with its literal pill label,
// design-system 3.4 icon and crew.md 6 pose.
const STATES = [
  ['starting', {}, 'Starting', 'loader-circle', 'running'],
  ['running', {}, 'Running', null, 'running'],
  ['needs_approval', {}, 'Needs approval', 'bell', 'needs'],
  ['asked_you', {}, 'Asked you', 'bell', 'needs'],
  ['done', {}, 'Done', 'check', 'done'],
  ['stale', { n: 22 }, 'No activity 22m', 'waves', 'idle'],
  ['idle', { duration: '1h' }, 'Idle 1h', 'moon', 'idle'],
  ['reviewed', {}, 'Reviewed', 'check-check', 'done'],
  ['crashed', { code: 1 }, 'Crashed · exit 1', 'x', 'crashed'],
  ['ended', {}, 'Ended', 'square', 'none']
]

test('every M1 session state maps to its literal pill label, icon and crew pose', async () => {
  const { StatusPill, stateLabel, SESSION_STATES } = await load('StatusPill.jsx')
  const { poseFor } = await load('CrewAvatar.jsx')
  assert.deepEqual([...SESSION_STATES].sort(), STATES.map(row => row[0]).sort())
  for (const [state, params, label, icon, pose] of STATES) {
    assert.equal(stateLabel(state, params), label, state)
    assert.equal(poseFor(state), pose, `pose for ${state}`)
    const html = render(StatusPill, { state, params })
    assert.match(html, new RegExp(`class="status-pill status-pill--pill status-pill--${state.replace('_', '-')}"`), state)
    assert.ok(html.includes(`>${label.replace(/·/g, '·')}</span>`), `${state} label in ${html}`)
    if (icon) assert.match(html, new RegExp(`data-icon="${icon}"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-icon="${icon}"`), `${state} icon`)
    else assert.match(html, /<span class="status-dot motion-breathe" aria-hidden="true"><\/span>/, 'running carries a breathing live dot')
    assert.doesNotMatch(html, /aria-live|role="status"/, 'pills are never live regions')
  }
  assert.equal(stateLabel('crashed', { kind: 'signal', signal: 'SIGKILL' }), 'Crashed · signal SIGKILL')
  assert.equal(stateLabel('crashed', { kind: 'lost' }), 'Crashed · lost')
  assert.equal(stateLabel('draft'), 'Draft · not saved')
  assert.match(render(StatusPill, { state: 'running', role: 'research' }), /data-icon="compass"/, 'research runs show the compass instead of the dot')
  assert.match(render(StatusPill, { state: 'needs_approval', label: '2 of 4 need you' }), />2 of 4 need you<\/span>/, 'literal override')
  assert.match(render(StatusPill, { state: 'idle', params: { duration: '3d' }, variant: 'text' }), /status-pill--text[\s\S]*data-icon="moon"/, 'text variant keeps the icon')
  const dot = render(StatusPill, { state: 'done', variant: 'dot' })
  assert.match(dot, /status-pill--dot/)
  assert.doesNotMatch(dot, /motion-breathe/, 'only running breathes')
  const t = key => key === 'state.asked_you.label' ? 'Perguntou' : key
  assert.equal(stateLabel('asked_you', {}, t), 'Perguntou', 'labels come from i18n keys when the catalog has them')
  assert.equal(stateLabel('done', {}, t), 'Done', 'missing keys fall back to the English copy')
})

test('pill params derive stale minutes, idle duration and crash kind from the session', async () => {
  const { pillParams, compactDuration } = await load('StatusPill.jsx')
  assert.equal(compactDuration(12 * MIN), '12m')
  assert.equal(compactDuration(72 * MIN), '1h 12m')
  assert.equal(compactDuration(60 * MIN), '1h')
  assert.equal(compactDuration(3 * 24 * 60 * MIN + 5 * MIN), '3d')
  assert.equal(compactDuration(20_000), '0m')
  assert.deepEqual(pillParams({ state: 'stale', lastActivityAt: NOW - 22 * MIN }, NOW), { n: 22 })
  assert.deepEqual(pillParams({ state: 'idle', stateSince: NOW - 61 * MIN }, NOW), { duration: '1h 1m' })
  assert.deepEqual(pillParams({ state: 'crashed', crashKind: 'exit', exitCode: 137 }, NOW), { kind: 'exit', code: 137 })
  assert.deepEqual(pillParams({ state: 'crashed', crashKind: 'signal', exitSignal: 'SIGKILL' }, NOW), { kind: 'signal', signal: 'SIGKILL' })
  assert.deepEqual(pillParams({ state: 'crashed', crashKind: 'lost' }, NOW), { kind: 'lost' })
  assert.deepEqual(pillParams({ state: 'running' }, NOW), {})
})

test('count chips read "3 need you", "2 running", "1 to review", hide zero and name their action', async () => {
  const { Counts, countLabel, requestSummary } = await load('Counts.jsx')
  const counts = { needYouSessions: 3, running: 2, toReview: 1, openRequests: 4, requestSessions: 3, oldestRequestAt: NOW - 9 * MIN, perRun: [] }
  const clicks = []
  const html = render(Counts, { counts, onNeeds: () => clicks.push('needs') })
  assert.match(html, /<div class="counts" role="group" aria-label="Session counts">/)
  const chips = [...html.matchAll(/<button type="button" class="count-chip count-chip--(\w+)"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
  assert.deepEqual(chips.map(chip => chip[1]), ['needs', 'running', 'review'])
  assert.deepEqual(chips.map(chip => chip[2]), ['3 sessions need you. Open Needs you', '2 running', '1 to review'])
  assert.match(chips[0][3], />3 need you<\/span>/)
  assert.match(chips[1][3], />2 running<\/span>/)
  assert.match(chips[2][3], />1 to review<\/span>/)
  assert.match(chips[0][3], /data-icon="bell"/)
  assert.match(chips[1][3], /data-icon="play"/)
  assert.match(chips[2][3], /data-icon="check"/)

  assert.equal(countLabel('needs', 1), '1 needs you')
  assert.equal(countLabel('needs', 1, { a11y: true }), '1 session needs you. Open Needs you')
  assert.equal(countLabel('needs', 1234), '1,234 need you', 'numbers use Intl grouping and never cap on chips')

  const quiet = render(Counts, { counts: { ...counts, needYouSessions: 0, toReview: 0, running: 0 } })
  assert.doesNotMatch(quiet, /count-chip--needs/, 'need you hides at zero')
  assert.doesNotMatch(quiet, /count-chip--review/, 'to review hides at zero')
  assert.match(quiet, /aria-label="0 running"/, 'running always shows')

  const loading = render(Counts, { counts: null })
  assert.match(loading, /<div class="counts counts--loading" aria-busy="true">/)
  assert.equal((loading.match(/class="count-skeleton motion-shimmer" aria-hidden="true"/g) ?? []).length, 3)
  assert.doesNotMatch(loading, /<button/, 'no chips before the snapshot')

  assert.equal(requestSummary(counts), '4 requests from 3 ships')
  assert.equal(requestSummary({ ...counts, openRequests: 1, requestSessions: 1 }), '1 request from 1 ship')
  assert.equal(requestSummary({ ...counts, openRequests: 0, requestSessions: 0 }), null)

  // Counts has no hooks, so calling it returns the element tree; each chip's onClick is its own handler.
  const tree = Counts({ counts, onNeeds: () => clicks.push('needs'), onRunning: () => clicks.push('running'), onReview: () => clicks.push('review') })
  const buttons = tree.props.children.filter(Boolean)
  assert.deepEqual(buttons.map(button => button.props.className), ['count-chip count-chip--needs', 'count-chip count-chip--running', 'count-chip count-chip--review'])
  for (const button of buttons) button.props.onClick()
  assert.deepEqual(clicks, ['needs', 'running', 'review'], 'each chip calls the handler for its own filter')
})

test('untrusted card text renders as literal text, never as markup', async () => {
  const { SessionCard, QuietCard } = await load('SessionCard.jsx')
  const payload = '<img src=x onerror=alert(1)>'
  const script = '<script>alert(1)</script>'
  const session = {
    id: 's1', repoId: '/home/you/dev/rustot', task: payload, branch: script, state: 'needs_approval', origin: 'observed',
    activity: null, changedFiles: [{ path: `src/${payload}.rs`, adds: 3, dels: 0 }], startedAt: NOW - 14 * MIN, stateSince: NOW - 3 * MIN
  }
  const repo = { id: session.repoId, name: `rustot${payload}`, crewSeed: 'rustot', crewSlot: 1, hat: 'none' }
  const requests = [{ id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: `cargo test ${payload}`, state: 'open', createdAt: NOW - 3 * MIN }]
  const steps = [{ text: `Read ${script}`, tone: 'tool' }]
  const html = render(SessionCard, { session, repo, requests, steps, now: NOW })
  assert.doesNotMatch(html, /<img|<script/i, 'no element is created from agent text')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the payload is visible literally')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  const quiet = render(QuietCard, { session: { ...session, state: 'idle', stateSince: NOW - 61 * MIN }, repo, now: NOW })
  assert.doesNotMatch(quiet, /<img|<script/i)
  assert.ok(quiet.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

test('bidi and control characters in titles and commands are shown as visible tokens and isolated', async () => {
  const { SessionCard } = await load('SessionCard.jsx')
  const { shown, titleText } = await load('StatusPill.jsx')
  assert.equal(shown('rm -rf /\u202E tmp'), 'rm -rf /<U+202E> tmp')
  assert.equal(shown('a\u2066b\u2069c\u200Ed\u200Fe\u061Cf\u0007g\u009Bh\u200Bi'), 'a<U+2066>b<U+2069>c<U+200E>d<U+200F>e<U+061C>f<U+0007>g<U+009B>h<U+200B>i')
  assert.equal(titleText('fix \u202Egnp.exe\u202C now'), 'fix <U+202E>gnp.exe<U+202C> now')
  assert.equal(titleText('résumé 🚀 שלום'), 'résumé 🚀 שלום', 'legitimate RTL and emoji text is untouched')
  const title = 'harmless \u202Eexe.ssalc'
  const session = { id: 's2', repoId: '/home/you/dev/api', task: title, branch: 'fix/\u2066x', state: 'needs_approval', origin: 'observed', changedFiles: [], startedAt: NOW, stateSince: NOW }
  const requests = [{ id: 'r2', sessionId: 's2', kind: 'permission', tier: 'caution', toolName: 'Bash', summary: 'git push \u202E--force', state: 'open', createdAt: NOW }]
  const html = render(SessionCard, { session, repo: { id: session.repoId, name: 'api', crewSlot: 2 }, requests, now: NOW })
  assert.doesNotMatch(html, /[\u202A-\u202E\u2066-\u2069]/u, 'no raw bidi control reaches the DOM')
  assert.ok(html.includes('harmless &lt;U+202E&gt;exe.ssalc'), 'title shows the token')
  assert.ok(html.includes('git push &lt;U+202E&gt;--force'), 'command shows the token')
  assert.ok(html.includes('fix/&lt;U+2066&gt;x'), 'branch shows the token')
  assert.match(html, /<bdi>harmless &lt;U\+202E&gt;exe.ssalc<\/bdi>/, 'the title is bidi-isolated from the pill beside it')
})

test('isolates and non-format default-ignorables are tokenized by titleText and shown', async () => {
  const { shown, titleText } = await load('StatusPill.jsx')
  for (const cp of [0x2066, 0x2067, 0x2068, 0x2069]) {
    const hex = cp.toString(16).toUpperCase()
    assert.equal(titleText(`a${String.fromCodePoint(cp)}b`), `a<U+${hex}>b`, `titleText U+${hex}`)
  }
  assert.equal(shown('xㅤyᅟz'), 'x<U+3164>y<U+115F>z', 'Hangul fillers are default-ignorable but not Cf')
})

test('every agent-supplied card string passes through its sanitizer', async () => {
  const { SessionCard } = await load('SessionCard.jsx')
  const RLO = '‮'
  const raw = /‮/u
  const base = { id: 'b1', repoId: '/home/you/dev/api', task: 'plain', branch: 'main', origin: 'observed', changedFiles: [], startedAt: NOW - MIN, stateSince: NOW - MIN }
  const repo = { id: base.repoId, name: 'api', crewSlot: 2 }
  const card = props => render(SessionCard, { repo, now: NOW, ...props })

  const files = card({ session: { ...base, state: 'running', changedFiles: [{ path: `src/${RLO}sr.exe`, adds: 1, dels: 0 }] } })
  assert.doesNotMatch(files, raw, 'file chip')
  assert.ok(files.includes('<span class="file-name">&lt;U+202E&gt;sr.exe</span>'), files)

  const steps = card({ session: { ...base, state: 'running' }, steps: [{ text: `Edit ${RLO}sr.exe` }] })
  assert.doesNotMatch(steps, raw, 'step text')
  assert.ok(steps.includes('<span class="card-step-text">Edit &lt;U+202E&gt;sr.exe</span>'), steps)

  const tool = card({ session: { ...base, state: 'running', activity: `tool:Ba${RLO}sh` } })
  assert.doesNotMatch(tool, raw, 'activity tool name')
  assert.ok(tool.includes('<p class="card-now">Using Ba&lt;U+202E&gt;sh</p>'), tool)

  const question = card({ session: { ...base, state: 'asked_you' }, requests: [{ id: 'q1', sessionId: 'b1', kind: 'question', summary: `Keep ${RLO}it?`, state: 'open', createdAt: NOW }] })
  assert.doesNotMatch(question, raw, 'question summary')
  assert.ok(question.includes('<p class="request-question"><bdi>Keep &lt;U+202E&gt;it?</bdi></p>'), question)

  const named = card({ session: { ...base, state: 'running' }, repo: { ...repo, name: `ap${RLO}i` } })
  assert.doesNotMatch(named, raw, 'repo name')
  assert.ok(named.includes('<span class="meta-item">ap&lt;U+202E&gt;i</span>'), named)

  const crashed = card({ session: { ...base, state: 'crashed', crashKind: 'exit', exitCode: `1${RLO}` } })
  const hint = /<p class="card-hint">([^<]*)<\/p>/.exec(crashed)?.[1]
  assert.equal(hint, 'The session exited with code 1&lt;U+202E&gt;.', 'crash code')
  const signalled = card({ session: { ...base, state: 'crashed', crashKind: 'signal', exitSignal: `SIG${RLO}X` } })
  assert.equal(/<p class="card-hint">([^<]*)<\/p>/.exec(signalled)?.[1], 'The session was stopped by signal SIG&lt;U+202E&gt;X.', 'crash signal')
})

test('only open requests of this session reach the card', async () => {
  const { SessionCard } = await load('SessionCard.jsx')
  const session = { id: 'o1', repoId: '/home/you/dev/api', task: 'ship it', branch: null, state: 'needs_approval', origin: 'observed', changedFiles: [], startedAt: NOW, stateSince: NOW }
  const mine = { id: 'mine', sessionId: 'o1', kind: 'permission', tier: 'safe', summary: 'cargo check', state: 'open', createdAt: NOW - MIN }
  const requests = [
    { ...mine, id: 'other', sessionId: 'o2', tier: 'destructive', summary: 'rm -rf ~', createdAt: NOW - 9 * MIN },
    { ...mine, id: 'done', tier: 'destructive', summary: 'rm -rf ~', state: 'resolved', createdAt: NOW - 8 * MIN },
    mine
  ]
  const html = render(SessionCard, { session, repo: { id: session.repoId, name: 'api', crewSlot: 2 }, requests, now: NOW })
  assert.match(html, /data-request="mine"/)
  assert.doesNotMatch(html, /rm -rf ~/, 'another session and a resolved request never render')
  assert.doesNotMatch(html, /more request/)
})

test('card caps, crash lines, quiet labels and hrefs', async () => {
  const { SessionCard, QuietCard } = await load('SessionCard.jsx')
  const { stateLabel } = await load('StatusPill.jsx')
  const base = { id: 'c1', repoId: '/home/you/dev/api', task: 'caps', branch: null, origin: 'observed', changedFiles: [], startedAt: NOW - MIN, stateSince: NOW - MIN }
  const repo = { id: base.repoId, name: 'api', crewSlot: 2 }

  const changedFiles = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.rs`, adds: 1, dels: 0 }))
  const files = render(SessionCard, { session: { ...base, state: 'running', changedFiles }, repo, now: NOW })
  assert.equal((files.match(/class="file-name"/g) ?? []).length, 6, 'at most six file chips')
  assert.ok(files.includes('f5.rs') && !files.includes('f6.rs'))
  assert.match(files, /<a class="file-chip file-chip--more" href="\/s\/c1\?tab=changes">\+2 more<\/a>/)

  const steps = Array.from({ length: 5 }, (_, i) => ({ text: `step ${i}` }))
  const stepped = render(SessionCard, { session: { ...base, state: 'running' }, repo, steps, now: NOW })
  assert.deepEqual([...stepped.matchAll(/class="card-step-text">([^<]*)</g)].map(m => m[1]), ['step 2', 'step 3', 'step 4'], 'the last three steps')

  const hint = session => /<p class="card-hint">([^<]*)<\/p>/.exec(render(SessionCard, { session: { ...base, state: 'crashed', ...session }, repo, now: NOW }))?.[1]
  assert.equal(hint({ crashKind: 'signal', exitSignal: 'SIGKILL' }), 'The process ran out of memory or was killed by the system.')
  assert.equal(hint({ crashKind: 'lost' }), 'The deck lost track of this process. It may have been closed outside the deck.')
  assert.equal(hint({ crashKind: 'signal', exitSignal: 'SIGSEGV' }), 'The session was stopped by signal SIGSEGV.')
  assert.equal(stateLabel('crashed', {}), 'Crashed · lost')

  const at = NOW - 30 * MIN
  const stale = { ...base, state: 'stale', lastActivityAt: at, stateSince: at }
  assert.match(render(QuietCard, { session: { ...stale, origin: 'launched' }, repo, now: NOW }), /href="\/s\/c1">Open terminal<\/a>/)
  assert.match(render(QuietCard, { session: stale, repo, now: NOW }), /href="\/s\/c1">Open<\/a>/)

  const odd = { ...base, id: 'a/b?c#d', state: 'done', changedFiles: [{ path: 'x.rs', adds: 1, dels: 0 }] }
  const done = render(SessionCard, { session: odd, repo, now: NOW })
  assert.match(done, /class="card-link" href="\/s\/a%2Fb%3Fc%23d"/)
  assert.match(done, /href="\/s\/a%2Fb%3Fc%23d\?tab=changes">Review changes/)
  assert.match(render(QuietCard, { session: { ...odd, state: 'idle' }, repo, now: NOW }), /class="button button--ghost button--xs" href="\/s\/a%2Fb%3Fc%23d">Open</)
})

test('long titles keep the full text in the node and the title attribute and truncate in CSS', async () => {
  const { SessionCard } = await load('SessionCard.jsx')
  const long = 'Port the damage formula from TFS '.repeat(12).trim()
  const session = { id: 's3', repoId: '/home/you/dev/rustot', task: long, branch: 'combat-tick', state: 'running', origin: 'observed', changedFiles: [], startedAt: NOW - 14 * MIN, stateSince: NOW - 14 * MIN, toolCalls: 31 }
  const html = render(SessionCard, { session, repo: { id: session.repoId, name: 'rustot', crewSlot: 1 }, now: NOW })
  const link = /<a class="card-link" href="\/s\/s3" title="([^"]*)"[^>]*><bdi>([^<]*)<\/bdi><\/a>/.exec(html)
  assert.ok(link, html)
  assert.equal(link[1], long, 'title attribute holds the full title')
  assert.equal(link[2], long, 'text node holds the full title')
  const css = await readFile(path.join(hub, 'web/src/styles/components.css'), 'utf8')
  const rule = /\.card-title\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(rule, /text-overflow:\s*ellipsis/)
  assert.match(rule, /white-space:\s*nowrap/)
  assert.match(rule, /overflow:\s*hidden/)
  assert.match(html, /<h3 class="card-title" id="card-title-s3">/)
  assert.match(html, /<article class="session-card[^"]*" aria-labelledby="card-title-s3"/)
  assert.match(html, />rustot<\/span><span class="meta-sep" aria-hidden="true"> · <\/span><span class="meta-item">combat-tick</, 'MetaLine dots are aria-hidden')
  assert.match(html, />14m<\/span><span class="meta-sep" aria-hidden="true"> · <\/span><span class="meta-item">31 tool calls</)
  const untitled = render(SessionCard, { session: { ...session, task: '' }, repo: { id: session.repoId, name: 'rustot', crewSlot: 1 }, now: NOW })
  assert.match(untitled, /<bdi>Untitled<\/bdi>/)
})

test('card variant, border and body follow the Home table; observed requests say answer in your terminal', async () => {
  const { SessionCard, cardVariant } = await load('SessionCard.jsx')
  const base = { id: 's', repoId: '/home/you/dev/rustot', task: 'combat', branch: null, origin: 'observed', changedFiles: [], startedAt: NOW - 14 * MIN, stateSince: NOW - 6 * MIN }
  assert.equal(cardVariant({ ...base, state: 'needs_approval', role: 'lead', runRef: { runId: 'r' } }), 'team')
  assert.equal(cardVariant({ ...base, state: 'running', role: 'research' }), 'research')
  assert.equal(cardVariant({ ...base, state: 'needs_approval' }), 'approval')
  assert.equal(cardVariant({ ...base, state: 'asked_you' }), 'question')
  assert.equal(cardVariant({ ...base, state: 'crashed' }), 'crashed')
  assert.equal(cardVariant({ ...base, state: 'done' }), 'done')
  assert.equal(cardVariant({ ...base, state: 'running' }), 'solo-running')
  assert.equal(cardVariant({ ...base, state: 'starting' }), 'solo-running')
  for (const state of ['stale', 'idle', 'reviewed']) assert.equal(cardVariant({ ...base, state }), 'quiet', state)
  assert.equal(cardVariant({ ...base, state: 'ended' }), 'ended')

  const repo = { id: base.repoId, name: 'rustot', crewSeed: 'rustot', crewSlot: 1 }
  const permission = { id: 'r1', sessionId: 's', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: 'cargo test --release combat::', state: 'open', createdAt: NOW - 3 * MIN }
  const approval = render(SessionCard, { session: { ...base, state: 'needs_approval' }, repo, requests: [permission, { ...permission, id: 'r0', createdAt: NOW - 5 * MIN }], now: NOW })
  assert.match(approval, /class="session-card session-card--approval session-card--needs-approval motion-pulse"/)
  assert.match(approval, /<span class="tier-badge tier-badge--safe">Safe<\/span>/)
  assert.match(approval, /Wants to run/)
  assert.match(approval, /<code class="request-command">cargo test --release combat::<\/code>/)
  assert.match(approval, /Answer in your terminal/)
  assert.match(approval, /<a class="button button--ghost button--xs" href="\/s\/s">Open<\/a>/)
  assert.match(approval, /\+1 more request/)
  assert.doesNotMatch(approval, /Allow once|Deny|<button/, 'M1 cards never answer from the browser')
  assert.match(approval, /data-request="r0"/, 'the oldest open request is the one shown')

  const question = render(SessionCard, { session: { ...base, state: 'asked_you' }, repo, requests: [{ ...permission, kind: 'question', tier: null, summary: 'Paginate or truncate?' }], now: NOW })
  assert.match(question, /session-card--question session-card--asked-you motion-pulse/)
  assert.match(question, /<span class="tier-badge tier-badge--question">Question<\/span>/)
  assert.match(question, /<p class="request-question"><bdi>Paginate or truncate\?<\/bdi><\/p>/)
  assert.doesNotMatch(question, /<input|<textarea/)

  const done = render(SessionCard, { session: { ...base, state: 'done', changedFiles: [{ path: 'src/combat/damage.rs', adds: 64, dels: 3 }, { path: 'README.md', adds: 0, dels: 2 }] }, repo, now: NOW })
  assert.match(done, /session-card--done session-card--done"/)
  assert.doesNotMatch(done, /motion-pulse/)
  assert.match(done, /damage\.rs<\/span> <span class="diff-add">\+64<\/span> <span class="diff-del">−3<\/span>/)
  assert.match(done, /README\.md<\/span> <span class="diff-del">−2<\/span><\/a>/, 'zero counts are omitted on chips')
  assert.match(done, /Finished 6 minutes ago/)
  assert.match(done, /href="\/s\/s\?tab=changes">Review changes<\/a>/)

  const crashed = render(SessionCard, { session: { ...base, state: 'crashed', crashKind: 'exit', exitCode: 1 }, repo, now: NOW })
  assert.match(crashed, /<bdi>rustot ran aground<\/bdi>/)
  assert.match(crashed, />Crashed · exit 1</)
  assert.match(crashed, /The session exited with code 1\./)

  const running = render(SessionCard, { session: { ...base, state: 'running', activity: 'subagents:3' }, repo, now: NOW })
  assert.match(running, /<p class="card-now">3 subagents working<\/p>/)
  assert.match(render(SessionCard, { session: { ...base, state: 'running', activity: 'compacting' }, repo, now: NOW }), /Compacting context…/)
  assert.match(render(SessionCard, { session: { ...base, state: 'running', joinedMidLife: true }, repo, now: NOW }), /Joined mid-voyage: changes before \d\d:\d\d are not counted\./)
  assert.match(running, /<svg class="crew-avatar crew-avatar--md" width="36" height="36"[^>]*aria-hidden="true"/, 'the card avatar is decorative')
})

test('quiet cards carry the corrected lines and observed-safe actions', async () => {
  const { QuietCard } = await load('SessionCard.jsx')
  const repo = { id: '/home/you/dev/turbidassist', name: 'turbidassist', crewSlot: 5 }
  const base = { id: 'q', repoId: repo.id, task: 'Tune the VAD threshold', branch: 'main', origin: 'observed', changedFiles: [] }
  const at = new Date(2026, 8, 30, 17, 40).getTime()
  const stale = render(QuietCard, { session: { ...base, state: 'stale', lastActivityAt: at, stateSince: at }, repo, now: at + 22 * MIN })
  assert.match(stale, /class="quiet-card quiet-card--stale"/)
  assert.match(stale, />No activity 22m</)
  assert.match(stale, /Adrift since 17:40: no activity since then\./)
  assert.match(stale, /<a class="button button--ghost button--xs" href="\/s\/q">Open<\/a>/)
  assert.doesNotMatch(stale, /Nudge|Stop/, 'observed sessions get Open only')
  const idle = render(QuietCard, { session: { ...base, state: 'idle', stateSince: at }, repo, now: at + 60 * MIN })
  assert.match(idle, /quiet-card--idle/)
  assert.match(idle, />Idle 1h</)
  assert.match(idle, /Last turn ended at 17:40\. Waiting for the next order\./)
  const reviewed = render(QuietCard, { session: { ...base, state: 'reviewed', reviewedAt: at, stateSince: at }, repo, now: at })
  assert.match(reviewed, /Reviewed at 17:40\. Leaves the grid at midnight\./)
  assert.match(reviewed, /<svg class="crew-avatar crew-avatar--sm" width="27" height="27"/)
})

test('every M1 empty state renders its copy with the right heading and no live region', async () => {
  const { EmptyState, EMPTY_KINDS } = await load('EmptyState.jsx')
  const expected = {
    drawer: ['Nothing needs you.', 'New requests show up here and on the Sessions grid.'],
    palette: ['No matches.', null],
    home: ['Calm seas. No ships out.', 'No ships yet. Launch one, or start claude in a terminal and it shows up here.'],
    openLoops: ['No open loops.', null],
    focusChanges: ['No changes yet.', null],
    focusMemory: ['Nothing in your vault matches this task yet.', null],
    rules: ['No approval rules yet. Rules you accept from suggestions, or add by hand, show up here.', null]
  }
  assert.deepEqual([...EMPTY_KINDS].sort(), Object.keys(expected).sort())
  for (const [kind, [title, body]] of Object.entries(expected)) {
    const html = render(EmptyState, { kind })
    assert.match(html, new RegExp(`<div class="empty-state empty-state--${kind}">`), kind)
    assert.ok(html.includes(`>${title}</`), `${kind} title in ${html}`)
    if (body) assert.ok(html.includes(`<p class="empty-body">${body}</p>`), `${kind} body`)
    else assert.doesNotMatch(html, /empty-body/, `${kind} has no body line`)
    assert.doesNotMatch(html, /aria-live|role="status"|role="alert"/)
  }
  assert.match(render(EmptyState, { kind: 'home', as: 'h1' }), /<h1 class="empty-title">Calm seas\. No ships out\.<\/h1>/)
  assert.match(render(EmptyState, { kind: 'drawer' }), /<p class="empty-title">Nothing needs you\.<\/p>/)
  const action = render(EmptyState, { kind: 'home', action: { label: 'Launch a ship', href: '/new', kbd: ['Alt', 'N'] } })
  assert.match(action, /<a class="button button--primary button--hero" href="\/new">Launch a ship <kbd class="kbd kbd--on-primary">Alt N<\/kbd><\/a>/)
  assert.match(render(EmptyState, { kind: 'home', crew: [{ seed: 'rustot', slot: 1 }, { seed: 'fleetmates', slot: 0 }] }), /(crew-avatar--xl[\s\S]*){2}/, 'calm hero crew')
  assert.match(render(EmptyState, { kind: 'palette', t: key => key === 'empty.palette.title' ? 'Nada.' : key }), />Nada\.</)
})

// crew.md section 6.2 and 7, produced by docs/deck/design/tools/crew-reference.mjs.
const MAPS = {
  'rustot none': `
....L....   A...L....   ....L...G   ....L....   ....L....   ....L....
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBBBB..   ..BBBBBB.   ..BBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..
DBBBBBBBD   .BBBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..   .BBBBBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........`,
  'fleetmates none': `
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
.BBIBIBB.   .BBIBIBBL   .BBDBDBB.   LBBIBIBBL   .BBRBRBB.   .BBIBIBB.
.BBBDBBB.   .BBBDBBBB   .BBBDBBB.   BBBIIIBBB   .BBBDBBB.   .BBBDBBB.
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........`,
  'discord-audit none': `
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........`,
  'rustot cap': `
..HHHHH..   A.HHHHH..   ..HHHHH.G   ..HHHHH..   ..HHHHH..   ..HHHHH..
..HBBBH..   A.HBBBH.L   ..HBBBHG.   ..HBBBH..   ..HBBBH..   ..HBBBH..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBBBB..   ..BBBBBB.   ..BBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..
DBBBBBBBD   .BBBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..   .BBBBBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........`,
  'fleetmates bandana': `
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..HHHHHH.   A.HHHHHHL   ..HHHHHG.   ..HHHHHH.   ..HHHHHH.   ..HHHHHH.
.BBIBIBBH   .BBIBIBBL   .BBDBDBBH   LBBIBIBBL   .BBRBRBBH   .BBIBIBBH
.BBBDBBB.   .BBBDBBBB   .BBBDBBB.   BBBIIIBBB   .BBBDBBB.   .BBBDBBB.
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........`
}
const POSES = ['running', 'needs', 'idle', 'done', 'crashed', 'none']

test('crew hashing, shape bits and pixel maps match the crew.md vectors', async () => {
  const { fnv1a, shapeBits, paint } = await load('CrewAvatar.jsx')
  const vectors = [
    ['rustot', 1585975556, false, 1, false], ['vault-mcp', 3556031730, true, 1, false], ['discord-audit', 2232665825, false, 2, true],
    ['andreymudri.com', 1819880466, true, 0, false], ['turbidassist', 469188720, true, 0, false], ['rustot-client', 3212619052, false, 2, false],
    ['axios-like', 1415994239, true, 2, true], ['fleetmates', 789283731, true, 2, true]
  ]
  for (const [seed, h, wide, ears, belly] of vectors) {
    assert.equal(fnv1a(seed), h, seed)
    assert.deepEqual(shapeBits(h), { wide, ears, belly }, seed)
  }
  for (const [name, sheet] of Object.entries(MAPS)) {
    const [seed, hat] = name.split(' ')
    const rows = sheet.trim().split('\n')
    POSES.forEach((pose, column) => {
      const expected = rows.map(row => row.slice(column * 12, column * 12 + 9)).join('\n')
      assert.equal(paint(seed, pose, hat).map(row => row.join('')).join('\n'), expected, `${name} ${pose}`)
    })
  }
  for (const seed of ['rustot', 'vault-mcp', 'discord-audit', 'fleetmates', 'x', '']) {
    for (const pose of POSES) for (const hat of ['none', 'cap', 'bandana']) assert.equal(paint(seed, pose, hat)[8].join(''), '.........', `${seed} ${pose} ${hat} row 8`)
  }
})

test('crew shades, sizes, SVG runs and accessible naming follow crew.md', async () => {
  const { mix, SHADES, SLOT_COLORS, RESEARCH_COLOR, runs, paint, CrewAvatar, teammateColor } = await load('CrewAvatar.jsx')
  const table = [
    ['#ff9e64', '#ffc09a', '#a66741'], ['#f7768e', '#faa6b6', '#a14d5c'], ['#7aa2f7', '#a9c3fa', '#4f69a1'], ['#73daca', '#a4e7dd', '#4b8e83'],
    ['#bb9af7', '#d3bdfa', '#7a64a1'], ['#7dcfff', '#abe0ff', '#5187a6'], ['#c3e88d', '#d8f0b5', '#7f975c'], ['#e0c98a', '#ebdcb3', '#92835a'],
    ['#f5a3d7', '#f9c3e5', '#9f6a8c'], ['#c0caf5', '#d6ddf9', '#7d839f']
  ]
  assert.deepEqual([...SLOT_COLORS, RESEARCH_COLOR], table.map(row => row[0]))
  for (const [body, light, dark] of table) {
    assert.equal(mix(body, '#ffffff', 0.35), light)
    assert.equal(mix(body, '#000000', 0.35), dark)
    assert.deepEqual({ ...SHADES[body] }, { light, dark }, body)
  }
  assert.ok(Object.isFrozen(SHADES))
  assert.deepEqual([1, 2, 3, 4, 5].map(k => teammateColor('#ff9e64', k)), ['#ffb68b', '#e08b58', '#ffcaaa', '#c2784c', '#ffb68b'])

  const rustotRuns = runs(paint('rustot', 'running'))
  assert.equal(rustotRuns.length, 17, 'rustot running merges 35 cells into 17 runs')
  assert.equal(rustotRuns.reduce((sum, run) => sum + run.w, 0), 35)

  const html = render(CrewAvatar, { seed: 'rustot', slot: 1, pose: 'running' })
  assert.match(html, /^<svg class="crew-avatar crew-avatar--sm" width="27" height="27" viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true" focusable="false">/)
  assert.equal((html.match(/<rect /g) ?? []).length, 17)
  assert.match(html, /<rect x="2" y="1" width="5" height="1" fill="#f7768e"><\/rect>/, 'body color from slot 1')
  assert.match(html, /<rect x="0" y="5" width="1" height="1" fill="#a14d5c"><\/rect>/, 'dark hand from the precomputed shade')
  for (const [size, px] of [['sm', 27], ['md', 36], ['lg', 45], ['xl', 72]]) assert.match(render(CrewAvatar, { seed: 'a', slot: 0, pose: 'none', size }), new RegExp(`width="${px}" height="${px}"`))
  const named = render(CrewAvatar, { seed: 'rustot', slot: 1, pose: 'needs', label: 'rustot crew member, needs you' })
  assert.match(named, /role="img" aria-label="rustot crew member, needs you"/)
  assert.doesNotMatch(named, /aria-hidden/)
  const needs = render(CrewAvatar, { seed: 'rustot', slot: 1, pose: 'needs' })
  assert.match(needs, /<rect x="0" y="0" width="1" height="1" fill="#e0af68">/, 'amber needs flag')
  const team = render(CrewAvatar, { seed: 'rustot', slot: 1, pose: 'none', hat: 'cap', team: true })
  assert.match(team, /<rect x="2" y="0" width="5" height="1" fill="#3cc8c8">/, 'team cap is teal')
  const personal = render(CrewAvatar, { seed: 'rustot', slot: 1, pose: 'none', hat: 'cap' })
  assert.match(personal, /<rect x="2" y="0" width="5" height="1" fill="#a14d5c">/, 'personal cap uses the dark shade')
  assert.match(render(CrewAvatar, { seed: 'research', color: RESEARCH_COLOR, pose: 'running' }), /fill="#c0caf5"/)
  assert.doesNotMatch(html + needs + team, /animation|motion-/, 'the avatar never animates')
})

test('component styles use tokens, a card-wide focus ring and no private reduced-motion rules', async () => {
  const css = await readFile(path.join(hub, 'web/src/styles/components.css'), 'utf8')
  assert.doesNotMatch(css, /prefers-reduced-motion/, 'reduced motion is handled once in tokens.css')
  assert.doesNotMatch(css, /animation\s*:/, 'loops come only from the named motion classes')
  assert.doesNotMatch(css, /outline\s*:\s*(none|0)/, 'focus rings are never removed')
  assert.match(css, /\.session-card:has\(\.card-link:focus-visible\)[^{]*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring\)/)
  for (const state of ['starting', 'running', 'needs-approval', 'asked-you', 'done', 'stale', 'idle', 'reviewed', 'crashed', 'ended']) {
    assert.match(css, new RegExp(`\\.status-pill--${state}\\s*\\{[^}]*--pill-fg:\\s*var\\(--state-${state}-fg\\)`), `pill colors for ${state}`)
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b/i, 'no raw colors outside tokens')
  const sources = await Promise.all(['SessionCard.jsx', 'StatusPill.jsx', 'Counts.jsx', 'CrewAvatar.jsx', 'EmptyState.jsx'].map(name => readFile(path.join(components, name), 'utf8')))
  for (const source of sources) assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /dangerouslySetInnerHTML|innerHTML/)
})
