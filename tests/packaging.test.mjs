import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8'))

test('marketplace manifest names the same plugin as plugin.json', async () => {
  const marketplace = await readJson('../.claude-plugin/marketplace.json')
  const plugin = await readJson('../.claude-plugin/plugin.json')
  const entry = marketplace.plugins.find((p) => p.name === plugin.name)
  assert.ok(entry, `marketplace.json does not list ${plugin.name}`)
  assert.equal(marketplace.name, 'fleetmates')
  assert.deepEqual(entry.source, { source: 'url', url: 'https://github.com/andreymudri/fleetmates.git', ref: 'directory' })
})

test('the marketplace source ref is the branch the release workflow refreshes', async () => {
  const marketplace = await readJson('../.claude-plugin/marketplace.json')
  const { ref } = marketplace.plugins[0].source
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.ok(release.includes(`:refs/heads/${ref}"`), `release.yml does not push the ${ref} branch`)
})

test('third-party license text is present and names the upstream author', async () => {
  const text = await readFile(new URL('../LICENSE-THIRD-PARTY', import.meta.url), 'utf8')
  assert.match(text, /MIT/)
  assert.match(text, /Jesse Vincent/)
  assert.match(text, /superpowers/i)
})

test('NOTICE lists every adapted skill and no skill that does not exist', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  const present = (await readdir(new URL('../skills/', import.meta.url), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  for (const name of ADAPTED) assert.ok(notice.includes(name), `NOTICE.md omits adapted skill ${name}`)
  for (const m of notice.matchAll(/`([a-z-]+)`/g)) {
    if (present.includes(m[1]) || m[1].includes('.')) continue
    assert.ok(!m[1].startsWith('skills/'), `NOTICE.md references missing skill ${m[1]}`)
  }
})

test('NOTICE marks the original skills as original', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  for (const name of ['writing-plans', 'finishing-a-development-branch', 'using-fleetmates']) {
    assert.ok(notice.includes(name), `NOTICE.md omits original skill ${name}`)
  }
})

// Both of these are pins on the README's TEXT, not on the CLI's behaviour, and the second one is
// documentation running ahead of code on purpose: `prune-run --yes` does not delete a merged task's
// branch in this tree — the removal loop in `scripts/cli.mjs` calls `git.removeWorktree` and stops
// there. Plan Task 7 ("delete a pruned task's branch once it is provably merged") is the wiring,
// and it lands in a later phase of this same run. Whoever implements it must add the behavioural
// pin next to it in `tests/cli.test.mjs`; until then, treat the second assertion as a marker that
// the README makes a promise the code has yet to keep, not as evidence that it keeps it.
test('the README states the retention rule and the branch clause', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /`\.fleetmates\/<run-id>\/` is never removed by any command/)
  assert.match(readme, /delete each removed worktree's branch where the run branch already/)
})

test('the README tells a claude-teammates user how to move over', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /^## Coming from claude-teammates$/m)
  assert.match(readme, /\/plugin uninstall claude-teammates/)
  assert.match(readme, /\/plugin marketplace add andreymudri\/fleetmates/)
})

test('SECURITY.md names the host the update check contacts', async () => {
  const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8')
  assert.match(security, /registry\.npmjs\.org/)
  assert.doesNotMatch(security, /raw\.githubusercontent\.com/)
})

const PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1
`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Every path under `dir`, each file paired with its bytes, in a stable order. Comparing two of
// these fails on a deleted entry, a deleted NESTED entry, and a rewritten file alike. A flat
// `readdir` sees only the first of the three, and reading each top-level entry with `readFile`
// throws a bare EISDIR the moment the run directory holds a subdirectory — which a real one does.
async function snapshot(dir, prefix = '') {
  const entries = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const full = path.join(dir, e.name)
    if (e.isDirectory()) entries.push([rel, null], ...(await snapshot(full, rel)))
    else entries.push([rel, await readFile(full, 'utf8')])
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

// The behavioural counterpart to the prose assertion above. That assertion is a regex over the
// README's own text and stays green no matter what `prune-run` actually does to
// `.fleetmates/<run-id>/` — a reviewer proved this by adding an `rm` of that directory to
// `prune-run`'s handler and watching the full suite, this file included, stay green. This test
// builds a real run, prunes it with `--yes`, and checks the directory and its files are still on
// disk afterwards — the one thing the README's claim is actually about.
test('prune-run --yes leaves .fleetmates/<run-id>/ and its files on disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-packaging-prune-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    const planPath = path.join(root, 'plan.md')
    await writeFile(planPath, PLAN, 'utf8')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    git(root, ['checkout', '--quiet', '-b', 'run-branch'])

    const io = { out: () => {}, err: () => {} }
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'fileset', kind: 'fileset' }] } },
    }), 'utf8')
    git(root, ['add', 'fleetmates.gate.json'])
    git(root, ['commit', '--quiet', '-m', 'manifest'])
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    git(root, ['add', 'a.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T1 work'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--no-ff', '--quiet', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    const wtPath = path.join(root, '.claude', 'worktrees', 'a1')
    git(root, ['worktree', 'add', '--quiet', wtPath, 'fleetmates/r1/T1'])

    const runDir = path.join(root, '.fleetmates', 'r1')
    assert.ok(
      (await readdir(runDir)).length > 0,
      'init-run must have written run state for this test to pin its survival',
    )

    // The shape a run that has been through a review round actually has on disk: `collect-reviews`
    // resolves its drop directory as `runDir(root, runId)` joined with `reviews`, so any such run
    // carries `.fleetmates/<run-id>/reviews/`. `init-run` alone writes files and no subdirectory, so
    // pinning retention against its output would leave the realistic shape unpinned.
    await mkdir(path.join(runDir, 'reviews'), { recursive: true })
    await writeFile(path.join(runDir, 'reviews', 'phase-1-claims.json'), '{"findings":[]}\n', 'utf8')

    const before = await snapshot(runDir)

    const code = await runCli(
      ['prune-run', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--yes'],
      io,
    )
    assert.equal(code, 0)

    assert.deepEqual(
      await snapshot(runDir),
      before,
      '.fleetmates/r1 must hold the same entries, nested entries and contents after prune-run --yes',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
