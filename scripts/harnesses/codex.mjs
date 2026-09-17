// The only module in this repository that knows Codex's CLI surface (spec §5, §7). Everything
// else — the driver, the CLI — talks to `codexAdapter` through the harness-neutral interface
// (`scripts/harnesses/index.mjs`).
import { spawn as spawnProcess } from 'node:child_process'
import { writeFile, readFile, rm, mkdir, mkdtemp } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RESULT_SCHEMA } from '../result-schema.mjs'
import { fetchTaskBranch } from '../git.mjs'
import { makeFilesSandbox, commitFilesTree } from './files-sandbox.mjs'

// `-s <flag>` per sandbox mode. `full` is `danger-full-access` — never chosen automatically
// (spec "Out of Scope"), only selectable through `harnesses.codex.sandbox = "full"`.
export const SANDBOX_FLAG = { clone: 'workspace-write', files: 'workspace-write', full: 'danger-full-access' }

// Flags shared by a first spawn and a resume. `--disable hooks` is mandatory (§2 item 10:
// Codex hooks run outside the sandbox) — every argv this module builds carries it, never
// conditionally. `--skip-git-repo-check` because the clone layout's cwd carries no `.git`
// pointer (§7) and codex must not refuse to start over that. `approval_policy="never"` because
// the driver runs headless and can never answer an interactive prompt. The two
// `sandbox_workspace_write.exclude_*` keys stop /tmp and $TMPDIR from reading as
// writable-by-default gaps in the sandbox.
function baseArgs({ model, effort, network }) {
  const args = [
    '--json', '--disable', 'hooks', '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  ]
  if (network) args.push('-c', 'sandbox_workspace_write.network_access=true')
  if (model) args.push('-m', model)
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  return args
}

// `GIT_DIR`/`GIT_WORK_TREE` reach the agent's own shell tool calls only through this `-c`, never
// through the `codex` process's own environment (§5, §7): setting them on the node-level spawn
// env would make Codex's own per-turn `git status` (§2 item 9) inherit them and execute whatever
// config the teammate plants in the sandbox git dir.
function shellEnvSet(gitdir, cwd) {
  return `shell_environment_policy.set={GIT_DIR="${gitdir}",GIT_WORK_TREE="${cwd}"}`
}

// The argv for a first spawn (spec §5). Exported as a pure function so its shape can be
// asserted without actually spawning a process.
export function buildSpawnArgv({ sandbox, model, effort, network, schemaPath, resultPath }) {
  const { meta, cwd } = sandbox
  const args = ['exec', ...baseArgs({ model, effort, network }), '-s', SANDBOX_FLAG[meta.mode], '-C', cwd]
  if (meta.mode === 'clone') {
    args.push('--add-dir', meta.gitdir, '-c', shellEnvSet(meta.gitdir, cwd))
  }
  args.push('--output-schema', schemaPath, '-o', resultPath)
  return args
}

// The argv for `exec resume` (spec §5). Takes no `-s`/`-C`/`--add-dir` — the sandbox is rebuilt
// through `-c`, and cwd is set on the child process itself rather than with a flag (§2 item 12).
export function buildResumeArgv({ sandbox, sessionId, model, effort, network, schemaPath, resultPath }) {
  const { meta, cwd } = sandbox
  const args = ['exec', 'resume', sessionId, ...baseArgs({ model, effort, network })]
  if (meta.mode === 'clone') {
    args.push(
      '-c', 'sandbox_mode="workspace-write"',
      '-c', `sandbox_workspace_write.writable_roots=["${meta.gitdir}"]`,
      '-c', shellEnvSet(meta.gitdir, cwd),
    )
  } else if (meta.mode === 'files') {
    args.push('-c', 'sandbox_mode="workspace-write"')
  } else {
    args.push('-c', 'sandbox_mode="danger-full-access"')
  }
  args.push('--output-schema', schemaPath, '-o', resultPath)
  return args
}

// A codex process, prompt fed on stdin then closed. An inherited, never-closed stdin makes
// `codex exec` wait forever and emit zero events (measured, §2 item 4) — so this is the one
// place in the adapter that must never skip `.end()`. `sessionId` resolves from the first
// `thread.started` line of the stream; stdout is written to `streamPath` as it arrives (also the
// source `readUsage` sums), stderr to `errPath`.
function run(argv, { promptText, streamPath, errPath, cwd }) {
  const child = spawnProcess('codex', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = createWriteStream(streamPath)
  const err = createWriteStream(errPath)
  child.stderr.pipe(err)

  let resolveSessionId
  let idFound = false
  const sessionId = new Promise((resolve) => { resolveSessionId = resolve })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    out.write(chunk)
    buffer += chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (idFound || !line.trim()) continue
      let evt
      try { evt = JSON.parse(line) } catch { continue }
      if (evt && evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        idFound = true
        resolveSessionId(evt.thread_id)
      }
    }
  })
  child.stdout.on('end', () => {
    out.end()
    if (!idFound) { idFound = true; resolveSessionId(null) }
  })
  child.on('error', () => {
    if (!idFound) { idFound = true; resolveSessionId(null) }
  })
  child.stdin.end(promptText) // close stdin: never leave it open (§2 item 4)
  return { child, sessionId }
}

// A git call that throws instead of returning a `{ code }` the caller must remember to check —
// used only inside this module's own sandbox setup, never handed to a teammate.
async function must(git, args, opts) {
  const res = await git(args, opts)
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim() || `exit ${res.code}`}`)
  }
  return res
}

// Builds the sandbox for one task (spec §7). `clone` and `full` share the isolated-clone layout
// — a `--shared` clone with a separate git dir; only `clone` mode then deletes the `.git`
// pointer, which is the load-bearing step that keeps Codex's own per-turn `git status` from
// walking into the teammate's git config (§2 items 7-9). `files` gives a plain, git-less
// checkout of the branch's tree (§7, the fallback): `collect` computes and commits the diff
// itself, so nothing here needs a gitdir at all.
export async function makeCodexSandbox(git, { runRepo, runBranch, runId, taskId, mode }) {
  const base = path.join(runRepo, '.fleetmates', runId)
  const branch = `fleetmates/${runId}/${taskId}`
  if (mode === 'files') return makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })
  const gitdir = path.join(base, 'gitdirs', taskId)
  const cwd = path.join(base, 'clones', taskId)
  await mkdir(path.dirname(gitdir), { recursive: true })
  await mkdir(path.dirname(cwd), { recursive: true })
  await must(git, ['clone', '--shared', `--separate-git-dir=${gitdir}`, '--end-of-options', runRepo, cwd])
  await must(git, ['checkout', '-b', branch, `origin/${runBranch}`], { cwd })
    .catch(() => must(git, ['checkout', '-b', branch], { cwd }))
  // No `.git` pointer: keeps the harness's own git off the teammate's config (§7). Only for
  // `clone` — `full` mode keeps it, since `danger-full-access` removes the reason to hide it.
  if (mode === 'clone') await rm(path.join(cwd, '.git'), { recursive: true, force: true })
  return { cwd, meta: { mode, gitdir, branch, runBranch } }
}

// The only host-side git touch against teammate material (§3, §7): a hardened `fetch` of the
// task branch from the sandbox's git dir into the run repo. `files` mode has no git dir: the host
// commits the checkout itself through `commitFilesTree`, which never points git at it.
export async function collectCodex(git, { runRepo, sandbox, branch }) {
  if (sandbox.meta.mode === 'files') {
    // Codex does not scrub its checkout, so a control-path edit is refused rather than dropped.
    await commitFilesTree(git, { runRepo, runBranch: sandbox.meta.runBranch, sandbox, branch, refuseControlChanges: true })
    return
  }
  const res = await fetchTaskBranch((a, o) => git(a, { ...o, cwd: runRepo }), {
    fromGitDir: sandbox.meta.gitdir,
    branch,
  })
  if (res.code !== 0) {
    throw new Error(`fetch of ${branch} from ${sandbox.meta.gitdir} failed: ${(res.stderr || '').trim() || `exit ${res.code}`}`)
  }
}

export async function cleanup({ sandbox }) {
  await rm(sandbox.cwd, { recursive: true, force: true })
  if (sandbox.meta.gitdir) await rm(sandbox.meta.gitdir, { recursive: true, force: true })
}

// Writes `RESULT_SCHEMA` once per task, before the first spawn (a resume reuses the file a
// spawn already wrote).
export async function spawnCodex({
  sandbox, prompt, model, effort, network, schemaPath, resultPath, streamPath, errPath,
}) {
  await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA))
  const argv = buildSpawnArgv({ sandbox, model, effort, network, schemaPath, resultPath })
  return run(argv, { promptText: prompt, streamPath, errPath: errPath ?? `${streamPath}.err`, cwd: sandbox.cwd })
}

export async function resumeCodex({
  sandbox, sessionId, message, model, effort, network, schemaPath, resultPath, streamPath, errPath,
}) {
  const argv = buildResumeArgv({ sandbox, sessionId, model, effort, network, schemaPath, resultPath })
  return run(argv, { promptText: message, streamPath, errPath: errPath ?? `${streamPath}.err`, cwd: sandbox.cwd })
}

// Reads and parses the `-o` result file. `null` on ENOENT or a parse error — never a throw —
// because "no result" and "unparsable result" are both `orphaned`, not a driver crash.
export async function readResult({ resultPath }) {
  let raw
  try {
    raw = await readFile(resultPath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Sums `turn.completed.usage` across the stream file. `null` when the stream carries no such
// event (e.g. the process never got that far), so a caller can tell "zero usage" apart from
// "no usage was ever recorded".
export async function readUsage({ streamPath }) {
  let raw
  try {
    raw = await readFile(streamPath, 'utf8')
  } catch {
    return null
  }
  const totals = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let found = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    if (evt && evt.type === 'turn.completed' && evt.usage && typeof evt.usage === 'object') {
      found = true
      const u = evt.usage
      totals.input += u.input_tokens || 0
      totals.cachedInput += u.cached_input_tokens || 0
      totals.cacheWrite += u.cache_write_input_tokens || 0
      totals.output += u.output_tokens || 0
      totals.reasoning += u.reasoning_output_tokens || 0
    }
  }
  return found ? totals : null
}

// `codex login status` must not say "Not logged in", and $CODEX_HOME (default `~/.codex`) must
// be writable (§2 item 15: the process dies without it). Never runs `codex exec` — a probe that
// itself needed the sandbox would defeat the point of probing before building one.
export async function probe({ env = process.env } = {}) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const status = await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawnProcess('codex', ['login', 'status'], { env })
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
  const text = `${status.stdout}\n${status.stderr}`
  if (/not logged in/i.test(text)) {
    return { ok: false, reason: 'codex reports it is not logged in', fix: 'run: codex login' }
  }
  if (status.code !== 0) {
    return { ok: false, reason: `codex login status exited ${status.code}: ${text.trim()}`, fix: 'run: codex login' }
  }
  try {
    const probeDir = await mkdtemp(path.join(home, '.fm-probe-'))
    await rm(probeDir, { recursive: true, force: true })
  } catch (err) {
    return {
      ok: false,
      reason: `${home} is not writable: ${err.code || err.message}`,
      fix: `ensure CODEX_HOME (${home}) is writable`,
    }
  }
  return { ok: true }
}

export const codexAdapter = {
  name: 'codex',
  probe,
  makeSandbox: makeCodexSandbox,
  collect: collectCodex,
  cleanup,
  spawn: spawnCodex,
  resume: resumeCodex,
  readResult,
  readUsage,
  sandboxFlag: SANDBOX_FLAG,
}
