// Every child process the hub starts goes through here. On Windows the deck services run
// detached with no console, so a console child started without windowsHide opens a visible
// window (issue #56). windowsHide is set after the caller's options so no caller can drop it.
// test/unit/no-raw-child-process.test.mjs refuses a direct node:child_process import elsewhere.
import nodeChildProcess from 'node:child_process'
import { promisify } from 'node:util'

/**
 * @template {object} T
 * @param {T | undefined} options
 * @returns {T & { windowsHide: true }}
 */
export const hidden = (options) => /** @type {any} */ ({ ...options, windowsHide: true })

/**
 * Wrap a child_process-like module so every call hides its window on Windows. The wrappers take
 * the `(file, args, options)` form only: every hub call site passes `args` as an array.
 * @param {Pick<typeof nodeChildProcess, 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync'>} cp
 */
export function hiddenChildProcess (cp) {
  /** @type {any} */
  const execFile = (file, args, options, callback) => cp.execFile(file, args, hidden(options), callback)
  // Keep node's promisify shape: resolve { stdout, stderr }, and reject with both attached.
  execFile[promisify.custom] = (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {object} */ options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (/** @type {any} */ error, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
  return {
    /** @type {typeof nodeChildProcess.spawn} */
    spawn: /** @type {any} */ ((file, args, options) => cp.spawn(file, args, hidden(options))),
    /** @type {typeof nodeChildProcess.spawnSync} */
    spawnSync: /** @type {any} */ ((file, args, options) => cp.spawnSync(file, args, hidden(options))),
    /** @type {typeof nodeChildProcess.execFile} */
    execFile,
    /** @type {typeof nodeChildProcess.execFileSync} */
    execFileSync: /** @type {any} */ ((file, args, options) => cp.execFileSync(file, args, hidden(options))),
  }
}

const real = hiddenChildProcess(nodeChildProcess)
export const { spawn, spawnSync, execFile, execFileSync } = real
export default real
