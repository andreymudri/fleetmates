import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, chmod, writeFile, readFile, symlink, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { findNote, parseNote, readNote, itemKey, splitOwner } from '../../server/meetings/note.mjs'
import { writeMeetingsTree, meetings5 } from '../helpers/meetings-tree.mjs'

async function tree(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-note-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, ...await writeMeetingsTree(root, meetings5, options) }
}

const where = (m, key, tag) => ({ vaultPath: m.vaultPath, meetingsFolder: 'Meetings', id: m.ids[key], tag, date: m.ids[key].slice(0, 10) })

test('findNote resolves two candidates with the same date and tag prefix by frontmatter session_id', async t => {
  const m = await tree(t)
  const other = path.join(m.vaultPath, 'Meetings', `2026-09-12 client-a \u2014 aaa outra reunião.md`)
  await writeFile(other, '---\ntags: [meeting, client-a]\ndate: 2026-09-12\nsession_id: 2026-09-12T09-00-00\n---\n\n# aaa outra reunião\n')
  assert.equal(await findNote(where(m, 'weekly', 'client-a')), m.notes.weekly)
  assert.equal(m.notes.weekly, 'Meetings/2026-09-12 client-a \u2014 weekly sync.md')
  assert.equal(await findNote({ ...where(m, 'weekly', 'client-a'), id: '2026-09-12T09-00-00' }), path.join('Meetings', path.basename(other)))
  assert.equal(await findNote({ ...where(m, 'weekly', 'client-a'), id: '2026-09-12T23-59-59' }), null)
  assert.equal(await findNote(where(m, 'weekly', 'pessoal')), null)
})

test('findNote skips a symlinked note and a folder outside the vault', async t => {
  const m = await tree(t)
  const real = path.join(m.vaultPath, m.notes.weekly)
  const outside = path.join(m.root, 'outside.md')
  await writeFile(outside, await readFile(real))
  await unlink(real)
  await symlink(outside, real)
  assert.equal(await findNote(where(m, 'weekly', 'client-a')), null)
  assert.equal(await findNote({ ...where(m, 'planning', 'pessoal'), meetingsFolder: '../meetings' }), null)
  assert.equal(await findNote(where(m, 'planning', 'pessoal')), m.notes.planning)
})

test('findNote refuses a meetings folder that is the vault itself or outside it', async t => {
  const m = await tree(t)
  const body = (await readFile(path.join(m.vaultPath, m.notes.weekly), 'utf8'))
  const name = path.basename(m.notes.weekly)
  const outside = path.join(m.root, 'outside-vault')
  await mkdir(outside)
  for (const dir of [m.vaultPath, m.root, outside]) await writeFile(path.join(dir, name), body)
  const base = where(m, 'weekly', 'client-a')
  assert.equal(await findNote({ ...base, meetingsFolder: '.' }), null)
  assert.equal(await findNote({ ...base, meetingsFolder: '..' }), null)
  assert.equal(await findNote({ ...base, meetingsFolder: outside }), null)
  assert.equal(await findNote({ ...base, meetingsFolder: '../outside-vault' }), null)
  assert.equal(await findNote(base), m.notes.weekly)
  // An unlistable folder outside the vault: findNote must answer null without ever listing it, so no EACCES.
  const locked = path.join(m.root, 'locked')
  await mkdir(locked)
  await chmod(locked, 0o311)
  try { assert.equal(await findNote({ ...base, meetingsFolder: '../locked' }), null) } finally { await chmod(locked, 0o700) }
})

test('readNote reads a vault-relative note and refuses a symlink', async t => {
  const m = await tree(t)
  const text = await readNote({ vaultPath: m.vaultPath, notePath: m.notes.weekly })
  assert.equal(parseNote(text).title, 'weekly sync')
  const real = path.join(m.vaultPath, m.notes.retro)
  await unlink(real)
  await symlink(path.join(m.vaultPath, m.notes.weekly), real)
  await assert.rejects(readNote({ vaultPath: m.vaultPath, notePath: m.notes.retro }), { code: 'refused' })
  assert.equal(await readNote({ vaultPath: m.vaultPath, notePath: '../meetings/x.md' }), null)
})

test('parseNote reads title, summary, decisions and action items with owners', async t => {
  const m = await tree(t)
  const note = parseNote(await readNote({ vaultPath: m.vaultPath, notePath: m.notes.weekly }))
  const weekly = meetings5.sessions[0]
  assert.equal(note.title, 'weekly sync')
  assert.equal(note.summary, weekly.summary)
  assert.deepEqual(note.decisions, weekly.decisions)
  assert.deepEqual(note.actionItems.map(i => [i.owner, i.text]), [
    ['Você', 'ligar o feature flag da 3.2 no beta interno até quarta'],
    ['SPEAKER_00', 'revisar o painel de métricas do rollout'],
    [null, 'atualizar a página de status antes do lançamento']
  ])
  assert.ok(note.actionItems.every(i => /^[0-9a-f]{40}$/.test(i.key)))
})

test('the placeholders give empty decision and action item lists', async t => {
  const m = await tree(t)
  const note = parseNote(await readNote({ vaultPath: m.vaultPath, notePath: m.notes.planning }))
  assert.deepEqual(note.decisions, [])
  assert.deepEqual(note.actionItems, [])
  assert.equal(note.summary, meetings5.sessions[1].summary)
})

test('the owner is the prefix before ":" only up to 40 characters and without . ! ?', () => {
  assert.deepEqual(splitOwner('Você: ligar o flag'), { owner: 'Você', text: 'ligar o flag' })
  const forty = 'x'.repeat(40)
  const fortyOne = 'x'.repeat(41)
  assert.deepEqual(splitOwner(`${forty}: fazer`), { owner: forty, text: 'fazer' })
  assert.deepEqual(splitOwner(`${fortyOne}: fazer`), { owner: null, text: `${fortyOne}: fazer` })
  assert.deepEqual(splitOwner('Veja isto. Depois: fazer'), { owner: null, text: 'Veja isto. Depois: fazer' })
  assert.deepEqual(splitOwner('sem dono nenhum'), { owner: null, text: 'sem dono nenhum' })
})

test('the item key is equal across whitespace and normalization differences', () => {
  const key = itemKey('Você: ligar  o\tflag ')
  assert.equal(key, itemKey(' Você: ligar o flag'))
  assert.equal(itemKey('Você: ligar o flag'), key)
  assert.equal(key, createHash('sha1').update('Você: ligar o flag').digest('hex'))
  assert.notEqual(key, itemKey('Você: ligar o flag hoje'))
  const a = parseNote('## Action items\n- [ ] Você:  ligar o flag\n')
  const b = parseNote('## Action items\n- [ ] Você: ligar   o flag\n')
  assert.equal(a.actionItems[0].key, b.actionItems[0].key)
})

test('Transcript and Perguntas ao vivo never reach the summary', async t => {
  const m = await tree(t)
  const text = await readNote({ vaultPath: m.vaultPath, notePath: m.notes.retro })
  assert.match(text, /## Transcript/)
  assert.match(text, /O feature flag novo/)
  const note = parseNote(text)
  assert.equal(note.summary, meetings5.sessions[3].summary)
  assert.doesNotMatch(JSON.stringify(note), /feature flag novo|Transcript|Perguntas/)
  const tail = parseNote('# t\n\n## Resumo\nresumo\n\n## Perguntas ao vivo\n> **pergunta?**\n> resposta\n\n## Decisões\n- d\n')
  assert.equal(tail.summary, 'resumo')
  assert.deepEqual(tail.decisions, ['d'])
})

test('<script> in a note comes back as plain text', () => {
  const note = parseNote('# <script>alert(1)</script>\n\n## Resumo\n<script>alert(2)</script> e <b>negrito</b>\n\n## Action items\n- [ ] <script>alert(3)</script>\n')
  assert.equal(note.title, '<script>alert(1)</script>')
  assert.equal(note.summary, '<script>alert(2)</script> e <b>negrito</b>')
  assert.equal(note.actionItems[0].text, '<script>alert(3)</script>')
})
