// Which open request the prompt on screen belongs to (state-machines 2.3 `screenMatch`, F12),
// when the deck may offer option 2 (D-77, D-95), and the request rows Task 8 writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ScreenModel } from '../../deckd/screen-model.mjs'
import { parseScreen } from '../../server/screen/index.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { allowAlwaysFor, matchPrompt } from '../../server/approvals/screen-match.mjs'
import { applyScreen, fillConfirmLabel, FALLBACK_CONFIRM_LABEL, raiseTiers } from '../../server/approvals/request-updates.mjs'
import { requestView } from '../../server/machines/projector.mjs'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

/**
 * The prompt parsed from a captured frame.
 * @param {string} version
 * @param {string} name
 */
async function framePrompt (version, name) {
  const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', version, 'MANIFEST.json'), 'utf8'))
  const model = new ScreenModel(manifest.size)
  try {
    model.write(readFileSync(path.join(fixturesDir, 'screens', version, `${name}.ansi`)))
    await model.flush()
    const prompt = parseScreen(model.lines(), model.cursor()).prompt
    assert.ok(prompt, `${version}/${name} parses to a prompt`)
    return prompt
  } finally {
    model.dispose()
  }
}

/** The tool_input of a captured 2.1.285 hook payload. */
function hookInput (/** @type {string} */ file) {
  return JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', '2.1.285', file), 'utf8')).tool_input
}

let seq = 0
/**
 * A `requests` row as the store returns it.
 * @param {{ id?: string, kind?: string, tier?: string | null, tool?: string, input?: object, summary?: string, rule?: string | null, options?: object[], reasons?: object[] }} spec
 */
function row ({ id, kind = 'permission', tier = 'safe', tool = 'Bash', input = {}, summary, rule = null, options = [], reasons = [] }) {
  seq++
  return {
    id: id ?? `r${seq}`,
    session_id: 's1',
    kind,
    tier,
    tool_name: tool,
    summary: summary ?? String(input.command ?? input.file_path ?? input.url ?? ''),
    detail: JSON.stringify(input),
    why: null,
    options: JSON.stringify(options),
    state: 'open',
    expired_reason: null,
    answer: null,
    source: tool === 'AskUserQuestion' ? 'ask_user_question' : 'permission_request',
    match_key: `m${seq}`,
    delivery: 'idle',
    screen_match: 'unknown',
    task_id: null,
    rule_pattern: rule,
    reasons: JSON.stringify(reasons),
    confirm_label: null,
    created_at: seq,
    answered_at: null,
    notified_at: null,
    renotified_at: null
  }
}

test('the 2.1.285 permission-2 frame with one open matching request puts that request on screen', async () => {
  const prompt = await framePrompt('2.1.285', 'permission-2')
  const input = hookInput('PermissionRequest.Bash.json')
  // `summary` is display text, not the command: a row whose summary differs from its command still
  // matches by `tool_input.command`, and a row whose summary alone equals the visible command does not.
  const request = row({ id: 'bash', input, summary: `Bash ${input.command}` })
  const decoy = row({ id: 'decoy', input: { command: 'node --test other.test.mjs', description: input.description }, summary: input.command })
  assert.deepEqual(matchPrompt(prompt, [request, decoy]), { onScreen: 'bash', queued: ['decoy'], ambiguous: false })
  assert.deepEqual(matchPrompt(prompt, [request]), { onScreen: 'bash', queued: [], ambiguous: false })
})

test('two requests sharing the visible prefix of the long Bash frame, one Safe and one Destructive, are ambiguous', async () => {
  const prompt = await framePrompt('2.1.285', 'permission-bash-long')
  // The review's case is `npm test -- --grep "<long name>"` and the same text followed by
  // `; rm -rf /home/you/work`; the captured frame shows a long `node --test` command, so the pair is
  // built on the command that frame prints.
  const command = 'node --test --test-name-pattern="' + 'abcdefghijklmnopqrstuvwxyz'.repeat(7) + 'abcdefghijklmnopqr" capture.test.mjs'
  const description = 'Run capture tests filtered by a long name pattern'
  const safe = row({ id: 'safe', tier: 'safe', input: { command, description } })
  const destructive = row({ id: 'destructive', tier: 'destructive', input: { command: `${command}; rm -rf /home/you/work`, description } })
  assert.deepEqual(matchPrompt(prompt, [safe]), { onScreen: 'safe', queued: [], ambiguous: false }, 'alone, the Safe request matches')
  assert.deepEqual(matchPrompt(prompt, [safe, destructive]), { onScreen: null, queued: ['safe', 'destructive'], ambiguous: true })
  assert.deepEqual(matchPrompt(prompt, [destructive, safe]), { onScreen: null, queued: ['destructive', 'safe'], ambiguous: true })
})

test('a Safe request is queued while the prompt of a Caution request for another command is on screen', async () => {
  const prompt = await framePrompt('2.1.285', 'permission-2')
  const caution = row({ id: 'caution', tier: 'caution', input: hookInput('PermissionRequest.Bash.json') })
  const safe = row({ id: 'safe', tier: 'safe', input: { command: 'npm test', description: 'Run the tests' } })
  assert.deepEqual(matchPrompt(prompt, [safe, caution]), { onScreen: 'caution', queued: ['safe'], ambiguous: false })
})

test('file tools, WebFetch and AskUserQuestion match their 2.1.285 boxes by path, URL and question text', async () => {
  const edit = row({ id: 'edit', tool: 'Edit', input: hookInput('PermissionRequest.Edit.json') })
  const write = row({ id: 'write', tool: 'Write', input: hookInput('PermissionRequest.Write.json') })
  const fetch = row({ id: 'fetch', tool: 'WebFetch', input: hookInput('PermissionRequest.WebFetch.json') })
  const ask = row({ id: 'ask', kind: 'question', tier: null, tool: 'AskUserQuestion', input: hookInput('PermissionRequest.AskUserQuestion.json') })
  const all = [edit, write, fetch, ask]
  const cwd = '/home/you/fixture-repo'
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'permission-edit'), all, { cwd }).onScreen, 'edit')
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'permission-write'), all, { cwd }).onScreen, 'write')
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'permission-webfetch'), all, { cwd }).onScreen, 'fetch')
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'question-options'), all, { cwd }).onScreen, 'ask')
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'permission-edit'), all).onScreen, 'edit', 'without the session directory, by path suffix')
  const other = row({ id: 'other', tool: 'Edit', input: { ...hookInput('PermissionRequest.Edit.json'), file_path: '/home/you/fixture-repo/sub/notes.txt' } })
  assert.equal(matchPrompt(await framePrompt('2.1.285', 'permission-edit'), [other], { cwd }).onScreen, null, 'the same basename in another directory does not match the path row')
})

test('no prompt matches nothing, and a box the parser could not place matches nothing', async () => {
  const request = row({ id: 'bash', input: hookInput('PermissionRequest.Bash.json') })
  assert.deepEqual(matchPrompt(null, [request]), { onScreen: null, queued: [], ambiguous: false })
  const prompt = await framePrompt('2.1.285', 'permission-2')
  assert.deepEqual(matchPrompt({ ...prompt, title: null, body: null }, [request]), { onScreen: null, queued: ['bash'], ambiguous: false })
})

test('allowAlwaysFor is false for the Edit frame option 2, a Caution request and the permission-2 frame', async () => {
  const edit = await framePrompt('2.1.285', 'permission-edit')
  assert.match(edit.options[1].label, /^Yes, and switch to accept edits/)
  const safeBash = row({ tier: 'safe', input: { command: 'node --test capture.test.mjs' }, rule: 'Bash(node --test:*)' })
  assert.equal(allowAlwaysFor(row({ tool: 'Edit', input: hookInput('PermissionRequest.Edit.json') }), edit), false)
  assert.equal(allowAlwaysFor(safeBash, edit), false, 'a Safe Bash request paired with the Edit option 2 label')
  assert.equal(allowAlwaysFor(safeBash, await framePrompt('2.1.285', 'permission-2')), false, 'permission-2 has no option 2 of that form')
  // Synthetic, per D-95: no captured 2.1.285 Bash frame prints an option 2 that allows a rule.
  const synthetic = { options: [{ key: '1', label: 'Yes' }, { key: '2', label: "Yes, and don't ask again for node --test:*" }, { key: '3', label: 'No' }] }
  const caution = row({ tier: 'caution', input: { command: 'node --test capture.test.mjs' }, rule: 'Bash(node --test:*)' })
  assert.equal(allowAlwaysFor(caution, synthetic), false, 'a Caution request')
})

test('allowAlwaysFor is true only on the exact WebFetch-derived wording whose pattern equals the rule candidate (synthetic prompt, D-95)', async () => {
  // Synthetic, per D-95: the wording `Yes, and don't ask again for <pattern>` is the one the captured
  // 2.1.285 WebFetch frame prints; no captured Bash frame shows it, so this prompt is hand-written.
  const options = (/** @type {string} */ label) => ({ options: [{ key: '1', label: 'Yes' }, { key: '2', label }, { key: '3', label: 'No' }] })
  const webfetch = await framePrompt('2.1.285', 'permission-webfetch')
  assert.equal(webfetch.options[1].label, "Yes, and don't ask again for example.com", 'the captured wording the synthetic prompt copies')
  const safe = row({ tier: 'safe', input: { command: 'node --test capture.test.mjs' }, rule: 'Bash(node --test:*)' })
  assert.equal(allowAlwaysFor(safe, options("Yes, and don't ask again for node --test:*")), true)
  assert.equal(allowAlwaysFor(safe, options("Yes, and don't ask again for node --test *")), true, 'the 7.1 equivalence: `:*` and ` *`')
  assert.equal(allowAlwaysFor(safe, options("Yes, and don't ask again for Bash(node --test:*)")), true)
  assert.equal(allowAlwaysFor(safe, options("Yes, don't ask again for node --test:*")), false, 'other wording that also says "don\'t ask again"')
  assert.equal(allowAlwaysFor(safe, options("Yes, and don't ask again for node:*")), false, 'a wider pattern than the candidate')
  assert.equal(allowAlwaysFor(row({ tool: 'WebFetch', input: hookInput('PermissionRequest.WebFetch.json'), rule: 'WebFetch(domain:example.com)' }), webfetch), false, 'never for WebFetch')
})

/** A fresh deck.db with one session in `/repo`. */
function harness () {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-match-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/repo','repo',0,'repo',0)")
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','wrapped','/repo','/repo','needs_approval',1,1,1,1,1)")
  /** @param {ReturnType<typeof row>} r */
  const insert = (r) => {
    const cols = Object.keys(r)
    store.run(`INSERT INTO requests(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => /** @type {any} */ (r)[c]))
  }
  const get = (/** @type {string} */ id) => store.get('SELECT * FROM requests WHERE id = ?', id)
  const events = () => store.all("SELECT type, entity_id, data FROM events WHERE type = 'request.updated' ORDER BY seq")
  return { store, insert, get, events, close () { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('applyScreen writes screen_match and the on-screen options and appends request.updated for each changed row', async () => {
  const h = harness()
  try {
    const prompt = await framePrompt('2.1.285', 'permission-2')
    h.insert(row({ id: 'bash', tier: 'caution', input: hookInput('PermissionRequest.Bash.json') }))
    h.insert(row({ id: 'other', tier: 'safe', input: { command: 'npm test' } }))
    assert.deepEqual(applyScreen(h.store, 's1', prompt, 10), ['bash', 'other'])
    assert.equal(h.get('bash').screen_match, 'on_screen')
    assert.deepEqual(JSON.parse(h.get('bash').options), [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }])
    assert.equal(h.get('other').screen_match, 'queued')
    assert.deepEqual(JSON.parse(h.get('other').options), [])
    assert.deepEqual(h.events().map((e) => [e.entity_id, JSON.parse(e.data).screenMatch]), [['bash', 'on_screen'], ['other', 'queued']])
    assert.deepEqual(applyScreen(h.store, 's1', prompt, 11), [], 'an unchanged screen changes no row')
    assert.equal(h.events().length, 2)
    assert.deepEqual(applyScreen(h.store, 's1', undefined, 12), ['bash', 'other'], 'no screen model: every request is unknown')
    assert.equal(h.get('bash').screen_match, 'unknown')
  } finally {
    h.close()
  }
})

test('raiseTiers writes a tier only when the new one is higher and never lowers one', () => {
  const h = harness()
  try {
    h.insert(row({ id: 'low', tier: 'safe', input: { command: 'npm test' }, rule: 'Bash(npm test:*)' }))
    h.insert(row({ id: 'high', tier: 'destructive', input: { command: 'rm -rf build' } }))
    h.insert(row({ id: 'ask', kind: 'question', tier: null, tool: 'AskUserQuestion', input: hookInput('PermissionRequest.AskUserQuestion.json') }))
    const reasons = [{ entryId: 'x', tier: 'caution', segment: '', description: 'changed by the new tiers' }]
    const changed = raiseTiers(h.store, () => ({ tier: 'caution', reasons, ruleCandidate: null }), 20)
    assert.deepEqual(changed, ['low'])
    assert.equal(h.get('low').tier, 'caution')
    assert.equal(h.get('low').rule_pattern, null, 'a raised request loses its Safe rule candidate')
    assert.deepEqual(JSON.parse(h.get('low').reasons), reasons)
    assert.equal(h.get('high').tier, 'destructive', 'never lowered')
    assert.equal(h.get('ask').tier, null, 'questions have no tier')
    assert.deepEqual(h.events().map((e) => [e.entity_id, JSON.parse(e.data).tier]), [['low', 'caution']])
  } finally {
    h.close()
  }
})

test('fillConfirmLabel fills {n} from the counter and falls back when the counter throws or the template is missing', async () => {
  const h = harness()
  try {
    const rm = [{ entryId: 'destructive.shell.rm', tier: 'destructive', segment: 'rm -rf a b', description: 'deletes files' }]
    h.insert(row({ id: 'rm', tier: 'destructive', input: { command: 'rm -rf a b' }, reasons: rm }))
    /** @type {unknown[][]} */
    const calls = []
    const label = await fillConfirmLabel(h.store, 'rm', { countFor: async (...args) => { calls.push(args); return 2 } })
    assert.equal(label, 'I checked the 2 paths that will be deleted')
    assert.deepEqual(calls, [['rm_paths', ['rm', '-rf', 'a', 'b'], '/repo']])
    assert.equal(h.get('rm').confirm_label, label)
    assert.equal(JSON.parse(h.events().at(-1).data).confirmLabel, label)
    const thrown = await fillConfirmLabel(h.store, 'rm', { countFor: async () => { throw new Error('git failed') } })
    assert.equal(thrown, FALLBACK_CONFIRM_LABEL)
    assert.equal(FALLBACK_CONFIRM_LABEL, 'I checked what this command will change')
    assert.equal(h.get('rm').confirm_label, FALLBACK_CONFIRM_LABEL)
    assert.equal(await fillConfirmLabel(h.store, 'rm', { countFor: async () => null }), FALLBACK_CONFIRM_LABEL, 'an unknown count')
    h.insert(row({ id: 'odd', tier: 'destructive', input: { command: 'odd thing' }, reasons: [{ entryId: 'floor.m1', tier: 'destructive', segment: '', description: 'x' }] }))
    assert.equal(await fillConfirmLabel(h.store, 'odd', { countFor: async () => 3 }), FALLBACK_CONFIRM_LABEL, 'no template')
  } finally {
    h.close()
  }
})

test('requestView adds reasons, rulePattern, ruleNote, description, confirmLabel and allowAlways', () => {
  const reasons = [{ entryId: 'safe.npm.test', tier: 'safe', segment: 'npm test', description: 'runs the test script' }]
  const allow = [{ key: '1', label: 'Yes' }, { key: '2', label: "Yes, and don't ask again for npm test:*" }, { key: '3', label: 'No' }]
  const view = requestView(row({ tier: 'safe', input: { command: 'npm test' }, rule: 'Bash(npm test:*)', reasons, options: allow }))
  assert.deepEqual(view.reasons, reasons)
  assert.equal(view.rulePattern, 'Bash(npm test:*)')
  assert.equal(view.ruleNote, 'anyFlags')
  assert.equal(view.description, 'runs the test script')
  assert.equal(view.confirmLabel, null)
  assert.equal(view.allowAlways, true)
  assert.equal(requestView(row({ tier: 'safe', input: { command: 'npm test' }, rule: 'Bash(npm test:*)', reasons, options: [] })).allowAlways, false)
})

test('requestView describes a Destructive rm by the reason classify headlines, not the floor.plain reason that comes first', async () => {
  const { classify } = await import('../../server/approvals/tiers.mjs')
  const input = { command: 'rm -rf x' }
  const classified = classify({ toolName: 'Bash', toolInput: input, cwd: '/home/you/work', repoRoot: '/home/you/work' })
  assert.equal(classified.tier, 'destructive')
  assert.equal(classified.reasons[0].entryId, 'floor.plain', 'the first stored reason is the plain-command floor')
  const view = requestView(row({ tier: classified.tier, input, reasons: classified.reasons }))
  assert.equal(view.description, 'deletes files')
  assert.equal(view.description, classified.description)
})
