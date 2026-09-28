import { readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Drain completed spool files through the same validator and reorder buffer as the socket. */
export async function drainSpool(dir, ingest) {
  let names
  try { names = await readdir(dir) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const name of names.filter(name => /^hooks-\d{8}\.jsonl(?:\.draining)?$/.test(name)).sort((a, b) => a.replace('.draining', '').localeCompare(b.replace('.draining', '')) || Number(b.endsWith('.draining')) - Number(a.endsWith('.draining')))) {
    const source = path.join(dir, name)
    const draining = name.endsWith('.draining') ? source : `${source}.draining`
    if (source !== draining) await rename(source, draining)
    await delay(220)
    let consumed = 0
    while (true) {
      let content
      try { content = await readFile(draining, 'utf8') } catch (error) { if (error.code === 'ENOENT') break; throw error }
      const lines = content.split('\n')
      const complete = lines.slice(0, -1)
      const fresh = complete.slice(consumed)
      fresh.sort((a, b) => {
        const time = raw => { try { return JSON.parse(raw).hookTs ?? Infinity } catch { return Infinity } }
        return time(a) - time(b)
      })
      for (const line of fresh) ingest.receive(line, 'spool')
      ingest.flush()
      consumed = complete.length
      const latest = await readFile(draining, 'utf8')
      if (latest !== content) continue
      if (lines.at(-1)) ingest.rejectRaw(lines.at(-1), 'spool', 'partial_line')
      break
    }
    await rm(draining)
  }
}

/** Drain before serving clients, then poll for spooled hooks every minute. */
export async function startSpoolDrain({ dir, ingest, intervalMs = 60_000, onError = () => {} }) {
  await drainSpool(dir, ingest)
  const timer = setInterval(() => { drainSpool(dir, ingest).catch(onError) }, intervalMs)
  timer.unref()
  return { close() { clearInterval(timer) } }
}
