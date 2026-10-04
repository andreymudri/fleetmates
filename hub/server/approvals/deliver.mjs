// Answer delivery (docs/deck/07-approvals.md 5, docs/deck/interaction/state-machines.md 2.5 to 2.7,
// docs/deck/05-api.md 2.4): the server-side checks of an answer, the option keys typed into the PTY
// through deckd's guarded write (D-84), the proof that the answer landed, `did_not_land`, Safe
// batches, the follow-up after a deny and the approvals audit of each outcome. Answers reach a PTY
// only through this module. Nothing here logs input bytes, reply text, prompt text or tool input.
import { apiError } from '../http/router.mjs'
import { requestView } from '../machines/projector.mjs'
import { classifyHook } from '../machines/request.mjs'
import { workingRoot } from '../machines/session.mjs'
import { parseScreen } from '../screen/index.mjs'
import * as auditLog from './audit.mjs'
import { FALLBACK_CONFIRM_LABEL, applyScreen } from './request-updates.mjs'
import { recordAllow, ruleThreshold } from './rules.mjs'
import { allowAlwaysFor } from './screen-match.mjs'

/** Answer choices of `AnswerBody` (05-api 2.4). */
export const CHOICES = Object.freeze(['allow', 'allow_always', 'deny', 'option', 'reply'])
/** Paths an answer may come from. */
export const VIAS = Object.freeze(['browser', 'popup', 'batch'])
/** deckd's typing guard: no terminal or browser input in the last second (D-84). */
export const QUIET_MS = 1000
/** How often a `screen_changed` refusal refetches the screen and matches again before `not_on_screen`. */
export const SCREEN_RETRIES = 2
/** The AskUserQuestion option that opens the free-text field (2.1.285 `question-options` frame). */
const FREE_TEXT_LABEL = 'Type something.'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const MAX_TEXT = 64 * 1024
const TIER_RANK = { safe: 0, caution: 1, destructive: 2 }
/** @param {string | null | undefined} tier */
const rank = (tier) => TIER_RANK[/** @type {keyof typeof TIER_RANK} */ (tier)] ?? -1

/**
 * Text made safe to paste (07-approvals 5.3): the bracketed-paste end sequence `ESC [ 201 ~` and every
 * C0 and C1 control character (and DEL) but tab and newline are removed, so a reply cannot leave the
 * paste and type keys.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizePaste (text) {
  let out = String(text ?? '')
  // Removing one marker can join the halves of another, so repeat until none is left.
  while (out.includes(PASTE_END)) out = out.replaceAll(PASTE_END, '')
  return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** @param {string} text */
const paste = (text) => `${PASTE_START}${sanitizePaste(text)}${PASTE_END}\r`

/**
 * One comparable form of a parsed prompt, so a later screen proves the answer when its prompt differs.
 * @param {import('../screen/prompt.mjs').Prompt | null | undefined} prompt
 */
function promptKey (prompt) {
  if (!prompt) return null
  return JSON.stringify([prompt.kind, prompt.title, prompt.body, prompt.question, prompt.options.map((o) => [o.key, o.label])])
}

/**
 * @param {number} status
 * @param {string} code
 * @param {object} [details]
 */
const refuse = (status, code, details) => apiError(status, code, details)

/** Option 2 of a Bash prompt that would save a Claude Code allow rule (D-77, D-95). */
const ALLOW_ALWAYS_LABEL = /^Yes, and don't ask again\b/

/**
 * Whether an AskUserQuestion request needs a key sequence the deck cannot type yet: more than one
 * question, or a multi-select question (07-approvals 5.3, APR-O6: "Answer in the terminal").
 * @param {any} row
 */
function unreadableQuestion (row) {
  let input = {}
  try { input = JSON.parse(row.detail) ?? {} } catch {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  return questions.length > 1 || questions.some((/** @type {any} */ q) => q?.multiSelect === true)
}

/**
 * The bytes for one answer on the parsed prompt, the label of the option they pick and the choice
 * they amount to (state-machines 2.6 keys, F17). On a permission request an `option` resolves to
 * `allow` (option 1 "Yes"), `deny` (the "No" option) or `allow_always` (a "Yes, and don't ask again"
 * option); any other option is `tier_forbids`. Throws `options_unreadable` when the screen has no
 * option that fits or the question needs a key sequence (several questions, multi-select), and
 * `tier_forbids` for option 2 when the prompt does not offer it under D-77 and D-95.
 * @param {any} row the `requests` row
 * @param {{ choice: string, optionKey?: string, text?: string }} body
 * @param {import('../screen/prompt.mjs').Prompt | null} prompt
 * @returns {{ data: string, label: string | null, choice: string }}
 */
export function answerKeys (row, body, prompt) {
  if (row.source === 'stop_question') {
    if (body.choice !== 'reply') throw refuse(409, 'options_unreadable')
    return { data: paste(body.text ?? ''), label: null, choice: 'reply' }
  }
  if (row.kind === 'question' && row.tool_name === 'AskUserQuestion' && unreadableQuestion(row)) throw refuse(409, 'options_unreadable')
  const options = (prompt?.options ?? []).filter((o) => typeof o?.key === 'string' && /^\d$/.test(o.key))
  let choice = body.choice
  let option
  if (row.kind === 'permission' && choice === 'option') {
    option = options.find((o) => o.key === String(body.optionKey))
    if (!option) throw refuse(409, 'options_unreadable')
    if (option.key === '1' && option.label === 'Yes') choice = 'allow'
    else if (/^No\b/.test(option.label)) choice = 'deny'
    else if (ALLOW_ALWAYS_LABEL.test(option.label)) choice = 'allow_always'
    else throw refuse(403, 'tier_forbids')
  }
  if (choice === 'allow') option = options.find((o) => o.key === '1' && o.label === 'Yes')
  else if (choice === 'allow_always') {
    if (!allowAlwaysFor(row, prompt)) throw refuse(403, 'tier_forbids')
    option = options.find((o) => o.key === '2')
  } else if (choice === 'deny') option = options.find((o) => /^No\b/.test(o.label))
  else if (choice === 'option') option = options.find((o) => o.key === String(body.optionKey))
  else if (choice === 'reply' && row.kind === 'question' && row.tool_name === 'AskUserQuestion') {
    option = options.find((o) => o.label === FREE_TEXT_LABEL)
    if (option) return { data: option.key + paste(body.text ?? ''), label: option.label, choice }
  }
  if (!option) throw refuse(409, 'options_unreadable')
  return { data: /** @type {string} */ (option.key), label: option.label, choice }
}

/**
 * @typedef {{ run: Function, get: Function, all: Function, appendEvent: Function, tx: Function }} Store
 * @typedef {{ connected: boolean, features: string[], request: (op: string, fields?: object) => Promise<any>,
 *   writeGuarded: (ptyId: string, data: string, guard: { rev: number, quietMs: number }) => Promise<any>,
 *   onParsed: (fn: (event: { ptyId: string, parsed: import('../screen/index.mjs').ParsedScreen }) => void) => () => void }} Link
 * @typedef {'answered' | 'did_not_land' | 'closed'} Outcome
 */

/**
 * The deliverer. `classify(row, session)` re-classifies a permission request at answer time (default:
 * the M3 classifier on the stored tool input; the stored tier only rises). `rules` supplies
 * `recordAllow` and `ruleThreshold`, `audit` supplies `record`. `lateMs` bounds how long a request that
 * did not land is still watched for a late hook proof.
 * @param {{ store: Store, link: Link, publish?: (event: object) => void, now?: () => number,
 *   classify?: (row: any, session: any) => { tier: string, reasons?: object[], ruleCandidate?: string | null },
 *   rules?: { recordAllow: Function, ruleThreshold: Function }, audit?: { record: Function },
 *   verifyMs?: number, followupMs?: number, lateMs?: number, pollMs?: number }} options
 */
export function createDeliverer ({ store, link, publish = () => {}, now = Date.now, classify = defaultClassify,
  rules = { recordAllow, ruleThreshold }, audit = auditLog, verifyMs = 3000, followupMs = 30000, lateMs = 600000, pollMs = 50 }) {
  /** Requests between their checks and the end of their write. */
  const busy = new Set()
  /** request id -> stop function of a running verification or late watch */
  const watches = new Map()
  /** request id -> when a deck deny was verified (the follow-up window) */
  const denied = new Map()

  const getRow = (/** @type {string} */ id) => store.get('SELECT * FROM requests WHERE id = ?', id)
  const getSession = (/** @type {string} */ id) => store.get('SELECT * FROM sessions WHERE id = ?', id)

  /**
   * Run `fn` and publish the events it appended, in order.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function commit (fn) {
    const before = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
    const result = fn()
    for (const row of store.all('SELECT seq, at, type, entity_id, data FROM events WHERE seq > ? ORDER BY seq', before)) {
      try { publish({ seq: Number(row.seq), at: row.at, type: row.type, entityId: row.entity_id, data: JSON.parse(row.data) }) } catch {}
    }
    return result
  }

  /**
   * Write columns of one request and append `type` with its view, in one transaction.
   * @param {string} id
   * @param {Record<string, unknown>} fields
   * @param {string} [type]
   */
  function update (id, fields, type = 'request.updated') {
    const names = Object.keys(fields)
    commit(() => store.tx(() => {
      store.run(`UPDATE requests SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`, ...names.map((n) => fields[n]), id)
      store.appendEvent({ at: now(), type, entityId: id, data: requestView(getRow(id)) })
    }))
    return getRow(id)
  }

  /**
   * One audit row; a failing audit write never changes the answer's outcome.
   * @param {string} kind
   * @param {any} row
   * @param {object} [extra]
   */
  function note (kind, row, extra = {}) {
    try {
      const session = row ? getSession(row.session_id) : null
      audit.record(store, { kind, at: now(), requestId: row?.id ?? null, sessionId: row?.session_id ?? null, repoId: session?.repo_id ?? null,
        tier: row?.tier ?? null, reasons: row?.reasons ?? [], summary: row?.summary ?? null, ...extra })
    } catch {
      try { process.stderr.write('deck: audit.error\n') } catch {}
    }
  }

  /**
   * Re-classify a permission request; a higher tier is written with its reasons and rule candidate
   * (07-approvals 3.2 step 6, 5.4) and published. Returns the current row.
   * @param {any} row
   */
  function reclassify (row) {
    if (row.kind !== 'permission' || !row.tool_name) return row
    let next
    try { next = classify(row, getSession(row.session_id)) } catch { next = { tier: 'caution', reasons: [{ entryId: 'classify.error' }] } }
    if (!next || rank(next.tier) <= rank(row.tier)) return row
    return update(row.id, { tier: next.tier, reasons: JSON.stringify(next.reasons ?? []), rule_pattern: next.tier === 'safe' ? next.ruleCandidate ?? null : null })
  }

  /**
   * The tier rules of 05-api 2.4 (2 and 3) and state-machines 2.5: option 2 only where the deck offers
   * it, popup and batch only for a Safe permission, and a Destructive answer other than deny only with
   * `confirm: true`. An `option` on a permission request is checked again as the choice it resolves to
   * once the screen is read (`answerKeys`), so here it skips the confirm rule.
   * @param {any} row
   * @param {any} body
   * @param {string} via
   */
  function tierChecks (row, body, via) {
    if (body.choice === 'allow_always' && !requestView(row).allowAlways) throw refuse(403, 'tier_forbids')
    if ((via === 'popup' || via === 'batch') && !(row.kind === 'permission' && row.tier === 'safe')) throw refuse(403, 'tier_forbids')
    if (row.kind === 'permission' && row.tier === 'destructive' && !['deny', 'option'].includes(body.choice) && body.confirm !== true) throw refuse(422, 'confirm_required')
  }

  /** @param {any} body @param {any} row */
  function validate (body, row) {
    const fields = []
    if (!body || typeof body !== 'object' || !CHOICES.includes(body.choice)) fields.push('choice')
    else {
      if (body.choice === 'option' && (typeof body.optionKey !== 'string' || !/^\d$/.test(body.optionKey))) fields.push('optionKey')
      if (body.choice === 'reply' && (typeof body.text !== 'string' || !sanitizePaste(body.text).trim() || body.text.length > MAX_TEXT)) fields.push('text')
      const allowed = row.kind === 'permission' ? ['allow', 'allow_always', 'deny', 'option'] : ['option', 'reply']
      if (!allowed.includes(body.choice)) fields.push('choice')
      if (body.confirm !== undefined && typeof body.confirm !== 'boolean') fields.push('confirm')
    }
    if (fields.length) throw refuse(422, 'validation_failed', { fields })
  }

  function deckdReady () {
    if (!link.connected) throw refuse(503, 'deckd_unavailable')
    if (!link.features.includes('guardedWrite')) throw refuse(503, 'deckd_outdated')
  }

  /**
   * Fetch and parse the session's screen from deckd.
   * @param {string} ptyId
   */
  async function readScreen (ptyId) {
    const screen = await link.request('screen', { ptyId, scrollback: 0 })
    const lines = Array.isArray(screen?.lines) ? screen.lines.filter((/** @type {unknown} */ l) => typeof l === 'string') : []
    return { rev: screen?.rev, parsed: parseScreen(lines, screen?.cursor ?? { x: 0, y: -1 }) }
  }

  /**
   * Every check, then the guarded write. Resolves once the keys are written, with the verification
   * promise; throws the refusal otherwise.
   * @param {string} requestId
   * @param {any} body
   * @param {string} via
   */
  async function attempt (requestId, body, via) {
    if (!VIAS.includes(via)) throw new TypeError(`unknown via ${via}`)
    let row = getRow(requestId)
    if (!row) throw refuse(404, 'not_found', { entity: 'request' })
    validate(body, row)
    if (row.state !== 'open') throw refuse(409, 'request_closed')
    const session = getSession(row.session_id)
    if (!session || session.origin === 'observed' || !session.pty_id) throw refuse(409, 'read_only_session')
    tierChecks(row, body, via)
    row = reclassify(row)
    tierChecks(row, body, via)
    if (busy.has(row.id) || ['sending', 'verifying'].includes(row.delivery)) throw refuse(409, 'answer_in_flight')
    deckdReady()
    busy.add(row.id)
    const previous = { delivery: row.delivery, answer: row.answer }
    let sending = false
    try {
      for (let tries = 0; ; tries++) {
        const { rev, parsed } = await readScreen(session.pty_id)
        row = getRow(row.id)
        if (row.state !== 'open') throw refuse(409, 'request_closed')
        if (row.source === 'stop_question') {
          if (!parsed.idle) throw refuse(409, 'not_on_screen')
        } else {
          commit(() => applyScreen(store, row.session_id, parsed.prompt, now()))
          row = getRow(row.id)
          if (row.screen_match !== 'on_screen') throw refuse(409, 'not_on_screen')
        }
        const keys = answerKeys(row, body, parsed.prompt)
        if (row.kind === 'permission' && body.choice === 'option') tierChecks(row, { ...body, choice: keys.choice }, via)
        if (!sending) {
          // `until` bounds how long a closing hook still counts as the deck's answer (request.mjs closingAnswer).
          update(row.id, { delivery: 'sending', answer: JSON.stringify({ via, choice: keys.choice, until: now() + verifyMs + lateMs }) })
          sending = true
        }
        try {
          stopWatch(row.id)
          await link.writeGuarded(session.pty_id, keys.data, { rev, quietMs: QUIET_MS })
        } catch (error) {
          if (/** @type {any} */ (error)?.code === 'screen_changed') {
            if (tries < SCREEN_RETRIES) continue
            throw refuse(409, 'not_on_screen')
          }
          throw error
        }
        row = update(row.id, { delivery: 'verifying' })
        const outcome = verify(row.id, session.pty_id, row.source === 'stop_question' ? undefined : promptKey(parsed.prompt), { via, choice: keys.choice, label: keys.label })
        return { request: requestView(row), outcome }
      }
    } catch (error) {
      if (sending) {
        const current = getRow(row.id)
        if (current?.state === 'open') update(row.id, { delivery: previous.delivery === 'did_not_land' ? 'did_not_land' : 'idle', answer: previous.answer })
      }
      throw error
    } finally {
      busy.delete(requestId)
    }
  }

  /** @param {string} id */
  function stopWatch (id) {
    const stop = watches.get(id)
    if (stop) stop()
  }

  /**
   * Record an answer the deck proved: the audit row, the Safe allow count and the follow-up window.
   * When the closing hook contradicted the deck's choice, request.mjs recorded the hook's verdict as a
   * terminal answer (and counted a terminal Safe allow itself): only the audit row is written then, and
   * the result is false.
   * @param {any} row the closed row
   * @param {{ via: string, choice: string, label: string | null }} sent
   * @returns {boolean} whether the deck's answer is the one recorded
   */
  function proved (row, sent) {
    let answer = null
    try { answer = JSON.parse(row.answer ?? 'null') } catch {}
    if (answer?.via === 'terminal') {
      note('answered', row, { via: 'terminal', choice: typeof answer.choice === 'string' ? answer.choice : null })
      return false
    }
    const choice = typeof answer?.choice === 'string' ? answer.choice : sent.choice
    const allow = choice === 'allow' || choice === 'allow_always'
    note('answered', row, { via: sent.via, choice, optionLabel: sent.label,
      confirmLabel: allow && row.tier === 'destructive' ? row.confirm_label ?? FALLBACK_CONFIRM_LABEL : null })
    if (allow && row.kind === 'permission' && row.tier === 'safe') {
      try {
        commit(() => rules.recordAllow(store, row, { via: sent.via, at: row.answered_at ?? now(), threshold: rules.ruleThreshold(store), choice }))
      } catch {
        try { process.stderr.write('deck: rule.count-error\n') } catch {}
      }
    }
    if (choice === 'deny') denied.set(row.id, now())
    return true
  }

  /**
   * Wait for proof (state-machines 2.6): a later screen whose prompt differs from `sentPrompt`, or the
   * request closing by its matching hook. No proof within `verifyMs` is `did_not_land`; a hook that
   * closes the request later (within `lateMs`) still answers it. A request closed by a hook that
   * contradicts the deck's choice, or closed without an answer, settles `closed`. A screen change after `did_not_land`
   * is not taken as proof, because by then the owner may have answered in the terminal.
   * @param {string} id
   * @param {string} ptyId
   * @param {string | null | undefined} sentPrompt the prompt the keys answered; undefined: hook proof only
   * @param {{ via: string, choice: string, label: string | null }} sent
   * @returns {Promise<Outcome>}
   */
  function verify (id, ptyId, sentPrompt, sent) {
    return new Promise((resolve) => {
      let late = false
      let settled = false
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      /** @type {NodeJS.Timeout | undefined} */
      let lateTimer
      /** @type {NodeJS.Timeout | undefined} */
      let latePoll
      const stop = () => {
        offParsed()
        clearInterval(poll)
        clearInterval(latePoll)
        clearTimeout(timer)
        clearTimeout(lateTimer)
        if (watches.get(id) === stop) watches.delete(id)
      }
      /** @param {Outcome} outcome */
      const settle = (outcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      const closedByHook = () => {
        const row = getRow(id)
        if (!row || row.state === 'open') return
        stop()
        settle(row.state === 'answered' && proved(row, sent) ? 'answered' : 'closed')
      }
      const offParsed = link.onParsed((event) => {
        if (late || event.ptyId !== ptyId || sentPrompt === undefined) return
        if (promptKey(event.parsed.prompt) === sentPrompt) return
        const row = getRow(id)
        if (!row || row.state !== 'open') return closedByHook()
        stop()
        const closed = update(id, { state: 'answered', answer: JSON.stringify({ via: sent.via, choice: sent.choice }), answered_at: now() }, 'request.closed')
        proved(closed, sent)
        settle('answered')
      })
      const poll = setInterval(closedByHook, pollMs)
      timer = setTimeout(() => {
        const row = getRow(id)
        if (!row || row.state !== 'open') return closedByHook()
        late = true
        update(id, { delivery: 'did_not_land' })
        note('did_not_land', getRow(id), { via: sent.via, choice: sent.choice, optionLabel: sent.label })
        settle('did_not_land')
        clearInterval(poll)
        latePoll = setInterval(closedByHook, Math.max(pollMs, 250))
        lateTimer = setTimeout(stop, lateMs)
      }, verifyMs)
      watches.set(id, stop)
    })
  }

  return {
    /**
     * Answer one request (05-api 2.4). Resolves once the keys are written, with the request view
     * (`delivery: 'verifying'`) and `outcome`, which settles `answered`, `did_not_land` or `closed`
     * (the request expired while being verified). Every refusal is audited and rejects with an
     * `apiError` code.
     * @param {string} requestId
     * @param {{ choice: string, optionKey?: string, text?: string, confirm?: boolean }} body
     * @param {{ via?: 'browser' | 'popup' | 'batch' }} [options]
     * @returns {Promise<{ request: object, outcome: Promise<Outcome> }>}
     */
    async answer (requestId, body, { via = 'browser' } = {}) {
      try {
        return await attempt(requestId, body, via)
      } catch (error) {
        note('refused', getRow(requestId), { via: VIAS.includes(via) ? via : null, code: /** @type {any} */ (error)?.code ?? 'internal' })
        throw error
      }
    },

    /**
     * Allow several Safe requests once (07-approvals 5.4). Refuses the whole batch with
     * `batch_not_safe` (`details.ids`) when any id is not a Safe permission request; otherwise answers
     * sequentially within a session and in parallel across sessions, each with its own checks and
     * proof. An id that re-classifies above Safe is skipped with `skipped_not_safe`. A request that is
     * not on screen yet (the session shows one prompt at a time) is retried until `verifyMs` passes.
     * @param {string[]} ids
     * @returns {Promise<{ id: string, ok: boolean, error?: string }[]>}
     */
    async batch (ids) {
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw refuse(422, 'validation_failed', { fields: ['ids'] })
      }
      const rows = ids.map((id) => getRow(id))
      const bad = ids.filter((id, i) => !rows[i] || rows[i].kind !== 'permission' || rows[i].tier !== 'safe')
      if (bad.length) {
        for (const id of ids) note('refused', getRow(id), { via: 'batch', code: 'batch_not_safe' })
        throw refuse(422, 'batch_not_safe', { ids: bad })
      }
      /** @type {Map<string, string[]>} */
      const groups = new Map()
      rows.forEach((row) => groups.set(row.session_id, [...groups.get(row.session_id) ?? [], row.id]))
      /** @type {Map<string, { id: string, ok: boolean, error?: string }>} */
      const results = new Map()
      const one = async (/** @type {string} */ id) => {
        const current = getRow(id)
        if (current?.state === 'open' && reclassify(current).tier !== 'safe') {
          note('refused', getRow(id), { via: 'batch', code: 'skipped_not_safe' })
          return { id, ok: false, error: 'skipped_not_safe' }
        }
        const deadline = now() + verifyMs
        for (;;) {
          try {
            const { outcome } = await attempt(id, { choice: 'allow' }, 'batch')
            const done = await outcome
            return done === 'answered' ? { id, ok: true } : { id, ok: false, error: done === 'did_not_land' ? 'did_not_land' : 'request_closed' }
          } catch (error) {
            const code = /** @type {any} */ (error)?.code ?? 'internal'
            if (code === 'not_on_screen' && now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 100))
              continue
            }
            note('refused', getRow(id), { via: 'batch', code })
            return { id, ok: false, error: code }
          }
        }
      }
      await Promise.all([...groups.values()].map(async (group) => {
        for (const id of group) results.set(id, await one(id))
      }))
      return ids.map((id) => /** @type {{ id: string, ok: boolean, error?: string }} */ (results.get(id)))
    },

    /**
     * "Tell Claude what to do instead" (state-machines 2.5): within `followupMs` of a deck deny that was
     * verified, and only while the idle input box shows, the sanitized text as a bracketed paste and
     * `\r`. Otherwise `followup_window_closed`. One follow-up per deny.
     * @param {string} requestId
     * @param {string} text
     * @returns {Promise<{ ok: true }>}
     */
    async followup (requestId, text) {
      const row = getRow(requestId)
      if (!row) throw refuse(404, 'not_found', { entity: 'request' })
      if (typeof text !== 'string' || !sanitizePaste(text).trim() || text.length > MAX_TEXT) throw refuse(422, 'validation_failed', { fields: ['text'] })
      const session = getSession(row.session_id)
      if (!session || session.origin === 'observed' || !session.pty_id) throw refuse(409, 'read_only_session')
      const at = denied.get(requestId)
      if (at === undefined || now() - at > followupMs) throw refuse(409, 'followup_window_closed')
      deckdReady()
      for (let tries = 0; ; tries++) {
        const { rev, parsed } = await readScreen(session.pty_id)
        if (!parsed.idle) throw refuse(409, 'followup_window_closed')
        try {
          await link.writeGuarded(session.pty_id, paste(text), { rev, quietMs: QUIET_MS })
          denied.delete(requestId)
          return { ok: true }
        } catch (error) {
          if (/** @type {any} */ (error)?.code === 'screen_changed' && tries < SCREEN_RETRIES) continue
          if (/** @type {any} */ (error)?.code === 'screen_changed') throw refuse(409, 'followup_window_closed')
          throw error
        }
      }
    },

    /** Stop every verification and late watch. */
    close () {
      for (const stop of [...watches.values()]) stop()
      watches.clear()
    }
  }
}

/**
 * The classifier at answer time: the stored tool input in the session's directory and repo.
 * @param {any} row
 * @param {any} session
 */
function defaultClassify (row, session) {
  let input = {}
  try { input = JSON.parse(row.detail) ?? {} } catch {}
  const cwd = session?.cwd ?? null
  return classifyHook({ tool_name: row.tool_name, tool_input: input, cwd }, { repoRoot: session?.repo_id ?? (cwd ? workingRoot(cwd) : undefined) })
}
