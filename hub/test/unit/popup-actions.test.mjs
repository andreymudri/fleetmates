// Task 5 (M3): popup actions. A Safe popup offers "Allow once" only when it shows one request's whole command
// (F11); everything else offers "Open" (D-71). The notify-send stand-in is a fake runner that records argv and
// lets the test write stdout lines and watch the abort signal that kills the waiting process.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import { ACTION_WAIT_MS, createNotifier } from '../../server/adapters/notify.mjs'
import { createNotificationMachine, popupActions, requestPopupText } from '../../server/machines/notification.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))

/** A fake runner: popups without actions answer at once; waiting popups stay open until killed or exited. */
function fakeRunner() {
  const procs = []
  async function run(command, args, options) {
    if (!options.onLine) return { ok: true, exitCode: 0, stdout: '7\n' }
    return new Promise(resolve => {
      const proc = { command, args, killed: false, line: text => options.onLine(text), exit: code => resolve({ ok: code === 0, exitCode: code, stdout: '' }) }
      options.signal?.addEventListener('abort', () => { proc.killed = true; resolve({ ok: false, exitCode: null }) }, { once: true })
      procs.push(proc)
    })
  }
  return { run, procs }
}

const safe = summary => ({ kind: 'permission', tier: 'safe', summary })
const rendered = (requests, observed = false) => requestPopupText('task', requests, observed)
const actionsFor = (requests, observed = false) => popupActions(requests, observed, rendered(requests, observed))

test('a single Safe request whose whole summary fits gets "Allow once" and "Open"', () => {
  const summary = `npm test -- ${'x'.repeat(48)}`
  assert.equal(summary.length, 60)
  assert.deepEqual(actionsFor([safe(summary)]), ['allow', 'open'])
})

test('a Safe summary that requestPopupText clips gets "Open" only', () => {
  const summary = `node --test test/unit/a.test.mjs --import=data:text/javascript,${'globalThis.x=1;'.repeat(11)}${'y'.repeat(221)}`.slice(0, 221)
  assert.equal(summary.length, 221)
  assert.ok(!rendered([safe(summary)]).body.includes(summary), 'the popup body clips this summary')
  assert.deepEqual(actionsFor([safe(summary)]), ['open'])
})

test('two Safe requests, Caution, Destructive, a question and an observed session get "Open" only', () => {
  assert.deepEqual(actionsFor([safe('ls'), safe('pwd')]), ['open'])
  assert.deepEqual(actionsFor([{ kind: 'permission', tier: 'caution', summary: 'npm install' }]), ['open'])
  assert.deepEqual(actionsFor([{ kind: 'permission', tier: 'destructive', summary: 'rm -rf build' }]), ['open'])
  assert.deepEqual(actionsFor([{ kind: 'question', tier: null, summary: 'Which one?' }]), ['open'])
  assert.deepEqual(actionsFor([safe('ls')], true), ['open'])
})

test('the action argv puts every option before --, waits and prints the id, and only offers allow and open', async () => {
  const fake = fakeRunner()
  const notifier = createNotifier({ run: fake.run })
  const sent = notifier.popup({ title: '-t', body: 'b', actions: ['allow', 'open', 'rm'], onAction: () => {} })
  await settle()
  fake.procs[0].line('7')
  assert.deepEqual(await sent, { ok: true, id: 7 })
  const args = fake.procs[0].args
  assert.deepEqual(args, ['--app-name=fleetmates deck', '--print-id', '--wait', '--urgency=normal', '--action=allow=Allow once', '--action=open=Open', '--', '-t', 'b'])
  assert.deepEqual(args.filter(arg => arg.startsWith('--action=')).map(arg => arg.split('=')[1]), ['allow', 'open'])
  assert.equal(args.at(-3), '--')
})

test('stdout lines call onAction once for an offered key and ignore anything else', async () => {
  const fake = fakeRunner()
  const notifier = createNotifier({ run: fake.run })
  const keys = []
  const sent = notifier.popup({ title: 't', body: 'b', actions: ['open'], onAction: key => keys.push(key) })
  await settle()
  fake.procs[0].line('allow')
  fake.procs[0].line('9')
  assert.deepEqual(await sent, { ok: true, id: 9 })
  fake.procs[0].line('allow; rm -rf x')
  fake.procs[0].line('allow')
  fake.procs[0].line('12')
  assert.deepEqual(keys, [], 'only an offered key counts, and only after the id')
  fake.procs[0].line('open')
  fake.procs[0].line('open')
  assert.deepEqual(keys, ['open'])
})

test('the waiting process is killed on dismiss, on replace and after the wait window', async () => {
  assert.equal(ACTION_WAIT_MS, 11 * 60_000)
  const fake = fakeRunner()
  const dismissed = []
  const notifier = createNotifier({ run: async (command, args, options) => {
    if (command === 'makoctl') { dismissed.push(args); return { ok: true, exitCode: 0, stdout: '' } }
    return fake.run(command, args, options)
  } })
  const first = notifier.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} })
  await settle()
  fake.procs[0].line('5')
  await first
  assert.equal(fake.procs[0].killed, false)
  await notifier.dismiss(5)
  assert.equal(fake.procs[0].killed, true, 'dismiss kills the waiting notify-send')
  assert.deepEqual(dismissed, [['dismiss', '-n', '5']])
  const second = notifier.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} })
  await settle()
  fake.procs[1].line('6')
  await second
  const third = notifier.popup({ title: 't', body: 'b', replaceId: 6, actions: ['open'], onAction: () => {} })
  await settle()
  fake.procs[2].line('6')
  await third
  assert.equal(fake.procs[1].killed, true, 'replacing a popup kills the old wait')
  assert.equal(fake.procs[2].killed, false, 'the replacement keeps waiting')
  const quick = createNotifier({ run: fake.run, actionWaitMs: 30 })
  const timed = quick.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} })
  await settle()
  fake.procs[3].line('8')
  await timed
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(fake.procs[3].killed, true, 'the wait window ends the process')
})

test('a wait that exits before printing an id fails privately, and one that never prints an id is killed', async () => {
  const fake = fakeRunner()
  const notifier = createNotifier({ run: fake.run, timeoutMs: 30 })
  const exited = notifier.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} })
  await settle()
  fake.procs[0].exit(3)
  assert.deepEqual(await exited, { ok: false, error: { code: 'notify_failed', exitCode: 3 } })
  const silent = notifier.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} })
  await settle()
  assert.deepEqual(await silent, { ok: false, error: { code: 'notify_failed', exitCode: null } })
  assert.equal(fake.procs[1].killed, true)
})

test('the default runner streams a real child\'s stdout by line and kills it on dismiss', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-popup-'))
  const pidFile = path.join(dir, 'pid')
  const action = path.join(dir, 'action.mjs')
  const waiting = path.join(dir, 'waiting.mjs')
  const done = path.join(dir, 'done.mjs')
  writeFileSync(action, `#!${process.execPath}\nprocess.stdout.write('42\\n')\nsetTimeout(() => process.stdout.write('allow; rm -rf x\\nallow\\n'), 50)\n`, { mode: 0o700 })
  writeFileSync(waiting, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nprocess.stdout.write('43\\n')\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  writeFileSync(done, `#!${process.execPath}\n`, { mode: 0o700 })
  let pid = 0
  try {
    const env = { PATH: process.env.PATH, HOME: dir }
    const keys = []
    let clicked
    const picked = new Promise(resolve => { clicked = resolve })
    const notifier = createNotifier({ notifyCommand: action, dismissCommand: done, env })
    assert.deepEqual(await notifier.popup({ title: 't', body: 'b', actions: ['allow', 'open'], onAction: key => { keys.push(key); clicked() } }), { ok: true, id: 42 })
    await picked
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(keys, ['allow'])
    const holder = createNotifier({ notifyCommand: waiting, dismissCommand: done, env })
    assert.deepEqual(await holder.popup({ title: 't', body: 'b', actions: ['open'], onAction: () => {} }), { ok: true, id: 43 })
    assert.ok(existsSync(pidFile))
    pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    assert.equal(alive(), true)
    await holder.dismiss(43)
    const deadline = Date.now() + 2000
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(alive(), false, 'dismiss killed the waiting child')
  } finally {
    // A failing run must not leave the waiting child behind.
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

async function harness({ onAction }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-popup-db-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  let at = 1000
  const fake = fakeRunner()
  const notifier = createNotifier({ run: fake.run })
  const machine = createNotificationMachine({ store, notifier, now: () => at, onAction })
  const projector = createProjector({ store, now: () => at })
  const hook = JSON.parse(readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url), 'utf8'))
  const send = (event, extra = {}) => projector.applyHooks([{ v: 1, hook: { ...hook, cwd: dir, session_id: 'synthetic-session', hook_event_name: event, ...extra }, hookTs: at, receivedAt: at, claudePid: 42, ptyId: null, via: 'socket' }])
  send('SessionStart', { source: 'startup' })
  const sessionId = projector.snapshot().sessions[0].id
  return {
    store, fake, sessionId, machine,
    usePty() { store.run("UPDATE sessions SET origin='wrapped',pty_id='pty-1' WHERE id=?", sessionId) },
    open(command, tier = 'safe') {
      send('PermissionRequest', { tool_name: 'Bash', tool_input: { command } })
      const id = projector.snapshot().requests.at(-1).id
      store.run('UPDATE requests SET tier=? WHERE id=?', tier, id)
      return id
    },
    async popup() {
      at += 4000
      const ticked = machine.tick(at)
      await settle()
      const proc = fake.procs.at(-1)
      proc.line(String(fake.procs.length))
      await ticked
      return proc
    },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }) }
  }
}

test('the machine offers "Allow once" only for a lone Safe request in a PTY session and passes allow while it still holds', async () => {
  const actions = []
  const h = await harness({ onAction: value => actions.push(value) })
  try {
    h.usePty()
    const id = h.open('ls -la')
    const proc = await h.popup()
    assert.deepEqual(proc.args.filter(arg => arg.startsWith('--action=')), ['--action=allow=Allow once', '--action=open=Open'])
    proc.line('allow')
    assert.deepEqual(actions, [{ key: 'allow', requestIds: [id], sessionId: h.sessionId }])
  } finally { h.cleanup() }
})

test('an observed session popup offers "Open" only', async () => {
  const h = await harness({ onAction: () => {} })
  try {
    h.open('ls -la')
    const proc = await h.popup()
    assert.deepEqual(proc.args.filter(arg => arg.startsWith('--action=')), ['--action=open=Open'])
  } finally { h.cleanup() }
})

test('"allow" from a popup whose request was raised to Caution after it was sent becomes "open"', async () => {
  const actions = []
  const h = await harness({ onAction: value => actions.push(value) })
  try {
    h.usePty()
    const id = h.open('ls -la')
    const proc = await h.popup()
    h.store.run("UPDATE requests SET tier='caution' WHERE id=?", id)
    proc.line('allow')
    assert.deepEqual(actions, [{ key: 'open', requestIds: [id], sessionId: h.sessionId }])
  } finally { h.cleanup() }
})

test('"allow" for a session that lost its PTY becomes "open"', async () => {
  const actions = []
  const h = await harness({ onAction: value => actions.push(value) })
  try {
    h.usePty()
    const id = h.open('ls -la')
    const proc = await h.popup()
    h.store.run("UPDATE sessions SET pty_id=NULL WHERE id=?", h.sessionId)
    proc.line('allow')
    assert.deepEqual(actions, [{ key: 'open', requestIds: [id], sessionId: h.sessionId }])
  } finally { h.cleanup() }
})

test('"allow" for a request answered after the popup was sent becomes "open", and "open" stays "open"', async () => {
  const actions = []
  const h = await harness({ onAction: value => actions.push(value) })
  try {
    h.usePty()
    const id = h.open('ls -la')
    const proc = await h.popup()
    h.store.run("UPDATE requests SET state='answered',answer=? WHERE id=?", JSON.stringify({ decision: 'allow' }), id)
    proc.line('allow')
    assert.deepEqual(actions, [{ key: 'open', requestIds: [id], sessionId: h.sessionId }])
    const other = h.open('pwd')
    const next = await h.popup()
    next.line('open')
    assert.deepEqual(actions.at(-1), { key: 'open', requestIds: [other], sessionId: h.sessionId })
  } finally { h.cleanup() }
})

test('closing the machine kills its waiting popups and later clicks reach no one', async () => {
  const actions = []
  const h = await harness({ onAction: value => actions.push(value) })
  try {
    h.usePty()
    h.open('ls -la')
    const proc = await h.popup()
    h.machine.close()
    assert.equal(proc.killed, true)
    proc.line('allow')
    assert.deepEqual(actions, [])
  } finally { h.cleanup() }
})
