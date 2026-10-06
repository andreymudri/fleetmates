import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadScenario, renderNoteFile } from '../fakes/fake-vault-mcp.mjs'

/**
 * Materialize an invented vault for read-only contract and performance tests, without Git.
 * Generated trees are deterministic; the canvas tree shares the fake server's scenario.
 * @param {{ kind?: 'vault22' | 'small' | { notes: number }, dir?: string }} options
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
export async function makeVaultTree ({ kind = 'vault22', dir = os.tmpdir() } = {}) {
  const root = await mkdtemp(path.join(dir, 'vault-'))
  try {
    let notes
    if (kind === 'vault22') {
      notes = loadScenario().notes.map(note => ({
        path: note.path, text: renderNoteFile({ frontmatter: note.frontmatter, body: note.body.trimEnd().split('\n') }),
        mtimeMs: note.mtimeMs
      }))
    } else {
      const count = kind === 'small' ? 10 : kind.notes
      if (!Number.isInteger(count) || count < 10 || count > 100000) throw new RangeError('notes must be an integer from 10 to 100000')
      notes = Array.from({ length: count }, (_, i) => {
        const name = i === 0 ? '00-index/index-knowledge.md' : i <= 8
          ? `02-wiki/domain-${i - 1}/domain-${i - 1}-moc.md`
          : `02-wiki/domain-${i % 8}/note-${i}.md`
        return { path: name, mtimeMs: Date.UTC(2026, 0, 1), index: i }
      })
      notes = notes.map(note => ({ ...note, text: renderNoteFile({
        frontmatter: { tipo: note.index <= 8 ? 'moc' : 'wiki', tags: [`domain-${note.index % 8}`], status: 'ativo', criado: '2026-01-01', atualizado: '2026-01-01' },
        body: [`# ${path.posix.basename(note.path, '.md')}`, '', ...Array.from({ length: 5 }, (_, k) => `- [[${notes[(note.index + k + 1) % count].path.replace(/\.md$/, '')}]]`)]
      }) }))
    }
    for (const note of notes) {
      const file = path.join(root, note.path)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, note.text)
      await utimes(file, note.mtimeMs / 1000, note.mtimeMs / 1000)
    }
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
