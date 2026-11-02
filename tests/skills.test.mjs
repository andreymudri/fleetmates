import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { assertClaim, assertStatement, parseDoc } from './md-contract.mjs'
import { STALL_HINT, renderLiveness } from '../scripts/liveness.mjs'

const dir = new URL('../skills/', import.meta.url)
const REQUIRED = ['fleet-lifecycle', 'fleet-supervision', 'parallel-execution', 'phase-gate', 'using-fleetmates']

async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${name} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

test('every required fleet skill is present', async () => {
  const names = await allSkills()
  for (const required of REQUIRED) assert.ok(names.includes(required), `missing skill ${required}`)
})

test('each skill has a name matching its folder and a description starting with "Use when"', async () => {
  for (const name of await allSkills()) {
    const { fields } = await skill(name)
    assert.equal(fields.name, name)
    assert.match(fields.description, /^Use when/, `${name} description must start with "Use when"`)
  }
})

test('every cli subcommand referenced by a skill actually exists', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  // Derived from the CLI's own usage line, not restated here. A hand-kept allowlist fails in
  // the useless direction: it rejects a subcommand the CLI really does implement, so adding one
  // means editing a list in a test that has no opinion about it, and the assertion below —
  // "cli.mjs implements what the skill calls" — is the one actually carrying the weight.
  const usage = /usage: cli\.mjs <([a-z|-]+)>/.exec(cli)
  assert.ok(usage, 'cli.mjs must declare its subcommands in a usage line')
  const known = usage[1].split('|')
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    for (const m of body.matchAll(/cli\.mjs["']?\s+([a-z-]+)/g)) {
      assert.ok(known.includes(m[1]), `${name} calls unknown subcommand ${m[1]}`)
      assert.ok(cli.includes(`'${m[1]}'`), `cli.mjs does not implement ${m[1]}`)
    }
  }
})

test('every agent referenced by a skill exists', async () => {
  const agents = (await readdir(new URL('../agents/', import.meta.url))).map((f) => f.replace('.md', ''))
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    for (const m of body.matchAll(/\btm-[a-z]+\b/g)) {
      assert.ok(agents.includes(m[0]), `${name} references missing agent ${m[0]}`)
    }
  }
})

test('the entrypoint routes to all four working skills', async () => {
  const { body } = await skill('using-fleetmates')
  for (const name of REQUIRED.filter((n) => n !== 'using-fleetmates')) {
    assert.ok(body.includes(name), `entrypoint does not route to ${name}`)
  }
})

test('parallel-execution states the workflow threshold and the worktree invariant', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /three or more/)
  assert.match(body, /never touches the main worktree/)
})

test('phase-gate never reports done without a recorded PASS', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /never report .*done.* without/i)
  assert.match(body, /skipped/)
})

test('parallel-execution falls back to the direct-agent path when Workflow is declined or unavailable', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /do not stop/i)
  assert.match(body, /Fall back to the\s+direct-agent path/)
})

test('phase-gate states its limit as tamper-evident, not tamper-proof, and points at the spec', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /tamper-evident/i)
  assert.match(body, /not tamper-proof/i)
  assert.match(body, /docs\/specs\/2026-08-05-tamper-evident-enforcement-design\.md/)
})

test('parallel-execution requires --no-ff on the integration merge', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /--no-ff/)
})

test('no skill instructs recording an integration', async () => {
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    assert.doesNotMatch(body, /record(?:s|ed|ing)?\s+(?:an?\s+)?integration/i, `${name} should not instruct recording an integration`)
    assert.doesNotMatch(body, /cli\.mjs["']?\s+integrated/, `${name} should not call a non-existent 'integrated' command`)
  }
})

test('README states the phase gate guarantee and its limit', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /\bcommitted\b/)
  assert.match(readme, /tamper-evident/i)
  assert.match(readme, /not tamper-proof/i)
})

test('the tamper-evident spec lists a run based on another run branch as out of scope, with no ownership exception', async () => {
  const spec = await readFile(
    new URL('../docs/specs/2026-08-05-tamper-evident-enforcement-design.md', import.meta.url),
    'utf8',
  )
  // Sectioned rather than sliced. `spec.slice(spec.indexOf(...))` returns the file's last
  // character when the heading is gone, so a guard on the slice's length can never fire; the
  // section lookup asserts exactly one heading matches and names the file when none does.
  const outOfScope = parseDoc(spec, 'tamper-evident spec').section(/Not defended against/)
  assertStatement(
    outOfScope,
    /A run whose base branch is another run's branch/i,
    'the spec must list a run based on another run branch as out of scope',
  )
  // Counted from `git log --oneline run/claims`: four amendment commits plus the plan-creation
  // commit, all above the last task merge and all touching only the plan file.
  assertStatement(outOfScope, /FIVE commits above 09f5ad9/i, 'the spec must state the unowned-commit count')
  // `ownership` keeps no memory of the violation. Once `run/claims` became an ancestor of the
  // default branch the anchor moved onto the run tip and the commit range emptied, so the spec must
  // not promise a check that fails forever — the record lives in the spec, not in the check.
  //
  // `subject:` rather than a `doesNotMatch` on the retracted phrase: a phrase pin binds one
  // spelling, and a paraphrase ("the gate will refuse it forever") reinstates the claim with this
  // file green. The inventory lock fails on ANY unlisted sentence in the section that speaks about
  // the report's permanence, whatever it says, so re-adding the claim costs a deliberate `allow`.
  assertClaim(outOfScope, {
    label: 'ownership report permanence',
    claim: /That report is not permanent, and its answer depends on the base it is run against/i,
    subject: /(permanent|permanently|forever|never (again )?(pass|go green)|no memory|memory of the violation|passes on run\/claims|its own gate)/i,
    allow: [
      /the commit range anchor\.\.run is EMPTY, and ownership has nothing to report and passes/i,
      /the check has no memory of the violation; the record of it lives in this spec and in the permanent history of the default branch/i,
      /an ownership PASS computed in that state inspected zero commits/i,
      /A green ownership on a run already merged into its base is therefore not evidence that anything was checked/i,
    ],
  })
  assertStatement(
    outOfScope,
    /the commit range anchor\.\.run is EMPTY/i,
    'the spec must state why the report evaporates: the range is empty',
  )
  // The record has to point at the durable copy. A reflog is local to one clone and expires, so a
  // reader on a fresh clone follows the pointer and finds nothing.
  assertStatement(
    outOfScope,
    /Do not send a reader to git reflog for them/i,
    'the spec must point at branch history, not at the reflog, for the evidence',
  )
  // An exception accepting anything on a parent run's branch would accept exactly the unowned
  // commit `ownership` exists to catch, so the spec has to record that none was added.
  assertStatement(
    outOfScope,
    /No ownership exception is added for this/i,
    'the spec must record that no ownership exception was added',
  )
})

test('fleet-supervision quotes the liveness stall hint exactly as renderLiveness emits it', async () => {
  // Import the hint rather than restating it here, and rather than regexing the source for it. A
  // test carrying its own copy goes green while the skill quotes a hint the CLI no longer prints;
  // a regex over the source reads the file as TEXT, so a line-start occurrence inside a comment or
  // a template literal wins the match just as happily as the declaration and produces the same
  // false green. The import is what `renderLiveness` itself pushes, so there is no second copy.
  const { body } = await skill('fleet-supervision')
  // The hint text only. The skill quotes it inside an indented block, so the rendered line carries
  // more leading whitespace than the constant and the exact indent of that line is not pinned here.
  assert.ok(
    body.includes(STALL_HINT),
    'fleet-supervision must quote the stall hint text verbatim as scripts/liveness.mjs emits it',
  )
  assert.match(
    renderLiveness([{ taskId: 'T1', tipAgeMs: null, touchAgeMs: null, floored: false, state: 'stalled' }]),
    /likely cause: backgrounded command/,
    'renderLiveness must still emit the hint the skill quotes',
  )
})

// Without a documented way back to the full output, a contributor hitting a confusing failure
// has no obvious next move and the quiet suite just looks like it has gone silent.
test('the README documents the escape hatch to full test output', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /npm run test:verbose/)
})

// The watchdog's skill text. Comments are stripped before anything is matched, so a markdown
// comment that names an event or a command cannot stand in for the instruction itself.
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')
const rawOf = (section) => section.blocks.map((b) => b.raw).join('\n')

test('stripComments removes a markdown comment, so a commented instruction cannot satisfy these tests', () => {
  assert.equal(stripComments('a <!-- cli.mjs" watch --run --> b'), 'a  b')
  assert.equal(stripComments('<!--\n`resume`\n-->\n'), '\n')
})

test('parallel-execution starts the watchdog under Monitor in its own section between sections 2 and 3', async () => {
  const { body } = await skill('parallel-execution')
  const doc = parseDoc(stripComments(body), 'parallel-execution')
  const watch = doc.section(/^Watch the phase$/)
  assert.equal(watch.level, 2, 'Watch the phase must be a top-level section')
  const top = doc.sections.filter((s) => s.level === 2).map((s) => s.title)
  const at = top.indexOf('Watch the phase')
  assert.equal(top[at - 1], '2. Dispatch the phase', 'Watch the phase must come right after section 2')
  assert.match(top[at + 1] ?? '', /^3\. /, 'Watch the phase must come right before section 3')
  assert.ok(
    watch.code.some((b) => b.code.includes('cli.mjs" watch --run')),
    'Watch the phase must carry a cli.mjs watch --run command block',
  )
  assertStatement(watch, /\bMonitor\b/, 'Watch the phase must tell the orchestrator to run watch with Monitor')
  // Section 2 is locked by tests/skill-contracts.test.mjs, so the watchdog stays out of it.
  const dispatch = doc.section(/^2\. Dispatch the phase$/)
  assert.ok(!rawOf(dispatch).includes('cli.mjs" watch --run'), 'section 2 must not carry the watch command')
  assert.ok(!/\bMonitor\b/.test(rawOf(dispatch)), 'section 2 must not name Monitor')
})

test('fleet-supervision documents the watchdog events and the commands each response runs', async () => {
  const { body } = await skill('fleet-supervision')
  const doc = parseDoc(stripComments(body), 'fleet-supervision')
  const watchdog = doc.section(/^The watchdog$/)
  const raw = rawOf(watchdog)
  for (const event of ['start', 'resume', 'respawn', 'orphan', 'unmeasured', 'watch-error', 'exit']) {
    assert.ok(raw.includes(`\`${event}\``), `The watchdog section must name the ${event} event`)
  }
  assert.match(raw, /reason: spinning/, 'The watchdog section must name the spinning reason')
  assert.match(raw, /cli\.mjs"? rescue --run/, 'The watchdog section must name rescue --run')
  assert.match(raw, /cli\.mjs"? dispatch [^\n|]*--task/, 'The watchdog section must name dispatch with --task')
  // The heartbeat report itself did not change: liveness still only reports.
  assertStatement(doc.section(/^The heartbeat$/), /^It reports; it does not act\.$/, 'liveness must still be described as report-only')
})
