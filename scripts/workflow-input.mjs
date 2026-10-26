import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
const MAX_BYTES = 1024 * 1024

export async function readWorkflowInput(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Workflow input must be a regular file')
    if (info.size > MAX_BYTES) throw new Error('Workflow input exceeds 1 MiB')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > MAX_BYTES) throw new Error('Workflow input exceeds 1 MiB')
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'))
  } finally { await handle.close() }
}
