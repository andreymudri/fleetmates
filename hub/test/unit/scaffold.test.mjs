import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stat, access, constants } from 'node:fs/promises'
import path from 'node:path'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

test('makeRuntimeDir returns a 0700 dir that cleanup removes', async () => {
  const { dir, env, cleanup } = await makeRuntimeDir()
  const st = await stat(dir)
  assert.ok(st.isDirectory())
  // NTFS has no POSIX mode bits, so only POSIX can show 0700.
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o700)
  assert.equal(env.XDG_RUNTIME_DIR, dir)
  await cleanup()
  await assert.rejects(stat(dir), { code: 'ENOENT' })
})

test('fakeBin writes an executable claude whose PATH entry is first', async () => {
  const { binDir, claudePath, env, cleanup } = await fakeBin({ script: 'idle', log: '/dev/null' })
  try {
    // claude.cmd on Windows, claude elsewhere.
    assert.equal(claudePath, path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude'))
    await access(claudePath, constants.X_OK)
    assert.equal(env.PATH.split(path.delimiter)[0], binDir)
    assert.equal(env.FAKE_CLAUDE_SCRIPT, 'idle')
    assert.equal(env.FAKE_CLAUDE_LOG, '/dev/null')
    assert.equal(env.FAKE_CLAUDE_VERSION, '2.1.282')
  } finally {
    await cleanup()
  }
})

test('node-pty and @xterm/headless resolve', async () => {
  const pty = await import('node-pty')
  assert.equal(typeof pty.spawn, 'function')
  const headless = await import('@xterm/headless')
  assert.equal(typeof (headless.Terminal ?? headless.default?.Terminal), 'function')
})
