// Every spelling this project writes to disk, to git, or into a plugin namespace, in one place.
// `NAMES` is what the code uses. `LEGACY` is what claude-teammates used, and `scripts/migrate.mjs`
// is its only reader: no other module dual-reads, so a legacy spelling found anywhere else is a
// missed rename rather than a compatibility path.
//
// Imports nothing, deliberately: `enforce.mjs` is loaded by the stop-time hook inside every
// teammate, and this module must not grow that graph.

export const NAMES = Object.freeze({
  product: 'fleetmates',
  gateFile: 'fleetmates.gate.json',
  localFile: 'fleetmates.local.json',
  stateDir: '.fleetmates',
  branchPrefix: 'fleetmates',
  refPrefix: 'refs/fleetmates',
  mapHeader: 'fleetmates-map',
  updateCheckEnv: 'FLEETMATES_UPDATE_CHECK',
})

export const LEGACY = Object.freeze({
  product: 'claude-teammates',
  gateFile: 'teammates.gate.json',
  localFile: 'teammates.local.json',
  stateDir: '.teammates',
  branchPrefix: 'teammates',
  refPrefix: 'refs/teammates',
  mapHeader: 'teammates-map',
  updateCheckEnv: 'CLAUDE_TEAMMATES_UPDATE_CHECK',
})
