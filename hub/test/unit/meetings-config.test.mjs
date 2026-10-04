import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createConfigWatcher, locateConfig, parseConfig, policyFor, readConfig } from '../../server/meetings/config.mjs'

const HOME = '/home/you'

// The shape of contract 2.11 (config.example.yaml), with placeholder paths and tags.
const SAMPLE = `# TurbidAssist config
session_dir: ~/meetings
user_name: You

vault:
  path: /home/you/vault
  meetings_folder: Meetings
  tasks_note: Tasks/Inbox.md
  git_commit: true

audio:
  sample_rate: 16000
  meeting_sink: deck_meeting
  route_rules:
    mic_in_use: [zoom, teams, "web # browser"]
    allow_application_name: [Firefox]
  route_poll_s: 1

realtime:
  model: small
  language: pt

ask:
  backend: claude_cli
  vault_mcp: true
  system_prompt: |
    Answer in Portuguese.
    key: not a key # not a comment
  max_tokens: 800

batch:
  model: large-v3
  diarization: true
  retention_days: 30

synthesis:
  claude_model: sonnet
  default_tag: pessoal
  tag_policies:
    pessoal:
      store_transcript: true
    client-a:
      store_transcript: false
    client-b:
      # no store_transcript: fail closed
      other: 1
`

function parse(text, options = {}) {
  return parseConfig(text, { path: '/home/you/dev/turbidassist/config.yaml', home: HOME, ...options })
}

test('tags keep file order and the default tag is marked', () => {
  const config = parse(SAMPLE)
  assert.equal(config.ok, true, JSON.stringify(config.error))
  assert.deepEqual(config.tags.map(t => t.tag), ['pessoal', 'client-a', 'client-b'])
  assert.equal(config.defaultTag, 'pessoal')
  assert.deepEqual(config.tags.map(t => t.isDefault), [true, false, false])
  assert.equal(config.vaultPath, '/home/you/vault')
  assert.equal(config.meetingsFolder, 'Meetings')
  assert.equal(config.batchModel, 'large-v3')
  assert.equal(config.path, '/home/you/dev/turbidassist/config.yaml')
})

test('store_transcript false is confidential and true is not', () => {
  const config = parse(SAMPLE)
  const byTag = Object.fromEntries(config.tags.map(t => [t.tag, t.confidential]))
  assert.equal(byTag.pessoal, false)
  assert.equal(byTag['client-a'], true)
  for (const word of ['True', 'TRUE']) {
    const other = parse(SAMPLE.replace('store_transcript: true', `store_transcript: ${word}`))
    assert.equal(other.tags[0].confidential, false, word)
  }
  for (const word of ['"true"', 'yes', 'on', '1']) {
    const other = parse(SAMPLE.replace('store_transcript: true', `store_transcript: ${word}`))
    assert.equal(other.tags[0].confidential, true, word)
  }
})

test('a missing store_transcript is confidential', () => {
  const config = parse(SAMPLE)
  assert.equal(config.tags.find(t => t.tag === 'client-b').confidential, true)
  const empty = parse(SAMPLE.replace('    client-b:\n      # no store_transcript: fail closed\n      other: 1\n', '    client-b:\n'))
  assert.equal(empty.ok, true, JSON.stringify(empty.error))
  assert.deepEqual(empty.tags.at(-1), { tag: 'client-b', confidential: true, isDefault: false })
})

test('a duplicate key replaces the earlier one entirely, as PyYAML does', () => {
  const head = 'session_dir: /home/you/m\nsynthesis:\n  default_tag: acme\n  tag_policies:\n'
  const trueThenOther = parse(`${head}    acme:\n      store_transcript: true\n    client-a:\n      store_transcript: true\n    acme:\n      other: 1\n`)
  assert.equal(trueThenOther.ok, true, JSON.stringify(trueThenOther.error))
  assert.deepEqual(policyFor(trueThenOther, 'acme'), { confidential: true })
  assert.deepEqual(trueThenOther.tags.map(t => t.tag), ['acme', 'client-a'], 'a replaced key keeps its first position, as a Python dict does')
  const otherThenTrue = parse(`${head}    acme:\n      other: 1\n    acme:\n      store_transcript: true\n`)
  assert.deepEqual(policyFor(otherThenTrue, 'acme'), { confidential: false })
  const emptyAgain = parse(`${head}    acme:\n      store_transcript: true\n    acme:\n`)
  assert.deepEqual(policyFor(emptyAgain, 'acme'), { confidential: true })
  // Every level: a second tag_policies or synthesis block replaces the first one's tags.
  const policiesAgain = parse(`${head}    acme:\n      store_transcript: true\n  tag_policies:\n    client-a:\n      store_transcript: false\n`)
  assert.deepEqual(policiesAgain.tags.map(t => t.tag), ['client-a'])
  assert.deepEqual(policyFor(policiesAgain, 'acme'), { confidential: true })
  const synthesisAgain = parse(`${head}    acme:\n      store_transcript: true\nsynthesis:\n  tag_policies:\n    acme:\n`)
  assert.equal(synthesisAgain.defaultTag, null)
  assert.deepEqual(policyFor(synthesisAgain, 'acme'), { confidential: true })
  // A second top-level synthesis block without tag_policies drops the first block's tags.
  const synthesisWithoutPolicies = parse(`${head}    acme:\n      store_transcript: true\nsynthesis:\n  default_tag: acme\n`)
  assert.equal(synthesisWithoutPolicies.ok, true, JSON.stringify(synthesisWithoutPolicies.error))
  assert.deepEqual(synthesisWithoutPolicies.tags, [])
  assert.deepEqual(policyFor(synthesisWithoutPolicies, 'acme'), { confidential: true })
  const vaultAgain = parse('session_dir: /home/you/m\nvault:\n  path: /home/you/v\n  meetings_folder: M\nvault:\n  path: /home/you/w\n')
  assert.deepEqual([vaultAgain.vaultPath, vaultAgain.meetingsFolder], ['/home/you/w', null])
  const askAgain = parse('session_dir: /home/you/m\nask:\n  vault_mcp: true\nask:\n  backend: api\n')
  assert.equal(askAgain.askVaultMcp, false)
  const scalarAgain = parse('session_dir: /home/you/m\nsession_dir: /home/you/n\n')
  assert.equal(scalarAgain.sessionDir, '/home/you/n')
})

test('policyFor is confidential for an unknown tag and for an unreadable file', () => {
  const config = parse(SAMPLE)
  assert.deepEqual(policyFor(config, 'pessoal'), { confidential: false })
  assert.deepEqual(policyFor(config, 'acme'), { confidential: true })
  assert.deepEqual(policyFor(config, 'client-a'), { confidential: true })
  const failed = { ok: false, path: '/home/you/x.yaml', error: { code: 'unreadable', line: null, message: 'EACCES' } }
  assert.deepEqual(policyFor(failed, 'pessoal'), { confidential: true })
  assert.deepEqual(policyFor(null, 'pessoal'), { confidential: true })
})

test('a flow list under audio.route_rules and a block scalar under ask are skipped', () => {
  const config = parse(SAMPLE)
  assert.equal(config.ok, true, JSON.stringify(config.error))
  assert.equal(config.askVaultMcp, true)
  const without = parse(SAMPLE.replace('  vault_mcp: true\n', ''))
  assert.equal(without.askVaultMcp, false)
  const inner = parse('session_dir: /home/you/m\nvault:\n  git_commit: {enabled: true}\n  tasks: [a, b]\n  path: /home/you/v\n')
  assert.equal(inner.ok, true, JSON.stringify(inner.error))
  assert.equal(inner.vaultPath, '/home/you/v')
  const sequence = parse(`session_dir: /home/you/m\nunused:\n  - a\n  - [b, c]\nother:\n- x\n- y\nsynthesis:\n  default_tag: acme\n  tag_policies:\n    acme:\n      store_transcript: true\n`)
  assert.equal(sequence.ok, true, JSON.stringify(sequence.error))
  assert.deepEqual(sequence.tags, [{ tag: 'acme', confidential: false, isDefault: true }])
})

test('a flow mapping as the value of synthesis.tag_policies is unsupported with its line', () => {
  const text = 'session_dir: /home/you/m\nsynthesis:\n  default_tag: pessoal\n  tag_policies: {pessoal: {store_transcript: true}}\n'
  const config = parse(text)
  assert.equal(config.ok, false)
  assert.equal(config.error.code, 'unsupported')
  assert.equal(config.error.line, 4)
  const sequence = parse('session_dir: /home/you/m\nsynthesis:\n  tag_policies:\n    - pessoal\n')
  assert.deepEqual([sequence.error.code, sequence.error.line], ['unsupported', 4])
  const block = parse('session_dir: |\n  /home/you/m\n')
  assert.deepEqual([block.error.code, block.error.line], ['unsupported', 1])
})

test('session_dir expands ~/ against home and must be absolute', () => {
  const config = parse('session_dir: ~/meetings\nvault:\n  path: "~/vault"\n')
  assert.equal(config.sessionDir, '/home/you/meetings')
  assert.equal(config.vaultPath, '/home/you/vault')
  const relative = parse('session_dir: meetings\n')
  assert.deepEqual([relative.ok, relative.error.code, relative.error.line], [false, 'unsupported', 1])
  const missing = parse('vault:\n  path: /home/you/vault\n')
  assert.deepEqual([missing.ok, missing.error.code], [false, 'missing_key'])
})

test('a # inside a quoted tag is not a comment', () => {
  const text = `session_dir: /home/you/m # trailing comment
synthesis:
  default_tag: "acme#2" # the default
  tag_policies:
    'acme#2':
      store_transcript: true
`
  const config = parse(text)
  assert.equal(config.ok, true, JSON.stringify(config.error))
  assert.equal(config.sessionDir, '/home/you/m')
  assert.equal(config.defaultTag, 'acme#2')
  assert.deepEqual(config.tags, [{ tag: 'acme#2', confidential: false, isDefault: true }])
  const escaped = parse('session_dir: "/home/you/a \\"b\\" \\\\ c"\n')
  assert.equal(escaped.sessionDir, '/home/you/a "b" \\ c')
  const single = parse("session_dir: '/home/you/it''s'\n")
  assert.equal(single.sessionDir, "/home/you/it's")
})

test('a tab in the indentation is a syntax error with its line number', () => {
  const config = parse('session_dir: /home/you/m\nvault:\n  path: /home/you/v\n\tmeetings_folder: M\n')
  assert.equal(config.ok, false)
  assert.equal(config.error.code, 'syntax')
  assert.equal(config.error.line, 4)
  // A tab-indented child that would otherwise read as a consistent mapping level.
  const nested = parse('session_dir: /home/you/m\nvault:\n\tpath: /home/you/v\n')
  assert.deepEqual([nested.ok, nested.error?.code, nested.error?.line], [false, 'syntax', 3])
})

test('leading document marker is accepted and a second document is unsupported', () => {
  assert.equal(parse('---\nsession_dir: /home/you/m\n').ok, true)
  const two = parse('session_dir: /home/you/m\n---\nsession_dir: /home/you/n\n')
  assert.deepEqual([two.error.code, two.error.line], ['unsupported', 2])
  const anchor = parse('session_dir: &d /home/you/m\n')
  assert.deepEqual([anchor.error.code, anchor.error.line], ['unsupported', 1])
})

test('readConfig reports not_found, too_large and reads a real file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-mcfg-'))
  try {
    const file = path.join(dir, 'config.yaml')
    assert.deepEqual(readConfig(file, { home: HOME }).error.code, 'not_found')
    assert.deepEqual(readConfig(null, { home: HOME }), { ok: false, path: null, error: { code: 'not_found', line: null, message: 'no TurbidAssist config located' } })
    writeFileSync(file, SAMPLE)
    const config = readConfig(file, { home: HOME })
    assert.equal(config.ok, true, JSON.stringify(config.error))
    assert.equal(config.sessionDir, '/home/you/meetings')
    writeFileSync(file, `# ${'x'.repeat(256 * 1024)}\n`)
    assert.equal(readConfig(file, { home: HOME }).error.code, 'too_large')
    assert.equal(readConfig(dir, { home: HOME }).error.code, 'unreadable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('locateConfig prefers the pref and uses the default path only when it exists', () => {
  const seen = []
  const exists = file => { seen.push(file); return true }
  assert.equal(locateConfig({ pref: '~/ta/config.yaml', home: HOME, exists }), '/home/you/ta/config.yaml')
  assert.equal(locateConfig({ pref: '/srv/ta/config.yaml', home: HOME, exists }), '/srv/ta/config.yaml')
  assert.deepEqual(seen, [])
  assert.equal(locateConfig({ pref: null, home: HOME, exists }), '/home/you/dev/turbidassist/config.yaml')
  assert.equal(locateConfig({ pref: null, home: HOME, exists: () => false }), null)
})

function fakeTimers() {
  let clock = 0
  let seq = 0
  const pending = new Map()
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { at: clock + ms, fn }); return id },
    clearTimeout(id) { pending.delete(id) },
    advance(ms) {
      clock += ms
      for (const [id, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= clock && pending.has(id)) { pending.delete(id); entry.fn() }
      }
    },
    size: () => pending.size
  }
}

function fakeWatch() {
  const watchers = []
  const watch = (dir, listener) => {
    const handle = { dir, listener, closed: false, close() { this.closed = true } }
    watchers.push(handle)
    return handle
  }
  return { watch, watchers }
}

test('two directory changes within 1 s give one onChange', () => {
  const timers = fakeTimers()
  const { watch, watchers } = fakeWatch()
  let version = 0
  let reads = 0
  const changes = []
  const watcher = createConfigWatcher({
    locate: () => '/home/you/ta/config.yaml',
    read: file => { reads++; return { ok: true, path: file, version } },
    onChange: config => changes.push(config),
    watch,
    timers
  })
  assert.equal(watchers.length, 1)
  assert.equal(watchers[0].dir, '/home/you/ta')
  assert.equal(watcher.current().version, 0)
  version = 1
  watchers[0].listener('change', 'config.yaml')
  timers.advance(500)
  watchers[0].listener('rename', 'config.yaml.tmp')
  timers.advance(999)
  assert.equal(changes.length, 0)
  timers.advance(1)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].version, 1)
  assert.equal(reads, 2)
  watchers[0].listener('change', 'config.yaml')
  timers.advance(1000)
  assert.equal(changes.length, 1, 'an unchanged result does not call onChange')
  version = 2
  assert.equal(watcher.reload().version, 2)
  assert.equal(changes.length, 2)
  watcher.close()
  assert.equal(watchers[0].closed, true)
  watchers[0].listener('change', 'config.yaml')
  assert.equal(timers.size(), 0)
})

test('reload follows a moved config to its new directory', () => {
  const timers = fakeTimers()
  const { watch, watchers } = fakeWatch()
  let located = null
  const changes = []
  const watcher = createConfigWatcher({
    locate: () => located,
    read: file => file ? { ok: true, path: file } : { ok: false, path: null, error: { code: 'not_found', line: null, message: 'none' } },
    onChange: config => changes.push(config),
    watch,
    timers
  })
  assert.equal(watchers.length, 0)
  located = '/home/you/b/config.yaml'
  watcher.reload()
  assert.deepEqual(watchers.map(w => w.dir), ['/home/you/b'])
  assert.equal(changes.at(-1).path, '/home/you/b/config.yaml')
  watcher.close()
})
