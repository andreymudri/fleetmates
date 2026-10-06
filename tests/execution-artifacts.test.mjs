import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, writeFile, stat, chmod, symlink, link, mkdir, open, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { discover, git } from '../scripts/workflow-lifecycle.mjs'
import { retainExecutionArtifact, readExecutionArtifact, pruneExecutionArtifacts } from '../scripts/execution-artifacts.mjs'

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
  await assert.rejects(retain(request, Buffer.from('xyz')), /run.*bound/i)
  await retain(request, Buffer.from('xy'))
  await assert.rejects(readExecutionArtifact({ ...request, retention: { ...request.retention, maxArtifactBytes: 3 }, reference }))
  await writeFile(artifactFile(request, reference), Buffer.alloc(5))
  await assert.rejects(readExecutionArtifact({ ...request, reference }), /artifact.*bound/i)
})

test('serializes competing writers instead of exceeding the total run bound', async t => {
  const request = { ...await repository(t), retention: { ...retention, maxRunBytes: 4 } }
  const results = await Promise.allSettled([retain(request, Buffer.from('aaaa')), retain(request, Buffer.from('bbbb'))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const result = results.find(result => result.status === 'fulfilled').value
  assert.equal((await readdir(directory(request))).length, 1)
  assert.equal((await readExecutionArtifact({ ...request, reference: result.reference })).length, 4)
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
  execFileSync('mkfifo', [file], { timeout: 1000 })
  await chmod(file, 0o600)
  const module = new URL('../scripts/execution-artifacts.mjs', import.meta.url).href
  const code = `import { readExecutionArtifact } from ${JSON.stringify(module)}; import assert from 'node:assert/strict'; await assert.rejects(readExecutionArtifact(${JSON.stringify({ ...request, reference })}), /regular/)`
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000 }).length, 0)
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
  const mocked = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) throw new Error('injected sync failure')
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
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [], now: 11001 })
  assert.equal(report.removed, 1)
  assert.equal(report.retained, 1)
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
  assert.equal(report.removed, 1)
  assert.equal(report.retained, 1)
  assert.equal(report.bytes, 4)
  assert.equal(report.limitsSatisfied, false)
  assert.deepEqual(report.retentionExceeded, { artifactBytes: true, runBytes: true, age: true })
  assert.deepEqual(report.unresolvedReferences, [live.reference])
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: live.reference }), Buffer.from('live'))
  await assert.rejects(retain(request, Buffer.from('new'), { now: 12000 }), /age.*bound/i)
})

test('cleanup returns missing and corrupt recovery references without deleting their evidence or exposing bodies', async t => {
  const request = await repository(t), corrupt = await retain(request, Buffer.from('secret'), { now: 10000 })
  const missing = await retain(request, Buffer.from('missing'), { now: 10000 })
  await writeFile(artifactFile(request, corrupt.reference), Buffer.from('broken'))
  await rm(artifactFile(request, missing.reference))
  const report = await pruneExecutionArtifacts({ ...request, liveReferences: [corrupt.reference, missing.reference], now: 12000 })
  assert.equal(report.removed, 0)
  assert.deepEqual(report.unresolvedReferences, [corrupt.reference, missing.reference])
  assert.deepEqual(await readFile(artifactFile(request, corrupt.reference)), Buffer.from('broken'))
  assert.ok(!JSON.stringify(report).includes('broken'))
  assert.ok(!JSON.stringify(report).includes(request.common))
  const absent = await pruneExecutionArtifacts({ ...request, runId: 'absent-run', liveReferences: [], now: 12000 })
  assert.equal(absent.retained, 0)
  const absentReference = { ...missing.reference, runId: 'absent-run' }
  const absentLive = await pruneExecutionArtifacts({ ...request, runId: 'absent-run', liveReferences: [absentReference], now: 12000 })
  assert.deepEqual(absentLive.unresolvedReferences, [absentReference])
})

test('cleanup evicts oldest unreferenced bytes to meet a lowered total budget', async t => {
  const request = await repository(t)
  const first = await retain(request, Buffer.from('aaaa'), { now: 10000 })
  const second = await retain(request, Buffer.from('bbbb'), { now: 10500 })
  const report = await pruneExecutionArtifacts({ ...request, retention: { ...retention, maxRunBytes: 4 }, liveReferences: [], now: 10500 })
  assert.equal(report.removed, 1)
  assert.equal(report.bytes, 4)
  assert.equal(report.limitsSatisfied, true)
  await assert.rejects(readExecutionArtifact({ ...request, reference: first.reference }))
  assert.deepEqual(await readExecutionArtifact({ ...request, reference: second.reference }), Buffer.from('bbbb'))
})

test('cleanup applies a lowered per-artifact bound without expiring fresh smaller artifacts', async t => {
  const request = await repository(t)
  const large = await retain(request, Buffer.from('aaaa'), { now: 10000 })
  const small = await retain(request, Buffer.from('bb'), { now: 10000 })
  const report = await pruneExecutionArtifacts({ ...request, retention: { ...retention, maxArtifactBytes: 3 }, liveReferences: [], now: 10000 })
  assert.equal(report.removed, 1)
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
  const request = await repository(t), bytes = Buffer.from('new')
  await retain(request, Buffer.from('existing'))
  const expected = { version: 1, runId: request.runId, kind: 'stdout', sha256: hash(bytes), byteLength: bytes.length }
  const handle = await open(path.join(request.common, 'sync-probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync
  await handle.close()
  const mocked = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) await writeFile(artifactFile(request, expected), 'conflict', { flag: 'wx', mode: 0o600 })
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
