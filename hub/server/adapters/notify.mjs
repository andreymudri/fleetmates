import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Run one command with an argv array (never a shell) and resolve with its exit code and at most 4096 bytes of
 * stdout. With `onLine`, each complete stdout line is also handed over as it arrives and the child's handles
 * stop holding the event loop open; with `signal`, an abort kills the child.
 */
function execute(command, args, { env, input, timeoutMs, onLine, signal }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    const decoder = new StringDecoder('utf8')
    let partial = ''
    let size = 0
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish({ ok: false, exitCode: null })
    }
    const timer = setTimeout(abort, timeoutMs)
    child.on('error', () => finish({ ok: false, exitCode: null }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 4096) return abort()
      chunks.push(chunk)
      if (!onLine || settled) return
      const lines = (partial + decoder.write(chunk)).split('\n')
      partial = lines.pop()
      for (const line of lines) onLine(line.replace(/\r$/, ''))
    })
    child.on('close', code => finish({ ok: code === 0, exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') }))
    child.stdin.end(input)
    if (onLine) {
      timer.unref()
      child.unref()
      child.stdout.unref?.()
      child.stdin.unref?.()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function bellAudio() {
  const rate = 48000
  const samples = rate / 3
  const bytes = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const decay = Math.exp(-i / (rate * 0.09))
    const wave = Math.sin(2 * Math.PI * 880 * i / rate) + 0.4 * Math.sin(2 * Math.PI * 1320 * i / rate)
    bytes.writeInt16LE(Math.round(6000 * wave * decay), i * 2)
  }
  return bytes
}

/** How long a popup with actions keeps its `notify-send --wait` running: one renotify window plus a minute. */
export const ACTION_WAIT_MS = 11 * 60_000
/** The only action keys a popup can offer, with their fixed labels (D-71, F11). */
const ACTION_LABELS = Object.freeze({ allow: 'Allow once', open: 'Open' })

/** Title and body caps in characters, counted after stripping (08-security.md section 4.9). */
export const TITLE_MAX = 80
export const BODY_MAX = 200
// C0 controls and DEL (VT and FF included), C1 controls (NEL included), LINE and PARAGRAPH SEPARATOR, and the
// bidi controls (ALM, LRM, RLM, LRE..RLO, LRI..PDI). The body keeps line feeds and no other line break.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/gu
const CONTROLS_BUT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/gu
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Make agent-supplied text safe for a notification daemon that renders markup (08-security.md 4.9,
 * threat T13): strip C0 and C1 controls and bidi characters (the body keeps line feeds between its lines),
 * cap the stripped text at `max` characters with an ellipsis, then escape `& < > " '`. Escaping comes after
 * the cap, so an entity is never cut in half; the escaped argument can be longer than `max`.
 * @param {unknown} text
 * @param {number} max
 * @param {{ keepLineFeeds?: boolean }} [options]
 * @returns {string}
 */
export function notificationText(text, max, { keepLineFeeds = false } = {}) {
  return clipText(text, max, { keepLineFeeds }).replace(/[&<>"']/g, char => ENTITIES[char])
}

/**
 * The strip and cap steps of {@link notificationText}, without escaping: controls and bidi characters removed
 * (line feeds kept only with `keepLineFeeds`), then at most `max` characters ending in `…`. Callers compose
 * popup text from clipped parts so that the fixed parts they add always fit the final caps.
 * @param {unknown} text
 * @param {number} max
 * @param {{ keepLineFeeds?: boolean }} [options]
 * @returns {string}
 */
export function clipText(text, max, { keepLineFeeds = false } = {}) {
  const chars = Array.from(String(text ?? '').replace(keepLineFeeds ? CONTROLS_BUT_LF : CONTROLS, ''))
  if (max <= 0) return ''
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

/**
 * Create popup, dismissal, test-ping and bell commands with injectable executables and runner.
 * `popup({ title, body, urgency, replaceId, actions, onAction })` with `actions` (keys from `allow` and `open`
 * only, any other key dropped) starts `notify-send --print-id --wait` with one `--action` per key, resolves with
 * the id from the first integer stdout line, then calls `onAction(key)` once for the first later line equal to
 * an offered key; other lines are ignored. The waiting process is killed after `actionWaitMs`, on
 * `dismiss(id)`, when another popup replaces it, and on `close()`. Without `actions` a popup runs as before.
 * That is the linux notifier; `platform` picks it by default. darwin gets the osascript and afplay notifier below,
 * and win32 one whose popups and bells resolve `{ ok: false, reason: 'unsupported on win32' }` without running anything.
 */
export function createNotifier({ platform = process.platform, ...options } = {}) {
  if (platform === 'win32') return unsupportedNotifier(platform)
  if (platform === 'darwin') return createDarwinNotifier(options)
  return createLinuxNotifier(options)
}

/** A notifier for a platform without desktop popups: popups and bells resolve unsupported and nothing runs. */
function unsupportedNotifier(platform) {
  const unsupported = async () => ({ ok: false, reason: `unsupported on ${platform}` })
  return { popup: unsupported, bell: unsupported, testPing: unsupported, async dismiss() { return { ok: true } }, close() {} }
}

/** An AppleScript string literal: backslash, double quote, CR and LF escaped, the whole in double quotes. */
function appleScriptString(text) {
  return `"${String(text).replace(/[\\"]/g, char => `\\${char}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

/**
 * macOS: a popup is `osascript` with three `-e` script lines, the title and the body each set from an AppleScript
 * string literal, run as argv with no shell. Notification Center offers no action buttons to a script, so `actions`
 * are dropped, a popup has no id and `dismiss` does nothing. The bell is `afplay` on the Glass system sound.
 */
function createDarwinNotifier({ notifyCommand = 'osascript', soundCommand = 'afplay', env = process.env, run = execute, timeoutMs = 2000 } = {}) {
  async function call(command, args, code) {
    try {
      const result = await run(command, args, { env, timeoutMs })
      return result.ok ? result : { ok: false, error: { code, exitCode: result.exitCode ?? null } }
    } catch { return { ok: false, error: { code, exitCode: null } } }
  }
  async function popup({ title, body }) {
    const result = await call(notifyCommand, [
      '-e', `set deckTitle to ${appleScriptString(clipText(title, TITLE_MAX))}`,
      '-e', `set deckBody to ${appleScriptString(clipText(body, BODY_MAX, { keepLineFeeds: true }))}`,
      '-e', 'display notification deckBody with title deckTitle'
    ], 'notify_failed')
    return result.ok ? { ok: true, id: null } : result
  }
  return {
    popup,
    async bell() {
      const result = await call(soundCommand, ['/System/Library/Sounds/Glass.aiff'], 'bell_failed')
      return result.ok ? { ok: true } : result
    },
    async dismiss() { return { ok: true } },
    testPing() { return popup({ title: 'fleetmates deck', body: 'Test ping · Desktop notifications are working.' }) },
    close() {}
  }
}

function createLinuxNotifier({ notifyCommand = 'notify-send', soundCommand = 'pw-play', dismissCommand = 'makoctl', env = process.env, run = execute, timeoutMs = 2000, actionWaitMs = ACTION_WAIT_MS } = {}) {
  /** Popup id to the controller that kills its waiting process. */
  const waits = new Map()
  async function call(command, args, code, input) {
    try {
      const result = await run(command, args, { env, input, timeoutMs })
      return result.ok ? result : { ok: false, error: { code, exitCode: result.exitCode ?? null } }
    } catch { return { ok: false, error: { code, exitCode: null } } }
  }
  const stopWait = (id, controller = waits.get(id)) => {
    if (waits.get(id) === controller) waits.delete(id)
    controller?.abort()
  }
  function wait(args, keys, onAction) {
    return new Promise(resolve => {
      const controller = new AbortController()
      let id = null
      let acted = false
      const settle = result => {
        clearTimeout(idTimer)
        resolve(result)
      }
      const idTimer = setTimeout(() => {
        controller.abort()
        settle({ ok: false, error: { code: 'notify_failed', exitCode: null } })
      }, timeoutMs)
      const onLine = line => {
        if (controller.signal.aborted) return
        if (id === null) {
          if (!/^[0-9]+$/.test(line)) return
          id = Number(line)
          if (Number.isSafeInteger(id) && id > 0) waits.set(id, controller)
          return settle({ ok: true, id: Number.isSafeInteger(id) && id > 0 ? id : null })
        }
        if (acted || !keys.includes(line)) return
        acted = true
        try { onAction?.(line) } catch {}
      }
      // The wait window is the notifier's own, so it holds whatever the runner does with its timeout.
      const windowTimer = setTimeout(() => controller.abort(), actionWaitMs)
      windowTimer.unref?.()
      const ended = result => {
        clearTimeout(windowTimer)
        if (id !== null) {
          if (waits.get(id) === controller) waits.delete(id)
          return
        }
        // A runner that does not stream (a test double) still reports the id in its stdout.
        const printed = Number(result?.stdout?.trim())
        if (result?.ok) return settle({ ok: true, id: Number.isInteger(printed) && printed > 0 ? printed : null })
        settle({ ok: false, error: { code: 'notify_failed', exitCode: result?.exitCode ?? null } })
      }
      let started
      try { started = Promise.resolve(run(notifyCommand, args, { env, timeoutMs: actionWaitMs, onLine, signal: controller.signal })) } catch (error) { started = Promise.reject(error) }
      started.then(ended, () => ended({ ok: false, exitCode: null }))
    })
  }
  async function popup({ title, body, urgency = 'normal', replaceId = null, actions = null, onAction = null }) {
    const keys = Array.isArray(actions) ? Object.keys(ACTION_LABELS).filter(key => actions.includes(key)) : []
    const args = ['--app-name=fleetmates deck', '--print-id']
    if (keys.length) args.push('--wait')
    args.push(`--urgency=${urgency}`)
    const replacing = Number.isInteger(replaceId) && replaceId > 0
    if (replacing) args.push(`--replace-id=${replaceId}`)
    for (const key of keys) args.push(`--action=${key}=${ACTION_LABELS[key]}`)
    args.push('--', notificationText(title, TITLE_MAX), notificationText(body, BODY_MAX, { keepLineFeeds: true }))
    const previous = replacing ? waits.get(replaceId) : undefined
    let result
    if (keys.length) result = await wait(args, keys, onAction)
    else {
      result = await call(notifyCommand, args, 'notify_failed')
      if (result.ok) {
        const id = Number(result.stdout?.trim())
        result = { ok: true, id: Number.isInteger(id) && id > 0 ? id : null }
      }
    }
    if (result.ok && previous) stopWait(replaceId, previous)
    return result
  }
  return {
    popup,
    async bell() {
      const result = await call(soundCommand, ['--raw', '--format=s16', '--rate=48000', '--channels=1', '-'], 'bell_failed', bellAudio())
      return result.ok ? { ok: true } : result
    },
    async dismiss(id) {
      if (!Number.isInteger(id) || id <= 0) return { ok: true }
      stopWait(id)
      const result = await call(dismissCommand, ['dismiss', '-n', String(id)], 'notify_failed')
      return result.ok ? { ok: true } : result
    },
    testPing() { return popup({ title: 'fleetmates deck', body: 'Test ping · Desktop notifications are working.' }) },
    /** Kill every waiting popup process. */
    close() { for (const id of [...waits.keys()]) stopWait(id) }
  }
}
