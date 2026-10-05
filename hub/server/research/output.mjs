import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateDraft, validateScout } from './contract.mjs'
import { apiError } from '../http/router.mjs'
import { rankSources } from './sources.mjs'

export const RESEARCH_ID = /^research-[a-f0-9-]{36}$/
export const OUTPUT_MAX = 256 * 1024

/** A bounded regular file under the selected repository, never a symlink leaf. */
export async function readOutputFile (repo, relative) {
  const root = await fs.realpath(repo)
  const target = path.resolve(root, relative)
  if (!target.startsWith(root + path.sep)) throw apiError(422, 'research_output_invalid')
  let directory = root
  for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
    directory = path.join(directory, part)
    const entry = await fs.lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw apiError(422, 'research_output_invalid')
  }
  const parent = await fs.realpath(path.dirname(target))
  if (!parent.startsWith(root + path.sep)) throw apiError(422, 'research_output_invalid')
  const handle = await fs.open(path.join(parent, path.basename(target)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > OUTPUT_MAX) throw apiError(422, 'research_output_invalid')
    // Read a fixed-size buffer, rather than trusting a size that may change.
    const buffer = Buffer.alloc(OUTPUT_MAX + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    if (bytes > OUTPUT_MAX) throw apiError(422, 'research_output_invalid')
    return buffer.subarray(0, bytes).toString('utf8')
  } finally { await handle.close() }
}

/** Read only the fixed output names, with a content revision for future preview freshness. */
export async function readResearchOutput (repo, id, domain) {
  if (!RESEARCH_ID.test(id)) throw apiError(422, 'validation_failed')
  const dir = `out/${id}`
  try {
    const [json, body] = await Promise.all([readOutputFile(repo, `${dir}/draft.json`), readOutputFile(repo, `${dir}/draft.md`)])
    const validated = validateDraft(JSON.parse(json), body, { domain })
    return { state: 'drafted', ...validated, revision: createHash('sha256').update(json).update('\0').update(body).digest('hex') }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'running' }
    throw apiError(422, 'research_output_invalid')
  }
}

/** Scout reads are explicit task IDs, never paths supplied by an agent. */
export async function readScoutOutput (repo, id, task) {
  if (!RESEARCH_ID.test(id) || !/^T[1-9]\d{0,3}$/.test(task)) throw apiError(422, 'validation_failed')
  try {
    const result = validateScout(JSON.parse(await readOutputFile(repo, `out/${id}/scouts/${task}.json`)))
    if (result.task !== task) throw apiError(422, 'research_output_invalid')
    if (result.sources.some(source => source.publishedAt !== undefined || source.engagement !== undefined)) {
      result.sources = rankSources(result.sources, Math.max(...result.sources.map(source => Date.parse(source.accessed))))
    }
    return result
  } catch { throw apiError(422, 'research_output_invalid') }
}
