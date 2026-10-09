// node-pty 1.1.0's macOS prebuilt spawn helper is shipped without execute bits.
// Prepare only the known native helper paths during package installation, and again from
// deckd (prepareNativeSync) because an npm that skips install scripts never runs this one.
import * as fsSync from 'node:fs'
import { open as openAsync } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { constants } = fsSync
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

/** chmod failures that mean this user may not change the helper, not that something broke. */
const CANNOT_CHANGE = new Set(['EPERM', 'EROFS', 'EACCES'])

/**
 * The error for a helper whose execute bits are missing and whose chmod failed: one this user may
 * not change gets a message naming the helper and the fix, keeping the code; any other is as is.
 * @param {string} file
 * @param {NodeJS.ErrnoException} err
 * @returns {Error}
 */
function chmodError (file, err) {
  if (!CANNOT_CHANGE.has(err?.code ?? '')) return err
  const msg = `node-pty spawn helper ${file} is not executable and this user cannot change it (${err.code}); run chmod +x ${file} as its owner`
  return Object.assign(new Error(msg, { cause: err }), { code: err.code })
}

/**
 * On darwin, add the execute bits to every node-pty spawn helper found, opened without following
 * a symlink and refused unless it is a regular file. A helper that already has all three execute
 * bits is left alone, so a helper this user does not own (a root-owned global install) or cannot
 * write (a read-only install) is accepted as it is. Returns how many were found (0 off darwin);
 * throws when none is. `open` stands in for fs/promises open in tests.
 * @param {{ platform?: string, arch?: string, packageRoot?: string, open?: (file: string, flags: number) => Promise<any> }} [opts]
 * @returns {Promise<number>}
 */
export async function prepareNative({ platform = process.platform, arch = process.arch, packageRoot, open = openAsync } = {}) {
  if (platform !== 'darwin') return 0
  let found = 0
  for (const file of helperPaths(arch, packageRoot)) {
    let handle
    try {
      handle = await open(file, OPEN_FLAGS)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(NOT_REGULAR)
      if ((stat.mode & 0o111) !== 0o111) {
        try { await handle.chmod(stat.mode | 0o111) } catch (err) { throw chmodError(file, err) }
      }
      found += 1
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    } finally { await handle?.close() }
  }
  if (!found) throw new Error(MISSING)
  return found
}

/**
 * prepareNative, synchronously, for deckd to run before its first node-pty spawn. `fs` stands in
 * for the node:fs calls it makes (openSync, fstatSync, fchmodSync, closeSync) in tests.
 * @param {{ platform?: string, arch?: string, packageRoot?: string, fs?: Pick<typeof fsSync, 'openSync' | 'fstatSync' | 'fchmodSync' | 'closeSync'> }} [opts]
 * @returns {number}
 */
export function prepareNativeSync ({ platform = process.platform, arch = process.arch, packageRoot, fs = fsSync } = {}) {
  if (platform !== 'darwin') return 0
  let found = 0
  for (const file of helperPaths(arch, packageRoot)) {
    let fd
    try {
      fd = fs.openSync(file, OPEN_FLAGS)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) throw new Error(NOT_REGULAR)
      if ((stat.mode & 0o111) !== 0o111) {
        try { fs.fchmodSync(fd, stat.mode | 0o111) } catch (err) { throw chmodError(file, /** @type {NodeJS.ErrnoException} */ (err)) }
      }
      found += 1
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  if (!found) throw new Error(MISSING)
  return found
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNative()
