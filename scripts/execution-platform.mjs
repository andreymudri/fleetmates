import { constants as fsConstants } from 'node:fs'

// The one sentence every strict-execution refusal prints.
export const STRICT_EXECUTION_UNSUPPORTED = 'strict execution needs POSIX no-follow, nonblocking reads and private file modes; it is not supported on Windows'

// Whether this platform can run strict execution: not on win32, and not where either
// `O_NOFOLLOW` or `O_NONBLOCK` is missing from `fs.constants`.
export function strictExecutionSupport({ platform = process.platform, constants = fsConstants } = {}) {
  if (platform === 'win32' || typeof constants?.O_NOFOLLOW !== 'number' || typeof constants?.O_NONBLOCK !== 'number') {
    return { supported: false, reason: STRICT_EXECUTION_UNSUPPORTED }
  }
  return { supported: true, reason: null }
}
