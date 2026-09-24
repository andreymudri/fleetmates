import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// A shell string on purpose: `npm` is `npm.cmd` on Windows, which execFile cannot start. Nothing
// in the string comes from outside this file.
const packed = () => {
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0]
}

test('the npm package is fleetmates at the plugin manifest version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'fleetmates')
  assert.equal(plugin.name, 'fleetmates')
  assert.equal(pkg.version, plugin.version)
})

test('the package carries the plugin and nothing that only develops it', () => {
  const paths = packed().files.map((f) => f.path)
  for (const required of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/session-start', 'hooks/update-check', 'hooks/run-hook.cmd', 'scripts/cli.mjs', 'templates/phase-workflow.js', 'LICENSE', 'NOTICE.md']) {
    assert.ok(paths.includes(required), `package is missing ${required}`)
  }
  const skills = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const skill of skills) assert.ok(paths.includes(`skills/${skill.name}/SKILL.md`), `package is missing skills/${skill.name}/SKILL.md`)
  // tools/ holds operator replay tooling and its recorded data, which must never ship.
  assert.deepEqual(paths.filter((p) => ['tests/', 'docs/', '.github/', 'tools/'].some((dir) => p.startsWith(dir))), [])
})
