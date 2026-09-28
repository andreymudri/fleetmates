import { access, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const legacyOffsets = new Map()
const thirtyDays = 30 * 24 * 60 * 60 * 1000
const spoolName = /^hooks-\d{8}(?:-\d{13}-[a-f0-9]{12})?\.jsonl(?:\.draining)?$/
const legacyName = /^hooks-\d{8}\.jsonl(?:\.draining)?$/

/** Drain completed spool files through the same validator and reorder buffer as the socket. */
export async function drainSpool(dir, ingest) {
  let names
  try { names = await readdir(dir) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  const sorted = names.filter(name => spoolName.test(name)).sort((a, b) => a.replace('.draining', '').localeCompare(b.replace('.draining', '')) || Number(b.endsWith('.draining')) - Number(a.endsWith('.draining')))
  const ordered = [...sorted.filter(name => legacyName.test(name)), ...sorted.filter(name => !legacyName.test(name))]
  const completed = []
  const legacyFiles = []
  const pendingLines = []
  for (const name of ordered) {
    const source = path.join(dir, name)
    const legacy = legacyName.test(name)
    let draining = name.endsWith('.draining') ? source : `${source}.draining`
    if (source !== draining) {
      let occupied = false
      try { await access(draining); occupied = true } catch {}
      if (occupied) draining = source
      else await rename(source, draining)
    }
    if (legacy) await delay(220)
    const info = await stat(draining)
    const previous = legacy ? legacyOffsets.get(draining) : null
    let consumed = previous?.ino === info.ino && previous.lines >= 0 ? previous.lines : 0
    while (true) {
      let content
      try { content = await readFile(draining, 'utf8') } catch (error) { if (error.code === 'ENOENT') break; throw error }
      const lines = content.split('\n')
      const complete = lines.slice(0, -1)
      if (consumed > complete.length) consumed = 0
      const fresh = complete.slice(consumed)
      fresh.sort((a, b) => {
        const time = raw => { try { return JSON.parse(raw).hookTs ?? Infinity } catch { return Infinity } }
        return time(a) - time(b)
      })
      for (const line of fresh) pendingLines.push(line)
      consumed = complete.length
      const latest = await readFile(draining, 'utf8')
      if (latest !== content) continue
      if (lines.at(-1)) ingest.rejectRaw(lines.at(-1), 'spool', 'partial_line')
      break
    }
    if (legacy) legacyFiles.push({ file: draining, ino: info.ino, consumed })
    else completed.push(draining)
  }
  for (const line of pendingLines) ingest.receive(line, 'spool')
  ingest.flush()
  for (let pass = 0; pass < 10; pass++) {
    const late = []
    const next = new Map()
    for (const legacy of legacyFiles) {
      const content = await readFile(legacy.file, 'utf8')
      const complete = content.split('\n').slice(0, -1)
      const from = legacy.consumed <= complete.length ? legacy.consumed : 0
      for (const line of complete.slice(from)) late.push(line)
      next.set(legacy, complete.length)
    }
    if (!late.length) break
    for (const line of late) ingest.receive(line, 'spool')
    ingest.flush()
    for (const legacy of legacyFiles) legacy.consumed = next.get(legacy)
  }
  for (const legacy of legacyFiles) {
    legacyOffsets.set(legacy.file, { ino: legacy.ino, lines: legacy.consumed })
    if (Date.now() - (await stat(legacy.file)).mtimeMs > thirtyDays) {
      await rm(legacy.file)
      legacyOffsets.delete(legacy.file)
    }
  }
  for (const file of completed) await rm(file)
}

/** Drain before serving clients, then poll for spooled hooks every minute. */
export async function startSpoolDrain({ dir, ingest, intervalMs = 60_000, onError = () => {} }) {
  await drainSpool(dir, ingest)
  const timer = setInterval(() => { drainSpool(dir, ingest).catch(onError) }, intervalMs)
  timer.unref()
  return { close() { clearInterval(timer) } }
}
