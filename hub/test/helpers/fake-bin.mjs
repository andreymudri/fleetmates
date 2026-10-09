import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * The npm cmd-shim body for a node script, CRLF line endings, with `_prog` falling back to `node`
 * replaced by the absolute node path, so the shim does not depend on node being on PATH.
 * @param {string} node absolute node path
 * @param {string} rel the script relative to the shim's directory, backslash separated
 * @returns {string}
 */
export function cmdShim (node, rel) {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    `  SET "_prog=${node}"`,
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    ''
  ].join('\r\n')
}

/**
 * Put a fake `claude` first on PATH. The wrapper execs the fake from
 * test/fake-claude/ at run time; the fake need not exist when this is called.
 * On Windows (or under FLEETMATES_TEST_FORCE_WINDOWS=1, which only changes the file written) the
 * wrapper is `claude.cmd`, an npm cmd-shim (see cmdShim) addressing fake-claude.mjs relative to binDir;
 * when no relative path exists (binDir on another drive) it addresses a `fake-claude-entry.mjs`
 * written into binDir that imports the real fake. Elsewhere it is a `#!/bin/sh` script named `claude`.
 * `relative` is injectable so a test can take the other-drive branch.
 * @param {{ script?: string, log?: string, version?: string, platform?: NodeJS.Platform, relative?: (from: string, to: string) => string }} opts
 * @returns {Promise<{ binDir: string, claudePath: string, env: NodeJS.ProcessEnv, cleanup: () => Promise<void> }>}
 */
export async function fakeBin ({ script, log, version = '2.1.282', platform = process.platform, relative = path.relative } = {}) {
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'deck-fake-bin-'))
  const windows = platform === 'win32' || process.env.FLEETMATES_TEST_FORCE_WINDOWS === '1'
  const claudePath = path.join(binDir, windows ? 'claude.cmd' : 'claude')
  if (windows) {
    let rel = relative(binDir, fakeClaude)
    if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
      rel = 'fake-claude-entry.mjs'
      await writeFile(path.join(binDir, rel), `await import(${JSON.stringify(pathToFileURL(fakeClaude).href)})\n`)
    }
    await writeFile(claudePath, cmdShim(process.execPath, rel.split(/[\\/]/).join('\\')), { mode: 0o755 })
  } else {
    await writeFile(claudePath, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(fakeClaude)} "$@"\n`, { mode: 0o755 })
  }
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
