// "Start scribed" (OPS-O1, SM-O13, MEET-O10): starts TurbidAssist's scribed as a transient systemd user unit with
// the command the owner decided on 2026-10-04, then waits for its socket to answer.
import { execFile as execFileCallback } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { redact } from '../approvals/audit.mjs'
import { apiError } from '../http/router.mjs'

const UNIT_ARGS = Object.freeze(['--user', '--collect', '--unit=turbidassist-scribed', '--property=KillMode=process'])
const STDERR_MAX_BYTES = 2048
const TOKEN_KEY = /TOKEN|SECRET|PASSWORD|AUTHORIZATION/i

/** @param {NodeJS.ProcessEnv} env */
function tokenFree (env) {
  const copy = { ...env }
  for (const key of Object.keys(copy)) if (TOKEN_KEY.test(key)) delete copy[key]
  return copy
}

/** @param {NodeJS.ProcessEnv} env */
function loginShell (env) {
  if (env.SHELL) return env.SHELL
  try {
    const shell = os.userInfo().shell
    if (shell) return shell
  } catch {}
  return '/bin/sh'
}

/** @param {unknown} stderr */
function tail (stderr) {
  const bytes = Buffer.from(stderr == null ? '' : String(stderr))
  return redact(bytes.subarray(Math.max(0, bytes.length - STDERR_MAX_BYTES)).toString('utf8'))
}

/**
 * The `systemd-run` argv for a scribed command. The default `scribed` gives the decided command
 * `... $SHELL -l -c 'exec scribed'`; any other command is passed as one argument after `-c 'exec "$0"'`, so no
 * setting text reaches a shell parser.
 * @param {string} scribedCommand
 * @param {string} shell
 * @returns {string[]}
 */
export function scribedArgv (scribedCommand, shell) {
  if (scribedCommand === 'scribed') return [...UNIT_ARGS, shell, '-l', '-c', 'exec scribed']
  return [...UNIT_ARGS, shell, '-l', '-c', 'exec "$0"', scribedCommand]
}

async function answers (probe) {
  try {
    return (await probe()) !== false
  } catch {
    return false
  }
}

/**
 * Start scribed unless it already answers.
 * @param {{
 *   scribedCommand?: string,
 *   shell?: string,
 *   env?: NodeJS.ProcessEnv,
 *   probe: () => Promise<unknown>,
 *   execFile?: (file: string, args: string[], options: { env: NodeJS.ProcessEnv, timeout: number }) => Promise<unknown>,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>
 * }} options `probe` is a scribed `status` call: it answers when it resolves to anything but `false`, and does not
 *   when it rejects. `env` is the caller's process environment; keys naming a token, secret, password or
 *   authorization are dropped before `systemd-run` sees it. `shell` defaults to `env.SHELL`, else the user's shell
 *   from `os.userInfo()`, else `/bin/sh`.
 * @returns {Promise<'running' | 'started'>} `'running'` when the first probe answers (nothing is spawned),
 *   `'started'` when a probe answers after `systemd-run`.
 * @throws {Error} `dependency_start_failed` (status 502) with `details: { exitCode, stderr }` when `systemd-run`
 *   fails (the last 2 KiB of its stderr, redacted), or `details: { reason: 'no_socket' }` when no probe answers
 *   within `timeoutMs` after it.
 */
export async function startScribed ({
  scribedCommand = 'scribed',
  shell,
  env = process.env,
  probe,
  execFile = promisify(execFileCallback),
  timeoutMs = 10000,
  intervalMs = 100,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (await answers(probe)) return 'running'
  const childEnv = tokenFree(env)
  const argv = scribedArgv(scribedCommand, shell ?? loginShell(childEnv))
  try {
    await execFile('systemd-run', argv, { env: childEnv, timeout: 5000 })
  } catch (error) {
    throw apiError(502, 'dependency_start_failed', {
      exitCode: typeof error?.code === 'number' ? error.code : null,
      stderr: tail(error?.stderr)
    })
  }
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    await sleep(intervalMs)
    if (await answers(probe)) return 'started'
  }
  throw apiError(502, 'dependency_start_failed', { reason: 'no_socket' })
}
