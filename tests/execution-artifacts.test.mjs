import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, writeFile, stat, lstat, chmod, symlink, link, mkdir, open, readFile, rename, utimes } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { discover, git } from '../scripts/workflow-lifecycle.mjs'
import { retainExecutionArtifact, readExecutionArtifact, pruneExecutionArtifacts, RETENTION_LIMITS } from '../scripts/execution-artifacts.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const retention = { maxArtifactBytes: 64, maxRunBytes: 128, maxAgeMs: 1000 }
async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  return { common: discover(root).common, runId: 'run-1', retention }
}
const directory = request => path.join(request.common, 'fleetmates-artifacts', hash(request.runId))
const artifactFile = (request, reference) => path.join(directory(request), hash(JSON.stringify(reference)) + '.bin')
const retain = (request, bytes, extra = {}) => retainExecutionArtifact({ ...request, kind: 'stdout', bytes, ...extra })

async function createFifo(file, execute = spawnSync) {
  const result = execute('mkfifo', [file], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 })
  if (result.error?.code === 'ENOENT' && result.error.path === 'mkfifo' && result.error.syscall === 'spawnSync mkfifo'
      && result.pid === 0 && result.status === null && result.signal === null && result.output === null
      && result.stdout === undefined && result.stderr === undefined) {
    await assert.rejects(lstat(file), { code: 'ENOENT' })
    return false
  }
  assert.equal(result.error, undefined, 'mkfifo failed to execute')
  assert.equal(result.status, 0, 'mkfifo failed')
  assert.equal(result.signal, null, 'mkfifo was interrupted')
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0, 'mkfifo must report a spawned process')
  assert.equal(result.stdout, '', 'mkfifo produced unexpected stdout')
  assert.equal(result.stderr, '', 'mkfifo produced unexpected stderr')
  assert.deepEqual(result.output, [null, '', ''], 'mkfifo output fields are inconsistent')
  assert.ok((await lstat(file)).isFIFO(), 'mkfifo did not create a FIFO')
  return true
}

test('retains exact bytes in common Git storage and rejects altered or missing bytes', async t => {
  const request = await repository(t), original = Buffer.from([0, 255, 128, 10])
  const { reference } = await retain(request, original)
  const readRequest = { ...request, reference }
  assert.deepEqual(await readExecutionArtifact(readRequest), original)
  await writeFile(artifactFile(request, reference), Buffer.from([0, 254, 128, 10]))
  await assert.rejects(readExecutionArtifact(readRequest))
  await rm(artifactFile(request, reference))
  await assert.rejects(readExecutionArtifact(readRequest))
  assert.deepEqual(await readdir(directory(request)), [])
})

test('deduplicates only the exact identity, preserving private modes and original age', async t => {
  const request = await repository(t), bytes = Buffer.from('secret body')
  const first = await retain(request, bytes, { now: 10000 })
  const second = await retain(request, bytes, { now: () => 10500 })
  assert.deepEqual(second.reference, first.reference)
  assert.ok(Object.isFrozen(first.reference))
  assert.deepEqual(Object.keys(first.reference), ['version', 'runId', 'kind', 'sha256', 'byteLength'])
  assert.equal(first.reference.sha256, hash(bytes))
  assert.equal(first.reference.byteLength, bytes.length)
  assert.equal((await stat(artifactFile(request, first.reference))).mtimeMs, 10000)
  assert.equal((await stat(artifactFile(request, first.reference))).mode & 0o777, 0o600)
  for (const dir of [directory(request), path.dirname(directory(request))]) assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal(first.durability.fileSynced, true)
  assert.equal(first.durability.directorySynced, process.platform !== 'win32')
  assert.equal(first.durability.powerLossGuaranteed, false)
  assert.match(first.trust, /same UID/)
  assert.match(first.durability.limitation, /power loss/)
  assert.ok(!JSON.stringify(first).includes(request.common))
  assert.ok(!JSON.stringify(first).includes(bytes.toString()))
  const otherKind = await retain(request, bytes, { kind: 'stderr', now: 10500 })
  assert.notDeepEqual(otherKind.reference, first.reference)
  assert.equal((await readdir(directory(request))).length, 2)
  await assert.rejects(readExecutionArtifact({ ...request, reference: { ...first.reference, kind: 'review' } }))
  await writeFile(artifactFile(request, first.reference), Buffer.alloc(bytes.length))
  await assert.rejects(retain(request, bytes, { now: 10500 }))
})

test('accepts empty bytes and copies the exact Uint8Array view before awaiting storage', async t => {
  const request = await repository(t)
  const empty = await retain(request, Buffer.alloc(0))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: empty.reference }), Buffer.alloc(0))
  const array = new Uint8Array([1, 2, 3, 4]), view = array.subarray(1, 3)
  const pending = retain(request, view)
  array.fill(9)
  const result = await pending
  assert.deepEqual(await readFile(artifactFile(request, result.reference)), Buffer.from([2, 3]))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: result.reference }), Buffer.from([2, 3]))
  for (const bytes of ['text', {}, [1, 2], new DataView(new ArrayBuffer(1))]) await assert.rejects(retain(request, bytes))
})

test('validates exact bounded retention contracts on every operation', async t => {
  const request = await repository(t), result = await retain(request, Buffer.from('x'))
  const invalid = [undefined, null, {}, { ...retention, unknown: 1 }]
  for (const [field, upper] of Object.entries({ maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 24 * 60 * 60 * 1000 })) {
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER, upper + 1, '1']) invalid.push({ ...retention, [field]: value })
  }
  for (const policy of invalid) {
    await assert.rejects(retain({ ...request, retention: policy }, Buffer.from('x')))
    await assert.rejects(readExecutionArtifact({ ...request, retention: policy, reference: result.reference }))
    await assert.rejects(pruneExecutionArtifacts({ ...request, retention: policy, liveReferences: [] }))
  }
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: Array(4097).fill(result.reference) }))
})

test('rejects unsafe run, kind, time and reference identities without accepting another run', async t => {
  const request = await repository(t), { reference } = await retain(request, Buffer.from('x'))
  for (const runId of ['', '../escape', '/home/you', 'a//b', 'a/./b', 'a\\b', 'x\n', 'x'.repeat(256)]) {
    await assert.rejects(retain({ ...request, runId }, Buffer.from('x')))
    await assert.rejects(readExecutionArtifact({ ...request, runId, reference }))
    await assert.rejects(pruneExecutionArtifacts({ ...request, runId, liveReferences: [] }))
  }
  for (const kind of ['', '../escape', '/home/you', 'body\n', 'x'.repeat(65)]) await assert.rejects(retain(request, Buffer.from('x'), { kind }))
  for (const now of [-1, NaN, Infinity, '1', () => -1]) await assert.rejects(retain(request, Buffer.from('x'), { now }))
  await assert.rejects(readExecutionArtifact({ ...request, runId: 'other-run', reference }))
  for (const changes of [{ version: 2 }, { extra: 'body' }, { sha256: 'A'.repeat(64) }, { byteLength: -1 }, { byteLength: 1.5 }, { byteLength: 2 }, { runId: 'other-run' }]) {
    await assert.rejects(readExecutionArtifact({ ...request, reference: { ...reference, ...changes } }))
  }
  const reversed = Object.fromEntries(Object.entries(reference).reverse())
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: reversed }), Buffer.from('x'))
})

test('enforces both byte budgets including stricter reads and equal-content deduplication', async t => {
  const request = { ...await repository(t), retention: { ...retention, maxArtifactBytes: 4, maxRunBytes: 6 } }
  await assert.rejects(retain(request, Buffer.alloc(5)), /artifact.*bound/i)
  const { reference } = await retain(request, Buffer.from('abcd'))
  await retain(request, Buffer.from('abcd'))
  // Old content over the run bound does not refuse new content; only content that alone cannot fit does.
  await retain(request, Buffer.from('xyz'))
  await assert.rejects(retain({ ...request, retention: { ...request.retention, maxArtifactBytes: 8 } }, Buffer.alloc(7)), /run.*bound/i)
  await retain({ ...request, retention: { ...request.retention, maxArtifactBytes: 8 } }, Buffer.alloc(6))
  await assert.rejects(readExecutionArtifact({ ...request, retention: { ...request.retention, maxArtifactBytes: 3 }, reference }))
  await writeFile(artifactFile(request, reference), Buffer.alloc(5))
  await assert.rejects(readExecutionArtifact({ ...request, reference }), /artifact.*bound/i)
})

test('eight concurrent writers on one store all succeed by waiting for the lock', async t => {
  const request = await repository(t)
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => retain(request, Buffer.from('body-' + i))))
  assert.deepEqual(results.map(result => result.status), Array(8).fill('fulfilled'))
  assert.equal((await readdir(directory(request))).length, 8)
  for (const [i, result] of results.entries()) assert.deepEqual(await readExecutionArtifact({ ...request, reference: result.value.reference }), Buffer.from('body-' + i))
})

test('rejects symlink, hardlink and directory artifact substitutions', async t => {
  const request = await repository(t), bytes = Buffer.from('x'), { reference } = await retain(request, bytes)
  const file = artifactFile(request, reference), outside = path.join(request.common, 'outside')
  await writeFile(outside, bytes, { mode: 0o600 })
  await rm(file); await symlink(outside, file)
  await assert.rejects(readExecutionArtifact({ ...request, reference }))
  await assert.rejects(retain(request, bytes))
  await rm(file); await link(outside, file)
  await assert.rejects(readExecutionArtifact({ ...request, reference }))
  await rm(file); await mkdir(file, { mode: 0o700 })
  await assert.rejects(readExecutionArtifact({ ...request, reference }))
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [] }))
  assert.deepEqual(await readFile(outside), bytes)
})

test('nonblocking reads reject FIFO artifacts as non-regular', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const request = await repository(t), { reference } = await retain(request, Buffer.alloc(0)), file = artifactFile(request, reference)
  await rm(file)
  if (!await createFifo(file)) { t.skip('mkfifo is unavailable; FIFO denial was not exercised'); return }
  await chmod(file, 0o600)
  const module = new URL('../scripts/execution-artifacts.mjs', import.meta.url).href
  const code = `import { readExecutionArtifact } from ${JSON.stringify(module)}; import assert from 'node:assert/strict'; await assert.rejects(readExecutionArtifact(${JSON.stringify({ ...request, reference })}), /regular/)`
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000 }).length, 0)
})

test('FIFO capability handling rejects command failures, inconsistent output and false success', async t => {
  const request = await repository(t), file = path.join(request.common, 'fifo-capability')
  const absent = () => ({ error: Object.assign(new Error('missing command'), { code: 'ENOENT', path: 'mkfifo', syscall: 'spawnSync mkfifo' }),
    pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined })
  const success = () => ({ pid: 1, status: 0, signal: null, output: [null, '', ''], stdout: '', stderr: '' })
  assert.equal(await createFifo(file, () => absent()), false)
  const invalid = [
    { ...absent(), error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    { ...absent(), error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { ...absent(), status: 1 }, { ...absent(), pid: 1 }, { ...absent(), signal: 'SIGTERM' },
    { ...absent(), stdout: 'unexpected' }, { ...absent(), stderr: 'unexpected' }, { ...absent(), output: [null, '', ''] },
    { ...absent(), error: Object.assign(new Error('other command'), { code: 'ENOENT', path: 'other', syscall: 'spawnSync other' }) },
    { ...success(), error: Object.assign(new Error('execution failed'), { code: 'EACCES' }) },
    { ...success(), status: 1 }, { ...success(), signal: 'SIGTERM' }, { ...success(), pid: 0 },
    { ...success(), stdout: 'unexpected', output: [null, 'unexpected', ''] },
    { ...success(), stderr: 'unexpected', output: [null, '', 'unexpected'] },
    { ...success(), output: [null, 'inconsistent', ''] }, { ...success(), output: null },
  ]
  for (const result of invalid) await assert.rejects(createFifo(file, () => result), { code: 'ERR_ASSERTION' })
  await writeFile(file, 'not a FIFO')
  await assert.rejects(createFifo(file, () => absent()))
  await assert.rejects(createFifo(file, () => success()), /FIFO/)
  await rm(file)
  await assert.rejects(createFifo(file, () => success()), { code: 'ENOENT' })
})

test('Node builtin Unix socket artifacts receive an explicit non-regular file denial', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const request = await repository(t), { reference } = await retain(request, Buffer.alloc(0))
  const file = artifactFile(request, reference), socket = path.join(path.dirname(request.common), 'probe.sock')
  const server = createServer(), cwd = process.cwd()
  t.after(() => new Promise(resolve => server.close(() => resolve())))
  try {
    // Bound by its relative name from its own directory: a Unix socket path is limited to about 108
    // bytes, which a long TMPDIR (the hostile-TMPDIR sweep) exceeds.
    process.chdir(path.dirname(socket))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path.basename(socket), () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    if (['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'ENOTSUP'].includes(error.code)) { t.skip(`Unix socket fixture unavailable: ${error.code}`); return }
    throw error
  } finally { process.chdir(cwd) }
  assert.ok((await lstat(socket)).isSocket())
  await chmod(socket, 0o600)
  await rm(file); await rename(socket, file)
  assert.ok((await lstat(file)).isSocket())
  await assert.rejects(readExecutionArtifact({ ...request, reference }), /regular/)
})

test('rejects linked or public storage directories and public artifact modes', async t => {
  const request = await repository(t), bytes = Buffer.from('x'), { reference } = await retain(request, bytes)
  await chmod(artifactFile(request, reference), 0o644)
  await assert.rejects(readExecutionArtifact({ ...request, reference }))
  await chmod(artifactFile(request, reference), 0o600)
  await chmod(directory(request), 0o755)
  await assert.rejects(readExecutionArtifact({ ...request, reference }))
  await assert.rejects(retain(request, bytes))
  await chmod(directory(request), 0o700)
  await rm(directory(request), { recursive: true })
  const outside = path.join(request.common, 'outside-dir')
  await mkdir(outside, { mode: 0o700 }); await symlink(outside, directory(request))
  await assert.rejects(retain(request, bytes))
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [] }))
  assert.deepEqual(await readdir(outside), [])
  await rm(directory(request))
  await rm(path.dirname(directory(request)), { recursive: true })
  await symlink(outside, path.dirname(directory(request)))
  await assert.rejects(retain(request, bytes))
})

test('reports incomplete storage and sync failures without returning a usable reference', async t => {
  const request = await repository(t)
  const missingCommon = { ...request, common: path.join(request.common, 'missing') }
  await assert.rejects(pruneExecutionArtifacts({ ...missingCommon, liveReferences: [] }))
  await assert.rejects(retain(missingCommon, Buffer.from('x')))
  await retain(request, Buffer.from('x'))
  await writeFile(path.join(directory(request), '.interrupted.tmp'), 'incomplete', { mode: 0o600 })
  await assert.rejects(retain(request, Buffer.from('y')), /incomplete/i)
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [] }), /incomplete/i)
  await rm(path.join(directory(request), '.interrupted.tmp'))
  const handle = await open(path.join(request.common, 'sync-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync
  await handle.close()
  // Only the one-byte artifact matches; a lock pid file holds at least two bytes.
  const mocked = t.mock.method(prototype, 'sync', async function () {
    const info = await this.stat()
    if (info.isFile() && info.size === 1) throw new Error('injected sync failure')
    return originalSync.call(this)
  })
  await assert.rejects(retain(request, Buffer.from('y')), /injected sync failure/)
  mocked.mock.restore()
  assert.equal((await readdir(directory(request))).length, 1)
  await retain(request, Buffer.from('y'))
})

test('age cleanup removes expired unreferenced artifacts and preserves other runs', async t => {
  const request = await repository(t), other = { ...request, runId: 'run-2' }
  const old = await retain(request, Buffer.from('old'), { now: 10000 })
  const fresh = await retain(request, Buffer.from('new'), { now: 10500 })
  const separate = await retain(other, Buffer.from('other'), { now: 10000 })
  const anchor = await retain(request, Buffer.alloc(0), { now: 10500 })
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [anchor.reference], now: 11001 })
  assert.equal(report.removed.length, 1)
  assert.deepEqual(report.kept.find(entry => !entry.live), { name: path.basename(artifactFile(request, fresh.reference)), bytes: 3, live: false })
  assert.equal(report.kept.length, 2)
  assert.equal(report.bytes, 3)
  assert.equal(report.limitsSatisfied, true)
  assert.deepEqual(report.unresolvedReferences, [])
  await assert.rejects(readExecutionArtifact({ ...request, reference: old.reference }))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: fresh.reference }), Buffer.from('new'))
  assert.deepEqual(await readExecutionArtifact({ ...other, reference: separate.reference }), Buffer.from('other'))
})

test('requires an explicit recovery set and protects live evidence when byte or age limits are unsatisfiable', async t => {
  const request = await repository(t)
  const live = await retain(request, Buffer.from('live'), { now: 10000 })
  await retain(request, Buffer.from('unused'), { now: 10000 })
  await assert.rejects(pruneExecutionArtifacts({ ...request, now: 12000 }))
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [ { ...live.reference, runId: 'other' } ], now: 12000 }))
  const tight = { ...request, retention: { ...retention, maxRunBytes: 3, maxArtifactBytes: 3 } }
  const report = await pruneExecutionArtifacts({ ...tight, liveReferences: new Set([live.reference]), now: 12000 })
  assert.equal(report.removed.length, 1)
  assert.equal(report.kept.length, 1)
  assert.equal(report.bytes, 4)
  assert.equal(report.limitsSatisfied, false)
  assert.deepEqual(report.retentionExceeded, { artifactBytes: true, runBytes: true, age: true, count: false })
  assert.deepEqual(report.unresolvedReferences, [live.reference])
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: live.reference }), Buffer.from('live'))
  await retain(request, Buffer.from('new'), { now: 12000 })
})

test('cleanup returns missing and corrupt recovery references without deleting their evidence or exposing bodies', async t => {
  const request = await repository(t), corrupt = await retain(request, Buffer.from('secret'), { now: 10000 })
  const missing = await retain(request, Buffer.from('missing'), { now: 10000 })
  await writeFile(artifactFile(request, corrupt.reference), Buffer.from('broken'))
  await rm(artifactFile(request, missing.reference))
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [corrupt.reference, missing.reference], now: 12000 })
  assert.deepEqual(report.removed, [])
  assert.deepEqual(report.unresolvedReferences, [corrupt.reference, missing.reference])
  assert.deepEqual(await readFile(artifactFile(request, corrupt.reference)), Buffer.from('broken'))
  assert.ok(!JSON.stringify(report).includes('broken'))
  assert.ok(!JSON.stringify(report).includes(request.common))
  const absent = await pruneExecutionArtifacts({ ...request, runId: 'absent-run', liveReferences: [], now: 12000 })
  assert.deepEqual(absent.kept, [])
  const absentReference = { ...missing.reference, runId: 'absent-run' }
  const absentLive = await pruneExecutionArtifacts({ ...request, runId: 'absent-run', liveReferences: [absentReference], now: 12000 })
  assert.deepEqual(absentLive.unresolvedReferences, [absentReference])
})

test('cleanup evicts oldest unreferenced bytes to meet a lowered total budget', async t => {
  const request = await repository(t)
  const first = await retain(request, Buffer.from('aaaa'), { now: 10000 })
  const second = await retain(request, Buffer.from('bbbb'), { now: 10500 })
  const anchor = await retain(request, Buffer.alloc(0), { now: 10500 })
  const report = await pruneExecutionArtifacts({ ...request, retention: { ...retention, maxRunBytes: 4 }, liveReferences: [anchor.reference], now: 10500 })
  assert.deepEqual(report.removed, [{ name: path.basename(artifactFile(request, first.reference)), bytes: 4 }])
  assert.equal(report.bytes, 4)
  assert.equal(report.limitsSatisfied, true)
  await assert.rejects(readExecutionArtifact({ ...request, reference: first.reference }))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: second.reference }), Buffer.from('bbbb'))
})

test('cleanup applies a lowered per-artifact bound without expiring fresh smaller artifacts', async t => {
  const request = await repository(t)
  const large = await retain(request, Buffer.from('aaaa'), { now: 10000 })
  const small = await retain(request, Buffer.from('bb'), { now: 10000 })
  const anchor = await retain(request, Buffer.alloc(0), { now: 10000 })
  const report = await pruneExecutionArtifacts({ ...request, retention: { ...retention, maxArtifactBytes: 3 }, liveReferences: [anchor.reference], now: 10000 })
  assert.deepEqual(report.removed, [{ name: path.basename(artifactFile(request, large.reference)), bytes: 4 }])
  assert.equal(report.bytes, 2)
  await assert.rejects(readExecutionArtifact({ ...request, reference: large.reference }))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: small.reference }), Buffer.from('bb'))
})

test('separate checkouts discover and share canonical common Git artifact storage', async t => {
  const request = await repository(t), root = path.dirname(request.common), checkout = path.join(root, 'checkout')
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline'], root)
  git(['worktree', 'add', '--detach', checkout, 'HEAD'], root)
  const other = { ...request, common: discover(checkout).common }
  const result = await retain(other, Buffer.from('shared'))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: result.reference }), Buffer.from('shared'))
  const alias = path.join(root, 'common-alias')
  await symlink(request.common, alias)
  let repeated
  await assert.doesNotReject(async () => { repeated = await retain({ ...request, common: alias }, Buffer.from('shared')) })
  assert.deepEqual(repeated.reference, result.reference)
  assert.equal((await readdir(directory(request))).length, 1)
})

test('exclusive publication refuses a competing identity without overwriting it', async t => {
  // Longer than any lock pid file, so only the artifact temporary's sync matches its size.
  const request = await repository(t), bytes = Buffer.from('new artifact body')
  await retain(request, Buffer.from('existing'))
  const expected = { version: 1, runId: request.runId, kind: 'stdout', sha256: hash(bytes), byteLength: bytes.length }
  const handle = await open(path.join(request.common, 'sync-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync
  await handle.close()
  const mocked = t.mock.method(prototype, 'sync', async function () {
    const info = await this.stat()
    if (info.isFile() && info.size === bytes.length) await writeFile(artifactFile(request, expected), 'conflict', { flag: 'wx', mode: 0o600 })
    return originalSync.call(this)
  })
  await assert.rejects(retain(request, bytes), { code: 'EEXIST' })
  mocked.mock.restore()
  assert.deepEqual(await readFile(artifactFile(request, expected)), Buffer.from('conflict'))
  assert.equal((await readdir(directory(request))).length, 2)
})

test('directory sync failure rejects retention and unsupported sync is reported explicitly', async t => {
  const request = await repository(t)
  const handle = await open(path.join(request.common, 'sync-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync
  await handle.close()
  const mocked = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) throw new Error('injected directory sync failure')
    return originalSync.call(this)
  })
  await assert.rejects(retain(request, Buffer.from('x')), /injected directory sync failure/)
  mocked.mock.restore()
  const unsupported = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) throw Object.assign(new Error('unsupported sync'), { code: 'EINVAL' })
    return originalSync.call(this)
  })
  const result = await retain(request, Buffer.from('x'))
  assert.equal(result.durability.directorySynced, false)
  assert.equal(result.durability.powerLossGuaranteed, false)
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: result.reference }), Buffer.from('x'))
  unsupported.mock.restore()
})

test('bounds storage entry counts before cleanup or further retention', async t => {
  const request = await repository(t)
  await retain(request, Buffer.alloc(0))
  for (let base = 0; base < 4096; base += 64) {
    await Promise.all(Array.from({ length: 64 }, (_, offset) => writeFile(path.join(directory(request), (base + offset).toString(16).padStart(64, '0') + '.bin'), '', { mode: 0o600, flag: 'wx' })))
  }
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [] }), /count bound/)
  await assert.rejects(retain(request, Buffer.from('x')), /count bound/)
  assert.equal((await readdir(directory(request))).length, 4097)
})

// A pid that named a real process which has already exited and been reaped.
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 })
  assert.equal(result.status, 0)
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' })
  return result.pid
}
async function plantLock(dir, pid) {
  await mkdir(path.join(dir, '.lock'), { mode: 0o700 })
  await writeFile(path.join(dir, '.lock', 'pid'), `${pid}\n`, { mode: 0o600 })
}
async function plantTemporary(dir, ageMs) {
  const name = '.' + randomUUID() + '.tmp', file = path.join(dir, name), at = (Date.now() - ageMs) / 1000
  await writeFile(file, 'partial', { mode: 0o600 })
  await utimes(file, at, at)
  return name
}

test('artifacts older than maxAgeMs never block a later retain, while new content that alone exceeds a bound still refuses', async t => {
  const request = await repository(t)
  const old = await retain(request, Buffer.from('old'), { now: 10000 })
  const later = await retain(request, Buffer.from('later'), { now: 20000 })
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: old.reference }), Buffer.from('old'))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: later.reference }), Buffer.from('later'))
  await assert.rejects(retain(request, Buffer.alloc(65), { now: 20000 }), /artifact byte bound/i)
  await assert.rejects(retain({ ...request, retention: { maxArtifactBytes: 64, maxRunBytes: 10, maxAgeMs: 1000 } }, Buffer.alloc(11), { now: 20000 }), /run byte bound/i)
  await retain({ ...request, retention: { maxArtifactBytes: 64, maxRunBytes: 10, maxAgeMs: 1000 } }, Buffer.alloc(10), { now: 20000 })
})

test('prune removes only content outside the live references and reports what it removed and kept', async t => {
  const request = await repository(t)
  const live = await retain(request, Buffer.from('live'), { now: 10000 })
  const dead = await retain(request, Buffer.from('dead'), { now: 10000 })
  const fresh = await retain(request, Buffer.from('fresh'), { now: 11500 })
  const name = reference => path.basename(artifactFile(request, reference))
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [live.reference], now: 12000 })
  assert.deepEqual(report.removed, [{ name: name(dead.reference), bytes: 4 }])
  assert.deepEqual(report.kept, [{ name: name(live.reference), bytes: 4, live: true }, { name: name(fresh.reference), bytes: 5, live: false }])
  assert.equal(report.bytes, 9)
  assert.deepEqual(report.reconciled, [])
  assert.deepEqual((await readdir(directory(request))).sort(), [name(live.reference), name(fresh.reference)].sort())
})

test('a dead-pid lock and a stale temporary file are reconciled by the next retain and reported', async t => {
  const request = await repository(t)
  const first = await retain(request, Buffer.from('first'))
  assert.deepEqual(first.reconciled, [])
  const dir = directory(request), stale = await plantTemporary(dir, 61000)
  await plantLock(dir, deadPid())
  const second = await retain(request, Buffer.from('second'))
  assert.deepEqual(second.reconciled, [{ path: '.lock', reason: 'dead-lock-holder' }, { path: stale, reason: 'stale-temporary' }])
  assert.ok(!JSON.stringify(second).includes(request.common))
  const names = [first, second].map(result => path.basename(artifactFile(request, result.reference)))
  assert.deepEqual((await readdir(dir)).sort(), names.sort())
  const young = await plantTemporary(dir, 59000)
  await assert.rejects(retain(request, Buffer.from('third')), /incomplete/i)
  await assert.rejects(pruneExecutionArtifacts({ ...request, liveReferences: [] }), /incomplete/i)
  assert.ok((await readdir(dir)).includes(young))
})

test('a lock held by a live process is waited on with bounded backoff, then refused as busy', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const dir = directory(request)
  await plantLock(dir, process.pid)
  let started = Date.now()
  await assert.rejects(retain(request, Buffer.from('second')), /busy/)
  const waited = Date.now() - started
  assert.ok(waited >= 4500 && waited <= 6500, `waited ${waited} ms`)
  assert.equal(await readFile(path.join(dir, '.lock', 'pid'), 'utf8'), `${process.pid}\n`)
  started = Date.now()
  const release = new Promise(resolve => setTimeout(resolve, 300)).then(() => rm(path.join(dir, '.lock'), { recursive: true }))
  const result = await retain(request, Buffer.from('second'))
  await release
  assert.ok(Date.now() - started >= 250)
  assert.deepEqual(result.reconciled, [])
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: result.reference }), Buffer.from('second'))
})

test('RETENTION_LIMITS is the exported upper bound: each limit is accepted and one past it is refused', async t => {
  assert.ok(Object.isFrozen(RETENTION_LIMITS))
  assert.deepEqual({ ...RETENTION_LIMITS }, { maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 24 * 60 * 60 * 1000 })
  const request = await repository(t)
  await retain({ ...request, retention: { ...RETENTION_LIMITS } }, Buffer.from('x'))
  for (const key of Object.keys(RETENTION_LIMITS)) {
    await assert.rejects(retain({ ...request, retention: { ...RETENTION_LIMITS, [key]: RETENTION_LIMITS[key] + 1 } }, Buffer.from('x')), /retention/)
  }
})

test('reclaiming a dead lock keeps mutual exclusion across processes and leaves nothing behind', { timeout: 240000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const base = await mkdtemp(path.join(tmpdir(), 'lock-stress-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const children = new Set()
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const module = new URL('../scripts/execution-artifacts.mjs', import.meta.url).href
  const totals = { ok: 0, overlap: 0, errors: [], leftovers: [] }
  for (let trial = 0; trial < 20; trial++) {
    const dir = path.join(base, 'trial-' + trial)
    await mkdir(dir, { mode: 0o700 })
    await plantLock(dir, deadPid())
    const source = `import { withStorageLock } from ${JSON.stringify(module)}
import { open, unlink } from 'node:fs/promises'
const dir = ${JSON.stringify(dir)}, sentinel = dir + '/inside', out = { ok: 0, overlap: 0, errors: [] }
await Promise.all(Array.from({ length: 4 }, async () => {
  try {
    await withStorageLock(dir, 'busy', async () => {
      let handle
      try { handle = await open(sentinel, 'wx') } catch (error) { if (error.code === 'EEXIST') { out.overlap++; return } throw error }
      await handle.close(); await new Promise(resolve => setTimeout(resolve, 3)); await unlink(sentinel)
    })
    out.ok++
  } catch (error) { out.errors.push(error.code ?? error.message) }
}))
process.stdout.write(JSON.stringify(out))`
    const runs = Array.from({ length: 6 }, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const [code] = await once(child, 'exit')
      children.delete(child)
      assert.equal(code, 0, stderr)
      return JSON.parse(stdout)
    })
    for (const result of await Promise.all(runs)) {
      totals.ok += result.ok; totals.overlap += result.overlap; totals.errors.push(...result.errors)
    }
    totals.leftovers.push(...(await readdir(dir)).filter(name => name.startsWith('.lock')))
  }
  assert.deepEqual(totals, { ok: 20 * 6 * 4, overlap: 0, errors: [], leftovers: [] })
})

test('prune with an empty live set removes every stored artifact as non-live', async t => {
  const request = await repository(t)
  const names = []
  for (const body of ['one', 'two', 'three']) names.push(path.basename(artifactFile(request, (await retain(request, Buffer.from(body), { now: 10000 })).reference)))
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [], now: 10000 })
  assert.deepEqual(report.removed.map(entry => entry.name).sort(), names.sort())
  assert.deepEqual(report.kept, [])
  assert.equal(report.bytes, 0)
  assert.deepEqual(await readdir(directory(request)), [])
})

test('prune makes room under the count bound by evicting non-live content, so the next retain is not refused', { timeout: 60000 }, async t => {
  const request = await repository(t), live = await retain(request, Buffer.from('live'), { now: 10000 })
  for (let base = 0; base < 4095; base += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 4095 - base) }, (_, offset) => writeFile(path.join(directory(request), (base + offset).toString(16).padStart(64, '0') + '.bin'), 'planted', { mode: 0o600, flag: 'wx' })))
  }
  await assert.rejects(retain(request, Buffer.from('new')), /count bound/)
  const report = await pruneExecutionArtifacts({ ...request, retention: { ...retention, maxRunBytes: 1024 * 1024, maxAgeMs: 86400000 }, liveReferences: [live.reference] })
  assert.equal(report.removed.length, 1)
  assert.equal(report.kept.length, 4095)
  assert.ok(report.kept.some(entry => entry.live))
  assert.equal(report.retentionExceeded.count, false)
  await retain(request, Buffer.from('new'))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: live.reference }), Buffer.from('live'))
})

test('a pid-less lock older than 60 s is reconciled by the next retain', async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const lock = path.join(directory(request), '.lock'), at = (Date.now() - 61000) / 1000
  await mkdir(lock, { mode: 0o700 }); await utimes(lock, at, at)
  const result = await retain(request, Buffer.from('second'))
  assert.deepEqual(result.reconciled, [{ path: '.lock', reason: 'abandoned-lock-without-pid' }])
  await assert.rejects(lstat(lock), { code: 'ENOENT' })
})

test('leftover lock entries of a dead process are reconciled, and a live process keeps its own', async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const dir = directory(request), dead = deadPid()
  const removing = `.lock.${dead}.${randomUUID()}.stale`, creating = `.lock.${dead}.${randomUUID()}.new`, owned = `.lock.${process.pid}.${randomUUID()}.stale`
  for (const name of [removing, creating, owned]) {
    await mkdir(path.join(dir, name), { mode: 0o700 })
    await writeFile(path.join(dir, name, 'pid'), `${dead}\n`, { mode: 0o600 })
  }
  const result = await retain(request, Buffer.from('second'))
  assert.deepEqual(result.reconciled.sort((a, b) => a.path.localeCompare(b.path)),
    [{ path: removing, reason: 'interrupted-lock-removal' }, { path: creating, reason: 'interrupted-lock-creation' }].sort((a, b) => a.path.localeCompare(b.path)))
  const left = await readdir(dir)
  assert.ok(left.includes(owned))
  assert.ok(!left.includes(removing) && !left.includes(creating))
  await pruneExecutionArtifacts({ ...request, liveReferences: [result.reference] })
})

test('a waiter polls at least every 250 ms, so it acquires soon after a late release', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const dir = directory(request)
  await plantLock(dir, process.pid)
  const started = Date.now()
  // Polls with a 250 ms ceiling fall near 3060 and 3310 ms; with a 500 ms ceiling near 3130 and 3630 ms.
  const release = new Promise(resolve => setTimeout(resolve, 3200)).then(() => rm(path.join(dir, '.lock'), { recursive: true }))
  await retain(request, Buffer.from('second'))
  const waited = Date.now() - started
  await release
  assert.ok(waited >= 3200 && waited <= 3560, `waited ${waited} ms`)
})

test('a dead lock whose reclaim token names a dead reclaimer is still reclaimed, but a live reclaimer is waited on', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const dir = directory(request), dead = deadPid(), lock = path.join(dir, '.lock')
  await plantLock(dir, dead)
  await writeFile(path.join(lock, `reclaim.${dead}`), `${deadPid()}\n`, { mode: 0o600 })
  const reclaimed = await retain(request, Buffer.from('second'))
  assert.deepEqual(reclaimed.reconciled, [{ path: '.lock', reason: 'dead-lock-holder' }])
  await plantLock(dir, dead)
  await writeFile(path.join(lock, `reclaim.${dead}`), `${process.pid}\n`, { mode: 0o600 })
  await assert.rejects(retain(request, Buffer.from('third')), /busy/)
  assert.equal(await readFile(path.join(lock, 'pid'), 'utf8'), `${dead}\n`)
})

// Plants a dead-holder lock whose reclaim token chain is `length` links long, every link owned by a dead pid.
async function plantReclaimChain(dir, length) {
  const dead = deadPid(), lock = path.join(dir, '.lock')
  await plantLock(dir, dead)
  let name = `reclaim.${dead}`
  for (let step = 0; step < length; step++) {
    const owner = deadPid()
    await writeFile(path.join(lock, name), `${owner}\n`, { mode: 0o600 })
    name += '.' + owner
  }
  return lock
}
for (const length of [8, 20]) {
  test(`a dead lock carrying a chain of ${length} dead reclaim tokens is reclaimed by the next retain`, { timeout: 30000 }, async t => {
    const request = await repository(t)
    await retain(request, Buffer.from('first'))
    const lock = await plantReclaimChain(directory(request), length)
    const started = Date.now()
    const result = await retain(request, Buffer.from('second'))
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`)
    assert.deepEqual(result.reconciled, [{ path: '.lock', reason: 'dead-lock-holder' }])
    await assert.rejects(lstat(lock), { code: 'ENOENT' })
  })
}

test('a dead lock directory over the entry cap is refused at once with an error naming the lock', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const lock = await plantReclaimChain(directory(request), 0)
  for (let entry = 0; entry < 100; entry++) await writeFile(path.join(lock, `junk.${entry}`), '', { mode: 0o600 })
  const started = Date.now()
  await assert.rejects(retain(request, Buffer.from('second')), error => error.message.includes(lock) && !/busy/.test(error.message))
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`)
  assert.ok((await lstat(lock)).isDirectory())
})

test('every pid file and reclaim token written through a handle is synced through it', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  await plantReclaimChain(directory(request), 2)
  const handle = await open(path.join(request.common, 'sync-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync, originalWrite = prototype.writeFile
  await handle.close()
  // Handle of each pid-sized file written during the retain -> whether it was synced after the write.
  // Keyed by handle, not inode: ext4 hands a removed temporary's inode to the next file.
  const size = `${process.pid}\n`.length, written = new Map()
  t.mock.method(prototype, 'writeFile', async function (...args) {
    const out = await originalWrite.apply(this, args), info = await this.stat()
    if (info.isFile() && info.size === size) written.set(this, false)
    return out
  })
  t.mock.method(prototype, 'sync', async function () {
    const out = await originalSync.call(this)
    if (written.has(this)) written.set(this, true)
    return out
  })
  const result = await retain(request, Buffer.from('a body longer than any pid file'))
  t.mock.restoreAll()
  assert.deepEqual(result.reconciled, [{ path: '.lock', reason: 'dead-lock-holder' }])
  // The staging pid of the refused first attempt, one temporary per reclaim token claim (three for a
  // chain of two) and the staging pid of the winning attempt.
  assert.ok(written.size >= 5, `saw ${written.size} pid files`)
  assert.deepEqual([...written.values()].filter(value => !value), [])
})

test('a lock directory swapped for a new one between the holder read and the reclaim is left in place', { timeout: 30000 }, async t => {
  const request = await repository(t)
  await retain(request, Buffer.from('first'))
  const dir = directory(request), lock = path.join(dir, '.lock'), dead = deadPid(), aside = path.join(request.common, 'old-lock')
  await plantLock(dir, dead)
  const { renameSync, mkdirSync, writeFileSync, existsSync, lstatSync } = await import('node:fs')
  const original = lstatSync(lock).ino, originalKill = process.kill
  let fresh = null
  t.mock.method(process, 'kill', function (pid, signal) {
    if (pid !== dead || signal !== 0) return originalKill.call(process, pid, signal)
    if (fresh === null) {
      // First liveness check of the original holder: replace the directory, same dead pid, new inode.
      renameSync(lock, aside)
      mkdirSync(lock, { mode: 0o700 }); writeFileSync(path.join(lock, 'pid'), `${dead}\n`, { mode: 0o600 })
      fresh = lstatSync(lock).ino
    } else if (!existsSync(path.join(lock, `reclaim.${dead}`))) return true // later holder checks: treat it as live so the run stops
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  })
  await assert.rejects(retain(request, Buffer.from('second')), /busy/)
  t.mock.restoreAll()
  assert.ok(fresh !== null && fresh !== original)
  assert.equal((await lstat(lock)).ino, fresh)
  assert.equal(await readFile(path.join(lock, 'pid'), 'utf8'), `${dead}\n`)
  assert.deepEqual(await readdir(lock), ['pid'])
})
