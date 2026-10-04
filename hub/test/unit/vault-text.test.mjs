// Parsers for the vault-mcp 0.3.0 text answers (docs/deck/10-memory-and-research.md 4.3,
// docs/deck/reference/vault-turbid-contract.md 1.5 and 1.6). The answers below are written by hand
// from the contract's EN labels; U+2014 is built from an escape, never typed.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EM, parseList, parseNote, parseBacklinks, parseSearch, stripDiagnostics
} from '../../server/adapters/vault-text.mjs'

const D = '\u2014'

test('the separator constant is U+2014', () => {
  assert.equal(EM, D)
  assert.equal(EM.codePointAt(0), 0x2014)
})

test('parseList reads every field of each note line, a lone separator meaning empty', () => {
  const text = [
    '3 note(s):',
    `- 00-index/index-knowledge.md ${D} Índice do conhecimento (tipo: moc, status: ${D}, tags: ${D})`,
    `- 02-wiki/nestjs/bullmq-worker.md ${D} BullMQ worker (tipo: wiki, status: ativo, tags: nestjs, filas)`,
    `- 03-projects/fila-emails/fila-emails.md ${D} Fila de e-mails (tipo: ${D}, status: rascunho, tags: projeto)`
  ].join('\n')
  const { notes, skipped } = parseList(text)
  assert.equal(skipped, 0)
  assert.deepEqual(notes, [
    { path: '00-index/index-knowledge.md', title: 'Índice do conhecimento', tipo: 'moc', status: null, tags: [], domain: null },
    { path: '02-wiki/nestjs/bullmq-worker.md', title: 'BullMQ worker', tipo: 'wiki', status: 'ativo', tags: ['nestjs', 'filas'], domain: 'nestjs' },
    { path: '03-projects/fila-emails/fila-emails.md', title: 'Fila de e-mails', tipo: null, status: 'rascunho', tags: ['projeto'], domain: null }
  ])
})

test('parseList keeps a title that itself holds " (tipo: " text', () => {
  const text = `1 note(s):\n- 02-wiki/patterns/x.md ${D} Notas (tipo: rascunho) sobre filas (tipo: wiki, status: ativo, tags: a)`
  const { notes } = parseList(text)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].title, 'Notas (tipo: rascunho) sobre filas')
  assert.equal(notes[0].tipo, 'wiki')
})

test('parseList skips and counts a line that does not parse, and reads the empty answer', () => {
  const text = [
    '2 note(s):',
    '- 02-wiki/docker/a.md - Hífen no lugar do travessão (tipo: wiki, status: ativo, tags: a)',
    `- 02-wiki/docker/b.md ${D} Boa (tipo: wiki, status: ativo, tags: a)`
  ].join('\n')
  const { notes, skipped } = parseList(text)
  assert.equal(skipped, 1)
  assert.deepEqual(notes.map(n => n.path), ['02-wiki/docker/b.md'])
  assert.deepEqual(parseList('No notes match those filters.'), { notes: [], skipped: 0 })
})

test('parseList ignores the diagnostics footer', () => {
  const text = [
    '1 note(s):',
    `- 02-wiki/docker/b.md ${D} Boa (tipo: wiki, status: ativo, tags: a)`,
    '',
    'Warning: 2 file(s) with an indexing problem',
    '  01-raw/x.md: invalid frontmatter',
    '  01-raw/y.md: hard link'
  ].join('\n')
  assert.deepEqual(parseList(text), {
    notes: [{ path: '02-wiki/docker/b.md', title: 'Boa', tipo: 'wiki', status: 'ativo', tags: ['a'], domain: 'docker' }],
    skipped: 0
  })
})

const NOTE_FIRST = [
  `02-wiki/nestjs/bullmq-worker.md ${D} BullMQ worker`,
  'Frontmatter:',
  '  tipo: wiki',
  '  tags: nestjs, filas',
  '  status: ativo',
  '  criado: 2026-08-20',
  '  atualizado: 2026-08-26',
  'Links: 02-wiki/nestjs/auth-guard.md, 02-wiki/patterns/retry-backoff.md',
  'Broken links: (none)',
  '',
  '# BullMQ worker',
  'Worker que consome a fila.',
  '',
  '## Retry e backoff',
  ''
].join('\n')

test('parseNote reads the header, the frontmatter block, the links and the raw body of a first page', () => {
  const note = parseNote(NOTE_FIRST)
  assert.deepEqual(note, {
    path: '02-wiki/nestjs/bullmq-worker.md',
    title: 'BullMQ worker',
    frontmatter: { tipo: 'wiki', tags: 'nestjs, filas', status: 'ativo', criado: '2026-08-20', atualizado: '2026-08-26' },
    frontmatterCut: false,
    links: ['02-wiki/nestjs/auth-guard.md', '02-wiki/patterns/retry-backoff.md'],
    brokenLinks: [],
    body: '# BullMQ worker\nWorker que consome a fila.\n\n## Retry e backoff\n',
    offset: 0,
    truncated: false,
    total: 63,
    nextOffset: null,
    skipped: 0
  })
})

test('parseNote reads a cut note with its continuation marker, and a continuation page', () => {
  const body = 'x'.repeat(30)
  const first = [
    `02-wiki/docker/longa.md ${D} Nota longa`,
    'Frontmatter:',
    '  (none)',
    'Links: (none)',
    'Broken links: mutex-antigo, outra',
    '',
    body,
    '[\u2026note cut at 20000 of 45123 characters; continue with offset: 20000]'
  ].join('\n')
  const a = parseNote(first)
  assert.equal(a.body, body)
  assert.equal(a.truncated, true)
  assert.equal(a.total, 45123)
  assert.equal(a.nextOffset, 20000)
  assert.deepEqual(a.frontmatter, {})
  assert.deepEqual(a.links, [])
  assert.deepEqual(a.brokenLinks, ['mutex-antigo', 'outra'])

  const second = [
    `02-wiki/docker/longa.md ${D} Nota longa`,
    '[slice starting at character 40000 of 45123]',
    '',
    'cauda da nota'
  ].join('\n')
  const b = parseNote(second)
  assert.equal(b.path, '02-wiki/docker/longa.md')
  assert.equal(b.offset, 40000)
  assert.equal(b.total, 45123)
  assert.equal(b.body, 'cauda da nota')
  assert.equal(b.truncated, false)
  assert.equal(b.nextOffset, null)
  assert.equal(b.frontmatter, null)
  assert.equal(b.links, null)
})

test('parseNote marks a cut frontmatter block and counts a block line it cannot read', () => {
  const text = [
    `a.md ${D} A`,
    'Frontmatter:',
    '  tipo: wiki',
    '  semdoispontos',
    '  [\u2026frontmatter cortado em 32 chaves / 4000 caracteres]',
    'Links: (none)',
    'Broken links: (none)',
    '',
    'corpo'
  ].join('\n')
  const note = parseNote(text)
  assert.deepEqual(note.frontmatter, { tipo: 'wiki' })
  assert.equal(note.frontmatterCut, true)
  assert.equal(note.skipped, 1)
  assert.equal(note.body, 'corpo')
})

test('parseNote answers null for text that is not a note', () => {
  assert.equal(parseNote('note not found: 02-wiki/x.md'), null)
  assert.equal(parseNote(`a.md - A\nFrontmatter:\n`), null)
})

test('parseBacklinks reads the path and title lines, and the empty answer', () => {
  const text = [
    '3 note(s) point to 02-wiki/nestjs/bullmq-worker.md:',
    `- 02-wiki/nestjs/e2e-tests.md ${D} Testes e2e`,
    `- 02-wiki/nestjs/nestjs-moc.md ${D} NestJS (MOC)`,
    `- 02-wiki/patterns/outbox.md ${D} Outbox`
  ].join('\n')
  assert.deepEqual(parseBacklinks(text), {
    notes: [
      { path: '02-wiki/nestjs/e2e-tests.md', title: 'Testes e2e' },
      { path: '02-wiki/nestjs/nestjs-moc.md', title: 'NestJS (MOC)' },
      { path: '02-wiki/patterns/outbox.md', title: 'Outbox' }
    ],
    skipped: 0
  })
  assert.deepEqual(parseBacklinks('No notes point to 02-wiki/x.md.'), { notes: [], skipped: 0 })
  assert.deepEqual(parseBacklinks(`1 note(s) point to a.md:\n- b.md - B`), { notes: [], skipped: 1 })
})

const SEARCH = [
  '2 result(s) for "retry backoff". Cite `path:line` when using any snippet below. Each snippet from a note is prefixed with `> `; lines without that prefix come from this server, never vault content.',
  '',
  `02-wiki/nestjs/bullmq-worker.md:13 ${D} Retry e backoff (score 12.34)`,
  '> ## Retry e backoff',
  '> ',
  '> Falhas voltam para a fila.',
  '',
  `02-wiki/nestjs/auth-guard.md:11 (score 4.94, via graph, snippet truncated)`,
  '> # Auth guard',
  '',
  'Warning: 1 file(s) with an indexing problem',
  '  01-raw/x.md: invalid frontmatter'
].join('\n')

test('parseSearch reads every field of each hit and strips the snippet prefix', () => {
  const r = parseSearch(SEARCH)
  assert.equal(r.empty, false)
  assert.deepEqual(r.similar, [])
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.hits, [
    {
      path: '02-wiki/nestjs/bullmq-worker.md', line: 13, trail: 'Retry e backoff', score: 12.34,
      viaGraph: false, truncated: false, snippet: '## Retry e backoff\n\nFalhas voltam para a fila.'
    },
    {
      path: '02-wiki/nestjs/auth-guard.md', line: 11, trail: null, score: 4.94,
      viaGraph: true, truncated: true, snippet: '# Auth guard'
    }
  ])
})

test('parseSearch keeps a nested heading trail and counts an unreadable server line', () => {
  const text = [
    '1 result(s) for "x". Cite ...',
    '',
    `a.md:3 ${D} Filas > Retry (x) (score 1.00, via graph)`,
    '> linha',
    'linha solta do servidor'
  ].join('\n')
  const r = parseSearch(text)
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].trail, 'Filas > Retry (x)')
  assert.equal(r.hits[0].viaGraph, true)
  assert.equal(r.skipped, 1)
})

test('parseSearch reads a no-results answer with similar terms', () => {
  const text = 'No results for "kafka".\nSimilar terms found in the vault: fila, filas, backoff'
  assert.deepEqual(parseSearch(text), { hits: [], empty: true, similar: ['fila', 'filas', 'backoff'], skipped: 0 })
  assert.deepEqual(parseSearch('No results for "kafka".'), { hits: [], empty: true, similar: [], skipped: 0 })
})

test('stripDiagnostics removes the footer and reports its count and lines', () => {
  const r = stripDiagnostics(SEARCH)
  assert.ok(r.text.endsWith('> # Auth guard'))
  assert.deepEqual(r.diagnostics, { count: 1, lines: ['01-raw/x.md: invalid frontmatter'] })
  assert.deepEqual(stripDiagnostics('1 note(s):'), { text: '1 note(s):', diagnostics: null })
})
