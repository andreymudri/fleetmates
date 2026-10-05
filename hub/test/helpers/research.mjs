import fs from 'node:fs/promises'
import path from 'node:path'
import { createResearchService } from '../../server/research/service.mjs'

export const researchRequest = () => ({ topic: 'Session lock lifetime', preset: 'standard', domain: 'concurrency', sourceTypes: ['docs', 'repo'], focusNotes: '', repoKey: 'research-fixture' })
export const researchDraft = () => ({ title: 'Session locks', domain: 'concurrency', tags: ['research'], links: ['existing-note'], contexto: 'Synthetic research', sources: [{ n: 1, id: 'T1-s1', url: 'https://example.org/locks', title: 'Lock lifetime', why: 'Primary reference', backs: ['Session owns the lock.'] }], rejected: [{ url: 'https://example.org/old', title: 'Old article', reason: 'Outdated' }] })
export const researchBody = 'The session owns the lock. [1]\n\nExtends [[existing-note]].\n\n## Sources\n\n1. [Lock lifetime](https://example.org/locks): primary reference.'
export async function writeResearchDraft (repo, id, { draft = researchDraft(), body = researchBody } = {}) {
  const dir = path.join(repo, 'out', id)
  await fs.writeFile(path.join(dir, 'draft.json'), JSON.stringify(draft))
  await fs.writeFile(path.join(dir, 'draft.md'), body)
}
export async function seedResearch (h) {
  const repo = path.join(h.home, 'research-fixture')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
  h.deck.store.run('INSERT INTO repos(id,name,crew_seed,crew_slot,first_seen_at) VALUES(?,?,?,?,?)', repo, 'research-fixture', 'research-fixture', 0, 1)
  const launches = [], stopped = []
  const service = createResearchService({ store: h.deck.store, preferences: () => ({ prefs: { lang: 'en' } }), publish: event => h.events.push(event),
    launcher: { async launch (root, body) {
      launches.push({ root, body })
      const session = h.deck.projector.create({ id: `research-lead-${launches.length}`, repo_id: root, cwd: root, task: body.task, launch_task: body.task, origin: 'launched', pty_id: `fake-${launches.length}`, process_key: `fake-${launches.length}` })
      return { data: { session } }
    }, async stop (id) { stopped.push(id); return { status: 202, data: {} } } } })
  const result = await service.launch(repo, researchRequest())
  return { repo, id: result.data.research.id, service, launches, stopped, research: result.data.research }
}
