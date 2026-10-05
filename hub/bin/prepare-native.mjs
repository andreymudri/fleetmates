// node-pty 1.1.0's macOS prebuilt spawn helper is shipped without execute bits.
// Prepare only the known native helper paths during package installation.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export async function prepareNative({ platform = process.platform, arch = process.arch, packageRoot } = {}) {
  if (platform !== 'darwin') return 0
  const root = packageRoot ?? path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  let found = 0
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]) {
    let handle
    try {
      handle = await open(path.join(root, dir, 'spawn-helper'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('node-pty spawn helper must be a regular file')
      await handle.chmod(stat.mode | 0o111)
      found += 1
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    } finally { await handle?.close() }
  }
  if (!found) throw new Error('node-pty macOS spawn helper is missing; reinstall dependencies')
  return found
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNative()
