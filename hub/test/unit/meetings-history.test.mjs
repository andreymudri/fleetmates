import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, unlink, utimes, stat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  listSessions, postState, readTranscript, readLiveEvents, searchTranscripts, logTail, speakers, lockKey, parseTranscriptMd,
  mountDevice, readInside
} from '../../server/meetings/history.mjs'
import { writeMeetingsTree, meetings5, VARIANTS } from '../helpers/meetings-tree.mjs'

const MIN = 60 * 1000

async function tree(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-meet-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, ...await writeMeetingsTree(root, meetings5, options) }
}

const procLine = (key, pid = 4242) => {
  const [major, minor, ino] = key.split(':')
  return `1: FLOCK  ADVISORY  WRITE ${pid} ${Number(major).toString(16).padStart(2, '0')}:${Number(minor).toString(16).padStart(2, '0')}:${ino} 0 EOF\n`
}

test('listSessions returns the five fixture sessions newest first, today 14:00 client-a on top', async t => {
  const m = await tree(t)
  const list = await listSessions(m.sessionDir, { now: m.now })
  assert.deepEqual(list.map(s => s.id), m.ids.meetings)
  assert.equal(list[0].id, '2026-09-12T14-00-00')
  assert.equal(list[0].tag, 'client-a')
  assert.equal(list[0].state, 'synthesized')
  assert.equal(list[0].endedAt - list[0].startedAt, 42 * MIN)
  assert.equal(list[0].dir, path.join(m.sessionDir, list[0].id))
  assert.ok(list.every(s => s.interrupted === false))
})

test('listSessions skips a non-matching name, a file and a symlinked session directory', async t => {
  const m = await tree(t)
  await mkdir(path.join(m.sessionDir, 'notes'))
  await mkdir(path.join(m.sessionDir, '2026-09-12T14-00'))
  await writeFile(path.join(m.sessionDir, '2026-09-12T15-00-00'), 'not a directory')
  const outside = path.join(m.root, 'elsewhere', '2026-09-12T15-30-00')
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'session.json'), JSON.stringify({ tag: 'pessoal', state: 'synthesized' }))
  await symlink(outside, path.join(m.sessionDir, '2026-09-12T15-30-00'))
  await symlink(path.join(m.sessionDir, m.ids.weekly), path.join(m.sessionDir, '2026-09-12T15-45-00'))
  const list = await listSessions(m.sessionDir, { now: m.now })
  assert.deepEqual(list.map(s => s.id), m.ids.meetings)
})

test('a manifest state outside the batch list reads as recorded', async t => {
  const m = await tree(t)
  const file = path.join(m.sessionDir, m.ids.planning, 'session.json')
  await writeFile(file, JSON.stringify({ tag: 'pessoal', started_at: '2026-09-12T10:30:00-03:00', state: 'exploded' }))
  const list = await listSessions(m.sessionDir, { now: m.now })
  assert.equal(list.find(s => s.id === m.ids.planning).state, 'recorded')
})

test('the interrupted variant is interrupted; a fresh directory without a manifest is stopping, or recording when named', async t => {
  const m = await tree(t, { variants: ['interrupted', 'recording'] })
  const list = await listSessions(m.sessionDir, { now: m.now })
  const interrupted = list.find(s => s.id === m.ids.interrupted)
  assert.equal(interrupted.state, 'stopping')
  assert.equal(interrupted.interrupted, true)
  assert.equal(interrupted.tag, null)
  const [y, mo, d] = [2026, 8, 10]
  assert.equal(interrupted.startedAt, new Date(y, mo, d, 17, 0, 0).getTime())
  const fresh = list.find(s => s.id === m.ids.recording)
  assert.equal(fresh.state, 'stopping')
  assert.equal(fresh.interrupted, false)
  const named = await listSessions(m.sessionDir, { now: m.now, recordingId: m.ids.recording })
  assert.equal(named.find(s => s.id === m.ids.recording).state, 'recording')
  assert.equal(list[0].id, m.ids.recording)
})

test('postState: stuck after 10 quiet minutes with the lock not held, not stuck with the lock inode in /proc/locks', async t => {
  const m = await tree(t, { variants: ['stuck'] })
  const id = m.ids.stuck
  const lock = path.join(m.sessionDir, 'postmeet.lock')
  assert.deepEqual(await postState(m.sessionDir, id, { now: m.now, procLocks: '' }), { state: 'transcribed', stuck: true })
  await writeFile(lock, '')
  const info = await stat(lock, { bigint: true })
  assert.deepEqual(await postState(m.sessionDir, id, { now: m.now, procLocks: '' }), { state: 'transcribed', stuck: true })
  assert.deepEqual(await postState(m.sessionDir, id, { now: m.now, procLocks: () => procLine(lockKey(info)) }), { state: 'transcribed', stuck: false })
  assert.deepEqual(await postState(m.sessionDir, m.ids.weekly, { now: m.now, procLocks: '' }), { state: 'synthesized', stuck: false })
  const log = path.join(m.sessionDir, id, 'postmeet.log')
  const recent = new Date(m.now - 9 * MIN)
  await utimes(log, recent, recent)
  assert.equal((await postState(m.sessionDir, id, { now: m.now, procLocks: '' })).stuck, false)
})

test('postState without /proc/locks treats a lock changed within 10 minutes as held', async t => {
  const m = await tree(t, { variants: ['stuck'] })
  const lock = path.join(m.sessionDir, 'postmeet.lock')
  await writeFile(lock, '')
  const unreadable = () => { throw Object.assign(new Error('no /proc'), { code: 'ENOENT' }) }
  const fresh = new Date(m.now - 2 * MIN)
  await utimes(lock, fresh, fresh)
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { now: m.now, procLocks: unreadable })).stuck, false)
  const old = new Date(m.now - 11 * MIN)
  await utimes(lock, old, old)
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { now: m.now, procLocks: unreadable })).stuck, true)
})

test('postState detects a btrfs-style lock: /proc/locks lists the mount device, stat() an anonymous one', async t => {
  const m = await tree(t, { variants: ['stuck'] })
  const lock = path.join(m.sessionDir, 'postmeet.lock')
  await writeFile(lock, '')
  const info = await stat(lock, { bigint: true })
  const statDev = lockKey(info).split(':').slice(0, 2).join(':')
  const mountDev = statDev === '0:29' ? '0:31' : '0:29'
  const root = await realpath(m.root)
  const mountinfo = [
    `32 2 0:99 /@ / rw,relatime shared:1 - btrfs /dev/mapper/root rw,subvol=/@`,
    `58 32 ${mountDev} /@home ${root} rw,relatime shared:206 - btrfs /dev/mapper/root rw,subvol=/@home`,
    `70 58 0:98 / ${root}-other rw,relatime - tmpfs tmpfs rw`
  ].join('\n') + '\n'
  const options = { now: m.now, mountinfo }
  const held = procLine(`${mountDev}:${info.ino}`)
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { ...options, procLocks: held })).stuck, false)
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { ...options, procLocks: procLine(`${mountDev}:${info.ino + 1n}`) })).stuck, true)
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { ...options, procLocks: procLine(`0:98:${info.ino}`) })).stuck, true)
  const elsewhere = `32 2 0:99 / / rw - ext4 /dev/x rw\n70 32 ${mountDev} / ${root}-other rw - tmpfs tmpfs rw\n`
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { now: m.now, mountinfo: elsewhere, procLocks: held })).stuck, true)
})

test('mountDevice picks the longest containing mount point and decodes octal escapes', () => {
  const text = '1 0 0:10 / / rw - ext4 a rw\n2 1 0:40 / /mnt/with\\040space rw - x y rw\n3 1 0:41 / /mnt/with rw - x y rw\n'
  assert.equal(mountDevice(text, '/mnt/with space/a'), '0:40')
  assert.equal(mountDevice(text, '/mnt/with/a'), '0:41')
  assert.equal(mountDevice(text, '/mnt/without/a'), '0:10')
})

test('postState reads a real flock(1) lock from /proc/locks',{ skip: !(existsSync('/proc/locks') && existsSync('/usr/bin/flock')) && 'needs Linux /proc/locks and /usr/bin/flock' }, async t => {
  const m = await tree(t, { variants: ['stuck'] })
  const lock = path.join(m.sessionDir, 'postmeet.lock')
  await writeFile(lock, '')
  assert.equal((await postState(m.sessionDir, m.ids.stuck, { now: m.now })).stuck, true)
  const child = spawn('/usr/bin/flock', [lock, '/bin/sleep', '30'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  let stuck = true
  for (let i = 0; i < 100 && stuck; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    stuck = (await postState(m.sessionDir, m.ids.stuck, { now: m.now })).stuck
  }
  assert.equal(stuck, false)
})

test('readTranscript prefers transcript.json, then transcript.md, then transcript.jsonl', async t => {
  const m = await tree(t)
  const dir = path.join(m.sessionDir, m.ids.weekly)
  const json = await readTranscript(m.sessionDir, m.ids.weekly)
  assert.equal(json.source, 'batch')
  assert.deepEqual(json.lines[0], { t0: 4.2, t1: 9.8, speaker: 'Você', text: 'Bom dia, vamos começar pela versão 3.2.' })
  assert.equal(speakers(json.lines), 4)
  await unlink(path.join(dir, 'transcript.json'))
  const md = await readTranscript(m.sessionDir, m.ids.weekly)
  assert.equal(md.source, 'batch')
  assert.deepEqual(md.lines[0], { t0: 4, t1: 11, speaker: 'Você', text: 'Bom dia, vamos começar pela versão 3.2.' })
  assert.equal(md.lines.at(-1).t1, md.lines.at(-1).t0)
  await unlink(path.join(dir, 'transcript.md'))
  const live = await readTranscript(m.sessionDir, m.ids.weekly)
  assert.equal(live.source, 'live')
  assert.deepEqual(live.lines[1], { t0: 11.0, t1: 17.5, speaker: 'Sala', text: 'O build da 3.2 passou em todos os testes ontem.' })
  assert.equal(speakers(live.lines), 2)
  await unlink(path.join(dir, 'transcript.jsonl'))
  assert.equal(await readTranscript(m.sessionDir, m.ids.weekly), null)
})

test('reads refuse a directory or a FIFO in place of a file, and a file over the cap', async t => {
  const m = await tree(t, { variants: ['stuck'] })
  const json = path.join(m.sessionDir, m.ids.weekly, 'transcript.json')
  await unlink(json)
  await mkdir(json)
  await assert.rejects(readTranscript(m.sessionDir, m.ids.weekly), { code: 'refused' })
  const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(existsSync)
  if (mkfifo) {
    const log = path.join(m.sessionDir, m.ids.stuck, 'postmeet.log')
    await unlink(log)
    assert.equal(spawnSync(mkfifo, [log]).status, 0)
    await assert.rejects(logTail(m.sessionDir, m.ids.stuck), { code: 'refused' })
  } else t.diagnostic('no mkfifo binary: the FIFO case did not run')
  const md = await stat(path.join(m.sessionDir, m.ids.planning, 'transcript.md'))
  await assert.rejects(readInside(m.sessionDir, [m.ids.planning, 'transcript.md'], md.size - 1), { code: 'too_large' })
  const exact = await readInside(m.sessionDir, [m.ids.planning, 'transcript.md'], md.size)
  assert.equal(exact.bytes.length, md.size)
})

test('transcript.md reads [HH:MM:SS] with hours, and malformed lines are skipped and counted', () => {
  const parsed = parseTranscriptMd('[01:02:05] Você: olá\nlixo sem formato\n[01:02:09] SPEAKER_00: oi\n')
  assert.equal(parsed.lines[0].t0, 3725)
  assert.equal(parsed.lines[0].t1, 3729)
  assert.equal(parsed.skipped, 1)
})

test('readTranscript skips and counts malformed live lines', async t => {
  const m = await tree(t, { variants: ['recording'] })
  const file = path.join(m.sessionDir, m.ids.recording, 'transcript.jsonl')
  await writeFile(file, '{"t0":1,"t1":2,"source":"mic","text":"a"}\nnot json\n{"t0":3,"t1":4,"source":"tv","text":"b"}\n')
  const live = await readTranscript(m.sessionDir, m.ids.recording)
  assert.deepEqual(live, { source: 'live', lines: [{ t0: 1, t1: 2, speaker: 'Você', text: 'a' }], skipped: 2 })
})

test('readLiveEvents returns only events with t1 after afterT1, in file order', async t => {
  const m = await tree(t, { variants: ['recording'] })
  const events = await readLiveEvents(m.sessionDir, m.ids.recording, { afterT1: 5.5 })
  assert.deepEqual(events.map(e => e.t1), [9.0])
  assert.equal(events[0].source, 'room')
  assert.deepEqual((await readLiveEvents(m.sessionDir, m.ids.recording)).map(e => e.t1), [5.5, 9.0])
})

test('search "feature flag" gives 4 hits in 2 meetings, newest first, with ranges on each', async t => {
  const m = await tree(t)
  const list = await listSessions(m.sessionDir, { now: m.now })
  const result = await searchTranscripts(list, 'feature flag')
  assert.equal(result.hits.length, 4)
  assert.equal(result.meetingCount, 2)
  assert.equal(result.partial, false)
  assert.deepEqual(result.hits.map(h => h.meetingId), [m.ids.weekly, m.ids.weekly, m.ids.retro, m.ids.retro])
  for (const hit of result.hits) {
    assert.ok(hit.ranges.length >= 1)
    for (const [a, b] of hit.ranges) assert.equal(hit.snippet.slice(a, b).toLowerCase(), 'feature flag')
  }
  assert.equal(result.hits[0].t0, 1060)
  assert.equal(result.hits[0].speaker, 'Você')
  assert.equal(result.hits[1].snippet.slice(...result.hits[1].ranges[0]), 'Feature Flag')
  assert.equal(result.hits[2].ranges.length, 2)
})

test('search folds accents and case: "decisao" finds "decisão"', async t => {
  const m = await tree(t)
  const list = await listSessions(m.sessionDir, { now: m.now })
  const result = await searchTranscripts(list, 'DECISAO')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].meetingId, m.ids.roadmap)
  assert.equal(result.hits[0].snippet.slice(...result.hits[0].ranges[0]), 'decisão')
})

const TRANSCRIPT_FILES = ['transcript.json', 'transcript.md', 'transcript.jsonl']

async function replaceInTranscripts(dir, from, to) {
  for (const name of TRANSCRIPT_FILES) {
    const file = path.join(dir, name)
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll(from, to))
  }
}

test('search reads the disk on every call, confidential sessions included: a changed word and a deleted transcript show at once', async t => {
  const m = await tree(t, { variants: ['confidential'] })
  const list = await listSessions(m.sessionDir, { now: m.now })
  const dir = path.join(m.sessionDir, m.ids.confidential)
  const [word] = m.sentinels.confidential
  assert.equal((await searchTranscripts(list, word)).hits.length, 1)
  await replaceInTranscripts(dir, word, 'PALAVRA-NOVA')
  assert.equal((await searchTranscripts(list, word)).hits.length, 0)
  assert.deepEqual((await searchTranscripts(list, 'palavra-nova')).hits.map(h => h.meetingId), [m.ids.confidential])
  assert.equal((await searchTranscripts(list, 'feature flag')).hits.length, 4)
  for (const name of TRANSCRIPT_FILES) await unlink(path.join(dir, name))
  assert.equal((await searchTranscripts(list, 'palavra-nova')).hits.length, 0)
  assert.equal((await searchTranscripts(list, 'feature flag')).hits.length, 4)
})

test('readTranscript reads the disk on every call, confidential sessions included', async t => {
  const m = await tree(t, { variants: ['confidential'] })
  const dir = path.join(m.sessionDir, m.ids.confidential)
  const [word] = m.sentinels.confidential
  assert.match((await readTranscript(m.sessionDir, m.ids.confidential)).lines[0].text, new RegExp(word))
  await replaceInTranscripts(dir, word, 'PALAVRA-NOVA')
  assert.equal((await readTranscript(m.sessionDir, m.ids.confidential)).lines[0].text, 'O codinome do projeto é PALAVRA-NOVA.')
  for (const name of TRANSCRIPT_FILES) await unlink(path.join(dir, name))
  assert.equal(await readTranscript(m.sessionDir, m.ids.confidential), null)
})

// Rewrites every transcript file with a same-length word and puts back its exact atime and mtime, so a cache
// keyed on a file's size and mtime cannot tell the new text from the old.
async function swapSameLength(dir, from, to) {
  assert.equal(from.length, to.length)
  for (const name of TRANSCRIPT_FILES) {
    const file = path.join(dir, name)
    const before = await stat(file)
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll(from, to))
    await utimes(file, before.atime, before.mtime)
    const after = await stat(file)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
  }
}

test('readTranscript returns a same-length rewrite with an unchanged mtime and size, confidential included', async t => {
  const m = await tree(t, { variants: ['confidential'] })
  const dir = path.join(m.sessionDir, m.ids.confidential)
  const [word] = m.sentinels.confidential
  const other = 'SENTINELA9'
  assert.match(JSON.stringify(await readTranscript(m.sessionDir, m.ids.confidential)), new RegExp(`${word}\\.`))
  await swapSameLength(dir, word, other)
  const text = JSON.stringify(await readTranscript(m.sessionDir, m.ids.confidential))
  assert.match(text, new RegExp(other))
  assert.doesNotMatch(text, new RegExp(`${word}\\.`))
})

test('search returns a same-length rewrite with an unchanged mtime and size, confidential included', async t => {
  const m = await tree(t, { variants: ['confidential'] })
  const list = await listSessions(m.sessionDir, { now: m.now })
  const dir = path.join(m.sessionDir, m.ids.confidential)
  const [word] = m.sentinels.confidential
  const other = 'SENTINELA9'
  assert.equal((await searchTranscripts(list, `${word}.`)).hits.length, 1)
  assert.equal((await searchTranscripts(list, other)).hits.length, 0)
  await swapSameLength(dir, word, other)
  assert.equal((await searchTranscripts(list, `${word}.`)).hits.length, 0)
  assert.deepEqual((await searchTranscripts(list, other)).hits.map(h => h.meetingId), [m.ids.confidential])
})

test('search reaches the confidential variant (MEET-O7)', async t => {
  const m = await tree(t, { variants: ['confidential'] })
  const list = await listSessions(m.sessionDir, { now: m.now })
  const result = await searchTranscripts(list, m.sentinels.confidential[0])
  assert.deepEqual(result.hits.map(h => h.meetingId), [m.ids.confidential])
})

test('search past its time budget returns partial', async t => {
  const m = await tree(t)
  const list = await listSessions(m.sessionDir, { now: m.now })
  let clock = 0
  const result = await searchTranscripts(list, 'feature flag', { budgetMs: 2000, now: () => (clock += 1500) })
  assert.equal(result.partial, true)
  assert.ok(result.hits.length < 4)
  const capped = await searchTranscripts(list, 'feature flag', { maxHits: 3 })
  assert.equal(capped.hits.length, 3)
  assert.equal(capped.partial, true)
})

test('search keeps a long line snippet within 160 characters around the match, and rejects a 1-character query', async t => {
  const m = await tree(t)
  const id = m.ids.planning
  const text = 'a'.repeat(300) + ' feature flag ' + 'b'.repeat(300)
  await writeFile(path.join(m.sessionDir, id, 'transcript.json'), JSON.stringify([{ t0: 1, t1: 2, speaker: 'Você', text }]))
  const list = (await listSessions(m.sessionDir, { now: m.now })).filter(s => s.id === id)
  const { hits } = await searchTranscripts(list, 'feature flag')
  assert.equal(hits.length, 1)
  assert.ok(hits[0].snippet.length <= 160)
  assert.equal(hits[0].snippet.slice(...hits[0].ranges[0]), 'feature flag')
  await assert.rejects(searchTranscripts(list, ' a '), { code: 'validation_failed' })
})

test('logTail returns the last lines of postmeet.log and refuses a symlink out of session_dir', async t => {
  const m = await tree(t, { variants: ['stuck'] })
  assert.equal(await logTail(m.sessionDir, m.ids.weekly, 2), 'síntese concluída\nnota publicada no vault')
  const log = path.join(m.sessionDir, m.ids.stuck, 'postmeet.log')
  const outside = path.join(m.root, 'secret.log')
  await writeFile(outside, 'fora do session_dir\n')
  await unlink(log)
  await symlink(outside, log)
  await assert.rejects(logTail(m.sessionDir, m.ids.stuck), { code: 'refused' })
  await unlink(log)
  await symlink(path.join(m.sessionDir, m.ids.stuck, 'transcript.md'), log)
  await assert.rejects(logTail(m.sessionDir, m.ids.stuck), { code: 'refused' })
  const elsewhere = path.join(m.root, 'elsewhere')
  await mkdir(elsewhere)
  await writeFile(path.join(elsewhere, 'postmeet.log'), 'fora do session_dir\n')
  await symlink(elsewhere, path.join(m.sessionDir, '2026-09-12T15-45-00'))
  await assert.rejects(logTail(m.sessionDir, '2026-09-12T15-45-00'), { code: 'refused' })
})

test('logTail reads only the last 64 KiB and drops the cut first line', async t => {
  const m = await tree(t)
  const log = path.join(m.sessionDir, m.ids.weekly, 'postmeet.log')
  const lines = Array.from({ length: 5000 }, (_, i) => `linha ${i} ${'x'.repeat(20)}`)
  await writeFile(log, lines.join('\n') + '\n')
  const tail = await logTail(m.sessionDir, m.ids.weekly, 100000)
  assert.ok(Buffer.byteLength(tail) <= 64 * 1024)
  assert.equal(tail.split('\n').at(-1), lines.at(-1))
  assert.ok(lines.includes(tail.split('\n')[0]))
})

test('the fixture writes every variant with its sentinels and private modes', async t => {
  const m = await tree(t, { variants: VARIANTS })
  assert.deepEqual(Object.keys(m.sentinels).sort(), [...VARIANTS].sort())
  const info = await stat(path.join(m.sessionDir, m.ids.confidential, 'transcript.jsonl'))
  assert.equal(info.mode & 0o777, 0o600)
  assert.equal((await stat(path.join(m.sessionDir, m.ids.confidential))).mode & 0o777, 0o700)
  assert.equal(m.configPath, path.join(m.root, 'dev', 'turbidassist', 'config.yaml'))
})
