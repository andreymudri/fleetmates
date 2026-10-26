export function validUiTarget(file) {
  return typeof file === 'string' && file.length <= 1024 && !/[\\:\p{C}\p{Zl}\p{Zp}]/u.test(file)
    && !file.startsWith('/') && !file.split('/').some(part => !part || part === '.' || part === '..')
    && /\.(md|html|svg)$/i.test(file)
}

export async function readUiTargets({ git, commit, tasks }) {
  const items = [], seen = new Set()
  for (const task of tasks) {
    for (const file of task.ui ?? []) {
      if (!validUiTarget(file)) throw new Error('UI targets must be plain repository-relative Markdown, HTML or SVG paths')
      if (seen.has(file)) continue
      seen.add(file)
      const mode = await git.fileModeAtCommit(commit, `:(literal)${file}`)
      if (!['100644', '100755'].includes(mode)) throw new Error('UI target must be a committed regular file at the plan anchor')
      if (await git.fileSizeAtCommit(commit, file) > 512 * 1024) throw new Error('UI target exceeds 512 KiB')
      const text = await git.fileAtCommit(commit, file)
      items.push({ id: `ui-target-${items.length + 1}`, source: file, startLine: 1, endLine: text.split(/\r?\n/).length,
        text, mandatory: true, reason: 'explicit tracked visual target; structure is not rendered or behavioral verification' })
    }
  }
  return items
}
