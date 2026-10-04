import { mkdir, writeFile, utimes, chmod } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The meetings5 fixture of meetings.md AC1 (placeholders only). */
export const meetings5 = Object.freeze(JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'meetings', 'meetings5.json'), 'utf8')))

/** Every variant name the fixture defines. */
export const VARIANTS = Object.freeze(Object.keys(meetings5.variants))

const pad = (n, w = 2) => String(n).padStart(w, '0')
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const sessionId = d => `${localDate(d)}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
const offset = d => {
  const minutes = -d.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}
const isoLocal = d => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset(d)}`
const hms = seconds => {
  const s = Math.floor(seconds)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

/**
 * Local start time of a fixture session: `dayOffset` days from `now` at `time`.
 * @param {{ dayOffset: number, time: string }} session
 * @param {number} now epoch ms
 * @returns {Date}
 */
export function sessionStart(session, now) {
  const base = new Date(now)
  const [h, m, s] = session.time.split(':').map(Number)
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + session.dayOffset, h, m, s)
}

/**
 * The frozen `now` of the fixture as epoch ms (local time).
 * @param {object} [fixture]
 * @returns {number}
 */
export function fixtureNow(fixture = meetings5) {
  return new Date(fixture.now).getTime()
}

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')

async function put(file, text, mtime) {
  await writeFile(file, text, { mode: 0o600 })
  await chmod(file, 0o600)
  if (mtime) await utimes(file, mtime, mtime)
}

function noteText(session, { id, date, confidential }) {
  const out = ['---', `tags: [meeting, ${session.tag}]`, `date: ${date}`, `session_id: ${id}`, '---', '', `# ${session.title}`, '',
    '## Resumo', session.summary, '', '## Decisões', ...session.decisions.map(d => `- ${d}`), '',
    '## Action items', ...session.actionItems.map(item => `- [ ] ${item}`), '']
  if (!confidential) {
    out.push('## Transcript', '', '> [!note]- Transcript', ...session.transcript.map(l => `> [${hms(l.t0)}] ${l.speaker}: ${l.text}`), '')
    if (session.asks.length) out.push('## Perguntas ao vivo', '', '> [!note]- Perguntas ao vivo', ...session.asks.flatMap(a => [`> **${a.question}**`, `> ${a.answer}`]), '')
  }
  return out.join('\n')
}

async function writeSession(root, session, { now, fixture }) {
  const start = sessionStart(session, now)
  const id = sessionId(start)
  const end = new Date(start.getTime() + session.durationMin * 60 * 1000)
  const state = session.state ?? 'synthesized'
  const manifest = session.manifest !== false
  const confidential = fixture.confidentialTags.includes(session.tag)
  const fileTime = session.fresh ? new Date(now) : new Date(Math.min(now, end.getTime() + 2 * 60 * 1000))
  const dir = path.join(root, 'meetings', id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const live = session.transcript.map(line => ({ t0: line.t0, t1: line.t1, source: line.speaker === 'Você' ? 'mic' : 'room', text: line.text, lang: 'pt', asr_model: fixture.asrModel, session_id: id }))
  await put(path.join(dir, 'transcript.jsonl'), jsonl(live), fileTime)
  await put(path.join(dir, 'asks.jsonl'), jsonl(session.asks.map(a => ({ t: a.t, question: a.question, answer: a.answer, context_minutes: 5.0 }))), fileTime)
  if (manifest) {
    await put(path.join(dir, 'session.json'), JSON.stringify({
      session_id: id, tag: session.tag, started_at: isoLocal(start), ended_at: isoLocal(end), mic_wav: 'mic.wav', room_wav: 'room.wav',
      transcript_jsonl: 'transcript.jsonl', asks_jsonl: 'asks.jsonl', state
    }, null, 2) + '\n', fileTime)
    if (state !== 'recorded') {
      await put(path.join(dir, 'transcript.json'), JSON.stringify(session.transcript.map(l => ({ t0: l.t0, t1: l.t1, speaker: l.speaker, text: l.text })), null, 2) + '\n', fileTime)
      await put(path.join(dir, 'transcript.md'), session.transcript.map(l => `[${hms(l.t0)}] ${l.speaker}: ${l.text}`).join('\n') + '\n', fileTime)
    }
    const log = [`postmeet run ${id}`, 'transcrevendo com large-v3', 'diarização concluída', 'merge concluído']
    if (state === 'synthesized') log.push('síntese concluída', 'nota publicada no vault')
    await put(path.join(dir, 'postmeet.log'), log.join('\n') + '\n', fileTime)
  }
  await utimes(dir, fileTime, fileTime)
  let note = null
  if (manifest && state === 'synthesized') {
    const date = localDate(start)
    const folder = path.join(root, 'vault', 'Meetings')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    note = path.join('Meetings', `${date} ${session.tag} \u2014 ${session.title}.md`)
    await put(path.join(root, 'vault', note), noteText(session, { id, date, confidential }), fileTime)
  }
  return { id, note }
}

/**
 * Write the meetings5 tree under `root` (a temporary HOME): `<root>/meetings/<id>/` with `session.json`,
 * `transcript.json`, `transcript.md`, `transcript.jsonl`, `asks.jsonl` and `postmeet.log` (directories 0700,
 * files 0600), `<root>/vault/Meetings/<date> <tag> <U+2014> <title>.md` for every synthesized session, and
 * `<root>/dev/turbidassist/config.yaml` (the MEET-O11 default location; its paths use `~/`, so read it with
 * `root` as HOME). Variants are written only when named.
 * @param {string} root
 * @param {object} [fixture] defaults to meetings5
 * @param {{ now?: number, variants?: string[] }} [options]
 * @returns {Promise<{ sessionDir: string, vaultPath: string, configPath: string, now: number,
 *   ids: Record<string, string> & { meetings: string[] }, notes: Record<string, string>,
 *   sentinels: Record<string, string[]> }>} `ids.meetings` holds the five base ids newest first; other keys
 *   are the session keys and variant names. `notes` maps keys to vault-relative note paths.
 */
export async function writeMeetingsTree(root, fixture = meetings5, { now = fixtureNow(fixture), variants = [] } = {}) {
  const sessionDir = path.join(root, 'meetings')
  const vaultPath = path.join(root, 'vault')
  const configDir = path.join(root, 'dev', 'turbidassist')
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  await mkdir(path.join(vaultPath, 'Meetings'), { recursive: true, mode: 0o700 })
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const configPath = path.join(configDir, 'config.yaml')
  await put(configPath, fixture.config)
  const ids = { meetings: [] }
  const notes = {}
  const sentinels = {}
  for (const session of fixture.sessions) {
    const { id, note } = await writeSession(root, session, { now, fixture })
    ids[session.key] = id
    ids.meetings.push(id)
    if (note) notes[session.key] = note
  }
  ids.meetings.sort().reverse()
  for (const name of variants) {
    const variant = fixture.variants[name]
    if (!variant) throw new Error(`unknown meetings variant ${name}`)
    const { id, note } = await writeSession(root, variant, { now, fixture })
    ids[name] = id
    if (note) notes[name] = note
    sentinels[name] = [...variant.sentinels]
  }
  return { sessionDir, vaultPath, configPath, now, ids, notes, sentinels }
}
