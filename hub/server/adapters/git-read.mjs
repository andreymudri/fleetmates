import { execFile } from 'node:child_process'

/** The configuration overrides of docs/deck/08-security.md section 4.8, placed before every git command. */
export const SAFE_GIT_FLAGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.allow=never',
  '--no-pager'
])

const secretName = /TOKEN|SECRET|PASSWORD|AUTHORIZATION/i

/**
 * The environment a read-only git child gets: the server's own environment without any variable whose
 * name looks like a credential (the deck token among them) and without inherited `GIT_*` variables
 * (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS` and the like would redirect or reconfigure
 * the call), plus the four 4.8 variables.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function gitEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || secretName.test(key) || key.startsWith('GIT_')) continue
    env[key] = value
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/false' }
}

/**
 * Run one read-only git command in `root` with the 4.8 flags: an argv array (never a shell), a timeout,
 * and no credential variables in the environment. Resolves `{ code, stdout }` for any exit status, so a
 * caller can read `git diff --no-index` exit 1 as "differences"; resolves null when git could not start,
 * timed out, was killed or wrote more than `maxBuffer` bytes. It never rejects.
 * @param {string} root working directory of the git call
 * @param {string[]} args git arguments after the safe flags
 * @param {{ timeoutMs?: number, maxBuffer?: number, input?: string|Buffer }} [options]
 * @returns {Promise<{ code: number, stdout: Buffer } | null>}
 */
export function gitRead(root, args, { timeoutMs = 1500, maxBuffer = 1024 * 1024, input } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = execFile('git', [...SAFE_GIT_FLAGS, ...args], {
        cwd: root,
        env: gitEnv(),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        encoding: 'buffer',
        shell: false,
        windowsHide: true
      }, (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout })
        if (typeof error.code === 'number' && !error.killed && !error.signal) return resolve({ code: error.code, stdout })
        resolve(null)
      })
    } catch { resolve(null); return }
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
