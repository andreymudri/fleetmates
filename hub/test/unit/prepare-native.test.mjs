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

/** The helper path a fake fs serves, under a package root that is never created. */
const FAKE_ROOT = path.join(os.tmpdir(), 'deck-native-fake')
const FAKE_HELPER = path.join(FAKE_ROOT, 'prebuilds/darwin-arm64/spawn-helper')
const FAKE_OPTIONS = { platform: 'darwin', arch: 'arm64', packageRoot: FAKE_ROOT }

/**
 * Fake fs calls serving one regular helper at FAKE_HELPER with `mode`, whose chmod fails with
 * `chmodCode` when given; every other path is ENOENT. `fs` is for prepareNativeSync, `open` for
 * prepareNative, and `chmods` records each chmod asked for.
 * @param {number} mode
 * @param {string} [chmodCode]
 */
function fakeFs (mode, chmodCode) {
  /** @type {number[]} */
  const chmods = []
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const stat = { mode, isFile: () => true }
  const chmod = (/** @type {number} */ m) => {
    chmods.push(m)
    if (chmodCode) throw Object.assign(new Error(`${chmodCode}: fchmod`), { code: chmodCode })
  }
  const fs = {
    openSync (/** @type {string} */ file) { if (file !== FAKE_HELPER) throw enoent(); return 42 },
    fstatSync: () => stat,
    fchmodSync: (/** @type {number} */ _fd, /** @type {number} */ m) => chmod(m),
    closeSync () {}
  }
  const open = async (/** @type {string} */ file) => {
    if (file !== FAKE_HELPER) throw enoent()
    return { stat: async () => stat, chmod: async (/** @type {number} */ m) => chmod(m), close: async () => {} }
  }
  return { fs, open, chmods }
}

test('native preparation accepts an already executable helper without changing it, though this user could not', async () => {
  for (const code of ['EPERM', 'EROFS']) {
    const sync = fakeFs(0o100755, code)
    assert.equal(prepareNativeSync({ ...FAKE_OPTIONS, fs: sync.fs }), 1, code)
    assert.deepEqual(sync.chmods, [], code)
    const promised = fakeFs(0o100755, code)
    assert.equal(await prepareNative({ ...FAKE_OPTIONS, open: promised.open }), 1, code)
    assert.deepEqual(promised.chmods, [], code)
  }
  // a helper missing one execute bit is still changed
  for (const run of [(/** @type {any} */ f) => prepareNativeSync({ ...FAKE_OPTIONS, fs: f.fs }), (/** @type {any} */ f) => prepareNative({ ...FAKE_OPTIONS, open: f.open })]) {
    const partly = fakeFs(0o100744)
    assert.equal(await run(partly), 1)
    assert.deepEqual(partly.chmods, [0o100755])
  }
})

test('native preparation that cannot make the helper executable names the helper and the chmod to run as its owner', async () => {
  for (const code of ['EPERM', 'EROFS', 'EACCES']) {
    const expected = (/** @type {any} */ err) => err.code === code && /not executable/.test(err.message) &&
      err.message.includes(`chmod +x ${FAKE_HELPER}`) && !/reinstall/.test(err.message)
    assert.throws(() => prepareNativeSync({ ...FAKE_OPTIONS, fs: fakeFs(0o100644, code).fs }), expected, code)
    await assert.rejects(prepareNative({ ...FAKE_OPTIONS, open: fakeFs(0o100644, code).open }), expected, code)
  }
  // any other chmod failure is passed on as it is
  assert.throws(() => prepareNativeSync({ ...FAKE_OPTIONS, fs: fakeFs(0o100644, 'EIO').fs }), { code: 'EIO', message: 'EIO: fchmod' })
})
