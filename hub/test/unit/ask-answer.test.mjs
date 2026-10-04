import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnswer, validateCitations, noteLineBound } from '../../server/ask/answer.mjs'

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
  assert.doesNotMatch(r.text, /sobrou/)
  assert.doesNotMatch(r.text.slice(r.text.indexOf('Depois.')), /deck-answer/)
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
  links: [],
  brokenLinks: [],
  body: '# Worker BullMQ\n\nTexto.',
  truncated: false,
  total: 23,
  nextOffset: null
}

test('noteLineBound counts body lines, both fences, every key and every list item', () => {
  // 3 body lines + 2 fences + 3 keys + 3 list items = 11
  assert.equal(noteLineBound(listNote), 11)
})

test('a cited line on the last frontmatter list item of a YAML tag list is kept', async () => {
  // 1 ---, 2 tipo: conceito, 3 tags:, 4 - nestjs, 5 - fila, 6 - retry, 7 ---, 8 Texto.
  const short = { ...listNote, frontmatter: { tipo: 'conceito', tags: ['nestjs', 'fila', 'retry'] }, body: 'Texto.', total: 6 }
  const s = await validateCitations([{ path: short.path, line: 6, viaGraph: false }],
    { toolPaths: [short.path], knownPaths: [], lineBound: () => noteLineBound(short) })
  assert.deepEqual(s.kept.map(c => c.line), [6])
  // In the longer layout above the last body line is 11, one past it is dropped.
  const r = await validateCitations([
    { path: listNote.path, line: 11, viaGraph: false },
    { path: listNote.path, line: 12, viaGraph: false }
  ], { toolPaths: [listNote.path], knownPaths: [], lineBound: () => noteLineBound(listNote) })
  assert.deepEqual(r.kept.map(c => c.line), [11])
  assert.deepEqual(r.dropped.map(c => c.line), [12])
})

test('noteLineBound reads a list printed as text, and gives Infinity past what it can count', () => {
  assert.equal(noteLineBound({ ...listNote, frontmatter: { tipo: 'conceito', tags: 'nestjs, fila, retry', status: 'ativo' } }), 11)
  assert.equal(noteLineBound({ ...listNote, frontmatter: [['tipo', 'conceito'], ['tags', ['nestjs', 'fila', 'retry']], ['status', 'ativo']] }), 11)
  assert.equal(noteLineBound({ ...listNote, truncated: true }), Infinity)
  assert.equal(noteLineBound({ ...listNote, total: 200001 }), Infinity)
})
