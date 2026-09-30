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
    args.push('--', String(title), String(body))
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
