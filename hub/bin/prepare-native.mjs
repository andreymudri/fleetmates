// node-pty 1.1.0's macOS prebuilt spawn helper is shipped without execute bits.
// Prepare only the known native helper paths during package installation, and again from
// deckd (prepareNativeSync) because an npm that skips install scripts never runs this one.
import { constants, closeSync, fchmodSync, fstatSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const NOT_REGULAR = 'node-pty spawn helper must be a regular file'
const MISSING = 'node-pty macOS spawn helper is missing; reinstall dependencies'

/**
 * The places node-pty may keep its spawn helper, under its package root.
 * @param {string} arch
 * @param {string} [packageRoot] node-pty's package root; the one this module resolves by default
 * @returns {string[]}
 */
function helperPaths (arch, packageRoot) {
  const root = packageRoot ?? path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  return ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`].map((dir) => path.join(root, dir, 'spawn-helper'))
}

/**
 * On darwin, add the execute bits to every node-pty spawn helper found, opened without following
 * a symlink and refused unless it is a regular file. Returns how many were found (0 off darwin);
 * throws when none is.
 * @param {{ platform?: string, arch?: string, packageRoot?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function prepareNative({ platform = process.platform, arch = process.arch, packageRoot } = {}) {
  if (platform !== 'darwin') return 0
  let found = 0
  for (const file of helperPaths(arch, packageRoot)) {
    let handle
    try {
      handle = await open(file, OPEN_FLAGS)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(NOT_REGULAR)
      await handle.chmod(stat.mode | 0o111)
      found += 1
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    } finally { await handle?.close() }
  }
  if (!found) throw new Error(MISSING)
  return found
}

/**
 * prepareNative, synchronously, for deckd to run before its first node-pty spawn.
 * @param {{ platform?: string, arch?: string, packageRoot?: string }} [opts]
 * @returns {number}
 */
export function prepareNativeSync ({ platform = process.platform, arch = process.arch, packageRoot } = {}) {
  if (platform !== 'darwin') return 0
  let found = 0
  for (const file of helperPaths(arch, packageRoot)) {
    let fd
    try {
      fd = openSync(file, OPEN_FLAGS)
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error(NOT_REGULAR)
      fchmodSync(fd, stat.mode | 0o111)
      found += 1
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  if (!found) throw new Error(MISSING)
  return found
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNative()
