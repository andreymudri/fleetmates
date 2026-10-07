const ROLES = ['implementer', 'reviewer', 'integrator']
const FIELDS = ['read', 'write', 'execute', 'network', 'sharedRefs', 'publication']

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

function object(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has an unknown key`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain enumerable data properties`)
    }
  }
  if (required.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${label} is missing required keys`)
}

export function validateRolePolicy(value) {
  object(value, ['version', 'roles'], ['version', 'roles'], 'role policy')
  if (value.version !== 1) throw new TypeError('role policy version must be 1')
  object(value.roles, ROLES, [], 'role policy roles')
  if (Object.keys(value.roles).length === 0) throw new TypeError('role policy requires declared roles')
  const roles = {}
  for (const role of Object.keys(value.roles)) {
    const entry = value.roles[role]
    object(entry, FIELDS, FIELDS, 'role policy capabilities')
    if (FIELDS.some(key => typeof entry[key] !== 'boolean')) throw new TypeError('role policy capabilities must be boolean')
    if (role === 'reviewer' && (entry.write || entry.sharedRefs || entry.publication)) {
      throw new TypeError('role policy reviewer cannot request write, sharedRefs or publication')
    }
    roles[role] = Object.fromEntries(FIELDS.map(key => [key, entry[key]]))
  }
  return freeze({ version: 1, roles })
}

export function resolveRoleCapabilities(input) {
  let requested = null
  const result = (blocked, enforcement = null) => freeze({ version: 1,
    ready: blocked.length === 0, blocked, requested, enforcement })
  try {
    object(input, ['policy', 'role', 'harness', 'sandboxMode', 'network', 'mode'], [], 'role request')
    if (input.mode !== undefined && input.mode !== 'host-bounded') return result(['unsupported integration mode'])
    if (input.mode === 'host-bounded') {
      if (input.policy === undefined) return result(['host-bounded integration requires explicit authority'])
      const policy = validateRolePolicy(input.policy)
      requested = policy.roles.integrator ?? null
      if (input.role !== 'integrator' || input.harness !== 'host' || input.network !== false
        || input.sandboxMode !== undefined || !requested
        || FIELDS.some(key => requested[key] !== !['network', 'publication'].includes(key))) {
        return result(['unsupported host-bounded integration authority'])
      }
      return result([], { kind: 'required', mode: 'host-bounded', harness: 'host', ...requested,
        trust: 'Trusted local host Git operations; no hostile same-UID isolation or model execution authority.' })
    }
    if (input.policy === undefined) return result([], { kind: 'legacy', verified: false })
    const policy = validateRolePolicy(input.policy)
    const { role, harness, sandboxMode, network } = input
    if (!ROLES.includes(role)) return result(['unknown role'])
    if (!Object.hasOwn(policy.roles, role)) return result(['role is not declared in policy'])
    requested = policy.roles[role]
    if (typeof network !== 'boolean') return result(['host network must be boolean'])
    if (!['codex', 'cursor'].includes(harness)) return result(['unsupported harness enforcement'])
    if (!['clone', 'files'].includes(sandboxMode) || (harness === 'cursor' && sandboxMode !== 'files')) {
      return result(['unsupported sandbox enforcement for required role policy'])
    }
    const blocked = []
    if (!requested.read) blocked.push('adapter cannot enforce read=false')
    if (requested.network && !network) blocked.push('host has not approved requested network access')
    for (const key of ['sharedRefs', 'publication']) {
      if (requested[key]) blocked.push(`adapter cannot enforce required ${key} authority in an isolated sandbox`)
    }
    if (harness === 'codex') {
      if (!requested.execute) blocked.push('Codex cannot enforce execute=false')
      if (!requested.write && requested.network) blocked.push('Codex read-only network enforcement is unsupported')
    } else {
      if (!requested.write && requested.execute) blocked.push('Cursor plan/ask cannot enforce required execute capability')
      if (requested.write && !requested.execute) blocked.push('Cursor workspace sandbox cannot enforce execute=false')
    }
    if (blocked.length) return result(blocked)
    return result([], { kind: 'required', harness, sandboxMode,
      sandbox: harness === 'codex' ? (requested.write ? 'workspace-write' : 'read-only') : 'enabled',
      mode: harness === 'cursor' && !requested.write ? 'ask' : null,
      addWritableRoots: harness === 'codex' && requested.write && sandboxMode === 'clone',
      ...requested, network: requested.network && network })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return result([error.message])
  }
}
