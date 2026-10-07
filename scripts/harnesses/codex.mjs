import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { constants } from 'node:fs'
import { defaultExec } from '../gate-runner.mjs'
import { resolveRoleCapabilities } from '../role-capabilities.mjs'
import { probeCommand } from './probe-command.mjs'
// The only module in this repository that knows Codex's CLI surface (spec §5, §7). Everything
// else — the driver, the CLI — talks to `codexAdapter` through the harness-neutral interface
// (`scripts/harnesses/index.mjs`).
import { spawn as spawnProcess } from 'node:child_process'
import { writeFile, rm, mkdir, lstat, mkdtemp, realpath, access, open } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RESULT_SCHEMA } from '../result-schema.mjs'
import { fetchTaskBranch } from '../git.mjs'
import { makeFilesSandbox, commitFilesTree, FILES_PREAMBLE } from './files-sandbox.mjs'

// `-s <flag>` per sandbox mode. `full` is `danger-full-access` — never chosen automatically
// (spec "Out of Scope"), only selectable through `harnesses.codex.sandbox = "full"`.
export const SANDBOX_FLAG = { clone: 'workspace-write', files: 'workspace-write', full: 'danger-full-access' }

function requiredEnforcement(sandbox, enforcement, network) {
  const value = enforcement !== undefined ? enforcement : sandbox.meta.enforcement
  if (value === undefined) {
    if (Object.hasOwn(sandbox.meta, 'prerequisites') && sandbox.meta.prerequisites?.rolePolicy !== null) {
      throw new Error('Missing required enforcement for bound policy')
    }
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid required enforcement')
  const fields = ['read', 'write', 'execute', 'network', 'sharedRefs', 'publication']
  const policy = { version: 1, roles: { implementer: Object.fromEntries(fields.map(key => [key, value[key]])) } }
  const resolved = resolveRoleCapabilities({ policy, role: 'implementer', harness: 'codex', sandboxMode: sandbox.meta.mode, network: network === true })
  if (value.kind !== 'required' || !resolved.ready
    || Object.keys(value).length !== Object.keys(resolved.enforcement).length
    || Object.entries(resolved.enforcement).some(([key, expected]) => value[key] !== expected)) throw new Error('Invalid required codex enforcement')
  return value
}


// Flags shared by a first spawn and a resume. `--disable hooks` is mandatory (§2 item 10:
// Codex hooks run outside the sandbox) — every argv this module builds carries it, never
// conditionally. `--skip-git-repo-check` because the clone layout's cwd carries no `.git`
// pointer (§7) and codex must not refuse to start over that. `approval_policy="never"` because
// the driver runs headless and can never answer an interactive prompt. The two
// `sandbox_workspace_write.exclude_*` keys stop /tmp and $TMPDIR from reading as
// writable-by-default gaps in the sandbox.
// A model and an effort each reach codex as ONE argv element (`-m <model>`,
// `-c model_reasoning_effort=<effort>`), so each must be one bounded token: a leading dash reads as
// a flag, and a comma, quote or space changes what the `-c` value means. Refused, never repaired.
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,127}$/
const EFFORT_TOKEN = /^[a-z][a-z0-9-]{0,31}$/
function baseArgs({ model, effort, network, required }) {
  if (model && (typeof model !== 'string' || !MODEL_TOKEN.test(model))) throw new Error('Invalid codex model name')
  if (effort && (typeof effort !== 'string' || !EFFORT_TOKEN.test(effort))) throw new Error('Invalid codex reasoning effort')
  const args = [
    '--json', '--disable', 'hooks', '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  ]
  if (required || network) args.push('-c', `sandbox_workspace_write.network_access=${network === true}`)
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
export function buildSpawnArgv({ sandbox, model, effort, network, schemaPath, resultPath, enforcement }) {
  const { meta, cwd } = sandbox
  const required = requiredEnforcement(sandbox, enforcement, network)
  const args = ['exec', ...baseArgs({ model, effort, network: required ? required.network : network, required }), '-s', required?.sandbox ?? SANDBOX_FLAG[meta.mode], '-C', cwd]
  if (meta.mode === 'clone' && (!required || required.addWritableRoots)) {
    args.push('--add-dir', meta.gitdir, '-c', shellEnvSet(meta.gitdir, cwd))
  }
  args.push('--output-schema', schemaPath, '-o', resultPath)
  return args
}

// The argv for `exec resume` (spec §5). Takes no `-s`/`-C`/`--add-dir` — the sandbox is rebuilt
// through `-c`, and cwd is set on the child process itself rather than with a flag (§2 item 12).
export function buildResumeArgv({ sandbox, sessionId, model, effort, network, schemaPath, resultPath, enforcement }) {
  const { meta, cwd } = sandbox
  const required = requiredEnforcement(sandbox, enforcement, network)
  const args = ['exec', 'resume', sessionId, ...baseArgs({ model, effort, network: required ? required.network : network, required })]
  if (required?.sandbox === 'read-only') {
    args.push('-c', 'sandbox_mode="read-only"')
  } else if (meta.mode === 'clone') {
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
//
// Capture is bounded: stdout and stderr share one budget of `maxStreamBytes` across their two
// files. The chunk that crosses it keeps only the bytes that fit, the child is SIGKILLed, nothing
// more is written, and the handle's `outputLimited` reads true, so an oversized capture is an
// explicit failure rather than a truncated stream a reader takes for a whole one. `flushed`
// resolves once both files have finished writing. The partial line held while looking for the
// session id is dropped past SESSION_LINE_LIMIT (not exercised by a test).
export const STREAM_LIMIT_BYTES = 64 * 1024 * 1024
export const RESULT_LIMIT_BYTES = 1024 * 1024
const SESSION_LINE_LIMIT = 1024 * 1024
function run(argv, { promptText, streamPath, errPath, cwd, maxStreamBytes = STREAM_LIMIT_BYTES }) {
  const child = spawnProcess('codex', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = createWriteStream(streamPath)
  const err = createWriteStream(errPath)
  const flushed = Promise.all([out, err].map(stream => new Promise((resolve) => {
    stream.on('finish', resolve)
    stream.on('error', resolve)
  }))).then(() => undefined)

  let resolveSessionId
  let idFound = false
  const sessionId = new Promise((resolve) => { resolveSessionId = resolve })
  const settle = (value) => {
    if (idFound) return
    idFound = true
    resolveSessionId(value)
  }
  let written = 0
  let limited = false
  // Every chunk passes through here before it is written. The chunk that crosses the bound keeps
  // only the bytes that fit, so the files end exactly at the bound whatever the pipe's chunking.
  const take = (chunk) => {
    if (limited) return null
    const room = maxStreamBytes - written
    if (chunk.length <= room) { written += chunk.length; return chunk }
    limited = true
    written = maxStreamBytes
    return chunk.subarray(0, Math.max(0, room))
  }
  const stop = () => {
    out.end()
    err.end()
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    settle(null)
  }
  let buffer = ''
  child.stderr.on('data', (chunk) => {
    const part = take(chunk)
    if (part === null) return
    if (part.length) err.write(part)
    if (limited) stop()
  })
  child.stdout.on('data', (chunk) => {
    const part = take(chunk)
    if (part === null) return
    if (part.length) out.write(part)
    if (!idFound) {
      buffer += part.toString('utf8')
      let nl
      while (!idFound && (nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        let evt
        try { evt = JSON.parse(line) } catch { continue }
        if (evt && evt.type === 'thread.started' && typeof evt.thread_id === 'string') settle(evt.thread_id)
      }
      if (buffer.length > SESSION_LINE_LIMIT) buffer = ''
    }
    if (limited) stop()
  })
  child.stdout.on('end', () => {
    if (!limited) out.end()
    settle(null)
  })
  child.stderr.on('end', () => { if (!limited) err.end() })
  child.on('error', () => {
    if (!limited) { out.end(); err.end() }
    settle(null)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(promptText) // close stdin: never leave it open (§2 item 4)
  return { child, sessionId, flushed, get outputLimited() { return limited } }
}

// A bounded read that does not follow a final symlink: `null` when the file is absent, a link,
// not a regular file, or larger than `max` bytes — never a throw.
async function readBounded(file, max) {
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) return null
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return offset > max ? null : buffer.subarray(0, offset).toString('utf8')
  } catch { return null } finally { await handle.close() }
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
export async function makeCodexSandbox(git, { runRepo, runBranch, runId, taskId, mode, requireFresh = false }) {
  const base = path.join(runRepo, '.fleetmates', runId)
  const branch = `fleetmates/${runId}/${taskId}`
  if (requireFresh) {
    const target = path.join(base, mode === 'files' ? 'files' : 'clones', taskId)
    try {
      await lstat(target)
      throw new Error('Refusing to overwrite an existing worker workspace')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (mode === 'files') return makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })
  const gitdir = path.join(base, 'gitdirs', taskId)
  const cwd = path.join(base, 'clones', taskId)
  await mkdir(path.dirname(gitdir), { recursive: true })
  await mkdir(path.dirname(cwd), { recursive: true })
  await must(git, ['clone', '--shared', `--separate-git-dir=${gitdir}`, '--end-of-options', runRepo, cwd])
  await must(git, ['checkout', '-b', branch, `origin/${runBranch}`], { cwd })
    .catch(() => must(git, ['checkout', '-b', branch], { cwd }))
  // The clone's own config carries the identity the run repo resolves, so a commit made in the
  // clone is authored as the project, not as whatever the host's global config names. An identity
  // the run repo cannot resolve is left unset rather than invented.
  for (const key of ['user.name', 'user.email']) {
    const value = (await git(['config', '--get', key], { cwd: runRepo })).stdout?.trim()
    if (value) await must(git, ['--git-dir', gitdir, 'config', '--end-of-options', key, value])
  }
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

// A `files` checkout has no repository of its own — git there resolves the run repo, whose .git the
// sandbox denies — so the persona's git steps are overridden up front, exactly as for Cursor.
function withPreamble(sandbox, text) {
  return sandbox.meta.mode === 'files' ? `${FILES_PREAMBLE}${text}` : text
}

// Writes `RESULT_SCHEMA` once per task, before the first spawn (a resume reuses the file a
// spawn already wrote).
export async function spawnCodex({
  sandbox, prompt, model, effort, network, enforcement, schemaPath, resultPath, streamPath, errPath, maxStreamBytes,
}) {
  const argv = buildSpawnArgv({ sandbox, model, effort, network, enforcement, schemaPath, resultPath })
  await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA))
  return run(argv, { promptText: withPreamble(sandbox, prompt), streamPath, errPath: errPath ?? `${streamPath}.err`, cwd: sandbox.cwd, maxStreamBytes })
}

export async function resumeCodex({
  sandbox, sessionId, message, model, effort, network, enforcement, schemaPath, resultPath, streamPath, errPath, maxStreamBytes,
}) {
  const argv = buildResumeArgv({ sandbox, sessionId, model, effort, network, enforcement, schemaPath, resultPath })
  return run(argv, { promptText: withPreamble(sandbox, message), streamPath, errPath: errPath ?? `${streamPath}.err`, cwd: sandbox.cwd, maxStreamBytes })
}

// Reads and parses the `-o` result file. `null` on ENOENT, a parse error or a file past
// RESULT_LIMIT_BYTES — never a throw — because "no result", "unparsable result" and "oversized
// result" are all `orphaned`, not a driver crash.
export async function readResult({ resultPath }) {
  const raw = await readBounded(resultPath, RESULT_LIMIT_BYTES)
  if (raw === null) return null
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
  const raw = await readBounded(streamPath, STREAM_LIMIT_BYTES)
  if (raw === null) return null
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
  const status = await probeCommand('codex', ['login', 'status'], env)
  const text = status.text
  if (status.timedOut || status.outputLimited) return { ok: false, reason: 'codex authentication probe exceeded its execution limits', fix: 'check the Codex CLI and retry' }
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

const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }
const pipeRunner = `
const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');
const r=JSON.parse(process.argv[1]);
const child=cp.spawnSync(r.command,r.argv,{env:r.env,stdio:['ignore','inherit','inherit']});
const launchError=child.error?.code??null;
fs.writeSync(3,JSON.stringify({
  code:child.status??(child.signal?128+os.constants.signals[child.signal]:1),signal:child.signal,
  completed:!child.error&&(Number.isInteger(child.status)||child.signal!==null),launchError
})+'\\n');
if(launchError)process.exitCode=1;`
// The fixed shell pipeline supplies ordinary pipes; native console output is pinned by the
// actual-native regression, separately from injected restriction-receipt validation.
//
// The command's shell runs `detached`, in a process group of its own, so a signal that ends the
// trampoline (an outer timeout's SIGTERM, a SIGINT or SIGHUP) would otherwise leave that whole
// group running. The trampoline handles SIGTERM, SIGINT and SIGHUP by SIGKILLing the group, then
// exits 128+signal. SIGKILL of the trampoline cannot be trapped: a trampoline SIGKILLed without
// a SIGTERM first still leaves the group running. `defaultExec`'s timeout sends SIGTERM before its
// SIGKILL, so that path is covered.
const trampoline = `
const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');
const r=JSON.parse(process.argv[1]);process.chdir(r.cwd);
const child=cp.spawn('/bin/sh',[
  '-c','{ "$@"; status=$?; printf "%s\\n" "$status" >&4; } 2>&1 | /bin/cat',
  'fm-verification',process.execPath,'-e',${JSON.stringify(pipeRunner)},JSON.stringify(r)
],{env:r.env,detached:true,stdio:['ignore','pipe','pipe','pipe','pipe']});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}process.exit(128+os.constants.signals[signal])});
let output=Buffer.alloc(0),outputBytes=0,runnerStatus='',observation='',timedOut=false,limited=false,runtimeError=null,finished=false,cleanup;
const stop=()=>{try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')runtimeError=error.code}cleanup??=setTimeout(finish,250)};
const timer=setTimeout(()=>{timedOut=true;runtimeError='ETIMEDOUT';stop()},r.timeoutMs);
function finish(){
  if(finished)return;finished=true;clearTimeout(timer);clearTimeout(cleanup);
  for(const stream of child.stdio)stream?.destroy();child.unref();
  const runnerCode=/^\\d{1,3}\\n$/.test(runnerStatus)?Number(runnerStatus.trim()):null;
  let receipt;try{receipt=JSON.parse(observation)}catch{}
  const completed=child.exitCode===0&&child.signalCode===null&&!runtimeError&&!limited&&!timedOut&&runnerCode===0
    &&receipt?.completed===true&&receipt.launchError===null;
  fs.writeSync(1,r.marker+JSON.stringify({
    code:completed?receipt.code:(child.signalCode?128+os.constants.signals[child.signalCode]:1),
    signal:completed?receipt.signal:child.signalCode,completed,runnerCode,timedOut,
    pipelineCode:child.exitCode>=0?child.exitCode:null,pipelineSignal:child.signalCode,
    launchError:receipt?.launchError??null,runtimeError,
    output:output.toString('base64'),outputLimited:limited
  })+'\\n');
}
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
  if(finished)return;const remaining=r.maxOutputBytes-output.length;
  output=Buffer.concat([output,chunk.subarray(0,remaining)]);
  outputBytes+=chunk.length;
  if(outputBytes>r.maxOutputBytes)limited=true;
  if(outputBytes>r.maxOutputBytes+2048){runtimeError='ENOBUFS';stop()}
});
for(const [fd,append]of [[3,chunk=>observation+=chunk],[4,chunk=>runnerStatus+=chunk]])child.stdio[fd].on('data',chunk=>{
  if(finished)return;
  if(chunk.length+(fd===3?observation.length:runnerStatus.length)>2048){runtimeError='ENOBUFS';limited=true;stop();return}
  append(chunk.toString());
});
child.once('error',error=>{runtimeError=error.code;finish()});
child.once('close',finish);`


export function buildVerificationInvocation({ executable, broker, home, worker, temp, write, command, argv = null, env = process.env, protectedRoots = [], marker = 'FM_COMMAND', maxOutputBytes = 32768, timeoutMs = 5000 }) {
  const safePath = (env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir) && !inside(worker, dir)).join(path.delimiter)
  const clean = { PATH: safePath, HOME: home, CODEX_HOME: home, LC_ALL: 'C.UTF-8', TMPDIR: temp,
    XDG_CACHE_HOME: temp, NPM_CONFIG_CACHE: path.join(temp, 'npm'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' }
  const filesystem = [...new Set([broker, home, path.join(worker, '.git'), path.join(worker, '.fleetmates'), ...protectedRoots])]
  const config = `default_permissions="worker"\n[permissions.worker]\nextends=":read-only"\n[permissions.worker.workspace_roots]\n${JSON.stringify(worker)}=${write}\n[permissions.worker.filesystem]\n${JSON.stringify(worker)}=${JSON.stringify(write ? 'write' : 'read')}\n":tmpdir"="read"\n":slash_tmp"="read"\n`
    + filesystem.map(file => `${JSON.stringify(file)}="read"\n`).join('') + '[permissions.worker.network]\nenabled=false\n'
  const payload = { cwd: worker, command: argv === null ? '/bin/sh' : command,
    argv: argv === null ? ['-c', command] : argv, env: clean, marker, maxOutputBytes, timeoutMs }
  return { command: '/usr/bin/env', cwd: broker, config, argv: ['-i', `PATH=${safePath}`, `HOME=${home}`, `CODEX_HOME=${home}`, 'TMPDIR=/tmp', 'LC_ALL=C.UTF-8',
    executable, 'sandbox', '-P', 'worker', '-C', broker, '--', process.execPath, '-e', trampoline, JSON.stringify(payload)] }
}

export async function createVerificationExecutor({ sandbox, root = sandbox.cwd, enforcement, platform = process.platform, env = process.env, run = defaultExec }) {
  if (platform !== 'linux') throw new Error('Required non-model verification platform is unsupported')
  const required = requiredEnforcement(sandbox, enforcement, false)
  if (!required || required.network || !required.execute) throw new Error('Required non-model verification authority is unsupported')
  const worker = await realpath(sandbox.cwd)
  let executable
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir) || inside(worker, dir)) continue
    try { const candidate = await realpath(path.join(dir, 'codex')); await access(candidate, constants.X_OK); if (!inside(worker, candidate)) { executable = candidate; break } } catch {}
  }
  if (!executable) throw new Error('Required native verification runtime is unavailable')
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'fm-verification-'))
  let temp
  let server
  let deniedTemporary
  const close = async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (deniedTemporary) await rm(deniedTemporary, { force: true })
    if (temp) await rm(temp, { recursive: true, force: true })
    await rm(privateRoot, { recursive: true, force: true })
  }
  try {
    if (inside(worker, privateRoot)) throw new Error('Verification configuration must be outside the worker')
    const broker = path.join(privateRoot, 'broker'), home = path.join(privateRoot, 'config')
    await mkdir(broker); await mkdir(home)
    temp = await mkdtemp(path.join(worker, '.fm-verification-'))
    const protectedDir = path.join(temp, 'protected'); await mkdir(protectedDir)
    const protectedRoots = [path.join(root, '.git'), path.join(root, '.fleetmates'), ...(sandbox.meta.gitdir ? [sandbox.meta.gitdir] : []), protectedDir]
    const invoke = async (command, cwd, options = {}) => {
      if (await realpath(cwd) !== worker) throw new Error('Verification cwd changed')
      const timeoutMs = options.timeoutMs ?? 5000
      const requestedBytes = options.maxOutputBytes ?? 32768
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
        throw new Error('Invalid verification limits')
      }
      const maxOutputBytes = Math.min(requestedBytes, 32768)
      const marker = `FM_COMMAND_${randomBytes(16).toString('hex')} `
      const request = buildVerificationInvocation({ executable, broker, home, worker, temp, write: required.write, command, argv: options.argv ?? null, env, protectedRoots, marker, maxOutputBytes, timeoutMs: Math.min(timeoutMs, 3600000) })
      const result = await run(request.command, request.cwd, { ...options, onOutput: null, env: null, argv: request.argv,
        timeoutMs: Math.min(timeoutMs, 3600000) + 1000, graceMs: 250,
        maxOutputBytes: 65536, maxCaptureBytes: 65536 })
      if (result.code !== 0 || result.timedOut || result.outputLimited) return { ...result, code: result.code || 1, completed: false }
      const line = result.output?.split('\n').find(line => line.startsWith(marker))
      let receipt
      try { receipt = JSON.parse(line.slice(marker.length)) } catch {}
      if (!receipt || !Number.isInteger(receipt.code) || receipt.code < 0 || receipt.code > 255
        || typeof receipt.output !== 'string' || typeof receipt.outputLimited !== 'boolean'
        || (receipt.signal !== null && (typeof receipt.signal !== 'string'
          || receipt.code !== 128 + os.constants.signals[receipt.signal]))
      ) {
        return { code: 1, output: 'Native verification command receipt is missing', completed: false }
      }
      const output = Buffer.from(receipt.output, 'base64')
      if (output.length > maxOutputBytes || output.toString('base64') !== receipt.output) {
        return { code: 1, output: 'Native verification command receipt is invalid', completed: false }
      }
      const completed = receipt.completed === true && receipt.timedOut !== true && receipt.runnerCode === 0 && receipt.pipelineCode === 0
        && receipt.pipelineSignal === null && receipt.launchError === null && receipt.runtimeError === null
      return { code: completed ? receipt.code : (receipt.code || 1), output: output.toString(), outputLimited: receipt.outputLimited,
        completed, timedOut: receipt.timedOut === true, runnerCode: receipt.runnerCode ?? null, pipelineCode: receipt.pipelineCode ?? null,
        pipelineSignal: receipt.pipelineSignal ?? null, launchError: receipt.launchError ?? null, runtimeError: receipt.runtimeError ?? null,
        ...(receipt.signal ? { signal: receipt.signal } : {}) }
    }
    const initial = buildVerificationInvocation({ executable, broker, home, worker, temp, write: required.write, command: 'true', env, protectedRoots })
    await writeFile(path.join(home, 'config.toml'), initial.config, { mode: 0o600 })
    await writeFile(path.join(home, 'gitconfig'), '', { mode: 0o600 })
    const nonce = randomBytes(16).toString('hex')
    let connections = 0
    server = createServer(socket => { connections++; socket.destroy() })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const paths = { inside: path.join(temp, 'allowed'), outside: path.join(privateRoot, 'outside'), broker: path.join(broker, 'outside'), git: path.join(protectedDir, 'ref'), temporary: path.join('/tmp', `fm-denied-${nonce}`) }
    deniedTemporary = paths.temporary
    const program = `const fs=require('node:fs'),net=require('node:net');const result={};for(const[key,file]of Object.entries(${JSON.stringify(paths)})){try{fs.writeFileSync(file,'dummy');result[key]=true}catch{result[key]=false}}const socket=net.connect({host:'127.0.0.1',port:${server.address().port}});socket.on('connect',()=>{result.network='allowed';socket.destroy();finish()});socket.on('error',error=>{result.network=error.code;finish()});function finish(){fs.writeSync(1,${JSON.stringify('FM_VERIFY_'+nonce+' ')}+JSON.stringify(result)+'\\n')}setTimeout(()=>process.exit(7),2000).unref();`
    const result = await invoke(process.execPath, worker, { argv: ['-e', program], timeoutMs: 5000 })
    const line = result.output?.split('\n').find(line => line.startsWith(`FM_VERIFY_${nonce} `))
    let observed
    try { observed = JSON.parse(line.slice(nonce.length + 11)) } catch {}
    const exists = async file => { try { await lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
    if (result.code !== 0 || result.timedOut || result.outputLimited || !observed
      || observed.inside !== required.write || await exists(paths.inside) !== required.write
      || ['outside', 'broker', 'git', 'temporary'].some(key => observed[key] !== false)
      || !['EPERM', 'EACCES'].includes(observed.network) || connections !== 0
      || await exists(paths.outside) || await exists(paths.broker) || await exists(paths.git) || await exists(paths.temporary)) {
      throw new Error('Required native verification restrictions were not independently observed')
    }
    await new Promise(resolve => server.close(resolve))
    return { exec: invoke, close, evidence: { kind: 'required', runtime: 'codex-sandbox', platform, write: required.write,
      network: false, sharedRefs: false, publication: false, temporaryFiles: 'private-worker-directory', observed: true } }
  } catch (error) { await close(); throw error }
}

export const codexAdapter = {
  name: 'codex',
  createVerificationExecutor,
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
