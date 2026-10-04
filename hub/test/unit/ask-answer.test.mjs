import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnswer, validateCitations, noteLineBound, FRONTMATTER_SLACK } from '../../server/ask/answer.mjs'

const FENCE = '```'

/**
 * Build an answer text ending with a deck-answer block holding `block`.
 * @param {string} prose
 * @param {unknown} block
 * @param {string} [after]
 */
function answer (prose, block, after = '') {
  return `${prose}\n\n${FENCE}deck-answer\n${JSON.stringify(block)}\n${FENCE}\n${after}`
}

const GOOD = {
  citations: [{ path: '02-wiki/nestjs/bullmq-worker.md', line: 13, viaGraph: false }],
  isMiss: false,
  generalKnowledge: null,
  searched: ['retry bullmq worker']
}

test('parseAnswer strips the deck-answer block and returns its fields', () => {
  const r = parseAnswer(answer('O worker usa backoff exponencial (02-wiki/nestjs/bullmq-worker.md:13).', GOOD))
  assert.equal(r.text, 'O worker usa backoff exponencial (02-wiki/nestjs/bullmq-worker.md:13).')
  assert.deepEqual(r.block, GOOD)
})

test('parseAnswer leaves a JSON example in a json fence alone', () => {
  const prose = `Exemplo de config:\n\n${FENCE}json\n{ "attempts": 3, "isMiss": true }\n${FENCE}\n\nFim.`
  const r = parseAnswer(answer(prose, GOOD))
  assert.equal(r.text, prose)
  assert.deepEqual(r.block?.citations, GOOD.citations)
  assert.equal(r.block?.isMiss, false)
  const only = parseAnswer(prose)
  assert.equal(only.text, prose)
  assert.equal(only.block, null)
})

test('parseAnswer takes the last deck-answer block and strips everything after it', () => {
  const first = { ...GOOD, isMiss: true, citations: [] }
  const text = answer('Antes.', first) + answer('Depois.', GOOD, 'texto que sobrou depois do bloco')
  const r = parseAnswer(text)
  assert.deepEqual(r.block, GOOD)
  // Only the last block and what follows it are cut; an earlier block stays in the shown text.
  assert.equal(r.text, `Antes.\n\n${FENCE}deck-answer\n${JSON.stringify(first)}\n${FENCE}\nDepois.`)
  // The last block wins even when an earlier one parses and the last does not.
  const lastBroken = parseAnswer(answer('Antes.', GOOD) + `Depois.\n\n${FENCE}deck-answer\n{ nope\n${FENCE}\n`)
  assert.equal(lastBroken.block, null)
})

test('parseAnswer: an unclosed deck-answer block gives block null and is cut from the text', () => {
  const r = parseAnswer(`Resposta.\n\n${FENCE}deck-answer\n${JSON.stringify(GOOD)}\n`)
  assert.equal(r.block, null)
  assert.equal(r.text, 'Resposta.')
  const empty = parseAnswer(`Resposta.\n\n${FENCE}deck-answer\n`)
  assert.equal(empty.block, null)
  assert.equal(empty.text, 'Resposta.')
})

test('parseAnswer: wrong types invalidate the block, unknown keys are ignored', () => {
  assert.equal(parseAnswer(answer('x', { ...GOOD, isMiss: 'yes' })).block, null)
  assert.equal(parseAnswer(answer('x', { ...GOOD, citations: [{ path: 'a.md', line: '3' }] })).block, null)
  assert.equal(parseAnswer(answer('x', { ...GOOD, generalKnowledge: 3 })).block, null)
  assert.equal(parseAnswer(answer('x', { ...GOOD, searched: 'retry' })).block, null)
  const extra = parseAnswer(answer('x', { ...GOOD, confidence: 0.9 }))
  assert.deepEqual(extra.block, GOOD)
  const broken = parseAnswer(`x\n\n${FENCE}deck-answer\n{ "citations": [\n${FENCE}\n`)
  assert.equal(broken.block, null)
  assert.equal(broken.text, 'x')
})

test('parseAnswer without a block keeps the whole text', () => {
  const r = parseAnswer('Só texto, sem bloco.')
  assert.deepEqual(r, { text: 'Só texto, sem bloco.', block: null })
})

test('validateCitations drops a path no tool returned and the vault does not list', async () => {
  const r = await validateCitations([
    { path: '02-wiki/nestjs/bullmq-worker.md', line: 13, viaGraph: false },
    { path: '02-wiki/nestjs/auth-guard.md', line: 11, viaGraph: true },
    { path: '02-wiki/inventada.md', line: 2, viaGraph: false }
  ], {
    toolPaths: ['02-wiki/nestjs/bullmq-worker.md'],
    knownPaths: new Set(['02-wiki/nestjs/auth-guard.md']),
    lineBound: async () => 40
  })
  assert.deepEqual(r.kept.map(c => c.path), ['02-wiki/nestjs/bullmq-worker.md', '02-wiki/nestjs/auth-guard.md'])
  assert.deepEqual(r.dropped.map(c => c.path), ['02-wiki/inventada.md'])
})

test('validateCitations drops line 0, a fractional line and a line past the bound; Infinity keeps any line', async () => {
  const path = '02-wiki/nestjs/bullmq-worker.md'
  const r = await validateCitations([
    { path, line: 0, viaGraph: false },
    { path, line: 2.5, viaGraph: false },
    { path, line: 21, viaGraph: false },
    { path, line: 20, viaGraph: false },
    { path, line: 1, viaGraph: false }
  ], { toolPaths: [path], knownPaths: [], lineBound: async () => 20 })
  assert.deepEqual(r.kept.map(c => c.line), [20, 1])
  assert.deepEqual(r.dropped.map(c => c.line), [0, 2.5, 21])
  const big = await validateCitations([{ path, line: 99999, viaGraph: false }],
    { toolPaths: [path], knownPaths: [], lineBound: () => Infinity })
  assert.equal(big.kept.length, 1)
})

test('validateCitations drops a citation whose bound cannot be read', async () => {
  const path = '02-wiki/nestjs/bullmq-worker.md'
  const r = await validateCitations([{ path, line: 3, viaGraph: false }],
    { toolPaths: [path], knownPaths: [], lineBound: async () => { throw new Error('vault_unavailable') } })
  assert.equal(r.kept.length, 0)
  assert.equal(r.dropped.length, 1)
})

// A note as the file holds it:
//  1 ---
//  2 tipo: conceito
//  3 tags:
//  4   - nestjs
//  5   - fila
//  6   - retry
//  7 status: ativo
//  8 ---
//  9 # Worker BullMQ
// 10 (blank)
// 11 Texto.
const listNote = {
  path: '02-wiki/nestjs/bullmq-worker.md',
  title: 'Worker BullMQ',
  frontmatter: { tipo: 'conceito', tags: ['nestjs', 'fila', 'retry'], status: 'ativo' },
  frontmatterCut: false,
  links: [],
  brokenLinks: [],
  body: '# Worker BullMQ\n\nTexto.',
  truncated: false,
  total: 23,
  nextOffset: null
}

test('noteLineBound over-estimates: body lines, 2 fences, 2 per key, 1 per list item, and 32 lines of slack', () => {
  // 3 body lines + 2 fences + 32 slack + 3 keys x 2 + 3 list items = 46
  assert.equal(noteLineBound(listNote), 46)
  assert.equal(FRONTMATTER_SLACK, 32)
})

test('a cited line on the last frontmatter list item of a YAML tag list is kept', async () => {
  // 1 ---, 2 tipo: conceito, 3 tags:, 4 - nestjs, 5 - fila, 6 - retry, 7 ---, 8 Texto.
  const short = { ...listNote, frontmatter: { tipo: 'conceito', tags: ['nestjs', 'fila', 'retry'] }, body: 'Texto.', total: 6 }
  const s = await validateCitations([{ path: short.path, line: 6, viaGraph: false }],
    { toolPaths: [short.path], knownPaths: [], lineBound: () => noteLineBound(short) })
  assert.deepEqual(s.kept.map(c => c.line), [6])
  // In the longer layout above, line 11 is the last real line and 46 the bound; 47 is dropped.
  const r = await validateCitations([
    { path: listNote.path, line: 11, viaGraph: false },
    { path: listNote.path, line: 47, viaGraph: false }
  ], { toolPaths: [listNote.path], knownPaths: [], lineBound: () => noteLineBound(listNote) })
  assert.deepEqual(r.kept.map(c => c.line), [11])
  assert.deepEqual(r.dropped.map(c => c.line), [47])
})

test('noteLineBound reads a list printed as text, and gives Infinity past what it can count', () => {
  assert.equal(noteLineBound({ ...listNote, frontmatter: { tipo: 'conceito', tags: 'nestjs, fila, retry', status: 'ativo' } }), 46)
  assert.equal(noteLineBound({ ...listNote, frontmatter: [['tipo', 'conceito'], ['tags', ['nestjs', 'fila', 'retry']], ['status', 'ativo']] }), 46)
  assert.equal(noteLineBound({ ...listNote, truncated: true }), Infinity)
  assert.equal(noteLineBound({ ...listNote, total: 200001 }), Infinity)
  assert.equal(noteLineBound({ ...listNote, frontmatterCut: true }), Infinity)
})

test('noteLineBound: 32 printed keys or a 512-character value give Infinity, an escaped newline adds a line', () => {
  const keys = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 'v']))
  assert.equal(noteLineBound({ ...listNote, frontmatter: keys }), Infinity)
  const fewer = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']))
  assert.equal(noteLineBound({ ...listNote, frontmatter: fewer }), 3 + 2 + 32 + 62)
  assert.equal(noteLineBound({ ...listNote, frontmatter: { resumo: 'a'.repeat(512) } }), Infinity)
  assert.equal(noteLineBound({ ...listNote, frontmatter: { resumo: 'a'.repeat(511) } }), 3 + 2 + 32 + 2)
  // vault-mcp prints a newline inside a value as the two characters backslash and n.
  assert.equal(noteLineBound({ ...listNote, body: 'x', frontmatter: { resumo: 'linha um\\nlinha dois\\nlinha tres' } }), 1 + 2 + 32 + 2 + 2)
})

// What T2's parseNote (hub/server/adapters/vault-text.mjs at fleetmates/deck-m5a/T2 0a94129) returns for two
// vault_get_note answers in the vault-mcp 0.3.0 format; the texts are kept beside them, and the last test
// re-parses them when that module is present.
const EM = '\u2014'
// File 02-wiki/nestjs/one-tag.md, two one-item block lists and no trailing newline:
//  1 ---, 2 tipo: wiki, 3 tags:, 4   - fila, 5 aliases:, 6   - retry, 7 status: ativo, 8 ---,
//  9 # Fila, 10 (blank), 11 Intro., 12 (blank), 13 ## Retry, 14 texto
const ONE_TAG_TEXT = `02-wiki/nestjs/one-tag.md ${EM} Fila\nFrontmatter:\n  tipo: wiki\n  tags: fila\n  aliases: retry\n  status: ativo\nLinks: (none)\nBroken links: (none)\n\n# Fila\n\nIntro.\n\n## Retry\ntexto`
const ONE_TAG = { path: '02-wiki/nestjs/one-tag.md', title: 'Fila', frontmatter: { tipo: 'wiki', tags: 'fila', aliases: 'retry', status: 'ativo' }, frontmatterCut: false, links: [], brokenLinks: [], body: '# Fila\n\nIntro.\n\n## Retry\ntexto', offset: 0, truncated: false, total: 30, nextOffset: null, skipped: 0 }
// File 02-wiki/nestjs/guarda.md, ten YAML comment lines that vault-mcp does not print:
//  1 ---, 2..11 # comentario, 12 tipo: wiki, 13 tags: [fila], 14 status: ativo, 15 ---,
//  16 # Guarda, 17 (blank), 18 Intro., 19 (blank), 20 ## Retry backoff, 21 texto
const GUARDA_TEXT = `02-wiki/nestjs/guarda.md ${EM} Guarda\nFrontmatter:\n  tipo: wiki\n  tags: fila\n  status: ativo\nLinks: (none)\nBroken links: (none)\n\n# Guarda\n\nIntro.\n\n## Retry backoff\ntexto`
const GUARDA = { path: '02-wiki/nestjs/guarda.md', title: 'Guarda', frontmatter: { tipo: 'wiki', tags: 'fila', status: 'ativo' }, frontmatterCut: false, links: [], brokenLinks: [], body: '# Guarda\n\nIntro.\n\n## Retry backoff\ntexto', offset: 0, truncated: false, total: 40, nextOffset: null, skipped: 0 }

test('parseNote output: the last line of a note with one-item block lists or YAML comments is in range', async () => {
  assert.equal(noteLineBound(ONE_TAG), 6 + 2 + 32 + 4 * 2)
  assert.equal(noteLineBound(GUARDA), 6 + 2 + 32 + 3 * 2)
  for (const [note, last] of [[ONE_TAG, 14], [GUARDA, 21]]) {
    const r = await validateCitations([{ path: note.path, line: last, viaGraph: false }],
      { toolPaths: [note.path], knownPaths: [], lineBound: () => noteLineBound(note) })
    assert.deepEqual(r.kept.map(c => c.line), [last], note.path)
  }
})

test('validateCitations keeps a line a vault_search hit of this ask reported, and any earlier line of that path', async () => {
  const path = ONE_TAG.path
  const searchHits = [{ path, line: 13 }, { path, line: 9 }]
  const r = await validateCitations([
    { path, line: 13, viaGraph: false },
    { path, line: 2, viaGraph: false },
    { path, line: 14, viaGraph: false },
    { path, line: 0, viaGraph: false }
  ], { toolPaths: [path], knownPaths: [], searchHits, lineBound: () => 10 })
  assert.deepEqual(r.kept.map(c => c.line), [13, 2])
  assert.deepEqual(r.dropped.map(c => c.line), [14, 0])
  // A hit counts even when the bound cannot be read and the path is in no other list.
  const down = await validateCitations([{ path, line: 13, viaGraph: false }],
    { toolPaths: [], knownPaths: [], searchHits, lineBound: async () => { throw new Error('vault_unavailable') } })
  assert.equal(down.kept.length, 1)
})

test('the literal parseNote results match T2 parseNote when vault-text.mjs is present', async (t) => {
  /** @type {any} */
  let mod
  try {
    mod = await import('../../server/adapters/vault-text.mjs')
  } catch {
    t.skip('hub/server/adapters/vault-text.mjs (Task 2) is not in this tree')
    return
  }
  assert.deepEqual(mod.parseNote(ONE_TAG_TEXT), ONE_TAG)
  assert.deepEqual(mod.parseNote(GUARDA_TEXT), GUARDA)
})

test('noteLineBound gives Infinity when a value holds a vault-mcp container summary', async () => {
  // File: 2 fences, `tipo: wiki`, `fontes:` and 20 mappings of 3 lines each, then one body line = 65 lines.
  // vault-mcp 0.3.0 prints each mapping one level down as `{objeto com 3 chave(s)}`.
  const fontes = Array.from({ length: 20 }, () => '{objeto com 3 chave(s)}').join(', ')
  assert.ok(fontes.length < 512)
  const note = { ...listNote, frontmatter: { tipo: 'wiki', fontes }, body: 'body line', total: 9 }
  assert.equal(noteLineBound(note), Infinity)
  const r = await validateCitations([{ path: note.path, line: 65, viaGraph: false }],
    { toolPaths: [note.path], knownPaths: [], lineBound: () => noteLineBound(note) })
  assert.equal(r.kept.length, 1)
  assert.equal(noteLineBound({ ...note, frontmatter: { aliases: '[lista com 4 item(ns)]' } }), Infinity)
  const ellipsis = String.fromCharCode(0x2026)
  assert.equal(noteLineBound({ ...note, frontmatter: { tags: `a, b, ${ellipsis}+5 item(ns)` } }), Infinity)
  // A value that only mentions the words stays countable.
  assert.equal(noteLineBound({ ...note, frontmatter: { resumo: 'um objeto com chaves' } }), 1 + 2 + 32 + 2)
})

test('rule (a) keeps an earlier line of a hit path even past the bound', async () => {
  const path = ONE_TAG.path
  const r = await validateCitations([{ path, line: 12, viaGraph: false }],
    { toolPaths: [path], knownPaths: [], searchHits: [{ path, line: 13 }], lineBound: () => 10 })
  assert.deepEqual(r.kept.map(c => c.line), [12])
})
