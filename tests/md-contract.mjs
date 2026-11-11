// Test helper: a small structural model of a markdown contract document, plus assertions that
// operate on that structure instead of on regexes over the whole body.
//
// WHY THIS EXISTS
// ---------------
// The assertions in `agents.test.mjs` and `skill-contracts.test.mjs` pin what the agent contracts
// and skills *say*, because agents act on that prose. Three rounds of those assertions converged
// on a shape that fails in both directions at once:
//
//   * `assert.match(body, /A[\s\S]{0,150}B/)` — a character-bounded window between two phrases.
//     The window is wide enough to host a whole sentence, so text inserted between A and B that
//     cancels A still matches, and the suite stays green while the contract now says the opposite.
//   * `assert.doesNotMatch(gap, /optional|skip|fine|supported|.../)` — a fixed vocabulary of
//     negations. It catches the phrasing whoever wrote it thought of, and nothing else.
//   * Both break on a reflow, a sentence split, or a backtick change that preserves meaning,
//     because the window is measured in characters of raw markdown.
//
// This module replaces the window with structure: headings -> sections, sections -> blocks
// (paragraph, list item, fenced/indented code), prose blocks -> statements (sentences). An
// assertion can then say "in the section titled X, the paragraph introducing this command block
// states Y, and the only statements in that section about Z are the ones listed" instead of
// "these tokens appear within 150 characters of each other".
//
// WHAT THE ASSERTIONS CAN DETECT
// ------------------------------
//  1. Insertion between a claim and its consequence. `then:` requires the two statements to be
//     *adjacent statements of the same block*. Adjacency is counted in statements, not
//     characters, so any inserted sentence — of any wording, negating or not — breaks it.
//  2. Insertion anywhere in the section that is *about the pinned subject*. `subject:` is a
//     inventory lock, not a denylist: every statement in the section that mentions the subject
//     must be the claim itself or one of the explicitly listed `allow` patterns. A new sentence
//     about that subject fails whatever it says, so no vocabulary of negations is involved.
//  3. Insertion anywhere in the section that cancels a neighbouring instruction *by reference*
//     rather than by naming it ("This rule is obsolete; do it.", "Ignore the step above."). Such
//     a sentence has a nearby instruction as its grammatical subject; a contract section should
//     not contain meta-prose about its own rules, so any of them fails. See BACK_REFERENCE.
//  4. Outright inversion of a claim, because `claim:` must match inside a single statement.
//     Polarity is bound by the sentence boundary; it cannot be satisfied by "never" in one
//     sentence and the asserted verb phrase in another.
//
// WHAT THEY CANNOT DETECT — read this before trusting a green run
// ---------------------------------------------------------------
//  * Contradiction in general. That is a semantic problem and this module does not solve it.
//    A sentence that negates a claim while (a) not naming the pinned subject and (b) not using a
//    recognised back-reference passes. "You may proceed without it." next to a detach requirement
//    is exactly that case: it names nothing and refers to nothing this module recognises.
//  * Back-references outside BACK_REFERENCE. That list is a lexicon and shares the weakness of
//    every lexicon. It is a second, independent net under the subject lock — not a guarantee.
//  * Anything in a *different* section, for a section-scoped assertion. Scope is one section
//    (heading plus its subsections), so a contradiction placed under another heading is out of
//    that assertion's reach by construction. `assertCorpusInventory` is the answer where a claim
//    must not move: it locks every site naming a mechanism across every document at once, so
//    relocation fails like rewording. It buys location, not meaning — its subject pattern is a
//    lexicon with the same weakness as any other, and a sentence that discusses the mechanism
//    without naming it still escapes.
//  * Anything inside a code block. Screens run over prose statements only; code is asserted
//    against explicitly, never scanned for contradictions.
//  * Meaning. `subject:` proves a sentence about the subject was *reviewed by a human writing the
//    test*, not that it agrees with the claim. Adding a pattern to `allow` waives the check for
//    that sentence, and that is the intended cost of adding prose about a pinned subject.
//
// Zero dependencies; Node built-ins only, no markdown library.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Meaning-preserving surface changes must not move an assertion: line wrapping, run of spaces,
// backtick decoration around a term (`merge` check -> merge check), emphasis markers, and smart
// quotes are all stripped before anything is matched.
export function normalize(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/`+/g, '')
    .replace(/\*\*|\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Split normalized prose into statements (sentences). The split is deliberately conservative: a
// terminator ends a statement only when it is followed by whitespace and then something that
// looks like the start of a new sentence. That keeps `cli.mjs status`, `.fleetmates/`, `a ..
// escape` and `...design.md lists what` in one piece. Over-splitting would let an assertion pass
// on half a sentence; under-splitting only makes a statement longer, which is the safe direction
// — a claim that spans an under-split boundary simply has to be written as one longer pattern.
export function statementsOf(normalizedText) {
  const out = []
  let start = 0
  const re = /[.!?]+(?=\s)/g
  let m
  while ((m = re.exec(normalizedText))) {
    const end = m.index + m[0].length
    const next = normalizedText.slice(end).trimStart()[0] ?? ''
    if (!(next === '' || /[A-Z0-9"(]/.test(next))) continue
    const chunk = normalizedText.slice(start, end).trim()
    if (chunk) out.push(chunk)
    start = end
  }
  const tail = normalizedText.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export function splitFrontmatter(text, label = 'document') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${label} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const FENCE = /^\s*(```+|~~~+)/
const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

function block(kind, lines, extra = {}) {
  const raw = lines.join('\n')
  return { kind, raw, text: normalize(raw), ...extra }
}

// Parse into a flat, ordered list of blocks. Indented code blocks are recognised the CommonMark
// way (four spaces, preceded by a blank line, not continuing a list item), because these
// documents use them for every command example.
export function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let afterBlank = true

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      afterBlank = true
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++])
      if (i < lines.length) i++
      blocks.push(block('code', body, { code: body.join('\n') }))
      afterBlank = false
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push(block('heading', [heading[2]], { level: heading[1].length }))
      i++
      afterBlank = false
      continue
    }

    if (afterBlank && /^ {4,}\S/.test(line)) {
      const body = []
      while (i < lines.length && (lines[i].trim() === '' || /^ {4,}/.test(lines[i]))) {
        if (lines[i].trim() === '' && !/^ {4,}\S/.test(lines[i + 1] ?? '')) break
        body.push(lines[i++])
      }
      const dedented = body.map((l) => l.replace(/^ {4}/, ''))
      blocks.push(block('code', dedented, { code: dedented.join('\n') }))
      afterBlank = false
      continue
    }

    const item = LIST_MARKER.exec(line)
    if (item) {
      const indent = item[1].length
      const body = [item[3]]
      i++
      while (i < lines.length && lines[i].trim() !== '') {
        const nested = LIST_MARKER.exec(lines[i])
        if (nested && nested[1].length <= indent) break
        if (HEADING.test(lines[i])) break
        body.push(lines[i++].trim())
      }
      blocks.push(block('list-item', body, { indent }))
      afterBlank = false
      continue
    }

    const body = []
    while (i < lines.length && lines[i].trim() !== '') {
      if (HEADING.test(lines[i]) || FENCE.test(lines[i]) || LIST_MARKER.test(lines[i])) break
      body.push(lines[i++].trim())
    }
    if (body.length) blocks.push(block('paragraph', body))
    else i++
    afterBlank = false
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function makeSection(title, level, blocks, label, heading = null) {
  const prose = blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'list-item')
  const statements = []
  for (const b of prose) {
    for (const text of statementsOf(b.text)) statements.push({ text, block: b })
  }
  return {
    label: `${heading?.file ?? label} § ${title || '(preamble)'}`,
    title,
    level,
    // The part this section's heading came from, for a document parsed from several files (see
    // parseParts). Undefined for the primary part and for a single-source document.
    source: heading?.source,
    blocks,
    prose,
    statements,
    code: blocks.filter((b) => b.kind === 'code'),
    text: blocks.map((b) => b.text).join(' '),
  }
}

export function parseDoc(source, label = 'document') {
  return docOf(parseBlocks(source), label)
}

// One document parsed from several files, in the order given — a skill's SKILL.md followed by its
// reference files. Each part is parsed into blocks ON ITS OWN, so a paragraph at the end of one
// file can never run on into the first line of the next, and the blocks are then joined into one
// document: sections, statements and `section(matcher)` see a single corpus, so a claim pinned in
// a section is found wherever its section lives. A section that crosses a file boundary is real,
// though: a reference opening with `##` closes the core's last `##`, but one opening with `###`
// nests under it — split files at a heading of the level the core's sections use.
//
// Every block carries the part it came from. `file` names it in a section label; `source` is the
// suffix `corpusSites` appends to a document's label, so a corpus inventory names the file each
// sentence came from and a sentence that moves between a core and its reference fails the lock. The
// primary part carries no `source`, which keeps its sites labelled with the document label alone.
//
//   parts  [{ text, file, source? }]
export function parseParts(parts, label = 'document') {
  const blocks = parts.flatMap((part) =>
    parseBlocks(part.text).map((b) => ({ ...b, file: part.file, source: part.source })),
  )
  return docOf(blocks, label)
}

function docOf(blocks, label) {
  const sections = []
  const preambleEnd = blocks.findIndex((b) => b.kind === 'heading')
  sections.push(
    makeSection('', 0, preambleEnd === -1 ? blocks : blocks.slice(0, preambleEnd), label),
  )
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== 'heading') continue
    const level = blocks[i].level
    let end = i + 1
    while (end < blocks.length && !(blocks[end].kind === 'heading' && blocks[end].level <= level)) end++
    sections.push(makeSection(blocks[i].text, level, blocks.slice(i + 1, end), label, blocks[i]))
  }

  const doc = {
    label,
    blocks,
    sections,
    text: blocks.map((b) => b.text).join(' '),
    // Built from the block list ONCE, in document order — not by concatenating the sections.
    // Sections nest: a section's blocks run to the next heading of the same or higher level, so
    // every block under `## 2` also sits under `# Title`, and one under `### 2a` sits under all
    // three. Concatenating them counted each statement once per enclosing heading — measured at
    // 316 entries for 154 sentences in `parallel-execution`, the deepest tripled. A scan survives
    // that (it checks the same sentence twice), but any assertion that counts, indexes or locks
    // an inventory at document level reads the duplicates as real, and would have to be written
    // against a number that changes when an unrelated heading is added.
    statements: blocks
      .filter((b) => b.kind === 'paragraph' || b.kind === 'list-item')
      .flatMap((b) => statementsOf(b.text).map((text) => ({ text, block: b }))),
    section(matcher) {
      const hits = sections.filter((s) =>
        matcher instanceof RegExp
          ? matcher.test(s.title)
          : s.title.toLowerCase().includes(String(matcher).toLowerCase()),
      )
      assert.equal(
        hits.length,
        1,
        `${label}: expected exactly one section matching ${matcher}, found ${hits.length}` +
          (hits.length > 1 ? ` (${hits.map((h) => h.title).join(' | ')})` : ''),
      )
      return hits[0]
    },
  }
  return doc
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

// A sentence whose subject is a neighbouring instruction rather than a named thing. Such prose
// can annul the rule beside it without repeating a single one of its words, which is precisely
// the hole a subject-scoped inventory cannot see. This is a lexicon and therefore not exhaustive;
// it is a second net, not a guarantee. See the header for what it misses.
const BACK_REFERENCE =
  /\b(this|that|these|those|the (above|preceding|previous|foregoing|earlier|following|last))\s+(\w+\s+){0,2}(rule|rules|note|notes|requirement|requirements|prohibition|restriction|constraint|instruction|instructions|guidance|guideline|warning|caveat|advice|directive|policy|mandate|step above|paragraph|sentence|clause)\b/i

export function backReferences(scope) {
  return scope.statements.filter((s) => BACK_REFERENCE.test(s.text))
}

function show(statements) {
  return statements.map((s) => `\n    - ${s.text}`).join('')
}

// Every place in a scope where a claim can be written, not only the places `statements` reaches.
// `parseDoc` slices a section's blocks past its own heading and `makeSection` builds statements
// from paragraphs and list items alone, so a scan over statements sees no heading at all: neither
// the section's own, nor one nested inside it. A reversed claim written as a heading therefore
// ships green through a scan that would refuse the same sentence one line lower. The gap was
// consistency, not discovery — the two prose sections in `parallel-execution` already scan their
// headings by hand; this makes that reach available to every scan rather than to the two that
// remembered.
//
// Heading text is emitted as-is, one site per heading. It is not split into statements: a heading
// is one claim by construction, and `statementsOf` would only ever return it unchanged or, with a
// terminator in it, cut it into fragments an assertion could pass on half of.
export function claimSites(scope) {
  const sites = (scope.statements ?? []).map((s) => ({ text: s.text, where: 'statement', source: s.block.source }))
  if (scope.title) sites.push({ text: scope.title, where: 'heading', source: scope.source })
  for (const b of scope.blocks ?? []) {
    if (b.kind === 'heading') sites.push({ text: b.text, where: 'heading', source: b.source })
  }
  return sites
}

// ---------------------------------------------------------------------------
// Corpus scope
// ---------------------------------------------------------------------------

// A section lock binds one section. Prose about the same mechanism written under ANOTHER heading,
// or in another document entirely, was out of its scope by construction — so the cheapest escape
// from an inventory was never to reword a locked sentence but to add a contradicting one somewhere
// else. That is the hole this closes for a named mechanism: the scope becomes every document at
// once.
//
// The unit is the same claim site as everywhere else, prefixed with the document it came from, so
// a sentence that MOVES between documents fails as surely as one that is added. Document order is
// fixed by sorting on the label, and within a document by position, so the list is stable against
// readdir order.
//
// This does not detect contradiction, and the subject pattern is still a lexicon — a sentence that
// discusses the mechanism without naming it escapes, exactly as it escapes a section-scoped
// `subject:` lock. What it removes is the LOCATION dimension: a contradiction now has to be
// written in vocabulary the pattern misses, rather than merely placed under a different heading.
export function corpusSites(docs, subject) {
  const ordered = [...docs].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  const out = []
  for (const { label, doc } of ordered) {
    for (const site of claimSites(doc)) {
      if (subject.test(site.text)) out.push(`${site.source ? `${label}/${site.source}` : label} :: ${site.text}`)
    }
  }
  return out
}

export function assertCorpusInventory(docs, subject, expected, message) {
  assert.deepEqual(
    corpusSites(docs, subject),
    expected,
    `${message}\n  Every sentence about this mechanism, in every document, must be in the locked `
      + 'list — one was added, removed, reworded, reordered, or moved to another document. If the '
      + 'change is correct, update the list; that is the review step.',
  )
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

// Match a single statement. Because the unit is one sentence, an assertion cannot be satisfied by
// tokens drawn from two different sentences, which is how an inverted claim used to sneak past a
// whole-body regex.
export function findStatement(scope, pattern) {
  return scope.statements.find((s) => pattern.test(s.text)) ?? null
}

export function assertStatement(scope, pattern, message) {
  const hit = findStatement(scope, pattern)
  assert.ok(hit, `${message}\n  ${scope.label}: no single statement matches ${pattern}`)
  return hit
}

export function assertNoStatement(scope, pattern, message) {
  const hit = findStatement(scope, pattern)
  assert.ok(!hit, `${message}\n  ${scope.label}: statement matches ${pattern}:\n    - ${hit?.text}`)
}

export function assertCode(scope, pattern, message) {
  const hit = scope.code.find((b) => pattern.test(b.code))
  assert.ok(hit, `${message}\n  ${scope.label}: no code block matches ${pattern}`)
  return hit
}

/**
 * Assert a claim structurally.
 *
 *   claim      RegExp — must match inside one statement of the section.
 *   then       RegExp — the *next* statement of the same block must match it. Adjacency is
 *              counted in statements, so any sentence inserted between them fails, whatever it
 *              says. This is the replacement for `[\s\S]{0,150}`.
 *   introduces RegExp — the block immediately following the claim's block must be a code block
 *              matching it. This is the "the paragraph introducing the command block" case.
 *   subject    RegExp — inventory lock. Every statement in the section matching it must be the
 *              claim or one of `allow`. Detects an inserted sentence about the subject regardless
 *              of wording; does not judge whether that sentence agrees with the claim.
 *   allow      RegExp[] — other statements permitted to mention the subject.
 *   forbid     RegExp[] — statements that must not appear anywhere in the section.
 *
 * Returns the matched claim statement.
 */
export function assertClaim(scope, spec) {
  const { claim, then, introduces, subject, allow = [], forbid = [], label = '' } = spec
  const where = label ? `${label}: ` : ''

  const hit = assertStatement(scope, claim, `${where}claim not stated in one sentence`)

  // A CLAIM MUST BE UNIQUE IN ITS SECTION. `findStatement` returns the FIRST statement matching,
  // and the stray inventory below exempts by TEXT EQUALITY (`s.text !== hit.text`), so a verbatim
  // duplicate of a chain link planted earlier in the same section steals the binding: `then:` is
  // satisfied against the decoy, the REAL occurrence is free to be followed by a sentence that
  // annuls it, and both copies are exempt from the inventory because they compare equal to the
  // hit. Verified in this worktree, on the run branch's merged tree: with a duplicated pair
  // planted ahead of the real one in both skills/parallel-execution/SKILL.md § 5 and the
  // finishing skill's cleanup section, `npm test` stayed green at 2047 tests, 2044 pass, 0 fail.
  //
  // Requiring exactly one match closes it for every claim in every document at once, and it costs
  // nothing legitimate: a document that states the same sentence twice in one section has a prose
  // defect of its own. Measured against the tree before this landed — 2047 tests, 2044 pass,
  // 0 fail — so no existing claim relied on being the first of several.
  const matches = scope.statements.filter((s) => claim.test(s.text))
  assert.equal(
    matches.length,
    1,
    `${where}the claim pattern ${claim} matches ${matches.length} statements in ${scope.label}, ` +
      'so which one it binds to is decided by position rather than by the pattern.' + show(matches) +
      '\n  A duplicate lets an inserted sentence annul the real occurrence while every ' +
      'anchored regex stays green. Make the claim unique, or narrow the pattern.',
  )

  let consequence = null

  if (then) {
    const inBlock = statementsOf(hit.block.text)
    const at = inBlock.indexOf(hit.text)
    const next = inBlock[at + 1]
    assert.ok(
      next !== undefined && then.test(next),
      `${where}the statement after the claim must match ${then}, ` +
        `but the next statement in the same block is ${next === undefined ? '(none)' : JSON.stringify(next)}. ` +
        'A sentence inserted between the claim and its consequence breaks this on purpose.',
    )
    consequence = next
  }

  if (introduces) {
    const at = scope.blocks.indexOf(hit.block)
    const after = scope.blocks[at + 1]
    assert.ok(
      after && after.kind === 'code' && introduces.test(after.code),
      `${where}the block introduced by the claim must be a code block matching ${introduces}, ` +
        `but the next block is ${after ? `${after.kind}: ${JSON.stringify(after.text.slice(0, 80))}` : '(none)'}`,
    )
  }

  if (subject) {
    // The claim and the consequence bound to it by `then` are already asserted; everything else
    // in the section that speaks about the subject has to be named in `allow`.
    const strays = scope.statements.filter(
      (s) =>
        subject.test(s.text) &&
        s.text !== hit.text &&
        s.text !== consequence &&
        !allow.some((a) => a.test(s.text)),
    )
    assert.equal(
      strays.length,
      0,
      `${where}unreviewed statement(s) about ${subject} in ${scope.label}.${show(strays)}\n` +
        '  Every sentence in this section about the pinned subject must be the claim itself or ' +
        'listed in `allow`. If the new sentence is legitimate, add it to `allow` — that is a ' +
        'deliberate review step, not a formality.',
    )
  }

  for (const pattern of forbid) assertNoStatement(scope, pattern, `${where}forbidden statement present`)

  const meta = backReferences(scope)
  assert.equal(
    meta.length,
    0,
    `${where}${scope.label} contains prose whose subject is a neighbouring instruction rather ` +
      `than a named thing, which can annul it without repeating any of its words:${show(meta)}`,
  )

  return hit
}

// ---------------------------------------------------------------------------
// Skill corpus
// ---------------------------------------------------------------------------

export const SKILLS_DIR = new URL('../skills/', import.meta.url)

// A skill is its SKILL.md plus every `reference/*.md` beside it, in name order. The core is what an
// agent loads; a reference is read on demand, and a claim moved from one to the other is still the
// skill's claim. Every test reads a skill through this one reader, so a sentence lock, a
// cross-skill scan or a corpus inventory follows a sentence wherever it lands in the skill, instead
// of a scan silently covering the core alone.
//
// What it reads: regular `.md` files directly under `reference/`, nothing nested. A missing
// `reference/` is a skill with no references; any other read failure throws.
export async function skillFiles(name, { dir = SKILLS_DIR } = {}) {
  let refs = []
  try {
    refs = (await readdir(new URL(`${name}/reference/`, dir), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return [
    { file: `${name}/SKILL.md`, path: 'SKILL.md' },
    ...refs.map((r) => ({ file: `${name}/reference/${r}`, path: `reference/${r}`, source: `reference/${r}` })),
  ]
}

//   fields  the SKILL.md frontmatter
//   raw     every file's full text, SKILL.md first, joined by a blank line
//   body    the same with SKILL.md's frontmatter removed
//   doc     parseParts over the same files; section labels and corpus sites name each file
//   files   [{ file, path, source?, text }] in reading order
// `transform` runs over each file's text before anything else, e.g. to strip comments.
export async function readSkill(name, { dir = SKILLS_DIR, transform = (t) => t } = {}) {
  const files = []
  for (const f of await skillFiles(name, { dir })) {
    files.push({ ...f, text: transform(await readFile(new URL(`${name}/${f.path}`, dir), 'utf8')) })
  }
  const [main, ...refs] = files
  const { fields, body: mainBody } = splitFrontmatter(main.text, name)
  const parts = [{ text: mainBody, file: main.file }, ...refs.map((r) => ({ text: r.text, file: r.file, source: r.source }))]
  return {
    fields,
    raw: files.map((f) => f.text).join('\n\n'),
    body: parts.map((p) => p.text).join('\n\n'),
    doc: parseParts(parts, main.file),
    files,
  }
}
