import { mkdtemp, chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Create a private temp directory to stand in for XDG_RUNTIME_DIR, so a test
 * never touches the real runtime dir. The chmod to 0700 is skipped on Windows.
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {Promise<{ dir: string, env: NodeJS.ProcessEnv, cleanup: () => Promise<void> }>}
 */
export async function makeRuntimeDir ({ platform = process.platform } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-runtime-'))
  if (platform !== 'win32') await chmod(dir, 0o700)
  const env = { ...process.env, XDG_RUNTIME_DIR: dir }
  const cleanup = () => rm(dir, { recursive: true, force: true })
  return { dir, env, cleanup }
}
