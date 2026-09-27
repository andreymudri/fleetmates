import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    ]
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
    ]
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
    ]
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
