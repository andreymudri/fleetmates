// Platform simulator: runs a command on a Linux or macOS machine under the conditions that most
// often break code on other hosts. The temp dir is reached through a symlink whose path holds a
// space, git checks out with core.autocrlf=true, and on POSIX the child runs under umask 077.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const SIM_CONDITIONS = ['symlinked-tmpdir', 'space-in-tmpdir', 'autocrlf', 'umask-077']

const SCRATCH_PREFIX = 'fm-platform-sim-'
const OVERRIDDEN = ['TMPDIR', 'TMP', 'TEMP', 'GIT_CONFIG_GLOBAL']

// Sets the umask for this process only, then runs the real command with inherited stdio.
// process.argv after `node -e <code> --` is the command's own argv.
const UMASK_TRAMPOLINE = `
const { execFileSync } = require('node:child_process')
const { constants } = require('node:os')
process.umask(0o077)
const [cmd, ...args] = process.argv.slice(1)
try {
  execFileSync(cmd, args, { stdio: 'inherit' })
} catch (err) {
  if (typeof err.status === 'number') process.exit(err.status)
  if (err.signal) process.exit(128 + (constants.signals[err.signal] ?? 0))
  process.stderr.write('platform-sim: could not run ' + JSON.stringify(cmd) + ': ' + err.message + '\\n')
  process.exit(127)
}
`

// The global config files git reads when GIT_CONFIG_GLOBAL is unset, in the order it reads
// them (a later file wins); or the one GIT_CONFIG_GLOBAL already names.
function previousGlobalConfigs(baseEnv, homedir) {
  if (baseEnv.GIT_CONFIG_GLOBAL) return existsSync(baseEnv.GIT_CONFIG_GLOBAL) ? [baseEnv.GIT_CONFIG_GLOBAL] : []
  const xdgHome = baseEnv.XDG_CONFIG_HOME || path.join(homedir, '.config')
  return [path.join(xdgHome, 'git', 'config'), path.join(homedir, '.gitconfig')].filter((p) => existsSync(p))
}

// JSON string quoting is valid git config quoting for a path: backslashes and double quotes
// are escaped the same way.
function gitConfigText(includes) {
  const lines = []
  for (const p of includes) lines.push('[include]', `\tpath = ${JSON.stringify(p)}`)
  lines.push('[core]', '\tautocrlf = true')
  return lines.join('\n') + '\n'
}

// The command may leave directories it made read-only, which rm cannot empty. Give every
// directory back u+rwx before removing, using lstat so a symlink is never followed out of the
// scratch directory.
async function restoreWrite(dir) {
  let st
  try { st = await lstat(dir) } catch { return }
  if (!st.isDirectory()) return
  if ((st.mode & 0o700) !== 0o700) await chmod(dir, (st.mode & 0o7777) | 0o700)
  for (const name of await readdir(dir)) await restoreWrite(path.join(dir, name))
}

// The system git config (GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM) passes through untouched: the
// simulator layers its conditions over the user's whole git setup rather than replacing it.
// symlinkImpl is a test seam; callers leave it at fs.symlink.
export async function buildSimEnv({ baseEnv = process.env, platform = process.platform, homedir = os.homedir(), symlinkImpl = symlink } = {}) {
  const realBase = await realpath(os.tmpdir())
  const scratch = await mkdtemp(path.join(realBase, SCRATCH_PREFIX))
  const cleanup = async () => {
    await restoreWrite(scratch)
    await rm(scratch, { recursive: true, force: true })
  }
  try {
    const applied = []
    const skipped = []
    const target = path.join(scratch, 'target')
    await mkdir(target)
    let simTmp = path.join(scratch, 'sim link')
    if (platform === 'win32') {
      skipped.push({ name: 'symlinked-tmpdir', reason: 'creating a symlink on Windows needs a privilege a normal shell lacks' })
      simTmp = path.join(scratch, 'sim tmp')
      await mkdir(simTmp)
    } else {
      try {
        await symlinkImpl(target, simTmp, 'dir')
        applied.push('symlinked-tmpdir')
      } catch (err) {
        skipped.push({ name: 'symlinked-tmpdir', reason: `could not create the symlink: ${err.code ?? err.message}` })
        simTmp = path.join(scratch, 'sim tmp')
        await mkdir(simTmp)
      }
    }
    applied.push('space-in-tmpdir')

    const gitConfig = path.join(scratch, 'gitconfig')
    await writeFile(gitConfig, gitConfigText(previousGlobalConfigs(baseEnv, homedir)))
    applied.push('autocrlf')

    if (platform === 'win32') skipped.push({ name: 'umask-077', reason: 'Windows has no umask' })
    else applied.push('umask-077')

    const env = {}
    for (const [k, v] of Object.entries(baseEnv)) {
      if (!OVERRIDDEN.includes(k.toUpperCase())) env[k] = v
    }
    Object.assign(env, { TMPDIR: simTmp, TMP: simTmp, TEMP: simTmp, GIT_CONFIG_GLOBAL: gitConfig })
    return { env, applied, skipped, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

// buildEnv is a test seam; callers leave it at buildSimEnv.
export async function runPlatformSim(argv, { cwd, onOutput = (chunk) => process.stdout.write(chunk), platform = process.platform, baseEnv = process.env, buildEnv = buildSimEnv } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('runPlatformSim needs a command')
  const sim = await buildEnv({ baseEnv, platform })
  // A cleanup failure is reported, never thrown: it must not replace the command's exit code
  // or the spawn error.
  const cleanup = async () => {
    try {
      await sim.cleanup()
    } catch (err) {
      onOutput(`platform-sim: could not remove the scratch directory: ${err.message}\n`)
    }
  }
  let code
  try {
    const umask = sim.applied.includes('umask-077')
    // argv[0] is spawned without a shell, so resolving Windows .cmd shims is the caller's concern.
    const [file, args] = umask
      ? [process.execPath, ['-e', UMASK_TRAMPOLINE, '--', ...argv]]
      : [argv[0], argv.slice(1)]
    code = await new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd, env: sim.env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', onOutput)
      child.stderr.on('data', onOutput)
      child.on('error', reject)
      child.on('close', (status, signal) => {
        resolve(typeof status === 'number' ? status : 128 + (os.constants.signals[signal] ?? 0))
      })
    })
  } finally {
    await cleanup()
  }
  return { code, applied: sim.applied, skipped: sim.skipped }
}
