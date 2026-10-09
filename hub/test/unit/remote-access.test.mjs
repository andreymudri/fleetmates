import { test } from 'node:test'
import { isWindows, posixTest } from '../helpers/platform.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { authorize, parsePublicOrigin, requestOrigin, securityHeaders } from '../../server/http/auth.mjs'
import { checkPassphrase, createRemoteAccess, hashPassphrase, readRemotePass, verifyPassphrase, writeRemotePass } from '../../server/http/remote-pass.mjs'
import { parseServerArgs } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

const origin = parsePublicOrigin('https://machine.tail1234.ts.net')
const request = (headers, method = 'GET') => ({ method, headers })

test('a public origin is one exact https origin, and anything else is refused at startup', () => {
  assert.deepEqual(origin, { origin: 'https://machine.tail1234.ts.net', host: 'machine.tail1234.ts.net', ws: 'wss://machine.tail1234.ts.net' })
  assert.equal(parsePublicOrigin('https://machine.tail1234.ts.net/').origin, 'https://machine.tail1234.ts.net')
  assert.equal(parsePublicOrigin('https://machine.tail1234.ts.net:8443').host, 'machine.tail1234.ts.net:8443')
  // The default port is not part of the origin a browser sends, so it must not be part of the one we compare to.
  assert.deepEqual(parsePublicOrigin('https://machine.tail1234.ts.net:443'), parsePublicOrigin('https://machine.tail1234.ts.net'))
  assert.equal(parsePublicOrigin('https://MACHINE.Tail1234.TS.NET').host, 'machine.tail1234.ts.net', 'a host is case insensitive')
  for (const value of [undefined, null, '']) assert.equal(parsePublicOrigin(value), null, `${value} keeps the deck loopback only`)
  for (const [value, reason] of [
    ['https://*.ts.net', /wildcard/],
    ['*', /wildcard/],
    ['https://*', /wildcard/],
    ['http://machine.tail1234.ts.net', /https/],
    ['ws://machine.tail1234.ts.net', /https/],
    ['machine.tail1234.ts.net', /https/],
    ['https://machine.tail1234.ts.net/deck', /path, query or fragment/],
    ['https://machine.tail1234.ts.net/?x=1', /path, query or fragment/],
    ['https://machine.tail1234.ts.net/#f', /path, query or fragment/],
    ['https://user:pw@machine.tail1234.ts.net', /credentials/],
    ['https://127.0.0.1:47800', /loopback/],
    ['https://localhost', /loopback/],
    [47800, /https/]
  ]) assert.throws(() => parsePublicOrigin(value), reason, String(value))
})

test('authorize accepts the loopback and the public pair, and never a mixed one', () => {
  const token = 'a'.repeat(43)
  const loopback = { host: '127.0.0.1:47800', origin: 'http://127.0.0.1:47800', authorization: `Bearer ${token}` }
  const tunnel = { host: origin.host, origin: origin.origin, authorization: `Bearer ${token}` }
  const options = { port: 47800, token, publicOrigin: origin }
  assert.equal(authorize(request(loopback), options), null)
  assert.equal(authorize(request(tunnel), options), null)
  assert.equal(authorize(request({ ...tunnel, origin: loopback.origin }), options).code, 'forbidden_origin', 'a tunnel Host with a loopback Origin')
  assert.equal(authorize(request({ ...loopback, origin: tunnel.origin }), options).code, 'forbidden_origin', 'a loopback Host with a tunnel Origin')
  assert.equal(authorize(request({ ...tunnel, host: 'other.ts.net' }), options).code, 'forbidden_host')
  assert.equal(authorize(request({ ...tunnel, origin: 'https://machine.tail1234.ts.net.evil.test' }), options).code, 'forbidden_origin')
  assert.equal(authorize(request({ ...tunnel, authorization: 'Bearer wrong' }), options).code, 'unauthorized')
  assert.equal(authorize(request({ ...tunnel, 'sec-fetch-site': 'cross-site' }), options).code, 'forbidden_origin')
  // Without the opt-in the public host is just another foreign host, and the loopback pair still passes.
  assert.equal(authorize(request(tunnel), { port: 47800, token }).code, 'forbidden_host')
  assert.equal(authorize(request(loopback), { port: 47800, token }), null)
  assert.equal(authorize(request({ ...loopback, host: 'localhost:47800' }), options).status, 421)
  assert.equal(requestOrigin(request(tunnel), 47800, origin), origin.origin)
  assert.equal(requestOrigin(request(loopback), 47800, origin), 'http://127.0.0.1:47800')
})

test('the public origin adds itself, its wss form and worker-src to the policy, and nothing without it', () => {
  const plain = securityHeaders(47800, false)['Content-Security-Policy']
  assert.match(plain, /connect-src 'self' ws:\/\/127\.0\.0\.1:47800;/)
  assert.doesNotMatch(plain, /worker-src/)
  assert.doesNotMatch(plain, /tail1234/)
  const opened = securityHeaders(47800, false, origin)['Content-Security-Policy']
  assert.match(opened, /connect-src 'self' ws:\/\/127\.0\.0\.1:47800 https:\/\/machine\.tail1234\.ts\.net wss:\/\/machine\.tail1234\.ts\.net;/)
  assert.match(opened, /worker-src 'self';/, 'the installed PWA registers a worker, so the policy names one')
  assert.equal(plain, opened.replace(" https://machine.tail1234.ts.net wss://machine.tail1234.ts.net", '').replace("worker-src 'self'; ", ''),
    'the opt-in changes the policy in those two places only')
  assert.equal(securityHeaders(47800, true, origin)['Cache-Control'], 'no-store')
})

test('the server entrypoint takes --public-origin and refuses anything else', () => {
  assert.deepEqual(parseServerArgs([]), {})
  assert.deepEqual(parseServerArgs(['--public-origin', 'https://machine.tail1234.ts.net']), { publicOrigin: 'https://machine.tail1234.ts.net' })
  for (const argv of [['--public-origin'], ['--open'], ['https://machine.tail1234.ts.net']]) assert.throws(() => parseServerArgs(argv), /usage/)
})

test('a passphrase is checked, stored as a scrypt hash, and compared against that hash', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  for (const value of ['', '   ', 'short', 'password', 'PASSWORD', 'let-me-in', 'fleetmates']) assert.throws(() => checkPassphrase(value), Error, value)
  assert.equal(checkPassphrase('correct horse battery'), 'correct horse battery')
  const record = await hashPassphrase('correct horse battery')
  assert.equal(record.v, 1)
  assert.equal(JSON.stringify(record).includes('correct horse'), false, 'the passphrase itself is never stored')
  assert.equal(await verifyPassphrase('correct horse battery', record), true)
  assert.equal(await verifyPassphrase('correct horse batterx', record), false)
  assert.equal(await verifyPassphrase('', record), false)
  // The same passphrase hashed again differs, so the salt is per installation.
  assert.notEqual((await hashPassphrase('correct horse battery')).hash, record.hash)
  const file = path.join(dir, 'remote-pass.json')
  writeRemotePass(file, record)
  assert.deepEqual(readRemotePass(file), { record })
  assert.deepEqual(readRemotePass(path.join(dir, 'nothing.json')), { missing: true }, 'a deck with no passphrase is not a deck with a broken one')
  fs.writeFileSync(file, '{"v":2}', { mode: 0o600 })
  assert.equal(readRemotePass(file).bad, 'not a passphrase record')
  fs.writeFileSync(file, 'not json', { mode: 0o600 })
  assert.equal(readRemotePass(file).bad, 'not JSON')
})

posixTest('the record file is private, and only POSIX has a mode and an owner to check', { reason: 'file modes and uids; NTFS has neither' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const file = path.join(dir, 'remote-pass.json')
  const record = await hashPassphrase('correct horse battery')
  writeRemotePass(file, record)
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600)
  fs.chmodSync(file, 0o644)
  assert.match(readRemotePass(file).bad, /mode 0644/)
  // On win32 there is no mode to check: the owner's profile ACLs are what keep the file private.
  assert.deepEqual(readRemotePass(file, { platform: 'win32' }), { record })
  fs.chmodSync(file, 0o600)
  assert.equal(readRemotePass(file, { uid: process.getuid() + 1 }).bad.includes('not by this user'), true)
})

test('the exchange is unavailable without a passphrase file, and throttles wrong answers once there is one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const file = path.join(dir, 'remote-pass.json')
  let at = 1_000_000
  const slept = []
  const logged = []
  // A stand-in for the scrypt comparison, so the test counts what reaches it without paying for 128 MiB a time.
  const tried = []
  const compare = async (passphrase, record) => { tried.push(passphrase)
    return passphrase === 'correct horse battery' && record.v === 1 }
  const remote = createRemoteAccess({ file, now: () => at, maxAttempts: 3, windowMs: 1000, compare, log: line => logged.push(line), sleep: ms => { slept.push(ms)
    return Promise.resolve() } })
  assert.equal(remote.enabled(), false)
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: false, code: 'pairing_unavailable' })
  writeRemotePass(file, await hashPassphrase('correct horse battery'))
  assert.equal(remote.enabled(), true)
  // Too short to be the passphrase: refused before scrypt, and never counted, so free requests cannot fill the window.
  assert.deepEqual(await remote.verify(''), { ok: false, code: 'unauthorized' })
  assert.deepEqual(await remote.verify('short'), { ok: false, code: 'unauthorized' })
  assert.deepEqual(tried, [], 'neither reached the comparison')
  assert.deepEqual(await remote.verify('wrong one here'), { ok: false, code: 'unauthorized' })
  assert.deepEqual(await remote.verify('wrong two here'), { ok: false, code: 'unauthorized' })
  assert.deepEqual(slept, [250, 500], 'a wrong answer costs more each time')
  const full = await remote.verify('wrong three here')
  assert.equal(full.code, 'too_many_attempts')
  assert.equal(full.retryAfterMs, 1000, 'what is left of the window, for the Retry-After header')
  // The owner is never locked out by someone else's wrong guesses: a full window still verifies, and the right
  // passphrase gets through and clears the counter.
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: true })
  assert.deepEqual(await remote.verify('wrong once more'), { ok: false, code: 'unauthorized' })
  assert.equal(slept.at(-1), 250, 'the delay restarts after a success')
  at += 1001
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: true })
  // A file that exists but cannot be used reads as "no passphrase set", and says why once.
  fs.writeFileSync(file, '{"v":9}', { mode: 0o600 })
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: false, code: 'pairing_unavailable' })
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: false, code: 'pairing_unavailable' })
  assert.deepEqual(logged, ['remote_pass.rejected not a passphrase record'])
})

test('concurrent attempts are serialized and bounded: a burst cannot outrun the counter or flood scrypt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const file = path.join(dir, 'remote-pass.json')
  writeRemotePass(file, await hashPassphrase('correct horse battery'))
  let running = 0
  let peak = 0
  let reached = 0
  // A comparison that yields, as scrypt does: without the queue every caller would be inside it at once.
  const compare = async passphrase => {
    reached++
    peak = Math.max(peak, ++running)
    await new Promise(resolve => setImmediate(resolve))
    running--
    return passphrase === 'correct horse battery'
  }
  const remote = createRemoteAccess({ file, maxAttempts: 10, maxPending: 3, compare, sleep: () => Promise.resolve(), log: () => {} })
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => remote.verify(`wrong guess ${i}`)))
  assert.equal(peak, 1, 'one derivation at a time, or a peer queues a thousand 128 MiB jobs on the threadpool')
  assert.ok(reached <= 10, `at most maxAttempts reach the comparison, not ${reached}`)
  assert.equal(results.filter(result => result.code === 'too_many_attempts').length, 200 - reached, 'the rest are refused without work')
  assert.equal(results.filter(result => result.ok).length, 0)
  // And the owner still gets in right after the burst.
  assert.deepEqual(await remote.verify('correct horse battery'), { ok: true })
})

test('the CLI writes the public origin to config.json and the passphrase, read from stdin, to its own file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  // The paths the CLI derives from this environment, on whatever platform the suite runs.
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state') }
  const paths = setupPaths(env)
  const configFile = path.join(paths.config, 'config.json')
  const bin = fileURLToPath(new URL('../../bin/fleetmates-deck.mjs', import.meta.url))
  const run = (args, input = '') => spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8' })
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(configFile, '{"port":47801}\n', { mode: 0o600 })
  assert.equal(run(['remote-access', '--public-origin', 'https://machine.tail1234.ts.net/']).status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { port: 47801, publicOrigin: 'https://machine.tail1234.ts.net' }, 'the port beside it is kept')
  const wildcard = run(['remote-access', '--public-origin', 'https://*.ts.net'])
  assert.equal(wildcard.status, 1)
  assert.match(wildcard.stderr, /wildcard/)
  assert.equal(run(['remote-access', '--off']).status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { port: 47801 })
  // The passphrase comes from stdin only: it is never an argument, which `ps` and the shell history would show.
  assert.match(run(['remote-pass', 'correct horse battery']).stderr, /usage/)
  assert.equal(run(['remote-pass'], 'short\nshort\n').status, 1)
  assert.equal(run(['remote-pass'], 'correct horse battery\nanother one here\n').status, 1)
  const set = run(['remote-pass'], 'correct horse battery\ncorrect horse battery\n')
  assert.equal(set.status, 0, set.stderr)
  const file = path.join(paths.state, 'remote-pass.json')
  if (!isWindows) assert.equal(fs.lstatSync(file).mode & 0o777, 0o600)
  assert.equal(await verifyPassphrase('correct horse battery', readRemotePass(file).record), true)
  assert.equal(fs.readFileSync(file, 'utf8').includes('correct horse'), false)
})
