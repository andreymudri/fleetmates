import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
const hub = fileURLToPath(new URL('../..', import.meta.url))
const load = async file => (await runnerImport(path.join(hub, 'web/src/screens/memory', file), { configFile: false, logLevel: 'silent', root: hub })).module
const render = (component, props) => renderToStaticMarkup(createElement(component, props))

test('note excerpt follows the cited section and note preview renders safe text and usage', async () => {
  const { noteExcerpt, NotePanel } = await load('NotePanel.jsx')
  const body = '## First\nFirst section\n## Second\nSecond section\n<script>alert(1)</script>\n[bad](javascript:alert(1))'
  assert.match(noteExcerpt(body, 4), /^## Second/)
  const html = render(NotePanel, { line: 4, result: { note: { path: 'x.md', title: 'Title\u202e', body, frontmatter: {} }, backlinks: [{ path: '02-wiki/x/x-moc.md', title: 'Index' }], usage: { citedIn: [{ threadId: 't', title: 'Retries' }], readBy: [{ repoName: 'test', tool: 'vault_get_note', at: 1 }] } } })
  assert.doesNotMatch(html, /<script|href="javascript:|\u202e/)
  assert.match(html, /U\+202E/)
  assert.match(html, /Backlinks · 1/)
  assert.match(html, /Cited today in the thread/)
  assert.match(html, /Read by the/)
  const realLine = render(NotePanel, { line: 13, result: { note: { path: 'worker.md', body: '# Worker\nIntro\n\n## Retry\nBackoff\n\n## Concurrency\nParallel jobs', frontmatter: { tipo: 'wiki', tags: 'nestjs, filas', status: 'ativo', criado: '2026-01-01', atualizado: '2026-01-01' } } } })
  assert.match(realLine, /Backoff/)
  assert.doesNotMatch(realLine, /Parallel jobs/)
  assert.match(realLine, /<span>nestjs<\/span>/)
})
test('Ask separates general knowledge, limits sources and excludes streaming text from its live log', async () => {
  const { AskPanel } = await load('AskPanel.jsx')
  const citations = Array.from({ length: 8 }, (_, i) => ({ path: `note-${i}.md`, line: 1 }))
  const html = render(AskPanel, { asking: true, messages: [{ id: 'a', role: 'assistant', text: 'note-0.md:1 unknown.md:2 <script>x</script>', status: 'complete', citations, generalKnowledge: 'Separate general text', unverified: true }, { id: 'b', role: 'assistant', text: 'Streaming sentinel', status: 'streaming' }] })
  assert.match(html, /\+2 sources/)
  assert.match(html, /class="ask-general"[\s\S]*Separate general text/)
  assert.doesNotMatch(html, /class="ask-answer"[^]*Separate general text[^]*<\/div><section/)
  assert.equal((html.match(/class="citation citation--source"/g) ?? []).length, 7)
  assert.match(html, /unknown.md:2/)
  assert.doesNotMatch(html, /href="[^"]*unknown.md|<script/)
  assert.match(html, /aria-live="off"[^]*Streaming sentinel/)
  assert.doesNotMatch(html.split('class="ask-stream"')[0], /Streaming sentinel/)
  assert.match(render(AskPanel, { down: true }), /<textarea[^>]*disabled/)
})
test('lists group by domain, show capture attribution and keep bidi controls visible', async () => {
  const { BrowseView, CapturesView, MissesView, browseGroups } = await load('MemoryLists.jsx')
  const notes = [{ path: '02-wiki/git/a.md', area: '02-wiki' }, { path: '02-wiki/nestjs/b.md', area: '02-wiki' }]
  assert.deepEqual(browseGroups(notes).map(group => group.domain), ['git', 'nestjs'])
  assert.match(render(BrowseView, { notes }), /git · 1/)
  assert.match(render(CapturesView, { captures: [{ path: 'x.md', sessionId: 's', repoName: 'test', capturedAt: 1 }] }), /from <bdi>test/)
  assert.doesNotMatch(render(CapturesView, { captures: [{ path: 'x.md' }] }), /from /)
  assert.match(render(MissesView, { misses: [{ id: 'm', question: 'Question\u202e', createdAt: 1 }] }), /U\+202E/)
})
test('Memory screen renders graph totals, local note panel, absent-tool state and degradation', async () => {
  const { MemoryView } = await load('Memory.jsx')
  const graph = { nodes: [{ id: '00-index/index-knowledge.md', title: 'Index' }, { id: '02-wiki/x/x-moc.md', title: 'X' }], edges: [{ source: '00-index/index-knowledge.md', target: '02-wiki/x/x-moc.md' }], counts: { notes: 22, edges: 34 } }
  const html = render(MemoryView, { graph, vault: { state: 'ok' } })
  assert.match(html, /Clustered by domain · 22 notes · 34 links/)
  assert.equal((html.match(/tabindex="0" aria-label=/g) ?? []).length, 1)
  const local = render(MemoryView, { graph, vault: { state: 'ok' }, route: { path: '02-wiki/x/x-moc.md' }, note: { note: { path: '02-wiki/x/x-moc.md', body: '', title: 'X' }, backlinks: [] } })
  assert.match(local, /Local graph · x-moc · 2 hops/)
  assert.match(local, /aria-pressed="true"/)
  const missing = render(MemoryView, { graph, vault: { state: 'degraded' }, error: { code: 'vault_tool_missing' } })
  assert.match(missing, /does not provide a graph/)
  assert.doesNotMatch(missing, /The charts are out of reach/)
  const down = render(MemoryView, { vault: { state: 'down', reason: 'spawn ENOENT' } })
  assert.match(down, /spawn ENOENT/)
  assert.doesNotMatch(down, /aria-label="Ask your vault"|aria-label="Knowledge graph"/)
})
