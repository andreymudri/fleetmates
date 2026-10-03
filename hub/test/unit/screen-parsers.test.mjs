import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { ScreenModel } from '../../deckd/screen-model.mjs'
import { parseScreen } from '../../server/screen/index.mjs'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const RULE = '─'.repeat(60)
const NBSP = ' '

/**
 * Pad a screen to `rows` rows with blank lines.
 * @param {string[]} top
 * @param {number} [rows]
 * @returns {string[]}
 */
function screen (top, rows = 20) {
  return [...top, ...Array(Math.max(0, rows - top.length)).fill('')]
}

/**
 * An idle-looking bottom: spinner row (optional), rule, input row, rule, footer.
 * @param {string[]} transcript
 * @param {{ spinner?: string, input?: string }} [opts]
 * @returns {string[]}
 */
function session (transcript, { spinner, input = '' } = {}) {
  const rows = [...transcript]
  while (rows.length < 14) rows.push('')
  rows.push(spinner ?? '', '', RULE, `❯${NBSP}${input}`, RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)')
  return rows
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[]}
 */
function changedRows (a, b) {
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i)
  return out
}

test('a two-option prompt yields exactly two options, verbatim', () => {
  const lines = screen([
    '● Update(notes.txt)',
    RULE,
    ' Edit file',
    '  1. read the file',
    '  2. write it back',
    '',
    ' Do you want to make this edit to notes.txt?',
    ' ❯ 1. Yes',
    '   2. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend'
  ])
  const { prompt, idle, statusRows } = parseScreen(lines, { x: 1, y: 7 })
  assert.deepEqual(prompt, {
    kind: 'permission',
    question: 'Do you want to make this edit to notes.txt?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No, and tell Claude what to do differently (esc)' }
    ],
    title: 'Edit file',
    body: '1. read the file\n2. write it back',
    truncated: false
  })
  assert.equal(idle, false)
  assert.deepEqual(statusRows, [])
})

test('a prompt whose box is cut off at the bottom yields null, not a partial list', () => {
  const full = [
    // A footer-like row ABOVE the box must not stand in for the box's own footer.
    '● Press Esc to cancel a running tool.',
    '',
    RULE,
    ' Bash command',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for echo commands",
    '   3. No'
  ]
  // The bottom of the screen ends inside the option list: the footer is not visible.
  assert.equal(parseScreen(full.slice(0, 8), { x: 1, y: 6 }).prompt, null)
  // Every option is visible but the footer is not: still not a complete box.
  assert.equal(parseScreen(full, { x: 1, y: 6 }).prompt, null)
  // With its footer the same box parses.
  const whole = parseScreen([...full, '', ' Esc to cancel · Tab to amend'], { x: 1, y: 6 })
  assert.deepEqual(whole.prompt?.options.map((o) => o.key), ['1', '2', '3'])
})

test('a numbered list without the ❯ cursor is not a prompt', () => {
  const lines = screen([
    RULE,
    '● Two ways to stop it:',
    '  1. press Ctrl+C',
    '  2. close the terminal',
    '',
    '● Or press Esc to cancel the tool call.'
  ])
  assert.equal(parseScreen(lines, { x: 0, y: 4 }).prompt, null)
})

test('typed text in the input box is neither a prompt nor idle', () => {
  const lines = session(['● Done.'], { input: 'hello there' })
  const parsed = parseScreen(lines, { x: 13, y: 17 })
  assert.equal(parsed.prompt, null)
  assert.equal(parsed.idle, false)
})

test('the empty input box is idle only while no spinner runs', () => {
  assert.equal(parseScreen(session(['● Done.']), { x: 2, y: 17 }).idle, true)
  assert.equal(parseScreen(session(['● Working'], { spinner: '✻ Swirling… (6s · ↓ 5 tokens)' }), { x: 2, y: 17 }).idle, false)
})

test('a spinner row change is reported only in statusRows', () => {
  const before = session(['❯ run the tests', '', '● Running 1 shell command…'], { spinner: '✻ Swirling… (6s · ↓ 5 tokens)' })
  const after = session(['❯ run the tests', '', '● Running 1 shell command…'], { spinner: '✻ Swirling… (7s · ↓ 9 tokens)' })
  const changed = changedRows(before, after)
  assert.deepEqual(changed, [14])
  const a = parseScreen(before, { x: 2, y: 17 })
  const b = parseScreen(after, { x: 2, y: 17 })
  assert.deepEqual(b.statusRows, [14, 15, 16, 17, 18, 19])
  for (const r of changed) assert.ok(b.statusRows.includes(r) && a.statusRows.includes(r), `row ${r} is in the status region`)
  assert.deepEqual({ prompt: a.prompt, idle: a.idle }, { prompt: b.prompt, idle: b.idle })

  // A transcript change is outside the status region.
  const more = session(['❯ run the tests', '', '● Running 1 shell command…', '  ⎿  ok'], { spinner: '✻ Swirling… (7s · ↓ 9 tokens)' })
  for (const r of changedRows(after, more)) assert.ok(!parseScreen(more, { x: 2, y: 17 }).statusRows.includes(r), `row ${r} is transcript`)
})

test('the question box parses the same whichever option carries the ❯ cursor', async () => {
  const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', '2.1.282', 'MANIFEST.json'), 'utf8'))
  const model = new ScreenModel(manifest.size)
  let base
  try {
    model.write(readFileSync(path.join(fixturesDir, 'screens', '2.1.282', 'question-options.ansi')))
    await model.flush()
    base = model.lines()
  } finally {
    model.dispose()
  }
  const expected = {
    kind: 'question',
    question: 'Which do you pick, A or B?',
    options: [
      { key: '1', label: 'A' },
      { key: '2', label: 'B' },
      { key: '3', label: 'Type something.' },
      { key: '4', label: 'Chat about this' }
    ],
    title: '☐ Choice',
    body: '',
    truncated: false
  }
  const row = (/** @type {string} */ key) => base.findIndex((l) => new RegExp(`^(❯| ) ${key}\\. `).test(l))
  assert.equal(base[row('1')], '❯ 1. A', 'the committed frame has the cursor on option 1')
  for (const key of ['2', '3', '4']) {
    const lines = [...base]
    lines[row('1')] = '  1. A'
    lines[row(key)] = '❯' + lines[row(key)].slice(1)
    assert.deepEqual(parseScreen(lines, { x: 0, y: row(key) }).prompt, expected, `cursor on option ${key}`)
  }
})

test('a numbering gap is not a prompt: no option is dropped and none is invented', () => {
  const lines = screen([RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '   4. Maybe', '', ' Esc to cancel'])
  assert.equal(parseScreen(lines, { x: 1, y: 2 }).prompt, null)
})

test('a trust box without blank rows keeps the question out of the options', () => {
  const lines = screen([RULE, ' Do you trust this folder?', ' ❯ Yes, I trust this folder', '   No, exit', ' Enter to confirm · Esc to cancel'])
  assert.deepEqual(parseScreen(lines, { x: 1, y: 2 }).prompt, {
    kind: 'trust',
    question: 'Do you trust this folder?',
    options: [
      { key: null, label: 'Yes, I trust this folder' },
      { key: null, label: 'No, exit' }
    ],
    title: null,
    body: null,
    truncated: false
  })
})

test('a hostile screen parses in linear time', () => {
  // 1000x300 is the case the review measured (8.5 s before the fix). The
  // 4000-column case catches a label regex that backtracks within one row,
  // which at 1000 columns alone still fits under the bound.
  for (const [W, H] of [[1000, 300], [4000, 300]]) {
    const lines = []
    for (let r = 0; r < H; r++) lines.push(r % 2 === 0 ? '─'.repeat(W) : '1. a' + ' '.repeat(W - 6) + 'b')
    const t = performance.now()
    parseScreen(lines, { x: 0, y: H - 1 })
    const ms = performance.now() - t
    assert.ok(ms < 500, `${W}x${H} alternating rules and '1. a<spaces>b' took ${Math.round(ms)} ms`)
  }
})

test('long near-miss rows for every screen pattern parse fast', async () => {
  // A backtracking regex is slow only on a long row that almost matches and
  // then fails late, so each row below is built to reach the end of one
  // pattern in hub/server/screen/*.mjs and fail on its last characters. The
  // parse runs in a worker so a catastrophic pattern is terminated and named
  // instead of hanging the suite.
  const W = 2000
  const a = 'a'.repeat(W)
  const rule = '─'.repeat(W)
  /** @type {string[]} */
  const rows = []
  for (const tail of ['\t!', ' !', `${NBSP}!`, `\t${NBSP}!`]) {
    rows.push(
      '1. ' + a + tail, // NUMBERED
      '  ❯ 1. ' + a + tail, // NUMBERED with the cursor, digit column
      '❯ ' + a + tail, // SELECTED, input row
      ' ❯' + ' '.repeat(W) + tail, // SELECTED / unnumbered column
      '❯' + NBSP.repeat(W) + tail, // empty input row
      rule + tail, // BOX_TOP, RULE
      '╌'.repeat(W) + tail, // SEPARATOR
      ' '.repeat(W) + tail, // RIGHT_ALIGNED
      '✻ ' + a + tail, // SPINNER
      'Esc to cance'.repeat(W / 12) + tail, // FOOTER
      '❯ 1. ' + '(esc)'.repeat(W / 5) + tail, // ESC_OPTION
      'Yes, I trus'.repeat(W / 11) + tail, // trust label
      '│ ' + a + tail, // GUTTER
      ' │' + ' '.repeat(W) + tail, // GUTTER after its space
      a + '…'.repeat(W / 2) + tail // CUT
    )
  }
  /** @type {{ name: string, lines: string[], cursor: { x: number, y: number } }[]} */
  const cases = []
  for (const [i, row] of rows.entries()) {
    const name = `row ${i} ${JSON.stringify(row.slice(0, 8))}…${JSON.stringify(row.slice(-3))}`
    cases.push({ name: `${name} x40`, lines: Array(40).fill(row), cursor: { x: 0, y: 39 } })
    cases.push({
      name: `${name} around an input box`,
      lines: [...Array(34).fill(row), rule, '❯ 1. Yes', row, ' Esc to cancel', rule, row],
      cursor: { x: 0, y: 36 }
    })
  }
  const url = new URL('../../server/screen/index.mjs', import.meta.url).href
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    import(workerData.url).then(({ parseScreen }) => {
      for (const c of workerData.cases) {
        parentPort.postMessage({ start: c.name })
        const t = performance.now()
        parseScreen(c.lines, c.cursor)
        parentPort.postMessage({ done: c.name, ms: performance.now() - t })
      }
      parentPort.postMessage({ end: true })
    })
  `, { eval: true, workerData: { url, cases } })
  /** @type {{ name: string, ms: number }[]} */
  const timings = []
  let current = ''
  await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      worker.terminate()
      reject(new Error(`parse did not finish within 10 s on ${current}`))
    }, 10_000)
    worker.on('message', (m) => {
      if (m.start) current = m.start
      if (m.done) timings.push({ name: m.done, ms: m.ms })
      if (m.end) { clearTimeout(watchdog); worker.terminate().then(resolve) }
    })
    worker.on('error', (err) => { clearTimeout(watchdog); reject(err) })
  })
  assert.equal(timings.length, cases.length)
  for (const { name, ms } of timings) assert.ok(ms < 500, `${name} took ${Math.round(ms)} ms`)
})

test('a number in an option description does not break the option run', () => {
  const lines = screen([
    '❯ ask me',
    RULE,
    ' ☐ Plan',
    '',
    'Which plan?',
    '',
    '❯ 1. Fast',
    '     1. Skip tests then deploy',
    '  2. Safe',
    '     Run tests first',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ])
  assert.deepEqual(parseScreen(lines, { x: 0, y: 6 }).prompt, {
    kind: 'question',
    question: 'Which plan?',
    options: [
      { key: '1', label: 'Fast' },
      { key: '2', label: 'Safe' },
      { key: '3', label: 'Type something.' },
      { key: '4', label: 'Chat about this' }
    ],
    title: '☐ Plan',
    body: '',
    truncated: false
  })
})

test('the trust box parses both options with the ❯ cursor on the second', async () => {
  const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', '2.1.282', 'MANIFEST.json'), 'utf8'))
  const model = new ScreenModel(manifest.size)
  let lines
  try {
    model.write(readFileSync(path.join(fixturesDir, 'screens', '2.1.282', 'trust-folder.ansi')))
    await model.flush()
    lines = model.lines()
  } finally {
    model.dispose()
  }
  const no = lines.indexOf(' ❯ No, exit')
  const yes = lines.indexOf('   Yes, I trust this folder')
  assert.ok(no !== -1 && yes === no + 1, 'the committed frame has the cursor on "No, exit"')
  lines[no] = '   No, exit'
  lines[yes] = ' ❯ Yes, I trust this folder'
  assert.deepEqual(parseScreen(lines, { x: 1, y: yes }).prompt?.options, [
    { key: null, label: 'No, exit' },
    { key: null, label: 'Yes, I trust this folder' }
  ])
})

test('a box printed above a live input box is transcript, not a prompt', () => {
  const lines = [
    '⏺ Here is the summary:',
    '  ' + '─'.repeat(40),
    '  Bash command',
    '    rm -rf ~/work',
    '  Do you want to proceed?',
    '  ❯ 1. Yes',
    '    2. No, and tell Claude what to do differently (esc)',
    '  Esc to cancel',
    '',
    '─'.repeat(40),
    '❯ ',
    '─'.repeat(40),
    '  ? for shortcuts'
  ]
  const parsed = parseScreen(lines, { x: 2, y: 10 })
  assert.equal(parsed.prompt, null)
  assert.equal(parsed.idle, true)
})

test('known limit: a box whose top edge is off screen is not a prompt', () => {
  assert.equal(parseScreen([' Do you want?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'], { x: 1, y: 1 }).prompt, null)
})

test('a permission box that ends on its "(esc)" deny option parses without a footer', () => {
  const box = [
    '● Fetch(https://example.com)',
    '',
    RULE,
    ' Fetch',
    '',
    ' Do you want to allow Claude to fetch this content?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for example.com",
    '   3. No, and tell Claude what to do differently (esc)'
  ]
  assert.deepEqual(parseScreen(box, { x: 1, y: 6 }).prompt?.options.map((o) => o.key), ['1', '2', '3'])
  // Drawn only up to option 2: the "(esc)" option that closes the box is not visible yet.
  assert.equal(parseScreen(box.slice(0, 8), { x: 1, y: 6 }).prompt, null)
  // The same box above a live input box is transcript, not a prompt.
  const above = [...box, '', RULE, '❯ ', RULE]
  assert.equal(parseScreen(above, { x: 2, y: above.length - 2 }).prompt, null)
})

/** The 2.1.285 frames that part (a) of Task 19 captured, each with its .expect.json. */
const FRAMES_2_1_285 = [
  'compacting', 'idle-input', 'permission-2', 'permission-bash-long', 'permission-edit', 'permission-webfetch',
  'permission-write', 'question-options', 'question-text', 'spinner', 'tool-output', 'trust-folder'
]

for (const name of FRAMES_2_1_285) {
  test(`2.1.285 ${name}: prompt kind, option keys and labels, and the deny option match the expectation`, async () => {
    const dir = path.join(fixturesDir, 'screens', '2.1.285')
    const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', '2.1.285', 'MANIFEST.json'), 'utf8'))
    const expected = JSON.parse(readFileSync(path.join(dir, `${name}.expect.json`), 'utf8')).prompt
    const model = new ScreenModel(manifest.size)
    let parsed
    try {
      model.write(readFileSync(path.join(dir, `${name}.ansi`)))
      await model.flush()
      parsed = parseScreen(model.lines(), model.cursor()).prompt
    } finally {
      model.dispose()
    }
    assert.equal(parsed?.kind ?? null, expected?.kind ?? null, 'prompt kind')
    const pairs = (/** @type {any} */ p) => p?.options.map((/** @type {any} */ o) => [o.key, o.label]) ?? null
    assert.deepEqual(pairs(parsed), pairs(expected), 'option keys and labels')
    if (expected?.kind === 'permission') {
      const deny = parsed?.options.filter((o) => /^No\b/.test(o.label)) ?? []
      assert.deepEqual(deny.map((o) => o.key), [expected.options[expected.options.length - 1].key], 'one deny option, the last one, starting with "No"')
    }
  })
}

/**
 * The frames whose .expect.json carries a prompt and the title, body and truncated fields
 * Task 8 added (state-machines 2.3 `screenMatch`, F12).
 */
const PROMPT_FIELD_FRAMES = [
  ['2.1.285', 'permission-2'], ['2.1.285', 'permission-bash-long'], ['2.1.285', 'permission-write'],
  ['2.1.285', 'permission-webfetch'], ['2.1.285', 'permission-edit'], ['2.1.285', 'question-options'],
  ['2.1.282', 'permission-edit'], ['2.1.282', 'question-options']
]

for (const [version, name] of PROMPT_FIELD_FRAMES) {
  test(`${version} ${name}: the prompt title, body and truncated flag match the expectation`, async () => {
    const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', version, 'MANIFEST.json'), 'utf8'))
    const dir = path.join(fixturesDir, 'screens', version)
    const expected = JSON.parse(readFileSync(path.join(dir, `${name}.expect.json`), 'utf8')).prompt
    const model = new ScreenModel(manifest.size)
    let parsed
    try {
      model.write(readFileSync(path.join(dir, `${name}.ansi`)))
      await model.flush()
      parsed = parseScreen(model.lines(), model.cursor()).prompt
    } finally {
      model.dispose()
    }
    assert.equal(typeof expected.title, 'string', 'the expectation names a title')
    assert.equal(typeof expected.truncated, 'boolean', 'the expectation states truncated')
    assert.equal(parsed?.title, expected.title, 'title')
    assert.equal(parsed?.body, expected.body, 'body')
    assert.equal(parsed?.truncated, expected.truncated, 'truncated')
  })
}

test('the 2.1.285 long Bash command wraps inside a │ gutter, one visible row per body line, and is not cut', async () => {
  const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', '2.1.285', 'MANIFEST.json'), 'utf8'))
  const model = new ScreenModel(manifest.size)
  let parsed
  try {
    model.write(readFileSync(path.join(fixturesDir, 'screens', '2.1.285', 'permission-bash-long.ansi')))
    await model.flush()
    parsed = parseScreen(model.lines(), model.cursor()).prompt
  } finally {
    model.dispose()
  }
  const rows = parsed?.body?.split('\n') ?? []
  assert.equal(rows[0], 'node --test')
  assert.ok(rows[1].startsWith('--test-name-pattern="abc'), 'the gutter is stripped from wrapped rows')
  assert.equal(rows[3], 'capture.test.mjs')
  assert.equal(rows[4], 'Run capture tests filtered by a long name pattern')
  assert.equal(parsed?.truncated, false)
})

test('hand-written, no captured frame shows it: a command row cut with "…" marks the prompt truncated', () => {
  const lines = screen([
    RULE,
    ' Bash command',
    '',
    '   npm test -- --grep "a very long name…',
    '   Run the tests',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend'
  ])
  const prompt = parseScreen(lines, { x: 1, y: 7 }).prompt
  assert.equal(prompt?.truncated, true)
  assert.equal(prompt?.body, 'npm test -- --grep "a very long name…\nRun the tests')
})

test('a box with no row between its top and the question has no title and a null body', () => {
  const lines = screen([
    RULE,
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel'
  ])
  const prompt = parseScreen(lines, { x: 1, y: 2 }).prompt
  assert.equal(prompt?.kind, 'permission')
  assert.equal(prompt?.title, null)
  assert.equal(prompt?.body, null)
  assert.equal(prompt?.truncated, false)
})
