import { spawn } from 'node:child_process'

function execute(command, args, { env, input, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    let size = 0
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, exitCode: null })
    }, timeoutMs)
    child.on('error', () => finish({ ok: false, exitCode: null }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size <= 4096) chunks.push(chunk)
      else {
        child.kill('SIGKILL')
        finish({ ok: false, exitCode: null })
      }
    })
    child.on('close', code => finish({ ok: code === 0, exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') }))
    child.stdin.end(input)
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

/** Title and body caps in characters, counted after stripping (08-security.md section 4.9). */
export const TITLE_MAX = 80
export const BODY_MAX = 200
// C0 controls and DEL, C1 controls, and the bidi controls (ALM, LRM, RLM, LRE..RLO, LRI..PDI).
const CONTROLS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu
const CONTROLS_BUT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu
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
  const chars = Array.from(String(text ?? '').replace(keepLineFeeds ? CONTROLS_BUT_LF : CONTROLS, ''))
  const capped = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
  return capped.replace(/[&<>"']/g, char => ENTITIES[char])
}

/** Create popup, dismissal, test-ping and bell commands with injectable executables and runner. */
export function createNotifier({ notifyCommand = 'notify-send', soundCommand = 'pw-play', dismissCommand = 'makoctl', env = process.env, run = execute, timeoutMs = 2000 } = {}) {
  async function call(command, args, code, input) {
    try {
      const result = await run(command, args, { env, input, timeoutMs })
      return result.ok ? result : { ok: false, error: { code, exitCode: result.exitCode ?? null } }
    } catch { return { ok: false, error: { code, exitCode: null } } }
  }
  async function popup({ title, body, urgency = 'normal', replaceId = null }) {
    const args = ['--app-name=fleetmates deck', '--print-id', `--urgency=${urgency}`]
    if (Number.isInteger(replaceId) && replaceId > 0) args.push(`--replace-id=${replaceId}`)
    args.push('--', notificationText(title, TITLE_MAX), notificationText(body, BODY_MAX, { keepLineFeeds: true }))
    const result = await call(notifyCommand, args, 'notify_failed')
    if (!result.ok) return result
    const id = Number(result.stdout?.trim())
    return { ok: true, id: Number.isInteger(id) && id > 0 ? id : null }
  }
  return {
    popup,
    async bell() {
      const result = await call(soundCommand, ['--raw', '--format=s16', '--rate=48000', '--channels=1', '-'], 'bell_failed', bellAudio())
      return result.ok ? { ok: true } : result
    },
    async dismiss(id) {
      if (!Number.isInteger(id) || id <= 0) return { ok: true }
      const result = await call(dismissCommand, ['dismiss', '-n', String(id)], 'notify_failed')
      return result.ok ? { ok: true } : result
    },
    testPing() { return popup({ title: 'fleetmates deck', body: 'Test ping · Desktop notifications are working.' }) }
  }
}
