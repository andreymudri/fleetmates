// `ci-local`: runs on this machine the CI steps this machine can run, before a push spends remote
// CI minutes on them. It reads the workflows that run on a branch push or a pull request, picks
// each job whose runner (its `runs-on`, or its `matrix.os` list) is this OS, and runs that job's
// `run:` steps in order the way a GitHub runner would: the step's shell, `env` from the workflow,
// the job and the step, `working-directory`, and `GITHUB_ENV` / `GITHUB_PATH` carried to the next
// step. It stops at the first failing step.
//
// What it cannot reproduce it skips and names, so the remote CI is what still has to judge it: a
// `uses:` action, an expression other than `matrix.os`, `runner.os` and `runner.temp`, an `if:`
// other than a `runner.os` comparison, a shell other than bash, sh, pwsh, powershell and cmd, and
// a job whose steps it cannot read.
//
// Steps run in the user's own environment, as a runner's steps run in its: no variable is added
// beyond the GITHUB_* and RUNNER_* files and names a step reads. A `git config --global` step (a CI
// identity, say) would change the user's real global git config, so each global git config file is
// read before every step and written back, or removed, after it when the step changed it, and the
// run says so. An interrupted run restores them before it exits.
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { readWorkflows, runnerOs } from './ci-workflows.mjs'

const NODE_OS = { linux: 'linux', darwin: 'macos', win32: 'windows' }
const RUNNER_OS = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }
const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g

// `text` with the expressions this can evaluate replaced, or null when it holds one it cannot.
export function evaluate(text, context) {
  if (typeof text !== 'string') return text
  let unknown = false
  const out = text.replace(EXPRESSION, (whole, expr) => {
    if (expr === 'matrix.os' && context.matrixOs !== null) return context.matrixOs
    if (expr === 'runner.os') return RUNNER_OS[context.os]
    if (expr === 'runner.temp') return context.temp
    unknown = true
    return whole
  })
  return unknown ? null : out
}

// An `if:` this can decide: absent, `success()`, `always()`, or `runner.os == / != '<name>'`,
// with or without `${{ }}`. Returns true, false, or null when it cannot decide.
export function decideIf(cond, context) {
  if (cond === null || cond === undefined) return true
  const expr = String(cond).trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim()
  if (expr === 'success()' || expr === 'always()' || expr === 'true') return true
  if (expr === 'false') return false
  const m = /^runner\.os\s*(==|!=)\s*'([^']*)'$/.exec(expr)
  if (!m) return null
  const same = RUNNER_OS[context.os].toLowerCase() === m[2].toLowerCase()
  return m[1] === '==' ? same : !same
}

// How GitHub runs a step's script for a shell name, or null for one this does not run. The
// default is bash on Linux and macOS and pwsh on Windows, as on a hosted runner.
export function shellInvocation(shell, os, file) {
  const name = shell ?? (os === 'windows' ? 'pwsh' : null)
  if (name === null) return { file: 'bash', args: ['-e', file], ext: '.sh' }
  if (name === 'bash') return { file: 'bash', args: ['--noprofile', '--norc', '-eo', 'pipefail', file], ext: '.sh' }
  if (name === 'sh') return { file: 'sh', args: ['-e', file], ext: '.sh' }
  if (name === 'pwsh' || name === 'powershell') return { file: name, args: ['-NoProfile', '-NonInteractive', '-Command', `. '${file.replaceAll("'", "''")}'`], ext: '.ps1', pwsh: true }
  if (name === 'cmd') return { file: 'cmd.exe', args: ['/D', '/E:ON', '/V:OFF', '/S', '/C', `CALL "${file}"`], ext: '.cmd', verbatim: true }
  return null
}

const PWSH_PRELUDE = "$ErrorActionPreference = 'stop'\n"
const PWSH_EPILOGUE = '\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n'

// `GITHUB_ENV` lines: `KEY=value` and the `KEY<<DELIM ... DELIM` form.
export function parseEnvFile(text) {
  const out = {}
  const ls = text.split(/\r?\n/)
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]
    const heredoc = /^([^=<\s]+)<<(.+)$/.exec(line)
    if (heredoc) {
      const body = []
      for (i++; i < ls.length && ls[i] !== heredoc[2]; i++) body.push(ls[i])
      out[heredoc[1]] = body.join('\n')
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

function defaultSpawn({ file, args, cwd, env, verbatim, onOutput }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd, env, windowsVerbatimArguments: Boolean(verbatim), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) { resolve({ code: 127, error: err.message }); return }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)
    child.on('error', (err) => resolve({ code: 127, error: err.message }))
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1) }))
  })
}

// The steps a local run would take, decided before anything runs: for each workflow that runs on a
// push or a pull request, each job whose runner is this OS, each step marked `run` or `skip` with
// the reason. `read` is readWorkflows' result.
export function planLocalRun(read, { os, temp }) {
  const jobs = []
  const skippedJobs = []
  for (const file of read.files) {
    if (!file.triggered) continue
    for (const job of file.jobs) {
      const label = job.labels.find((l) => runnerOs(typeof l.label === 'string' ? l.label : '') === os)
      if (!label) continue
      const where = `${file.path} ${job.id}`
      if (job.unreadable) { skippedJobs.push({ where, reason: job.unreadable }); continue }
      const context = { os, temp, matrixOs: label.matrixOs }
      const jobIf = decideIf(job.if, context)
      if (jobIf === false) continue
      if (jobIf === null) { skippedJobs.push({ where, reason: `its if: cannot be evaluated locally (${job.if})` }); continue }
      const env = {}
      const bad = Object.entries({ ...file.env, ...job.env }).find(([k, v]) => (env[k] = evaluate(String(v), context)) === null)
      if (bad) { skippedJobs.push({ where, reason: `its env ${bad[0]} uses an expression that cannot be evaluated locally` }); continue }
      const steps = job.steps.map((step, n) => {
        const name = step.name ?? (step.run ? step.run.split('\n')[0] : step.uses) ?? `step ${n + 1}`
        const skip = (reason) => ({ name, action: 'skip', reason })
        if (step.unreadable) return skip(step.unreadable)
        if (step.uses) return skip(`uses ${step.uses}`)
        if (step.run === null) return skip('no run')
        const cond = decideIf(step.if, context)
        if (cond === false) return skip(`if: ${step.if} is false here`)
        if (cond === null) return skip(`if: cannot be evaluated locally (${step.if})`)
        const run = evaluate(step.run, context)
        if (run === null) return skip('run uses an expression that cannot be evaluated locally')
        const stepEnv = {}
        for (const [k, v] of Object.entries(step.env)) {
          const value = evaluate(String(v), context)
          if (value === null) return skip(`env ${k} uses an expression that cannot be evaluated locally`)
          stepEnv[k] = value
        }
        const shell = step.shell ?? job.shell
        if (shellInvocation(shell, os, 'x') === null) return skip(`shell ${shell} is not run locally`)
        const wd = step.workingDirectory ?? job.workingDirectory
        const workingDirectory = wd === null ? null : evaluate(wd, context)
        if (wd !== null && workingDirectory === null) return skip('working-directory uses an expression that cannot be evaluated locally')
        return { name, action: 'run', run, shell, env: stepEnv, workingDirectory }
      })
      jobs.push({ where, env, steps })
    }
  }
  return { jobs, skippedJobs }
}

// The user's global git config files (what `git config --global` writes, and the XDG file git
// also reads), read before a step and put back after it. `restore` returns the files it put back.
// While a step runs, SIGINT and SIGTERM restore them before the process exits.
export function globalGitGuard(env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const files = [...new Set([
    env.GIT_CONFIG_GLOBAL ?? path.join(home, '.gitconfig'),
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config'),
  ])]
  let saved = null
  const read = async (file) => readFile(file).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
  const putBack = async () => {
    const restored = []
    if (!saved) return restored
    for (const [file, before] of saved) {
      const now = await read(file)
      if (now === null && before === null) continue
      if (now !== null && before !== null && now.equals(before)) continue
      if (before === null) await unlink(file).catch(() => {})
      else await writeFile(file, before)
      restored.push(file)
    }
    return restored
  }
  const onSignal = (signal) => { putBack().finally(() => process.kill(process.pid, signal)) }
  return {
    async snapshot() {
      saved = new Map()
      for (const file of files) saved.set(file, await read(file))
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
    },
    async restore() {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      const restored = await putBack()
      saved = null
      return restored
    },
  }
}

// Runs the plan. Returns { code, ran, skipped, failed }: code 0 when every step it ran passed and
// at least one ran, 1 at the first step that failed (nothing after it runs), 3 when there was
// nothing to run here. `spawnFn` and `write` are seams; `write` gets each line this prints,
// without its newline.
export async function runLocalCi(root, {
  platform = process.platform,
  env: baseEnv = process.env,
  spawnFn = defaultSpawn,
  write = (line) => process.stdout.write(`${line}\n`),
  onOutput = (chunk) => process.stdout.write(chunk),
  dryRun = false,
} = {}) {
  const os = NODE_OS[platform]
  if (!os) { write(`ci-local: ${platform} is not an OS a GitHub-hosted runner offers`); return { code: 3, ran: 0, skipped: [], failed: null } }
  const read = await readWorkflows(root)
  if (!read.present) { write('ci-local: no workflows under .github/workflows; nothing to run'); return { code: 3, ran: 0, skipped: [], failed: null } }
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-ci-local-'))
  try {
    const plan = planLocalRun(read, { os, temp: scratch })
    const skipped = []
    for (const s of read.skipped) { skipped.push({ where: s.path, reason: s.reason }); write(`ci-local: ${s.path}: skipped (${s.reason})`) }
    for (const s of plan.skippedJobs) { skipped.push(s); write(`ci-local: ${s.where}: job skipped (${s.reason})`) }
    const guard = globalGitGuard(baseEnv)
    let ran = 0
    for (const job of plan.jobs) {
      let jobEnv = { ...job.env }
      let pathPrefix = []
      for (const [n, step] of job.steps.entries()) {
        const label = `${job.where} [${n + 1}] ${step.name}`
        if (step.action === 'skip') { skipped.push({ where: label, reason: step.reason }); write(`ci-local: ${label}: skipped (${step.reason})`); continue }
        if (dryRun) { write(`ci-local: ${label}: would run`); continue }
        const stepDir = await mkdtemp(path.join(scratch, 'step-'))
        const files = { GITHUB_ENV: 'env', GITHUB_PATH: 'path', GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary' }
        for (const [k, f] of Object.entries(files)) { files[k] = path.join(stepDir, f); await writeFile(files[k], '') }
        const script = `${path.join(stepDir, 'script')}${shellInvocation(step.shell, os, '').ext}`
        const invocation = shellInvocation(step.shell, os, script)
        await writeFile(script, invocation.pwsh ? `${PWSH_PRELUDE}${step.run}${PWSH_EPILOGUE}` : step.run)
        const sep = os === 'windows' ? ';' : ':'
        const env = { ...baseEnv, ...jobEnv, ...step.env, ...files, GITHUB_WORKSPACE: root, RUNNER_OS: RUNNER_OS[os], RUNNER_TEMP: scratch }
        const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
        if (pathPrefix.length) env[pathKey] = [...pathPrefix, env[pathKey]].filter(Boolean).join(sep)
        const cwd = step.workingDirectory === null ? root : path.resolve(root, step.workingDirectory)
        write(`ci-local: ${label}: running`)
        await guard.snapshot()
        let result
        try {
          result = await spawnFn({ file: invocation.file, args: invocation.args, cwd, env, verbatim: invocation.verbatim, onOutput })
        } finally {
          for (const file of await guard.restore()) write(`ci-local: ${label}: changed ${file}; restored it`)
        }
        ran += 1
        if (result.code !== 0) {
          write(`ci-local: ${label}: failed with exit ${result.code}${result.error ? ` (${result.error})` : ''}; fix it before pushing`)
          return { code: 1, ran, skipped, failed: label }
        }
        jobEnv = { ...jobEnv, ...parseEnvFile(await readFile(files.GITHUB_ENV, 'utf8')) }
        const added = (await readFile(files.GITHUB_PATH, 'utf8')).split(/\r?\n/).filter(Boolean)
        pathPrefix = [...added.reverse(), ...pathPrefix]
      }
    }
    if (dryRun) { write(`ci-local: dry run, ${skipped.length} skipped`); return { code: 0, ran: 0, skipped, failed: null } }
    if (ran === 0) { write('ci-local: no step runs on this OS; the remote CI is the only check'); return { code: 3, ran, skipped, failed: null } }
    write(`ci-local: ${ran} step(s) passed here; ${skipped.length} skipped, left to the remote CI`)
    return { code: 0, ran, skipped, failed: null }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
