import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fakeClaude = path.join(hubDir, 'test', 'fake-claude', 'fake-claude.mjs')

/**
 * Quote a string for a POSIX shell script.
 * @param {string} s
 * @returns {string}
 */
function shq (s) {
  return `'${s.replaceAll("'", "'\\''")}'`
}

/**
 * Put a fake `claude` first on PATH. The wrapper execs the fake from
 * test/fake-claude/ at run time; the fake need not exist when this is called.
 * On Windows (or under FLEETMATES_TEST_FORCE_WINDOWS=1, which only changes the file written) the
 * wrapper is `claude.cmd` with CRLF line endings; elsewhere it is a `#!/bin/sh` script named `claude`.
 * @param {{ script?: string, log?: string, version?: string, platform?: NodeJS.Platform }} opts
 * @returns {Promise<{ binDir: string, claudePath: string, env: NodeJS.ProcessEnv, cleanup: () => Promise<void> }>}
 */
export async function fakeBin ({ script, log, version = '2.1.282', platform = process.platform } = {}) {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'deck-fake-bin-'))
  const windows = platform === 'win32' || process.env.FLEETMATES_TEST_FORCE_WINDOWS === '1'
  const claudePath = path.join(binDir, windows ? 'claude.cmd' : 'claude')
  const wrapper = windows
    ? `@"${process.execPath}" "${fakeClaude}" %*\r\n`
    : `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(fakeClaude)} "$@"\n`
  await writeFile(claudePath, wrapper, { mode: 0o755 })
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    FAKE_CLAUDE_VERSION: version
  }
  if (script !== undefined) env.FAKE_CLAUDE_SCRIPT = script
  if (log !== undefined) env.FAKE_CLAUDE_LOG = log
  const cleanup = () => rm(binDir, { recursive: true, force: true })
  return { binDir, claudePath, env, cleanup }
}
