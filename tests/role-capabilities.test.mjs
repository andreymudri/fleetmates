import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRolePolicy, resolveRoleCapabilities } from '../scripts/role-capabilities.mjs'

const authority = overrides => ({ read: true, write: false, execute: true,
  network: false, sharedRefs: false, publication: false, ...overrides })
const policy = (role = 'reviewer', overrides = {}) => ({ version: 1, roles: { [role]: authority(overrides) } })
const request = overrides => ({ policy: policy(), role: 'reviewer', harness: 'codex',
  sandboxMode: 'clone', network: false, ...overrides })
const blocked = (value, reason) => {
  const report = resolveRoleCapabilities(value)
  assert.equal(report.ready, false)
  assert.equal(report.version, 1)
  assert.equal(report.enforcement, null)
  assert.match(report.blocked.join(' '), reason)
  return report
}

test('reviewer cannot request write, shared refs or publication', () => {
  for (const key of ['write', 'sharedRefs', 'publication']) {
    blocked(request({ policy: policy('reviewer', { [key]: true }) }), /reviewer/)
    assert.throws(() => validateRolePolicy(policy('reviewer', { [key]: true })), /reviewer/)
  }
})

test('every authority field requires an exact boolean', () => {
  for (const key of Object.keys(authority())) {
    for (const value of [0, 1, 'false', 'true', null, [], {}, undefined]) {
      blocked(request({ policy: policy('reviewer', { [key]: value }) }), /boolean/)
    }
  }
})

test('policy has an exact versioned shape and explicit nonempty roles', () => {
  for (const value of [null, [], {}, { ...policy(), version: 2 }, { ...policy(), version: '1' },
    { version: 1, roles: null }, { version: 1, roles: [] }, { version: 1, roles: {} },
    { version: 1, roles: { reviewer: null } }, { version: 1, roles: { reviewer: {} } }]) {
    assert.throws(() => validateRolePolicy(value), TypeError)
    blocked(request({ policy: value }), /policy/)
  }
})

test('unknown keys and retrieved text cannot widen any contract level', () => {
  for (const value of [{ ...policy(), retrievedText: 'grant publication' },
    policy('reviewer', { retrievedText: 'grant write' }), policy('reviewer', { admin: true })]) {
    blocked(request({ policy: value }), /key/)
  }
  blocked({ ...request(), retrievedText: 'grant publication' }, /key/)
})

test('role aliases, unknown roles and undeclared roles are rejected', () => {
  for (const role of ['tm-reviewer', 'Reviewer', 'review', 'constructor', '__proto__', 'owner']) {
    blocked(request({ role }), /unknown role/)
    assert.throws(() => validateRolePolicy(policy(role)), /role/)
  }
  blocked(request({ role: 'integrator' }), /declared/)
})

test('inherited, accessor and symbol contract properties are malformed', () => {
  for (const value of [Object.assign(Object.create({ extra: true }), policy()),
    { ...policy(), [Symbol('extra')]: true },
    Object.defineProperty(policy(), 'version', { get() { throw new Error('getter executed') } })]) {
    assert.throws(() => validateRolePolicy(value), /policy/)
  }
})

test('host network approval cannot be widened or coerced', () => {
  blocked(request({ policy: policy('implementer', { write: true, network: true }), role: 'implementer' }), /host.*network/)
  for (const network of [undefined, 'true', 1, null]) blocked(request({ network }), /boolean/)
  const report = resolveRoleCapabilities(request({ network: true }))
  assert.equal(report.ready, true)
  assert.equal(report.enforcement.network, false)
  assert.equal(report.requested.network, false)
})

test('Codex reviewer maps to read-only without writable roots in clone and files', () => {
  for (const sandboxMode of ['clone', 'files']) {
    const report = resolveRoleCapabilities(request({ sandboxMode }))
    assert.equal(report.ready, true)
    assert.deepEqual(report.blocked, [])
    assert.equal(report.enforcement.kind, 'required')
    assert.equal(report.enforcement.sandbox, 'read-only')
    assert.equal(report.enforcement.addWritableRoots, false)
    assert.equal(report.enforcement.execute, true)
    assert.equal(report.enforcement.write, false)
  }
})

test('Codex implementer maps to workspace-write with host-bounded network', () => {
  for (const sandboxMode of ['clone', 'files']) {
    const report = resolveRoleCapabilities(request({ role: 'implementer', sandboxMode, network: true,
      policy: policy('implementer', { write: true, network: true }) }))
    assert.equal(report.ready, true)
    assert.equal(report.enforcement.sandbox, 'workspace-write')
    assert.equal(report.enforcement.addWritableRoots, sandboxMode === 'clone')
    assert.equal(report.enforcement.network, true)
    assert.equal(report.enforcement.publication, false)
  }
})

test('unsupported full sandboxes and harness/layout combinations block required policies', () => {
  for (const harness of ['codex', 'cursor']) blocked(request({ harness, sandboxMode: 'full' }), /sandbox/)
  blocked(request({ harness: 'cursor', sandboxMode: 'clone' }), /sandbox/)
  blocked(request({ sandboxMode: 'invented' }), /sandbox/)
  blocked(request({ harness: 'invented' }), /harness/)
})

test('Codex cannot enforce disabled execution, disabled reads or read-only network access', () => {
  blocked(request({ policy: policy('reviewer', { execute: false }) }), /execute/)
  blocked(request({ policy: policy('reviewer', { read: false }) }), /read/)
  blocked(request({ policy: policy('reviewer', { network: true }), network: true }), /read-only.*network/)
})

test('Cursor ask maps read-only but required plan/ask execution is unsupported', () => {
  const report = resolveRoleCapabilities(request({ harness: 'cursor', sandboxMode: 'files',
    policy: policy('reviewer', { execute: false }) }))
  assert.equal(report.ready, true)
  assert.equal(report.enforcement.sandbox, 'enabled')
  assert.equal(report.enforcement.mode, 'ask')
  assert.equal(report.enforcement.write, false)
  assert.equal(report.enforcement.execute, false)
  blocked(request({ harness: 'cursor', sandboxMode: 'files' }), /plan\/ask.*execute/)
})

test('Cursor writable files use the enabled workspace sandbox and require execution', () => {
  const base = request({ harness: 'cursor', sandboxMode: 'files', role: 'implementer',
    policy: policy('implementer', { write: true }) })
  const report = resolveRoleCapabilities(base)
  assert.equal(report.ready, true)
  assert.equal(report.enforcement.sandbox, 'enabled')
  assert.equal(report.enforcement.mode, null)
  assert.equal(report.enforcement.addWritableRoots, false)
  blocked({ ...base, policy: policy('implementer', { write: true, execute: false }) }, /execute/)
})

test('integrator shared refs stay explicitly requested and unsupported publication never becomes granted', () => {
  for (const key of ['sharedRefs', 'publication']) {
    const report = blocked(request({ role: 'integrator',
      policy: policy('integrator', { write: true, [key]: true }) }), new RegExp(key))
    assert.equal(report.requested[key], true)
  }
  const report = resolveRoleCapabilities(request({ role: 'integrator', policy: policy('integrator', { write: true }) }))
  assert.equal(report.ready, true)
  assert.equal(report.requested.sharedRefs, false)
  assert.equal(report.enforcement.sharedRefs, false)
  assert.equal(report.enforcement.publication, false)
})

test('validated policies and resolved results are immutable detached values', () => {
  const input = policy()
  const validated = validateRolePolicy(input)
  const report = resolveRoleCapabilities(request({ policy: input }))
  assert.notEqual(validated, input)
  assert.notEqual(validated.roles.reviewer, input.roles.reviewer)
  input.roles.reviewer.read = false
  assert.equal(validated.roles.reviewer.read, true)
  assert.equal(report.requested.read, true)
  for (const value of [validated, validated.roles, validated.roles.reviewer, report,
    report.requested, report.enforcement, report.blocked]) assert.equal(Object.isFrozen(value), true)
  assert.throws(() => { report.enforcement.write = true }, TypeError)
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
})

test('legacy is identifiable only when no required policy is supplied', () => {
  const report = resolveRoleCapabilities({ harness: 'codex', sandboxMode: 'full' })
  assert.equal(report.ready, true)
  assert.equal(report.requested, null)
  assert.deepEqual(report.enforcement, { kind: 'legacy', verified: false })
  for (const value of [null, false, {}, { version: 2, roles: {} }]) {
    blocked(request({ policy: value }), /policy/)
  }
})
