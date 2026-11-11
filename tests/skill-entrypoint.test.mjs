import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const skillsDir = new URL('../skills/', import.meta.url)
const body = async () => readFile(new URL('using-fleetmates/SKILL.md', skillsDir), 'utf8')

// The routing table is the pairing under test, so it is parsed as a table — every row's Skill
// cell, taken whole. The previous version filtered candidate names through a hardcoded prefix
// allowlist, which silently stopped covering any skill whose name did not start with one of
// them: `fleetmates-config` matched none, so deleting `skills/fleetmates-config/` while keeping
// its routing row left the whole suite green. A shape the table itself defines cannot fall out
// of step with the table the way a name list does.
function routedSkills(b) {
  const section = b.split(/^## Routing$/m)[1]
  assert.ok(section, 'using-fleetmates has no ## Routing section')
  const rows = section.split(/^## /m)[0]
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line))
    .slice(1) // the header row
  const routed = []
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim())
    assert.equal(cells.length, 2, `routing row is not two cells: ${row}`)
    const named = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    // One skill per row, backticked. A row that names none would otherwise contribute nothing
    // and be counted as covered.
    assert.equal(named.length, 1, `routing row names ${named.length} skills, expected 1: ${row}`)
    routed.push(named[0])
  }
  // Guards against the whole check going vacuous if the table is ever reformatted out of shape.
  assert.ok(routed.length >= 10, `routing table parsed to only ${routed.length} rows`)
  return routed
}

async function skillDirs() {
  return (await readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'using-fleetmates')
    .map((e) => e.name)
}

test('routes to every skill that exists', async () => {
  const routed = new Set(routedSkills(await body()))
  for (const name of await skillDirs()) {
    assert.ok(routed.has(name), `entrypoint does not route to ${name}`)
  }
})

test('every skill the routing table names actually exists', async () => {
  const present = new Set(await skillDirs())
  for (const name of routedSkills(await body())) {
    assert.ok(present.has(name), `routing table names missing skill ${name}`)
  }
})

test('requires invoking a skill before any response including clarifying questions', async () => {
  assert.match(await body(), /clarifying question/i)
})

test('carries the red-flag rationalization table', async () => {
  const b = await body()
  assert.match(b, /simple question/i)
  assert.match(b, /overkill/i)
})

test('states process skills take priority over implementation skills', async () => {
  assert.match(await body(), /priority|first/i)
})

test('keeps the fleet invariants', async () => {
  const b = await body()
  assert.match(b, /never touches the main worktree|main worktree/i)
  assert.match(b, /tm-integrator/)
})

// fleet.mode (scripts/config.mjs): auto starts an eligible plan as a fleet without the question.
test('the fleet policy reads fleet.mode before asking, and auto skips the question', async () => {
  const b = await body()
  const policy = b.indexOf('### The fleet policy')
  const choice = b.indexOf('### Presenting the choice')
  assert.ok(policy !== -1 && policy < choice, 'the fleet policy must come before the choice')
  assert.match(b, /config get fleet\.mode --root <project root>/)
  assert.match(b, /`fleet\.mode` is `ask` \(the default\) or `auto`\. With `auto`, run the plan through `init-run`,\s+show the phase breakdown in one short message, and start the fleet without asking\./)
  assert.match(b, /When a fleet \*\*is\*\* eligible and `fleet\.mode` is `ask`, never ask in prose\./)
})
