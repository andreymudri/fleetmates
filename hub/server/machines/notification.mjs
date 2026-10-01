import { BODY_MAX, TITLE_MAX, clipText, createNotifier } from '../adapters/notify.mjs'
import { oneLine } from './request.mjs'

/**
 * The summary length every shown request is promised (or its whole summary, when shorter). Requests are shown
 * in severity order only while all of them can keep that much; the rest move into "+N more".
 */
const SUMMARY_MIN = 24
const HINT = 'Answer in your terminal\n'
/** Popup line order: the drawer's tier words from most to least severe; other tiers, then untiered, come last. */
const SEVERITY = ['destructive', 'caution', 'safe']
const length = text => Array.from(text).length
const rank = request => request.tier ? (SEVERITY.includes(request.tier) ? SEVERITY.indexOf(request.tier) : SEVERITY.length) : SEVERITY.length + 1

/**
 * The deck's own words first, then the agent's text. Agent text that renders very wide (wide glyphs, U+3000)
 * wraps after the deck's words on its own line instead of before them; the hint and the most severe tier sit on
 * the first two body lines, ahead of any agent text.
 * @param {string} words the deck's phrase, such as "needs you" or a tier
 * @param {string} text agent text, already stripped
 * @returns {string}
 */
const lead = (words, text) => text ? `${words} · ${text}` : words
const leadLength = words => words ? length(words) + 3 : 0

/**
 * Title and body of a needs-you popup. Only the agent-written parts (the task and each summary) are cut, so
 * "needs you", every tier and the terminal hint always fit notify.mjs's final caps (08-security 4.9, T13).
 * Every line leads with the deck's words: the title is "needs you · <most severe tier> · <task>" (with
 * "(N requests)" after "needs you", and no tier when no request has one), the body opens with the terminal
 * hint, and each request line reads "<tier> · <summary>".
 * Lines go most severe first (stable within a tier), so the agent's arrival order cannot push a destructive
 * request out of the popup. Each summary is folded to one line, then the summaries share the room: the
 * shortest keep their whole text and the longest are cut to one common length. Requests left out are
 * counted on a last line that names the most severe tier among them, as "+N more · destructive".
 * @param {string} task
 * @param {{ summary: string, tier?: string | null }[]} requests
 * @param {boolean} observed whether to open with the terminal hint
 * @returns {{ title: string, body: string }}
 */
export function requestPopupText(task, requests, observed) {
  const head = observed ? HINT : ''
  const sorted = requests.map((request, index) => ({ request, index }))
    .sort((a, b) => rank(a.request) - rank(b.request) || a.index - b.index)
    .map(({ request }) => ({ text: clipText(oneLine(request.summary), Infinity), tier: request.tier || '' }))
  // The most severe tier sits in the title before any agent text, so a task that wraps or reads as a tier
  // cannot hide it (T13 review, title half).
  const phrase = `needs you${requests.length > 1 ? ` (${requests.length} requests)` : ''}`
  const words = sorted[0]?.tier ? lead(phrase, sorted[0].tier) : phrase
  const title = lead(words, clipText(task, TITLE_MAX - length(words) - 3))
  const more = shown => shown < sorted.length ? `+${sorted.length - shown} more${sorted[shown].tier ? ` · ${sorted[shown].tier}` : ''}` : ''
  // Room the first `shown` summaries share: everything but the deck's own words and the line breaks.
  const room = shown => BODY_MAX - length(head) - sorted.slice(0, shown).reduce((sum, row) => sum + leadLength(row.tier), 0)
    - (shown - 1) - (more(shown) ? 1 + length(more(shown)) : 0)
  let shown = sorted.length
  while (shown > 1 && sorted.slice(0, shown).reduce((sum, row) => sum + Math.min(length(row.text), SUMMARY_MIN), 0) > room(shown)) shown--
  const budget = room(shown)
  const lengths = sorted.slice(0, shown).map(row => length(row.text))
  // The largest common cut whose total fits the budget.
  let cut = Math.max(0, ...lengths)
  while (cut > 0 && lengths.reduce((sum, size) => sum + Math.min(size, cut), 0) > budget) cut--
  const lines = sorted.slice(0, shown).map(row => row.tier ? lead(row.tier, clipText(row.text, cut)) : clipText(row.text, cut))
  if (more(shown)) lines.push(more(shown))
  return { title, body: head + lines.join('\n') }
}

/**
 * Title of a done or crash popup, "made port · <task>" or "crashed · <task>", with the task cut so the deck's
 * own words always fit and always come first.
 * @param {string} task
 * @param {'done'|'crash'} kind
 * @returns {string}
 */
export function terminalPopupTitle(task, kind) {
  const words = kind === 'done' ? 'made port' : 'crashed'
  return lead(words, clipText(task, TITLE_MAX - length(words) - 3))
}

const graceMs = 3000
const prefix = 'notify:popup:'
const defaults = Object.freeze({ bell: true, renotifyAfter: 10, notifyDone: true, quietInMeetings: true, notifyCrash: true })

/** Create a serialized notification tick over committed session and request rows. */
export function createNotificationMachine({ store, notifier = createNotifier(), now = Date.now, recording = () => false, publish = () => {} }) {
  let pending = Promise.resolve()
  const read = key => {
    const row = store.get('SELECT value FROM meta WHERE key=?', key)
    return row ? JSON.parse(row.value) : null
  }
  const write = (key, value) => store.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value))
  const remove = key => store.run('DELETE FROM meta WHERE key=?', key)
  const delivered = key => !!store.get('SELECT id FROM notification_history WHERE dedupe_key=?', key)
  const requestKey = (kind, row) => `${kind}:${row.id}`
  function getPreferences() {
    const prefs = { ...defaults }
    for (const row of store.all('SELECT key,value FROM prefs')) if (Object.hasOwn(defaults, row.key)) prefs[row.key] = JSON.parse(row.value)
    return prefs
  }
  function setPreferences(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('invalid notification preference')
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(defaults, key) || (key === 'renotifyAfter' ? ![5, 10, 20, null].includes(value) : typeof value !== 'boolean')) throw new TypeError('invalid notification preference')
    }
    store.tx(() => {
      for (const [key, value] of Object.entries(patch)) store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, JSON.stringify(value), now())
    })
    const prefs = getPreferences()
    publish({ type: 'prefs.changed', data: { prefs } })
    return prefs
  }
  function syncEpisodes(open) {
    store.tx(() => {
      const seq = read('notify:episodeSeq') ?? 0
      const events = store.all('SELECT seq,type,data FROM events WHERE seq>? ORDER BY seq', seq)
      for (const event of events) {
        if (!['request.opened', 'request.closed', 'request.updated'].includes(event.type)) continue
        const request = JSON.parse(event.data)
        const key = `notify:episode:${request.sessionId}`
        let episode = read(key) ?? { ids: [], spent: false }
        if (request.state === 'open') {
          if (!episode.ids.includes(request.id)) episode.ids.push(request.id)
        } else episode.ids = episode.ids.filter(id => id !== request.id)
        if (episode.ids.length) write(key, episode)
        else remove(key)
      }
      if (events.length) write('notify:episodeSeq', Number(events.at(-1).seq))
      for (const sessionId of new Set(open.map(row => row.session_id))) {
        const key = `notify:episode:${sessionId}`
        const requests = open.filter(row => row.session_id === sessionId)
        const episode = read(key) ?? { spent: requests.some(row => delivered(requestKey('request', row))) }
        write(key, { ...episode, ids: requests.map(row => row.id) })
      }
      for (const row of store.all('SELECT key,value FROM meta WHERE key LIKE ?', 'notify:episode:%')) {
        if (!JSON.parse(row.value).ids.some(id => open.some(request => request.id === id))) remove(row.key)
      }
    })
  }

  async function popup(kind, session, requests, at, replacing = null) {
    const keys = requests.map(row => requestKey(kind, row))
    const claim = store.tx(() => {
      if (keys.some(delivered)) return false
      for (let i = 0; i < keys.length; i++) store.run('INSERT INTO notification_history(dedupe_key,kind,session_id,request_id,delivered_at) VALUES(?,?,?,?,?)', keys[i], kind, session.id, requests[i].id, at)
      return true
    })
    if (!claim) return false
    const { title, body } = requestPopupText(session.task, requests, session.origin === 'observed')
    let result
    try { result = await notifier.popup({ title, body, replaceId: replacing?.id ?? null }) } catch { result = { ok: false } }
    if (!result.ok) {
      store.tx(() => { for (const key of keys) store.run('DELETE FROM notification_history WHERE dedupe_key=?', key) })
      publish({ type: 'notify.failed', data: { code: 'notify_failed' } })
      return false
    }
    store.tx(() => {
      if (replacing) remove(prefix + replacing.key)
      write(prefix + keys[0], { key: keys[0], id: result.id, sessionId: session.id, requestIds: requests.map(row => row.id) })
      for (const row of requests) store.run(`UPDATE requests SET ${kind === 'request' ? 'notified_at' : 'renotified_at'}=? WHERE id=?`, at, row.id)
    })
    publish({ type: 'notification.sent', data: { kind, sessionId: session.id, requestIds: requests.map(row => row.id) } })
    return true
  }

  async function tick(at) {
    const prefs = getPreferences()
    const open = store.all("SELECT * FROM requests WHERE state='open' ORDER BY created_at,id")
    syncEpisodes(open)
    const ids = new Set(open.map(row => row.id))
    for (const row of store.all('SELECT key,value FROM meta WHERE key LIKE ?', prefix + '%')) {
      const value = JSON.parse(row.value)
      const session = value.kind ? store.get('SELECT state,state_since FROM sessions WHERE id=?', value.sessionId) : null
      const obsolete = value.kind ? session?.state !== (value.kind === 'crash' ? 'crashed' : 'done') || session.state_since !== value.stateSince : value.requestIds.every(id => !ids.has(id))
      if (obsolete) {
        await notifier.dismiss(value.id)
        remove(row.key)
      }
    }
    for (const session of store.all('SELECT * FROM sessions')) {
      const requests = open.filter(row => row.session_id === session.id)
      const episodeKey = `notify:episode:${session.id}`
      const kind = session.state === 'crashed' && prefs.notifyCrash ? 'crash' : session.state === 'done' && prefs.notifyDone && JSON.parse(session.changed_files).length && at - session.state_since >= 5000 ? 'done' : null
      if (kind) await terminalPopup(kind, session, at)
      if (!requests.length) continue
      const waiting = requests.filter(row => !delivered(requestKey('request', row)))
      while (waiting.length && at - waiting[0].created_at >= graceMs) {
        const cutoff = waiting[0].created_at + graceMs
        const due = waiting.filter(row => row.created_at <= cutoff)
        waiting.splice(0, due.length)
        if (await popup('request', session, due, at)) {
          const episode = read(episodeKey)
          if (!episode.spent) {
            write(episodeKey, { ...episode, spent: true })
            if (prefs.bell && !(prefs.quietInMeetings && recording())) await notifier.bell()
          }
        }
      }
      const reminders = requests.filter(row => prefs.renotifyAfter !== null && row.notified_at !== null && at - row.notified_at >= prefs.renotifyAfter * 60000 && !delivered(requestKey('renotify', row)))
      const groups = store.all('SELECT value FROM meta WHERE key LIKE ?', prefix + '%').map(row => JSON.parse(row.value)).filter(row => !row.kind && row.sessionId === session.id)
      for (const group of groups) {
        const due = reminders.filter(row => group.requestIds.includes(row.id))
        if (due.length) await popup('renotify', session, due, at, group)
      }
    }
  }
  async function terminalPopup(kind, session, at) {
    const key = `${kind}:${session.id}:${session.state_since}`
    if (delivered(key)) return
    const claimed = store.run('INSERT OR IGNORE INTO notification_history(dedupe_key,kind,session_id,delivered_at) VALUES(?,?,?,?)', key, kind, session.id, at).changes
    if (!claimed) return
    const title = terminalPopupTitle(session.task, kind)
    const body = kind === 'done' ? `${JSON.parse(session.changed_files).length} files changed · Review changes` : 'The session stopped unexpectedly · Open the session'
    let result
    try { result = await notifier.popup({ title, body, urgency: kind === 'done' ? 'low' : 'normal' }) } catch { result = { ok: false } }
    if (!result.ok) {
      store.run('DELETE FROM notification_history WHERE dedupe_key=?', key)
      publish({ type: 'notify.failed', data: { code: 'notify_failed' } })
      return
    }
    write(prefix + key, { key, id: result.id, kind, sessionId: session.id, stateSince: session.state_since })
    publish({ type: 'notification.sent', data: { kind, sessionId: session.id } })
  }
  return {
    getPreferences,
    setPreferences,
    testPing() { return notifier.testPing() },
    tick(at = now()) {
      const result = pending.then(() => tick(at))
      pending = result.catch(() => {})
      return result
    }
  }
}
