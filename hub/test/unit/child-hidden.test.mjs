import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import child, { hiddenChildProcess } from '../../platform/child.mjs'

const NAMES = /** @type {const} */ (['spawn', 'spawnSync', 'execFile', 'execFileSync'])

function recorder () {
  /** @type {Record<string, unknown[]>} */
  const calls = {}
  /** @type {Record<string, (...a: unknown[]) => string>} */
  const fake = {}
  for (const name of NAMES) fake[name] = (...a) => { calls[name] = a; return name }
  return { calls, wrapped: hiddenChildProcess(/** @type {any} */ (fake)) }
}

for (const name of NAMES) {
  test(`${name} sets windowsHide when the caller omits it`, () => {
    const { calls, wrapped } = recorder()
    assert.equal(/** @type {any} */ (wrapped[name])('git', ['status'], { cwd: '/x' }), name)
    const [file, args, options] = calls[name]
    assert.equal(file, 'git')
    assert.deepEqual(args, ['status'])
    assert.deepEqual(options, { cwd: '/x', windowsHide: true })
  })

  test(`${name} keeps windowsHide on when the caller passes false`, () => {
    const { calls, wrapped } = recorder()
    const call = /** @type {any} */ (wrapped[name])
    call('git', [], { windowsHide: false, timeout: 5 })
    assert.deepEqual(calls[name][2], { windowsHide: true, timeout: 5 })
  })

  test(`${name} sets windowsHide when the caller passes no options`, () => {
    const { calls, wrapped } = recorder()
    const call = /** @type {any} */ (wrapped[name])
    call('git', [])
    assert.deepEqual(calls[name][2], { windowsHide: true })
  })
}

test('execFile passes the callback through', () => {
  const { calls, wrapped } = recorder()
  const callback = () => {}
  wrapped.execFile('git', [], {}, callback)
  assert.equal(calls.execFile[3], callback)
})

test('promisified execFile sets windowsHide', async () => {
  /** @type {unknown[]} */
  let seen = []
  const fake = /** @type {any} */ ({ execFile: (/** @type {unknown[]} */ ...a) => { seen = a; /** @type {any} */ (a[3])(null, 'out', 'err') } })
  const result = await promisify(hiddenChildProcess(fake).execFile)('git', [], { windowsHide: false })
  assert.deepEqual(seen[2], { windowsHide: true })
  assert.deepEqual(result, { stdout: 'out', stderr: 'err' })
})

test('the real execFile works under promisify', async () => {
  const { stdout } = /** @type {any} */ (await promisify(child.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'], {}))
  assert.equal(stdout, 'ok')
})
