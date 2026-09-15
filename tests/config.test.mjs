import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultMaxParallel, loadGateConfig } from '../scripts/gate-config.mjs'
import { TIERS } from '../scripts/routing.mjs'
import {
  GATE_FILE,
  LOCAL_FILE,
  CAVEMAN_LEVELS,
  EFFORTS,
  SANDBOXES,
  KNOWN_HARNESSES,
  ROLES,
  ENFORCEMENT_KEYS,
  ENFORCEMENT_VALIDATORS,
  ConfigError,
  validateLocal,
  validateGate,
  validateHarnesses,
  readLayer,
  writeLayer,
  loadConfig,
  getKey,
  setKey,
  unsetKey,
  validateKey,
  isEnforcementKey,
  assertSafeKey,
  ensureGitignored,
} from '../scripts/config.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-config-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const writeJson = (root, file, obj) =>
  writeFile(path.join(root, file), JSON.stringify(obj), 'utf8')

test('vocabulary constants name the two layers and their domains', () => {
  assert.equal(GATE_FILE, 'fleetmates.gate.json')
  assert.equal(LOCAL_FILE, 'fleetmates.local.json')
  assert.deepEqual(CAVEMAN_LEVELS, ['lite', 'full', 'ultra'])
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(ROLES, ['implementer', 'reviewer', 'integrator'])
  assert.deepEqual(ENFORCEMENT_KEYS, ['phases', 'lens', 'preview'])
})

test('loadConfig lets the local layer beat the gate manifest for maxParallel', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 4 })
    await writeJson(root, LOCAL_FILE, { maxParallel: 12 })
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, 12)
    assert.equal(sources.maxParallel, LOCAL_FILE)
  })
})

test('loadConfig lets the gate manifest beat the default for maxParallel', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 4 })
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, 4)
    assert.equal(sources.maxParallel, GATE_FILE)
  })
})

test('loadConfig falls back to the computed default with neither layer present', async () => {
  await withTempRoot(async (root) => {
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, defaultMaxParallel())
    assert.equal(sources.maxParallel, 'default')
    assert.equal(resolved.caveman, false)
    assert.equal(sources.caveman, 'default')
  })
})

test('loadConfig exposes the raw gate manifest alongside the resolved view', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 3, phases: { default: { checks: [] } } })
    const { gate } = await loadConfig(root)
    assert.deepEqual(gate.phases, { default: { checks: [] } })
  })
})

test('loadConfig merges agent entries per role and names the winning layer', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { tier: 'mid', effort: 'low' } } })
    await writeJson(root, LOCAL_FILE, { agents: { implementer: { tier: 'capable' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.implementer, { tier: 'capable', effort: 'low' })
    assert.equal(sources['agents.implementer.tier'], LOCAL_FILE)
    assert.equal(sources['agents.implementer.effort'], GATE_FILE)
    assert.deepEqual(resolved.agents.integrator, {})
    assert.equal(sources['agents.integrator.tier'], 'default')
    assert.equal(sources['agents.integrator.effort'], 'default')
  })
})

test('loadConfig reports the gate layer as the source of an agent entry it alone sets', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { effort: 'high' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.implementer, { effort: 'high' })
    assert.equal(sources['agents.implementer.effort'], GATE_FILE)
    assert.equal(sources['agents.implementer.tier'], 'default')
  })
})

test('loadConfig rejects an enforcement key in the local layer by name', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, LOCAL_FILE, { phases: { default: { checks: [] } } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && /phases/.test(err.message)
        && err.message.includes(GATE_FILE),
    )
  })
})

test('loadConfig surfaces a corrupt local layer as a ConfigError, not a SyntaxError', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, LOCAL_FILE), '{ not json', 'utf8')
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && err.message.includes(LOCAL_FILE),
    )
  })
})

test('loadConfig rejects a falsy non-object local layer rather than ignoring it', async () => {
  for (const body of ['false', '0', '""', 'null']) {
    await withTempRoot(async (root) => {
      await writeFile(path.join(root, LOCAL_FILE), body, 'utf8')
      await assert.rejects(
        () => loadConfig(root),
        (err) => err instanceof ConfigError && /must contain a JSON object/.test(err.message)
          && err.message.includes(LOCAL_FILE),
        `expected a local layer of ${body} to be rejected`,
      )
    })
  }
})

test('loadConfig still treats an absent local layer as absent, not as a bad one', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 7 })
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, 7)
    assert.equal(sources.maxParallel, GATE_FILE)
  })
})

// `validateGate` looks a validator up per enforcement key. The invariant that every key has one
// was pinned only by the `['phases', 'lens', 'preview']` literal above — a maintainer adding a
// fourth key updates that literal in the same edit, so the suite stayed green while a manifest
// carrying the new key crashed with `ENFORCEMENT_VALIDATORS[key] is not a function`. Derived
// from the two exports themselves, this cannot be satisfied by editing a list.
test('every enforcement key has a validator, and every validator an enforcement key', () => {
  assert.deepEqual(Object.keys(ENFORCEMENT_VALIDATORS).sort(), [...ENFORCEMENT_KEYS].sort())
  for (const key of ENFORCEMENT_KEYS) {
    assert.equal(typeof ENFORCEMENT_VALIDATORS[key], 'function', key)
  }
})

// And if one is ever missing anyway, the refusal is a ConfigError like every other config
// failure — not a TypeError escaping as a stack trace and exit 1, which a skill branching on
// exit 2 reads as neither a pass nor a stated failure. Reached by removing a real validator,
// because that is the only way into the branch from outside the module.
test('a missing validator for an enforcement key is a ConfigError, not a TypeError', () => {
  const saved = ENFORCEMENT_VALIDATORS.preview
  delete ENFORCEMENT_VALIDATORS.preview
  try {
    assert.throws(
      () => validateGate({ preview: { link: ['node_modules'] } }),
      (err) => {
        assert.ok(err instanceof ConfigError)
        assert.equal(err.message, 'no validator for enforcement key: preview')
        return true
      },
    )
    // The value is refused, never validated-by-absence: a key with no validator must not be
    // the one key that passes unchecked.
    assert.throws(() => validateGate({ preview: 'anything at all' }), ConfigError)
  } finally {
    ENFORCEMENT_VALIDATORS.preview = saved
  }
  // Restored, so the rest of the file sees the real validator.
  assert.throws(() => validateGate({ preview: [] }), ConfigError)
  assert.deepEqual(validateGate({ preview: { link: ['node_modules'] } }), { preview: { link: ['node_modules'] } })
})

test('validateLocal rejects every enforcement key by name', () => {
  for (const key of ENFORCEMENT_KEYS) {
    assert.throws(
      () => validateLocal({ [key]: {} }),
      (err) => err instanceof ConfigError && err.message.includes(key),
    )
  }
})

test('validateLocal rejects an unknown key by name rather than dropping it', () => {
  assert.throws(
    () => validateLocal({ fixRounds: 99 }),
    (err) => err instanceof ConfigError && err.message.includes('fixRounds'),
  )
})

test('validateLocal rejects a non-object local layer', () => {
  for (const bad of [null, [], 'text', 3, false, 0, '']) {
    assert.throws(
      () => validateLocal(bad),
      (err) => err instanceof ConfigError && /must contain a JSON object/.test(err.message)
        && err.message.includes(LOCAL_FILE),
      `expected ${JSON.stringify(bad)} to be rejected as a local layer`,
    )
  }
})

test('validateLocal accepts a well-formed local layer unchanged', () => {
  const local = { maxParallel: 6, caveman: 'full', agents: { implementer: { tier: 'mid' } } }
  assert.equal(validateLocal(local), local)
})

test('validateLocal rejects an unknown agent role and a bad agent field', () => {
  assert.throws(
    () => validateLocal({ agents: { nobody: { tier: 'mid' } } }),
    (err) => err instanceof ConfigError && err.message.includes('nobody'),
  )
  assert.throws(
    () => validateLocal({ agents: { implementer: { tier: 'nonsense' } } }),
    (err) => err instanceof ConfigError && /tier must be one of/.test(err.message),
  )
  assert.throws(
    () => validateLocal({ agents: { implementer: { effort: 'nonsense' } } }),
    (err) => err instanceof ConfigError && /effort must be one of/.test(err.message),
  )
  assert.throws(
    () => validateLocal({ agents: [] }),
    (err) => err instanceof ConfigError && /agents must be an object keyed by role/.test(err.message),
  )
})

test('maxParallel accepts an integer >= 1 and rejects everything else', () => {
  assert.equal(validateKey('maxParallel', 1), 1)
  assert.equal(validateKey('maxParallel', 12), 12)
  for (const bad of [0, -1, 1.5, '4', null, true]) {
    assert.throws(
      () => validateKey('maxParallel', bad),
      (err) => err instanceof ConfigError && err.message.includes('maxParallel'),
    )
  }
})

test('caveman accepts false and each level, and rejects anything else', () => {
  assert.equal(validateKey('caveman', false), false)
  for (const level of CAVEMAN_LEVELS) assert.equal(validateKey('caveman', level), level)
  for (const bad of [true, 'loud', '', null, 1]) {
    assert.throws(
      () => validateKey('caveman', bad),
      (err) => err instanceof ConfigError && err.message.includes('caveman'),
    )
  }
})

test('tier accepts each known tier and rejects an unknown one', () => {
  for (const tier of TIERS) assert.equal(validateKey('agents.reviewer.tier', tier), tier)
  assert.throws(
    () => validateKey('agents.reviewer.tier', 'nonsense'),
    (err) => err instanceof ConfigError && TIERS.every((t) => err.message.includes(t)),
  )
})

test('effort accepts each known effort and rejects an unknown one', () => {
  for (const effort of EFFORTS) assert.equal(validateKey('agents.implementer.effort', effort), effort)
  assert.throws(
    () => validateKey('agents.implementer.effort', 'turbo'),
    (err) => err instanceof ConfigError && EFFORTS.every((e) => err.message.includes(e)),
  )
})

test('validateKey rejects an unknown role and an unknown key', () => {
  assert.throws(
    () => validateKey('agents.nobody.tier', 'mid'),
    (err) => err instanceof ConfigError && err.message.includes('nobody'),
  )
  assert.throws(
    () => validateKey('nonsense', 1),
    (err) => err instanceof ConfigError && err.message.includes('nonsense'),
  )
})

test('isEnforcementKey matches an enforcement root, dotted or bare', () => {
  assert.equal(isEnforcementKey('phases'), true)
  assert.equal(isEnforcementKey('phases.default.fixRounds'), true)
  assert.equal(isEnforcementKey('lens'), true)
  assert.equal(isEnforcementKey('preview.branch'), true)
  assert.equal(isEnforcementKey('maxParallel'), false)
  assert.equal(isEnforcementKey('agents.implementer.tier'), false)
})

test('getKey reads a dotted path and returns undefined for a missing branch', () => {
  const obj = { agents: { reviewer: { tier: 'capable' } } }
  assert.equal(getKey(obj, 'agents.reviewer.tier'), 'capable')
  assert.equal(getKey(obj, 'agents.integrator.tier'), undefined)
  assert.equal(getKey(obj, 'nothing.here.at.all'), undefined)
})

test('setKey creates the intermediate objects a dotted path needs', () => {
  const obj = {}
  setKey(obj, 'agents.reviewer.tier', 'capable')
  assert.deepEqual(obj, { agents: { reviewer: { tier: 'capable' } } })
  setKey(obj, 'agents.reviewer.effort', 'high')
  assert.deepEqual(obj.agents.reviewer, { tier: 'capable', effort: 'high' })
})

test('setKey replaces a non-object node standing where a branch must go', () => {
  const obj = { agents: 'oops' }
  setKey(obj, 'agents.reviewer.tier', 'mid')
  assert.deepEqual(obj, { agents: { reviewer: { tier: 'mid' } } })
})

test('unsetKey removes a leaf and leaves a missing path alone', () => {
  const obj = { agents: { reviewer: { tier: 'capable', effort: 'high' } } }
  unsetKey(obj, 'agents.reviewer.tier')
  assert.deepEqual(obj.agents.reviewer, { effort: 'high' })
  unsetKey(obj, 'agents.integrator.tier')
  assert.deepEqual(obj, { agents: { reviewer: { effort: 'high' } } })
})

test('readLayer returns null for a missing file and parses one that exists', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await readLayer(root, LOCAL_FILE), null)
    await writeJson(root, LOCAL_FILE, { maxParallel: 5 })
    assert.deepEqual(await readLayer(root, LOCAL_FILE), { maxParallel: 5 })
  })
})

test('readLayer turns invalid JSON into a ConfigError naming the file', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, GATE_FILE), '{ oops', 'utf8')
    await assert.rejects(
      () => readLayer(root, GATE_FILE),
      (err) => err instanceof ConfigError && err.message.includes(GATE_FILE),
    )
  })
})

test('writeLayer writes pretty JSON with a trailing newline and round-trips', async () => {
  await withTempRoot(async (root) => {
    await writeLayer(root, LOCAL_FILE, { maxParallel: 12 })
    const text = await readFile(path.join(root, LOCAL_FILE), 'utf8')
    assert.equal(text, '{\n  "maxParallel": 12\n}\n')
    assert.deepEqual(await readLayer(root, LOCAL_FILE), { maxParallel: 12 })
  })
})

test('ensureGitignored creates a missing .gitignore and appends the entry once', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await ensureGitignored(root, LOCAL_FILE), true)
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), `${LOCAL_FILE}\n`)
    assert.equal(await ensureGitignored(root, LOCAL_FILE), false)
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), `${LOCAL_FILE}\n`)
  })
})

test('ensureGitignored appends after a file with no trailing newline', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules', 'utf8')
    assert.equal(await ensureGitignored(root, LOCAL_FILE), true)
    assert.equal(
      await readFile(path.join(root, '.gitignore'), 'utf8'),
      `node_modules\n${LOCAL_FILE}\n`,
    )
  })
})

test('ensureGitignored recognises an existing entry with surrounding whitespace', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, '.gitignore'), `node_modules\r\n  ${LOCAL_FILE}  \r\n`, 'utf8')
    assert.equal(await ensureGitignored(root, LOCAL_FILE), false)
  })
})

test('assertSafeKey rejects every prototype-reaching segment by name', () => {
  for (const dotted of [
    '__proto__',
    '__proto__.polluted',
    'agents.__proto__.tier',
    'constructor',
    'constructor.prototype.polluted',
    'agents.reviewer.prototype',
  ]) {
    assert.throws(
      () => assertSafeKey(dotted),
      (err) => err instanceof ConfigError && /unsafe config key segment/.test(err.message),
      `expected ${dotted} to be rejected`,
    )
  }
})

test('assertSafeKey returns a safe key unchanged', () => {
  assert.equal(assertSafeKey('agents.reviewer.tier'), 'agents.reviewer.tier')
  assert.equal(assertSafeKey('maxParallel'), 'maxParallel')
})

test('setKey refuses a prototype-polluting path and leaves Object.prototype clean', () => {
  const unsafe = (err) => err instanceof ConfigError && /unsafe config key segment/.test(err.message)
  const target = {}
  assert.throws(() => setKey(target, '__proto__.pollutedBySetKey', 'PWNED'), unsafe)
  assert.throws(() => setKey(target, 'constructor.prototype.pollutedBySetKey', 'PWNED'), unsafe)
  assert.throws(() => setKey(target, 'agents.__proto__.tier', 'PWNED'), unsafe)
  assert.deepEqual(Object.keys(target), [])
  assert.equal({}.pollutedBySetKey, undefined)
  assert.equal(Object.prototype.pollutedBySetKey, undefined)
})

test('unsetKey refuses a prototype-reaching path rather than walking it', () => {
  const unsafe = (err) => err instanceof ConfigError && /unsafe config key segment/.test(err.message)
  const target = { agents: { reviewer: { tier: 'mid' } } }
  assert.throws(() => unsetKey(target, '__proto__.toString'), unsafe)
  assert.throws(() => unsetKey(target, 'constructor.prototype.toString'), unsafe)
  assert.throws(() => unsetKey(target, 'agents.__proto__.tier'), unsafe)
  assert.equal(typeof {}.toString, 'function')
  assert.deepEqual(target, { agents: { reviewer: { tier: 'mid' } } })
})

// The class alone proves nothing here: every one of these paths also falls through to the
// pre-existing `unknown config key` throw, which is a ConfigError too. Only the message
// distinguishes the assertSafeKey guard from that fallback, so assert the message.
test('validateKey refuses a prototype-reaching path before matching a known key', () => {
  const unsafe = (err) => err instanceof ConfigError && /unsafe config key segment/.test(err.message)
  assert.throws(() => validateKey('__proto__.maxParallel', 4), unsafe)
  assert.throws(() => validateKey('agents.__proto__.tier', 'mid'), unsafe)
  assert.throws(() => validateKey('constructor.prototype.caveman', 'full'), unsafe)
  assert.throws(() => validateKey('__proto__', 4), unsafe)
  assert.throws(() => validateKey('constructor', 1), unsafe)
  assert.throws(() => validateKey('agents.reviewer.prototype', 'mid'), unsafe)
  assert.equal({}.maxParallel, undefined)
})

test('getKey refuses a prototype-reaching path instead of reading through it', () => {
  const unsafe = (err) => err instanceof ConfigError && /unsafe config key segment/.test(err.message)
  const obj = { agents: { reviewer: { tier: 'capable' } } }
  assert.throws(() => getKey(obj, 'constructor'), unsafe)
  assert.throws(() => getKey(obj, '__proto__'), unsafe)
  assert.throws(() => getKey(obj, 'constructor.prototype'), unsafe)
  assert.throws(() => getKey(obj, 'agents.__proto__.tier'), unsafe)
  assert.throws(() => getKey(obj, 'agents.reviewer.prototype'), unsafe)
})

test('setKey writes an own property rather than mutating an inherited branch', () => {
  const shared = { x: 'inherited' }
  const target = Object.create({ shared })
  setKey(target, 'shared.x', 'own')
  assert.deepEqual(Object.keys(target), ['shared'])
  assert.equal(Object.hasOwn(target, 'shared'), true)
  assert.equal(target.shared.x, 'own')
  assert.equal(shared.x, 'inherited')
})

test('unsetKey refuses to delete through an inherited branch', () => {
  const shared = { x: 'inherited' }
  const target = Object.create({ shared })
  unsetKey(target, 'shared.x')
  assert.equal(shared.x, 'inherited')
  assert.deepEqual(Object.keys(target), [])
})

test('isEnforcementKey tests every segment, not only the first', () => {
  assert.equal(isEnforcementKey('__proto__.phases'), true)
  assert.equal(isEnforcementKey('a.b.lens'), true)
  assert.equal(isEnforcementKey('agents.reviewer.preview'), true)
})

test('isEnforcementKey treats the reviewer tier and effort as enforcement', () => {
  assert.equal(isEnforcementKey('agents.reviewer.tier'), true)
  assert.equal(isEnforcementKey('agents.reviewer.effort'), true)
  assert.equal(isEnforcementKey('agents.implementer.tier'), false)
  assert.equal(isEnforcementKey('agents.implementer.effort'), false)
  assert.equal(isEnforcementKey('agents.integrator.tier'), false)
  assert.equal(isEnforcementKey('agents.integrator.effort'), false)
})

test('isEnforcementKey treats the bare reviewer role as enforcement too', () => {
  assert.equal(isEnforcementKey('agents.reviewer'), true)
  assert.equal(isEnforcementKey('agents.reviewer.tier'), true)
  assert.equal(isEnforcementKey('agents.reviewer.anything.deeper'), true)
  assert.equal(isEnforcementKey('agents.implementer'), false)
  assert.equal(isEnforcementKey('agents.reviewerish.tier'), false)
  assert.equal(isEnforcementKey('agents'), false)
})

test('validateLocal rejects agents.reviewer by name and points at the gate file', () => {
  assert.throws(
    () => validateLocal({ agents: { reviewer: { tier: 'cheap' } } }),
    (err) => err instanceof ConfigError && err.message.includes('agents.reviewer')
      && err.message.includes(GATE_FILE),
  )
  assert.throws(
    () => validateLocal({ agents: { reviewer: {} } }),
    (err) => err instanceof ConfigError && /agents\.reviewer is an enforcement key/.test(err.message),
  )
})

test('validateLocal rejects an agent sub-key outside tier and effort, naming the path', () => {
  assert.throws(
    () => validateLocal({ agents: { implementer: { checks: [] } } }),
    (err) => err instanceof ConfigError && err.message.includes('agents.implementer.checks')
      && err.message.includes(LOCAL_FILE),
  )
  assert.throws(
    () => validateLocal({ agents: { integrator: { fixRounds: 0 } } }),
    (err) => err instanceof ConfigError && err.message.includes('agents.integrator.fixRounds'),
  )
})

test('validateLocal rejects a non-object agent entry by role', () => {
  for (const bad of [null, [], 'mid', 3]) {
    assert.throws(
      () => validateLocal({ agents: { implementer: bad } }),
      (err) => err instanceof ConfigError && err.message.includes('agents.implementer'),
    )
  }
})

test('unsetKey walks past a null branch without throwing', () => {
  const obj = { preview: null }
  assert.equal(unsetKey(obj, 'preview.link'), obj)
  assert.deepEqual(obj, { preview: null })
  const scalar = { preview: 'text' }
  assert.equal(unsetKey(scalar, 'preview.link'), scalar)
  assert.deepEqual(scalar, { preview: 'text' })
})

test('loadConfig records agent provenance per field, not per role', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { tier: 'mid' } } })
    await writeJson(root, LOCAL_FILE, { agents: { implementer: { effort: 'high' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.implementer, { tier: 'mid', effort: 'high' })
    assert.equal(sources['agents.implementer.tier'], GATE_FILE)
    assert.equal(sources['agents.implementer.effort'], LOCAL_FILE)
    assert.equal(sources['agents.integrator.tier'], 'default')
    assert.equal(sources['agents.integrator.effort'], 'default')
  })
})

test('loadConfig does not attribute a field to a local layer that only names the role', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { integrator: { tier: 'cheap', effort: 'low' } } })
    await writeJson(root, LOCAL_FILE, { agents: { integrator: {} } })
    const { sources } = await loadConfig(root)
    assert.equal(sources['agents.integrator.tier'], GATE_FILE)
    assert.equal(sources['agents.integrator.effort'], GATE_FILE)
  })
})

// --- Task 9: the tracked gate layer is validated as strictly as the local one ---

test('loadConfig rejects a non-object gate layer by name instead of resolving to defaults', async () => {
  for (const body of ['[]', '"text"', 'false', '0', '""', 'null']) {
    await withTempRoot(async (root) => {
      await writeFile(path.join(root, GATE_FILE), body, 'utf8')
      await assert.rejects(
        () => loadConfig(root),
        (err) => err instanceof ConfigError
          && err.message === `${GATE_FILE} must contain a JSON object`,
        `expected a gate layer of ${body} to be rejected`,
      )
    })
  }
})

test('loadConfig still treats an absent gate layer as absent, not as a bad one', async () => {
  await withTempRoot(async (root) => {
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, defaultMaxParallel())
    assert.equal(sources.maxParallel, 'default')
  })
})

test('loadConfig rejects a misspelled tier in the gate layer rather than dispatching no model', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { tier: 'capabel' } } })
    await assert.rejects(
      () => loadConfig(root),
      // The exact message, not just the class: what makes this a fix rather than a different
      // rejection is that the tier VALIDATOR is what refused it, naming the valid tiers.
      (err) => err instanceof ConfigError
        && err.message === `tier must be one of ${TIERS.join(', ')}`,
    )
  })
})

// Each case names the message its own validator produces, not merely the shared error class. A
// blanket `throw new ConfigError('gate agents are not supported')` would reject the effort case
// for a reason with nothing to do with the effort domain, and a class-only assertion would wave
// that substitution through — binding each input to its own message is what rules it out.
test('loadConfig rejects a bad effort, maxParallel or caveman in the gate layer', async () => {
  const bad = [
    [{ agents: { integrator: { effort: 'sorta-high' } } },
      `effort must be one of ${EFFORTS.join(', ')}`],
    [{ maxParallel: 0 }, 'maxParallel must be an integer >= 1'],
    [{ caveman: 'blah' }, `caveman must be false or one of ${CAVEMAN_LEVELS.join(', ')}`],
  ]
  for (const [body, message] of bad) {
    await withTempRoot(async (root) => {
      await writeJson(root, GATE_FILE, body)
      await assert.rejects(
        () => loadConfig(root),
        (err) => err instanceof ConfigError && err.message === message,
        `expected ${JSON.stringify(body)} to be rejected in the gate layer with: ${message}`,
      )
    })
  }
})

test('loadConfig rejects an unknown agent role and a malformed agents block in the gate layer', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { auditor: { tier: 'capable' } } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && /unknown agent role: auditor/.test(err.message),
    )
  })
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: [] })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError
        && /agents must be an object keyed by role/.test(err.message),
    )
  })
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: 'capable' } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && /agents\.implementer must be an object/.test(err.message),
    )
  })
})

test('loadConfig rejects an unknown sub-key under an agent role in the gate layer by full path', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { model: 'some-model' } } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError
        && err.message.includes('agents.implementer.model')
        && err.message.includes(GATE_FILE),
    )
  })
})

// The one asymmetry that is deliberate. The reviewer grades a teammate's own diff, so the
// gitignored layer must not choose it — but the tracked manifest is exactly where that choice
// belongs. Rejecting the role in both layers would leave no way to configure it at all.
test('agents.reviewer is accepted in the gate layer and still rejected in the local layer', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { reviewer: { tier: 'capable', effort: 'high' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.reviewer, { tier: 'capable', effort: 'high' })
    assert.equal(sources['agents.reviewer.tier'], GATE_FILE)
    assert.equal(sources['agents.reviewer.effort'], GATE_FILE)
  })
  await withTempRoot(async (root) => {
    await writeJson(root, LOCAL_FILE, { agents: { reviewer: { tier: 'capable' } } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError
        && /agents\.reviewer is an enforcement key/.test(err.message)
        && err.message.includes(GATE_FILE),
    )
  })
})

test('the enforcement keys are accepted in the gate layer untouched', async () => {
  await withTempRoot(async (root) => {
    const manifest = {
      phases: { default: { checks: [{ kind: 'command', run: 'npm test' }] } },
      lens: ['security', 'correctness'],
      preview: { base: 'main' },
      maxParallel: 5,
    }
    await writeJson(root, GATE_FILE, manifest)
    const { gate, resolved } = await loadConfig(root)
    assert.deepEqual(gate, manifest)
    assert.equal(resolved.maxParallel, 5)
  })
})

test('validateGate returns the manifest it accepts and names the file it rejects', () => {
  assert.deepEqual(validateGate({ phases: {} }), { phases: {} })
  assert.deepEqual(validateGate({}), {})
  assert.throws(
    () => validateGate([]),
    (err) => err instanceof ConfigError
      && err.message === `${GATE_FILE} must contain a JSON object`,
  )
})

// ============================================================================================
// T11 — enforcement-key shape.
//
// T9 checked the ergonomics keys and deliberately left the three enforcement keys unchecked:
// their presence was permitted, their shape was never examined. All three legs of what that
// cost were reproduced on the merged tree — `config get lens` said "unknown config key",
// `config list` never printed it, and checksForPhase silently substituted DEFAULT_LENS — so a
// manifest carrying `"lens": "performance"` was exit 0 everywhere while enforcing something
// else entirely.
//
// Hand-editing stays the way enforcement policy changes. These tests pin the feedback the
// documentation already tells operators to rely on, and each asserts its EXACT message: six
// failure modes now share exit 2, and an assertion that says only "a ConfigError" cannot tell
// an operator which of them fired.
// ============================================================================================

const gateShapeError = (message) => (err) =>
  err instanceof ConfigError && err.message === message

test('validateGate rejects a lens that is not an array, by exact message', () => {
  assert.throws(
    () => validateGate({ lens: 'performance' }),
    gateShapeError('lens must be a non-empty array of strings'),
  )
  // The leg the phase 4 review reproduced: before T11 this exact body reached `config get lens`
  // and came back "unknown config key: lens", sending the operator hunting for a typo in the
  // key name when the key is right and the value is wrong.
  assert.throws(
    () => validateGate({ lens: 'performance' }),
    (err) => {
      // Anchored on its own message, not only on the absence of the wrong one: six failure
      // modes in this CLI share exit 2, so a bare `doesNotMatch` is satisfied by five of them
      // — and by a TypeError from a validator that never ran at all.
      assert.ok(err instanceof ConfigError)
      assert.equal(err.message, 'lens must be a non-empty array of strings')
      assert.doesNotMatch(err.message, /unknown config key/)
      return true
    },
  )
})

test('validateGate rejects an empty lens array, by exact message', () => {
  // gate-config.mjs substitutes DEFAULT_LENS for an empty array with no report, so this is the
  // body that silently enforces the default forever. It has to be rejected, not defaulted.
  assert.throws(
    () => validateGate({ lens: [] }),
    gateShapeError('lens must be a non-empty array of strings'),
  )
})

test('validateGate rejects a lens array holding a non-string or an empty string', () => {
  assert.throws(
    () => validateGate({ lens: ['correctness', 7] }),
    gateShapeError('lens must be a non-empty array of strings'),
  )
  assert.throws(
    () => validateGate({ lens: ['correctness', ''] }),
    gateShapeError('lens must be a non-empty array of strings'),
  )
  assert.throws(
    () => validateGate({ lens: [['correctness']] }),
    gateShapeError('lens must be a non-empty array of strings'),
  )
})

test('validateGate rejects phases that is an array, a string or null, by exact message', () => {
  assert.throws(
    () => validateGate({ phases: [] }),
    gateShapeError('phases must be an object keyed by phase name'),
  )
  assert.throws(
    () => validateGate({ phases: 'default' }),
    gateShapeError('phases must be an object keyed by phase name'),
  )
  assert.throws(
    () => validateGate({ phases: null }),
    gateShapeError('phases must be an object keyed by phase name'),
  )
})

test('validateGate distinguishes a bad phases container from a bad phase entry', () => {
  // Two messages a few words apart, both exit 2. A test matching only /must be an object/ would
  // pass against either and pin neither, so each asserts the other is NOT what fired.
  assert.throws(
    () => validateGate({ phases: { default: 'checks' } }),
    gateShapeError('phases.default must be an object'),
  )
  assert.throws(
    () => validateGate({ phases: { default: [] } }),
    (err) => {
      assert.equal(err.message, 'phases.default must be an object')
      assert.doesNotMatch(err.message, /keyed by phase name/)
      return true
    },
  )
  assert.throws(
    () => validateGate({ phases: [] }),
    (err) => {
      // The container message, pinned exactly. Without this the predicate passes for any error
      // whose message merely fails to start with `phases.` — including one raised before the
      // `phases` validator was reached.
      assert.ok(err instanceof ConfigError)
      assert.equal(err.message, 'phases must be an object keyed by phase name')
      assert.doesNotMatch(err.message, /^phases\./)
      return true
    },
  )
})

test('validateGate names the offending phase when its checks are not an array', () => {
  assert.throws(
    () => validateGate({ phases: { integration: { checks: {} } } }),
    gateShapeError('phases.integration.checks must be an array'),
  )
  assert.throws(
    () => validateGate({ phases: { default: { checks: 'npm test' } } }),
    gateShapeError('phases.default.checks must be an array'),
  )
})

test('validateGate rejects a negative or non-integer fixRounds, by exact message', () => {
  assert.throws(
    () => validateGate({ phases: { default: { fixRounds: -1 } } }),
    gateShapeError('phases.default.fixRounds must be an integer >= 0'),
  )
  assert.throws(
    () => validateGate({ phases: { default: { fixRounds: 1.5 } } }),
    gateShapeError('phases.default.fixRounds must be an integer >= 0'),
  )
  assert.throws(
    () => validateGate({ phases: { default: { fixRounds: '2' } } }),
    gateShapeError('phases.default.fixRounds must be an integer >= 0'),
  )
  // Zero is a legitimate budget — "run the gate once, dispatch no fix round" — and
  // gate-config's own tests pin it, so a truthiness guard here would break a supported config.
  assert.deepEqual(
    validateGate({ phases: { default: { fixRounds: 0, checks: [] } } }),
    { phases: { default: { fixRounds: 0, checks: [] } } },
  )
})

test('validateGate rejects a preview that is not an object, by exact message', () => {
  assert.throws(
    () => validateGate({ preview: [] }),
    gateShapeError('preview must be an object'),
  )
  assert.throws(
    () => validateGate({ preview: 'main' }),
    gateShapeError('preview must be an object'),
  )
})

test('validateGate distinguishes a bad preview container from a bad preview.link', () => {
  assert.throws(
    () => validateGate({ preview: { link: 'node_modules' } }),
    (err) => {
      assert.equal(err.message, 'preview.link must be an array of non-empty strings')
      assert.doesNotMatch(err.message, /^preview must be an object$/)
      return true
    },
  )
  assert.throws(
    () => validateGate({ preview: { link: ['node_modules', ''] } }),
    gateShapeError('preview.link must be an array of non-empty strings'),
  )
  assert.throws(
    () => validateGate({ preview: { link: ['node_modules', 3] } }),
    gateShapeError('preview.link must be an array of non-empty strings'),
  )
  assert.throws(
    () => validateGate({ preview: [] }),
    (err) => {
      // Same anchoring: the container failure has its own message, and asserting only that
      // `preview.link` is absent from it would hold for an unrelated error just as well.
      assert.ok(err instanceof ConfigError)
      assert.equal(err.message, 'preview must be an object')
      assert.doesNotMatch(err.message, /preview\.link/)
      return true
    },
  )
})

test('validateGate accepts the shapes the repository and its fixtures actually use', () => {
  // An empty preview and a preview with no `link` are both legitimate: previewLinks() returns
  // [] for either, and inferGateConfig emits no preview key at all for a project with no
  // package. An empty link list is legitimate too — it declares "link nothing", explicitly.
  const shapes = [
    { phases: { default: { checks: [] } } },
    { phases: {} },
    { phases: { default: { fixRounds: 3, checks: [{ name: 'test', kind: 'command', run: 'npm test' }] } } },
    { preview: {} },
    { preview: { base: 'main' } },
    { preview: { link: [] } },
    { preview: { link: ['node_modules'] } },
    { lens: ['correctness'] },
    { lens: ['correctness', 'security', 'tests'] },
  ]
  for (const shape of shapes) {
    assert.deepEqual(validateGate(shape), shape, `rejected a valid shape: ${JSON.stringify(shape)}`)
  }
})

test("this repository's own fleetmates.gate.json validates", async () => {
  const own = JSON.parse(
    await readFile(path.join(import.meta.dirname, '..', GATE_FILE), 'utf8'),
  )
  assert.deepEqual(validateGate(own), own)
  // Its `review` check carries a per-check `lens`. That lives inside a check body, which is
  // policy this module does not read — only the top-level `lens` is a shape this layer owns.
  assert.equal(own.lens, undefined)
})

test('loadConfig reports an enforcement key of the wrong shape from the gate layer', async () => {
  // The end-to-end feedback channel: `config list` reads through loadConfig, and the docs tell
  // an operator who hand-edited an enforcement key to verify the edit there.
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 2, lens: 'performance' })
    await assert.rejects(
      () => loadConfig(root),
      gateShapeError('lens must be a non-empty array of strings'),
    )
  })
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { phases: { default: { fixRounds: -2 } } })
    await assert.rejects(
      () => loadConfig(root),
      gateShapeError('phases.default.fixRounds must be an integer >= 0'),
    )
  })
})

test('a shape-invalid enforcement key in the local layer still reports the enforcement refusal', async () => {
  // Deliberate: validateLocal must NOT run the shape validators. An enforcement key has no
  // business in the gitignored layer whatever its shape, and reporting "lens must be a
  // non-empty array of strings" would tell the operator to fix the value when the fix is to
  // move the key. Two exit-2 modes; this pins which one the operator is shown.
  await withTempRoot(async (root) => {
    await writeJson(root, LOCAL_FILE, { lens: 'performance' })
    await assert.rejects(
      () => loadConfig(root),
      (err) => {
        assert.ok(err instanceof ConfigError)
        assert.equal(err.message, `lens is an enforcement key; it may only be set in ${GATE_FILE}`)
        assert.doesNotMatch(err.message, /non-empty array/)
        return true
      },
    )
  })
  // Same for a well-shaped one: the refusal is about the layer, never about the value.
  await withTempRoot(async (root) => {
    await writeJson(root, LOCAL_FILE, { lens: ['correctness'] })
    await assert.rejects(
      () => loadConfig(root),
      gateShapeError(`lens is an enforcement key; it may only be set in ${GATE_FILE}`),
    )
  })
})

test('loadGateConfig is left alone: it is still the plain reader', async () => {
  // The decision this tripwire was set to force has since been re-made, deliberately: `gate`,
  // `complete` and `fix` now validate the manifest and exit 2 naming the file (see the
  // manifest tests in tests/cli.test.mjs). The validation lives at the CONSUMER, in
  // scripts/cli.mjs, not in here — `loadGateConfig` is also the plain reader `self-gate` and
  // tests/gate-config.test.mjs use to read a manifest as written, and those callers want the
  // bytes, not a verdict on them. So the boundary this test guards still stands, for a reason
  // that has changed: wiring the validators in here would now duplicate a check the three
  // commands already run, in a function whose other callers do not want it.
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { lens: 'performance', phases: { default: { checks: [] } } })
    const config = await loadGateConfig(root)
    assert.equal(config.lens, 'performance')
  })
})

// Task 2: harnesses.codex.* config validation. Every claim below is asserted by the run, not
// inferred: the harness block is permitted in both layers, its fields are shape-checked, and
// `config set` reaches the same field rules through validateKey.
test('harness vocabulary constants name the sandboxes and the known harnesses', () => {
  assert.deepEqual(SANDBOXES, ['clone', 'files', 'full'])
  assert.deepEqual(KNOWN_HARNESSES, ['codex'])
})

test('a well-formed harnesses.codex block passes both layers unchanged', () => {
  const block = {
    harnesses: {
      codex: {
        sandbox: 'clone',
        network: false,
        timeoutMinutes: 30,
        tierModels: { capable: 'gpt-5-codex' },
      },
    },
  }
  assert.equal(validateLocal(block), block)
  assert.equal(validateGate(block), block)
})

test('harnesses.codex.sandbox rejects a bogus value naming every sandbox', () => {
  assert.throws(
    () => validateHarnesses({ codex: { sandbox: 'bogus' } }, LOCAL_FILE),
    (err) => err instanceof ConfigError && SANDBOXES.every((s) => err.message.includes(s)),
  )
})

test('validateHarnesses rejects an unknown harness name, naming the file and path', () => {
  assert.throws(
    () => validateHarnesses({ gemini: {} }, GATE_FILE),
    (err) => err instanceof ConfigError
      && err.message.includes(GATE_FILE) && err.message.includes('harnesses.gemini'),
  )
})

test('validateHarnesses rejects an unknown field on a known harness', () => {
  assert.throws(
    () => validateHarnesses({ codex: { turbo: true } }, LOCAL_FILE),
    (err) => err instanceof ConfigError && err.message.includes('harnesses.codex.turbo'),
  )
})

test('validateHarnesses rejects a non-integer or too-small timeoutMinutes', () => {
  for (const bad of [0, -1, 1.5, '5', null]) {
    assert.throws(
      () => validateHarnesses({ codex: { timeoutMinutes: bad } }, LOCAL_FILE),
      (err) => err instanceof ConfigError && err.message.includes('timeoutMinutes'),
    )
  }
  assert.doesNotThrow(() => validateHarnesses({ codex: { timeoutMinutes: 1 } }, LOCAL_FILE))
})

test('validateHarnesses rejects a non-boolean network and a non-object tierModels', () => {
  assert.throws(
    () => validateHarnesses({ codex: { network: 'yes' } }, LOCAL_FILE),
    (err) => err instanceof ConfigError && err.message.includes('network'),
  )
  for (const bad of [null, [], 'x']) {
    assert.throws(
      () => validateHarnesses({ codex: { tierModels: bad } }, LOCAL_FILE),
      (err) => err instanceof ConfigError && err.message.includes('tierModels'),
    )
  }
})

test('validateHarnesses rejects a non-object harnesses value and a non-object entry', () => {
  for (const bad of [null, [], 'x', 3]) {
    assert.throws(
      () => validateHarnesses(bad, LOCAL_FILE),
      (err) => err instanceof ConfigError && err.message.includes('keyed by harness name'),
    )
  }
  assert.throws(
    () => validateHarnesses({ codex: [] }, LOCAL_FILE),
    (err) => err instanceof ConfigError && err.message.includes('harnesses.codex must be an object'),
  )
})

test('config set routes harnesses.codex.sandbox through the field rules', () => {
  assert.equal(validateKey('harnesses.codex.sandbox', 'files'), 'files')
  assert.equal(validateKey('harnesses.codex.sandbox', 'full'), 'full')
  assert.throws(
    () => validateKey('harnesses.codex.sandbox', 'x'),
    (err) => err instanceof ConfigError && SANDBOXES.every((s) => err.message.includes(s)),
  )
  assert.equal(validateKey('harnesses.codex.network', true), true)
  assert.equal(validateKey('harnesses.codex.timeoutMinutes', 5), 5)
  assert.throws(
    () => validateKey('harnesses.codex.timeoutMinutes', 0),
    (err) => err instanceof ConfigError && err.message.includes('timeoutMinutes'),
  )
})

test('harnesses is not an enforcement key: the local layer accepts it', () => {
  assert.equal(isEnforcementKey('harnesses'), false)
  assert.equal(isEnforcementKey('harnesses.codex.sandbox'), false)
  assert.doesNotThrow(() => validateLocal({ harnesses: { codex: { sandbox: 'clone' } } }))
})

test('loadConfig merges harness config gate-first with the local layer overriding', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, {
      harnesses: { codex: { sandbox: 'clone', network: false, timeoutMinutes: 30 } },
    })
    await writeJson(root, LOCAL_FILE, {
      harnesses: { codex: { sandbox: 'files' } },
    })
    const { resolved } = await loadConfig(root)
    assert.deepEqual(resolved.harnesses.codex, {
      sandbox: 'files', network: false, timeoutMinutes: 30,
    })
  })
})

test('loadConfig exposes an empty harnesses map when neither layer sets one', async () => {
  await withTempRoot(async (root) => {
    const { resolved } = await loadConfig(root)
    assert.deepEqual(resolved.harnesses, {})
  })
})
