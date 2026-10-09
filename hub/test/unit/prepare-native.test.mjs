import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareNative, prepareNativeSync } from '../../bin/prepare-native.mjs'
import { posixTest } from '../helpers/platform.mjs'

/** A private package root and the darwin-arm64 options and helper path inside it. */
async function packageRoot () {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-native-'))
  const options = { platform: 'darwin', arch: 'arm64', packageRoot: root }
  const helper = path.join(root, 'prebuilds/darwin-arm64/spawn-helper')
  return { root, options, helper }
}

test('native preparation does nothing off macOS, finds the macOS spawn helper and rejects a missing one', async () => {
  const { root, options, helper } = await packageRoot()
  try {
    assert.equal(await prepareNative({ ...options, platform: 'linux' }), 0)
    await assert.rejects(prepareNative(options), /helper is missing/)
    await mkdir(path.dirname(helper), { recursive: true })
    await writeFile(helper, 'Synthetic helper', { mode: 0o600 })
    assert.equal(await prepareNative(options), 1)
    assert.equal(await prepareNative(options), 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

posixTest('native preparation makes the macOS spawn helper executable and rejects a symlinked helper', { reason: 'execute bits and symlinks' }, async () => {
  const { root, options, helper } = await packageRoot()
  try {
    await mkdir(path.dirname(helper), { recursive: true })
    await writeFile(helper, 'Synthetic helper', { mode: 0o600 })
    assert.equal(await prepareNative(options), 1)
    assert.equal((await stat(helper)).mode & 0o111, 0o111)
    assert.equal(await prepareNative(options), 1)
    await rm(helper)
    const outside = path.join(root, 'outside')
    await writeFile(outside, 'Unrelated file', { mode: 0o600 })
    await symlink(outside, helper)
    await assert.rejects(prepareNative(options), { code: 'ELOOP' })
    assert.equal((await stat(outside)).mode & 0o111, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('synchronous native preparation does nothing off macOS, finds the macOS spawn helper and rejects a missing one', async () => {
  const { root, options, helper } = await packageRoot()
  try {
    assert.equal(prepareNativeSync({ ...options, platform: 'linux' }), 0)
    assert.equal(prepareNativeSync({ ...options, platform: 'win32' }), 0)
    assert.throws(() => prepareNativeSync(options), /helper is missing/)
    await mkdir(path.dirname(helper), { recursive: true })
    await writeFile(helper, 'Synthetic helper', { mode: 0o600 })
    assert.equal(prepareNativeSync(options), 1)
    // a helper in each of the three known places is prepared
    for (const dir of ['build/Release', 'build/Debug']) {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, 'spawn-helper'), 'Synthetic helper', { mode: 0o600 })
    }
    assert.equal(prepareNativeSync(options), 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

posixTest('synchronous native preparation makes the macOS spawn helper executable and rejects a symlinked helper', { reason: 'execute bits and symlinks' }, async () => {
  const { root, options, helper } = await packageRoot()
  try {
    await mkdir(path.dirname(helper), { recursive: true })
    await writeFile(helper, 'Synthetic helper', { mode: 0o600 })
    assert.equal(prepareNativeSync(options), 1)
    assert.equal((await stat(helper)).mode & 0o777, 0o711)
    await rm(helper)
    const outside = path.join(root, 'outside')
    await writeFile(outside, 'Unrelated file', { mode: 0o600 })
    await symlink(outside, helper)
    assert.throws(() => prepareNativeSync(options), { code: 'ELOOP' })
    assert.equal((await stat(outside)).mode & 0o111, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

posixTest('synchronous native preparation refuses a helper that is not a regular file', { reason: 'opening a directory read-only' }, async () => {
  const { root, options, helper } = await packageRoot()
  try {
    await mkdir(helper, { recursive: true })
    assert.throws(() => prepareNativeSync(options), /regular file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
