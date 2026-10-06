import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const COMMAND_LOG_BYTES = 16 * 1024 * 1024

// Local output observations outside disposable worktrees. A private file and a
// content hash do not authenticate execution or prevent the operator changing it.
export async function createCommandLog({ maxBytes = COMMAND_LOG_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COMMAND_LOG_BYTES) throw new Error('Invalid command log byte bound')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fm-command-log-')))
  const file = path.join(directory, 'output.log')
  const fd = fs.openSync(file, 'wx', 0o600)
  const hash = createHash('sha256')
  let bytes = 0, observedBytes = 0, error = null, finished = null
  const write = chunk => {
    if (finished) throw new Error('Command log is already closed')
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    observedBytes += buffer.length
    if (error) return
    const selected = buffer.subarray(0, Math.max(0, maxBytes - bytes))
    try {
      let offset = 0
      while (offset < selected.length) {
        const count = fs.writeSync(fd, selected, offset, selected.length - offset)
        if (count === 0) throw new Error('Command log write made no progress')
        hash.update(selected.subarray(offset, offset + count))
        bytes += count
        offset += count
      }
    } catch (failure) { error = failure.code ?? 'write-error' }
  }
  const finish = ({ complete = true } = {}) => {
    if (finished) return finished
    try { fs.closeSync(fd) } catch (failure) { error = failure.code ?? 'close-error' }
    finished = { path: file, bytes, observedBytes, maxBytes, sha256: hash.digest('hex'),
      complete: complete && !error && observedBytes === bytes,
      truncated: observedBytes > bytes, error }
    return finished
  }
  return { write, finish }
}
