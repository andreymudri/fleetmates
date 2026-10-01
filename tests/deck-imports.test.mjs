import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readState, worktreeKey, indexDir } from '../scripts/state.mjs'
import { livenessRows, DEFAULT_STALE_MINUTES } from '../scripts/liveness.mjs'
import { NAMES } from '../scripts/names.mjs'
import { createGit } from '../scripts/git.mjs'

test('deck reader root imports retain their public names', () => {
  assert.equal(typeof readState, 'function')
  assert.equal(typeof livenessRows, 'function')
  assert.equal(typeof DEFAULT_STALE_MINUTES, 'number')
  assert.equal(typeof NAMES.stateDir, 'string')
  assert.equal(typeof createGit, 'function')
  // The deck's teammate lookup (hub/server/adapters/fleetmates.mjs taskForCwd) names the index record with these.
  assert.equal(typeof worktreeKey, 'function')
  assert.equal(typeof indexDir, 'function')
})
