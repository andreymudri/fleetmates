import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generatePhaseWorkflow } from '../scripts/workflow-gen.mjs'

const tasks = [
  { id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 },
  { id: 'T2', title: 'db schema', files: ['src/db.ts'], phase: 1 },
]

test('generated source declares a meta literal with the run and phase', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /export const meta = \{/)
  assert.match(src, /name: 'fleetmates-3f2a-phase-1'/)
})

test('every task appears with its id, title and files', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  for (const t of tasks) {
    assert.ok(src.includes(t.id), `missing ${t.id}`)
    assert.ok(src.includes(t.title), `missing ${t.title}`)
    assert.ok(src.includes(t.files[0]), `missing ${t.files[0]}`)
  }
})

test('agents are spawned in parallel with worktree isolation', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /await parallel\(/)
  assert.match(src, /isolation: 'worktree'/)
})

test('the .then handler propagates null instead of spreading it, so a dead agent stays falsy', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /\.then\(\(r\) => \(r === null \? null : \{ taskId: t\.id, \.\.\.r \}\)\)/)
})

test('the generated body is syntactically valid javascript', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`))
})

test('the RESULT_SCHEMA marker is substituted with the shared schema literal', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /const RESULT_SCHEMA = \{[\s\S]*"status"[\s\S]*"branch"/)
  assert.doesNotMatch(src, /__RESULT_SCHEMA__/)
})

test('generating a phase with no tasks throws', async () => {
  await assert.rejects(
    () => generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: [], maxParallel: 4 }),
    /no tasks for phase 1/,
  )
})

test('task titles containing quotes do not break the source', async () => {
  const tricky = [{ id: 'T1', title: "don't break", files: ['a.ts'], phase: 1 }]
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: tricky, maxParallel: 2 })
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`))
})

test('a task with a tiered model resolves to that model in the generated source', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  assert.match(src, /"model": "haiku"/)
})

// Evaluates the generated body with stubbed workflow primitives and returns every
// options object the generated code passed to agent(). This exercises the dispatch
// half of the feature: a model that reaches TASKS but never reaches agent() would
// leave the dispatch inheriting the session model, which is the bug this guards.
async function captureAgentOptions(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  const captured = []
  const phase = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = (prompt, options) => {
    captured.push(options)
    return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  }
  const run = new Function(
    'phase',
    'parallel',
    'agent',
    `return (async () => { ${body} })`,
  )(phase, parallel, agent)
  await run()
  return captured
}

test('the resolved model is passed through to the agent() dispatch, not just the task list', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  const captured = await captureAgentOptions(src)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].model, 'haiku', 'agent() options must carry the resolved model')
})

test('agent() options carry each task its own resolved model', async () => {
  const mixed = [
    { id: 'T1', title: 'cheap task', files: ['a.ts'], phase: 1, tier: 'cheap' },
    { id: 'T2', title: 'capable task', files: ['b.ts'], phase: 1, tier: 'capable' },
  ]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: mixed,
    maxParallel: 2,
    tierModels: { cheap: 'haiku', capable: 'sonnet' },
  })
  const captured = await captureAgentOptions(src)
  assert.deepEqual(
    captured.map((o) => [o.label, o.model]),
    [
      ['T1', 'haiku'],
      ['T2', 'sonnet'],
    ],
  )
})

test('agent() options omit model entirely when no tier resolves', async () => {
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks, maxParallel: 4 })
  const captured = await captureAgentOptions(src)
  assert.equal(captured.length, 2)
  for (const options of captured) {
    assert.ok(!('model' in options), 'agent() options must not carry a model key when none resolves')
  }
})

test('a task whose tier is absent from tierModels emits no model key', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'capable' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  assert.ok(!src.includes('"model"'), 'expected no model key when tier is absent from tierModels')
})

test('calling with no tierModels at all emits no model key', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: tiered, maxParallel: 2 })
  assert.ok(!src.includes('"model"'), 'expected no model key when tierModels is not supplied')
})

// Evaluates the generated body with stubbed primitives and returns every prompt the
// generated code passed to agent(). The brief is assembled at run time by string
// concatenation, so a line like the checkout command exists only once the generated
// code runs — asserting on the source text alone would never see it.
async function captureAgentPrompts(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  const captured = []
  const phase = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = (prompt) => {
    captured.push(prompt)
    return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  }
  const run = new Function('phase', 'parallel', 'agent', `return (async () => { ${body} })`)(phase, parallel, agent)
  await run()
  return captured
}

test('the brief opens with a verifiable checkout of the task branch off the base branch', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(
    prompt.includes('git checkout -B fleetmates/r1/T1 main'),
    'brief must spell out the exact checkout command',
  )
  assert.ok(prompt.includes('git log --oneline -1'), 'brief must ask the teammate to verify the checkout')

  // Ordering is the whole point: a checkout instruction that arrives after the teammate has
  // been told which files to edit cannot stop it reading stale content first. Substring
  // presence alone would stay green if the block were moved to the end, so pin position.
  assert.ok(
    prompt.indexOf('git checkout -B fleetmates/r1/T1 main') < prompt.indexOf('FILES.'),
    'the checkout must come before the file set',
  )
  assert.ok(
    prompt.indexOf('MANDATORY FIRST STEP.') < prompt.indexOf('BASELINE.'),
    'the checkout must come before the baseline run',
  )

  // The log line is only worth running if it names a ref to compare against and attaches a
  // consequence to the mismatch; asserting the bare command would survive both being dropped.
  assert.ok(
    prompt.includes('If the log does not show the tip of main, STOP and report status "blocked".'),
    'the log check must name the base ref and require blocking on a mismatch',
  )
})

test('the brief requires a green baseline before any writing and blocks otherwise', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(
    prompt.includes('confirm it is green'),
    'the baseline must be required before writing, not merely suggested',
  )
  assert.ok(
    prompt.includes('Report status "blocked" only if the baseline cannot be made green.'),
    'a baseline that cannot be made green must carry the blocked consequence',
  )
})

test('the brief bootstraps the worktree before the baseline run, not after it', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)

  // A fresh worktree has no installed dependencies. On any project whose test runner is itself
  // a dependency — vitest, jest, pytest — the first baseline run fails on the missing runner,
  // and a teammate obeying the brief blocks having done no work. The teammate never reads
  // SKILL.md, so the install and config-copy steps have to be named here, and named before the
  // test command, or the skill's remedy is unreachable.
  // Matched across line breaks and without binding a fixed wording: `[\s\S]` rather than
  // `[^\n]` so a reflow does not fail this, and each step is identified by the word that
  // carries its meaning — `dependenc`, `config`, `test` — rather than by the sentence the
  // template happens to use. An earlier form asserted `/copy [^\n]*config/i`, which failed
  // when step 2 was reflowed across two array entries with identical rendered text, and
  // `/install (the [^\n]*)?dependenc/i`, which failed on any rewording that kept the step
  // first. Both were false failures on ordinary maintenance.
  const install = prompt.search(/install[\s\S]{0,60}?dependenc/i)
  const config = prompt.search(/copy[\s\S]{0,60}?config/i)
  const run = prompt.search(/test command/)
  const checkout = prompt.search(/git checkout -B/)
  assert.ok(install !== -1, 'the brief must name a dependency install step')
  assert.ok(config !== -1, 'the brief must name a config-copy step for untracked files')
  assert.ok(run !== -1, 'the brief must still name the test command')
  assert.ok(install < run, 'the install must come before the baseline test run')
  assert.ok(config < run, 'the config copy must come before the baseline test run')
  // Bootstrapping is pinned relative to the checkout as well as to the test run. Pinned only
  // against the test command, both steps could be hoisted above MANDATORY FIRST STEP and stay
  // green — telling the teammate to install dependencies into a worktree still sitting on the
  // stale commit the checkout exists to correct.
  assert.ok(checkout !== -1, 'the brief must still carry the verified checkout')
  assert.ok(checkout < install, 'the checkout must come before the install step')
  assert.ok(checkout < config, 'the checkout must come before the config copy')

  // The ordering is only justified by the reason a green baseline matters at all; dropping the
  // explanation leaves a bare chore a teammate under time pressure will skip.
  assert.ok(
    prompt.includes('looks exactly like a RED test'),
    'the brief must keep the reason a missing dependency is indistinguishable from a failure',
  )
})

test('the brief names the plan path when one is given', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    planPath: 'docs/plans/2026-08-06-thing.md',
  })
  assert.ok(src.includes('docs/plans/2026-08-06-thing.md'), 'plan path must reach the generated source')
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('PLAN. Read docs/plans/2026-08-06-thing.md'), 'brief must point at the plan')
  assert.ok(prompt.includes('"Task 1:"'), 'brief must name the task section to implement')
})

test('omitting planPath, baseBranch and constraints renders no undefined anywhere', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  assert.ok(!src.includes('undefined'), 'omitted inputs must render empty, never the string undefined')
  const prompts = await captureAgentPrompts(src)
  for (const prompt of prompts) {
    assert.ok(!prompt.includes('undefined'), 'brief must not contain undefined')
    assert.ok(!prompt.includes('PLAN. Read'), 'no plan section without a plan path')
    assert.ok(!prompt.includes('GLOBAL CONSTRAINTS'), 'no constraints section without constraints')
  }
})

test('with no base branch the brief emits no checkout command and says the start point is unverified', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  const prompts = await captureAgentPrompts(src)
  for (const prompt of prompts) {
    // `git checkout -B <branch>` with no start point silently branches from the stale worktree
    // HEAD — the exact failure this brief exists to prevent. Two shapes are forbidden, and each
    // needs its own assertion. First: a command occupying its own line, the copy-paste block a
    // teammate runs verbatim, whether or not it carries an operand.
    for (const line of prompt.split('\n')) {
      assert.ok(
        !/^\s*git checkout -B/.test(line),
        `no runnable checkout is allowed without a base: ${line}`,
      )
    }
    // Second: any occurrence anywhere — mid-sentence prose included — that hands the teammate a
    // start point the template invented. A line-anchored check alone misses
    // `... run: git checkout -B <branch> origin/main and proceed.`, which is just as runnable.
    //
    // The branch may be bare or quoted, and the start point must look like a ref. An earlier
    // form excluded quotes from the branch class, which let `git checkout -B "<branch>" main`
    // through: the class could not cross the closing quote, so the following `\s+` never
    // matched. Quoting a branch is the template's own house style in prose, so that was the
    // likelier reintroduction, not the unlikelier one.
    //
    // Requiring a ref-shaped start point is what keeps the template's own negative mention
    // unmatched. There, the quote opens before `git`, so the branch token ends `T1"` and
    // neither the bare nor the quoted alternative can complete — and the word that follows is
    // prose, not a ref. Matching any non-space token instead would flag that sentence.
    assert.ok(
      !/git checkout -B\s+(?:"[^"]+"|'[^']+'|[^\s"']+)\s+[A-Za-z0-9._/-]+/.test(prompt),
      'no checkout may supply a start point the template invented',
    )
    assert.ok(!prompt.includes('git checkout -B fleetmates/r1/T1 HEAD'), 'must not substitute HEAD for a base')
    assert.ok(prompt.includes('MANDATORY FIRST STEP.'), 'the first step must still be present')
    assert.ok(prompt.includes('No base branch was supplied'), 'the brief must say no base was supplied')
    assert.ok(prompt.includes('UNVERIFIED'), 'the brief must flag the starting commit as unverified')
    assert.ok(
      prompt.includes('Ask the orchestrator which commit to start from'),
      'the brief must route the teammate to the orchestrator before writing',
    )
    assert.ok(prompt.includes('report status "blocked"'), 'the no-base path must carry a blocked consequence')
    assert.ok(
      !prompt.includes('If the log does not show the tip of ,'),
      'the brief must never ask the teammate to verify against an unnamed ref',
    )
  }
})

test('every constraint passed in appears in the generated source and in the brief', async () => {
  const constraints = ['Node >= 24.2.0', 'Zero new runtime dependencies', 'Tests use node:test']
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, constraints })
  for (const c of constraints) assert.ok(src.includes(c), `missing constraint: ${c}`)
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('GLOBAL CONSTRAINTS:'), 'brief must head the constraints section')
  for (const c of constraints) assert.ok(prompt.includes('- ' + c), `constraint missing from brief: ${c}`)
})

test('a constraint containing $& survives the function replacer verbatim', async () => {
  const constraints = ['never write $& into the log']
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, constraints })
  assert.ok(src.includes('never write $& into the log'), '$& must not be read as a replacement pattern')
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('- never write $& into the log'), '$& must reach the brief verbatim')
})

test('a plan path and a base branch containing $& survive the function replacer verbatim', async () => {
  // Same hazard as the constraint case: a string replacement would read $& as "the match"
  // and rewrite the marker back into the output instead of the caller's value.
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    planPath: 'docs/plans/$&-thing.md',
    baseBranch: 'release/$&-base',
  })
  assert.ok(src.includes('docs/plans/$&-thing.md'), '$& in a plan path must not be read as a pattern')
  assert.ok(src.includes('release/$&-base'), '$& in a base branch must not be read as a pattern')
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('PLAN. Read docs/plans/$&-thing.md'), '$& must reach the brief from the plan path')
  assert.ok(
    prompt.includes('git checkout -B fleetmates/r1/T1 release/$&-base'),
    '$& must reach the brief from the base branch',
  )
})

test('a task title containing a marker string is not rescanned as a substitution site', async () => {
  // Marker substitution must be one pass. A chained .replace() rewrites the first occurrence
  // *anywhere*, including inside a value already substituted, so a title carrying a later
  // marker would have that marker expanded — caller text becoming a substitution site.
  const tricky = [{ id: 'T1', title: 'ok__BASE_BRANCH__ and __CONSTRAINTS__ too', files: ['a.ts'], phase: 1 }]
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: tricky,
    maxParallel: 2,
    baseBranch: 'main',
    constraints: ['c1'],
  })
  assert.ok(
    src.includes('ok__BASE_BRANCH__ and __CONSTRAINTS__ too'),
    'markers inside a task title must survive untouched',
  )
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('T1: ok__BASE_BRANCH__ and __CONSTRAINTS__ too.'), 'title must reach the brief verbatim')
  assert.ok(prompt.includes('git checkout -B fleetmates/r1/T1 main'), 'the real marker must still be substituted')
})

test('an emitted literal never carries a raw double quote', async () => {
  // Single-quoting alone makes a `"` inert only for as long as the value stays inside that
  // literal. A raw quote is one refactor away from closing a JSON string elsewhere in the
  // generated source, so the escape belongs in the escaper, not in the surrounding context.
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    planPath: 'docs/"p".md',
    baseBranch: 'feat/"q"',
    constraints: ['say "no"'],
  })
  // Briefs are embedded as a JSON.stringify'd object literal, which escapes an embedded double
  // quote as \" rather than leaving it raw — the escaping the surrounding JS string needs to
  // stay valid source. PLAN_PATH and BASE_BRANCH no longer exist as separate literals: the
  // quote only ever reaches the generated source inside the composed brief text.
  assert.ok(src.includes(String.raw`feat/\"q\"`), 'base branch quote must be escaped in the embedded brief')
  assert.ok(src.includes(String.raw`docs/\"p\".md`), 'plan path quote must be escaped in the embedded brief')
  assert.ok(src.includes(String.raw`say \"no\"`), 'constraint quote must be escaped in the embedded brief')
  // Escaping is transparent: the teammate still reads the value it was given.
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('git checkout -B fleetmates/r1/T1 feat/"q"'), 'escape must round-trip')
  assert.ok(prompt.includes('PLAN. Read docs/"p".md'), 'escape must round-trip in the plan path')
  assert.ok(prompt.includes('- say "no"'), 'escape must round-trip in a constraint')
})

test('a base branch containing a double quote cannot inject code into the generated module', async () => {
  // Reproduces the reviewed exploit: with chained substitution and an unescaped double quote,
  // a title carrying a marker plus a quote-bearing base branch closed the JSON string of the
  // already-substituted task list and appended an expression that ran on import.
  const tricky = [{ id: 'T1', title: 'ok__BASE_BRANCH__', files: ['a.ts'], phase: 1 }]
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: tricky,
    maxParallel: 2,
    baseBranch: '"+(globalThis.PWNED=1)+"',
  })
  const split = src.indexOf('\nconst TASKS')
  const wrapped = `${src.slice(0, split)}\nexport const run = async (phase, parallel, agent) => {${src.slice(split)}\n}\n`
  const dir = await mkdtemp(join(tmpdir(), 'workflow-gen-'))
  try {
    const file = join(dir, 'phase.mjs')
    await writeFile(file, wrapped, 'utf8')
    const mod = await import(pathToFileURL(file).href)
    assert.equal(globalThis.PWNED, undefined, 'importing the generated module must not execute injected code')
    const captured = []
    await mod.run(() => {}, (fns) => Promise.all(fns.map((f) => f())), (prompt) => {
      captured.push(prompt)
      return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
    })
    assert.equal(globalThis.PWNED, undefined, 'running the generated workflow must not execute injected code')
    assert.ok(
      captured[0].includes('git checkout -B fleetmates/r1/T1 "+(globalThis.PWNED=1)+"'),
      'the branch name must reach the brief as inert text',
    )
  } finally {
    delete globalThis.PWNED
    await rm(dir, { recursive: true, force: true })
  }
})

test('the dispatch names a real agent type and keeps worktree isolation', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  assert.ok(src.includes("agentType: 'fleetmates:tm-implementer'"), 'missing agentType')
  assert.ok(src.includes("isolation: 'worktree'"), 'missing worktree isolation')
  const captured = await captureAgentOptions(src)
  for (const options of captured) {
    assert.equal(options.agentType, 'fleetmates:tm-implementer')
    assert.equal(options.isolation, 'worktree')
  }
})

test('with caveman omitted the full brief is emitted, not the terse variant', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(
    prompt.includes('BASELINE. Then bootstrap the worktree, before writing anything, in this order:'),
    'the default brief must stay byte-identical to the full wording',
  )
  assert.ok(
    prompt.includes('A fresh worktree starts with none of that in place, and a failure caused by a missing'),
    'the default brief must keep the full baseline rationale',
  )
  assert.ok(!prompt.includes('STYLE.'), 'no style section without a caveman level')
})

test('the full brief requires the baseline test run to happen in the foreground', async () => {
  // A backgrounded baseline stalls with the work uncommitted and nothing notifies the teammate
  // when it finishes. This line is the rule that prevents that, so the full (non-caveman) brief
  // must carry it verbatim, not just the terse variant covered by the load-bearing list above.
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(
    prompt.includes('Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.'),
    'the full brief must instruct the baseline test run to happen in the foreground',
  )
  assert.ok(
    prompt.includes('Never background it: nothing notifies you when a backgrounded command finishes.'),
    'the full brief must state why backgrounding the baseline run is unsafe',
  )
})

test('a caveman brief keeps every load-bearing instruction verbatim', async () => {
  // Compressing a brief is compressing a specification. The gate enforces the file set and the
  // checkout, so those sentences are the last thing that may be shortened away.
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
    planPath: 'docs/plans/p.md',
    constraints: ['Node >= 24.2.0'],
    caveman: 'full',
  })
  const [prompt] = await captureAgentPrompts(src)
  for (const required of [
    'MANDATORY FIRST STEP',
    'git checkout -B fleetmates/r1/T1 main',
    'git log --oneline -1',
    'Report status "blocked"',
    'FILES. You may create or modify ONLY these files:',
    'Touching any other file fails the phase gate.',
    'GLOBAL CONSTRAINTS:',
    '- Node >= 24.2.0',
    'PLAN. Read docs/plans/p.md',
    'Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
    'Never background it: nothing notifies you when a backgrounded command finishes.',
  ]) {
    assert.ok(prompt.includes(required), `caveman brief dropped a load-bearing line: ${required}`)
  }
  assert.ok(prompt.includes('caveman:caveman'), 'the caveman brief must name the skill it asks for')
  assert.ok(prompt.includes('level full'), 'the caveman brief must name the configured level')
  assert.ok(
    prompt.includes('is not a blocker'),
    'a missing caveman skill must be explicitly non-blocking',
  )
  assert.ok(!prompt.includes('undefined'), 'the caveman brief must not contain undefined')
})

test('a caveman brief without a base branch still refuses to invent a start point', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, caveman: 'ultra' })
  const prompts = await captureAgentPrompts(src)
  for (const prompt of prompts) {
    for (const line of prompt.split('\n')) {
      assert.ok(!/^\s*git checkout -B/.test(line), `no runnable checkout without a base: ${line}`)
    }
    assert.ok(prompt.includes('No base branch was supplied'), 'the no-base wording must survive compression')
    assert.ok(prompt.includes('UNVERIFIED'), 'the unverified flag must survive compression')
  }
})

test('effort is absent from the dispatch options unless configured', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  const captured = await captureAgentOptions(src)
  assert.equal(captured.length, 2)
  for (const options of captured) {
    assert.ok(!('effort' in options), 'agent() options must not carry an effort key when none is configured')
  }
})

test('a configured effort reaches the agent() dispatch', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, effort: 'high' })
  assert.ok(src.includes("const EFFORT = 'high'"), 'effort must reach the generated source')
  const captured = await captureAgentOptions(src)
  for (const options of captured) assert.equal(options.effort, 'high')
})

test('a caveman level containing a quote is escaped rather than breaking the source', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    caveman: "full' + (globalThis.PWNED = 1) + '",
    effort: "high' + (globalThis.PWNED = 1) + '",
  })
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`))
  try {
    const captured = await captureAgentOptions(src)
    assert.equal(globalThis.PWNED, undefined, 'a quoted caveman level must not execute')
    assert.equal(captured[0].effort, "high' + (globalThis.PWNED = 1) + '", 'effort must round-trip as inert text')
  } finally {
    delete globalThis.PWNED
  }
})

// blastRadius(t) is called at generated-workflow run time, so its rendered output — the
// percentage and the section's presence or absence — only exists once the workflow body is
// evaluated, never in the raw generated source: the static function definition that decides
// whether to render it is always present in the source text regardless of neighbours. These
// content assertions therefore run against the rendered prompt via captureAgentPrompts, exactly
// as the checkout and baseline sections above are asserted.
test('a task with neighbours renders a blast radius naming each file and its percentage', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.82 }] },
  })
  // Static source text: the blastRadius function definition (and its literal 'BLAST RADIUS'
  // string) is always present in the generated module regardless of neighbours, so this only
  // pins that the neighbour's path made it into the TASKS literal, never that the section
  // renders. The rendering claim is asserted below via captureAgentPrompts.
  assert.match(src, /src\/b\.ts/)
  const [prompt] = await captureAgentPrompts(src)
  assert.match(prompt, /BLAST RADIUS/)
  assert.match(prompt, /82%/)
  assert.match(prompt, /src\/b\.ts/)
})

// A task with several neighbours must show every one, not just the first. Rendering only
// t.neighbours[0] would leave this test's earlier single-neighbour sibling green, since that
// one only ever supplies one entry — the mutation is only visible with more than one.
test('a task with several neighbours renders every one, not just the first', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: {
      T1: [
        { path: 'src/b.ts', confidence: 0.9 },
        { path: 'src/c.ts', confidence: 0.6 },
        { path: 'src/d.ts', confidence: 0.3 },
      ],
    },
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.match(prompt, /90%\s+src\/b\.ts/)
  assert.match(prompt, /60%\s+src\/c\.ts/)
  assert.match(prompt, /30%\s+src\/d\.ts/)
})

// neighbours is keyed by task id, so each task in a multi-task phase must see only its own
// entry. Resolving neighbours by position (e.g. the first value in the map) rather than by
// the task's own id would hand every teammate the first task's coupled files instead of its
// own — a real hazard once a phase has more than one task, which every other blast-radius
// test above avoids by using a single-task phase.
test('in a multi-task phase, each brief names only its own task neighbours', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [
      { id: 'T1', title: 'a', files: ['src/a.ts'] },
      { id: 'T2', title: 'b', files: ['src/x.ts'] },
    ],
    neighbours: {
      T1: [{ path: 'src/a-neighbour.ts', confidence: 0.7 }],
      T2: [{ path: 'src/x-neighbour.ts', confidence: 0.4 }],
    },
  })
  const [promptT1, promptT2] = await captureAgentPrompts(src)
  assert.match(promptT1, /src\/a-neighbour\.ts/)
  assert.doesNotMatch(promptT1, /src\/x-neighbour\.ts/)
  assert.match(promptT2, /src\/x-neighbour\.ts/)
  assert.doesNotMatch(promptT2, /src\/a-neighbour\.ts/)
})

test('a task with no neighbours renders no blast radius section', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [] },
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.doesNotMatch(prompt, /BLAST RADIUS/)
})

test('omitting neighbours entirely renders no blast radius and no undefined', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.doesNotMatch(prompt, /BLAST RADIUS/)
  assert.doesNotMatch(prompt, /undefined/)
})

// The brief is the specification the gate then enforces, so the caveman variant keeps it for the
// same reason it keeps the FILES list.
test('the caveman brief keeps the blast radius', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2, caveman: 'full',
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.5 }] },
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.match(prompt, /BLAST RADIUS/)
})

test('the blast radius tells a teammate to report blocked rather than edit a neighbour', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.5 }] },
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.match(prompt, /report status "blocked" naming it rather than editing it/)
})

test('the generated source parses as a real module', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    planPath: 'docs/plans/p.md',
    baseBranch: 'main',
    constraints: ["don't break $& things"],
  })
  // The workflow body ends in a top-level `return`, which is legal in the workflow host
  // but not in an ES module, so wrap the body in a function. Every other byte — the whole
  // brief included — is then parsed by the real module parser, which is exactly what the
  // substring assertions above cannot do.
  const split = src.indexOf('\nconst TASKS')
  assert.ok(split > 0, 'expected a TASKS declaration after the meta literal')
  const wrapped = `${src.slice(0, split)}\nexport const run = async (phase, parallel, agent) => {${src.slice(split)}\n}\n`
  const dir = await mkdtemp(join(tmpdir(), 'workflow-gen-'))
  try {
    const file = join(dir, 'phase.mjs')
    await writeFile(file, wrapped, 'utf8')
    const mod = await import(pathToFileURL(file).href)
    assert.equal(mod.meta.name, 'fleetmates-r1-phase-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The brief composer moved into scripts/brief.mjs; the template must not carry its own copy.
// A silent reappearance of `brief`, `briefTerse`, `checkoutSteps` or `blastRadius` inside the
// generated source would mean the template started composing text again instead of reading the
// already-composed BRIEFS object, defeating the single-implementation point of this task.
test('the generated script defines no local brief-composition function', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    baseBranch: 'main',
    planPath: 'docs/plans/p.md',
    constraints: ['c1'],
  })
  for (const name of ['brief', 'briefTerse', 'checkoutSteps', 'blastRadius']) {
    assert.ok(
      !new RegExp(`\\bfunction\\s+${name}\\b`).test(src) && !new RegExp(`\\bconst\\s+${name}\\s*=`).test(src),
      `generated source must not define a local ${name} function`,
    )
  }
})

// Cross-file pin: the text embedded in BRIEFS for a task must be exactly what composeBrief
// produces for the same inputs — not merely similar wording. This is what makes the generator
// and `cli.mjs brief` (via composeBrief) provably the same implementation rather than two
// copies that happen to agree today.
test('the embedded brief and composeBrief called directly are byte-identical', async () => {
  const { composeBrief } = await import('../scripts/brief.mjs')
  const task = { id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }
  const runId = 'r1'
  const planPath = 'docs/plans/p.md'
  const baseBranch = 'main'
  const constraints = ['Node >= 24.2.0']
  const src = await generatePhaseWorkflow({
    runId,
    phase: 1,
    tasks: [task],
    maxParallel: 2,
    planPath,
    baseBranch,
    constraints,
  })
  const [prompt] = await captureAgentPrompts(src)
  const expected = composeBrief({
    task: { id: task.id, title: task.title, files: task.files, branch: `fleetmates/${runId}/${task.id}` },
    runId,
    planPath,
    baseBranch,
    constraints,
  })
  assert.equal(prompt, expected, 'the embedded brief must be byte-identical to composeBrief\'s own output')
})
