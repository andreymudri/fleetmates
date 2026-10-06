import path from 'node:path'
import { buildContextBundle } from './context-bundle.mjs'

export function selectLearnings(markdown, files) {
  if (typeof markdown !== 'string' || !Array.isArray(files) || files.some(f => typeof f !== 'string')) throw new Error('Invalid learning context inputs')
  const lines = markdown.split(/\r?\n/), entries = []
  let current = null
  for (const [index, line] of lines.entries()) {
    const heading = /^## (\d{4}-\d{2}-\d{2}) run: ([A-Za-z0-9._/-]+)(?: scope: (.+))?$/.exec(line)
    if (heading) {
      current = { date: heading[1], run: heading[2], scope: heading[3] ?? 'global', startLine: index + 1, endLine: index + 1, lines: [line] }
      entries.push(current)
    } else if (current) { current.lines.push(line); current.endLine = index + 1 }
  }
  // Preserve older free-form human guidance instead of silently dropping it.
  if (!entries.length) return markdown.trim() ? [{ id: 'legacy-global', text: markdown, source: 'fleetmates.learnings.md', startLine: 1, endLine: lines.length, mandatory: true, reason: 'legacy human guidance preserved as advisory global context' }] : []
  const selected = []
  const first = entries[0].startLine - 1
  const preface = lines.slice(0, first).join('\n')
  if (preface.trim()) selected.push({ id: 'learning-preface', text: preface, source: 'fleetmates.learnings.md', startLine: 1, endLine: first, mandatory: true, reason: 'human-owned global preface' })
  for (const entry of entries) {
    const global = entry.scope === 'global'
    const globs = entry.scope.split(',').map(v => v.trim())
    if (globs.length > 50 || globs.some(g => !g || g.length > 512)) throw new Error('Learning scope must contain bounded nonempty globs')
    if (!global && !files.some(file => globs.some(glob => path.matchesGlob(file, glob)))) continue
    selected.push({ id: `learning-${entry.startLine}`, text: entry.lines.join('\n'), source: 'fleetmates.learnings.md', startLine: entry.startLine,
      endLine: entry.endLine, mandatory: global, reason: global ? 'human-owned global advisory guidance' : 'learning scope matches task-owned path', date: entry.date, run: entry.run })
  }
  return selected
}

export async function learningBundles({ git, commit, tasks, role = 'implementer', maxBytes = 24000 }) {
  if (!git || !commit) return {}
  const file = 'fleetmates.learnings.md'
  const mode = await git.fileModeAtCommit(commit, `:(literal)${file}`)
  if (!mode) return {}
  if (!['100644', '100755'].includes(mode)) throw new Error('Learning guidance must be a tracked regular file')
  if (await git.fileSizeAtCommit(commit, file) > 512 * 1024) throw new Error('Learning guidance exceeds 512 KiB; owner must condense it')
  const markdown = await git.fileAtCommit(commit, file)
  const bundles = {}
  for (const task of tasks) {
    const items = selectLearnings(markdown, task.files)
    if (items.length) bundles[task.id] = buildContextBundle({ task: task.id, role, commit, items, maxBytes, vault: 'unavailable' })
  }
  return bundles
}
export async function learningBundle({ task, ...options }) {
  return (await learningBundles({ ...options, tasks: [task] }))[task.id] ?? null
}
