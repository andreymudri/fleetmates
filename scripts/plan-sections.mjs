// Header sections of a plan: `## Destination`, `## Not Yet Specified` and `## Out of Scope`.
//
// This module owns exactly one thing — the `##` sections that sit above the task list — and it
// owns the extraction rules that `parseConstraints` in `scripts/cli.mjs` used to own alone. Each
// rule below was found the hard way; the comments are the record of why, and dropping one is how
// the next reader re-breaks it.
//
// `parsePlanSections` is called only where `scripts/cli.mjs` (re)derives the three fields from
// the plan markdown itself — not at every `plan.json` write: a write that only carries forward
// fields already on disk (recording the run branch, retiering tasks) never calls it. Nothing
// downstream of a derivation recomputes from these sections — no gate check re-derives them, and
// no teammate brief is built from them. State that bound, not the list of callers that satisfy
// it today: an enumeration of call sites goes stale the moment one is added or removed, while the
// bound (applied only at derivation, nothing later) stays true regardless.

const SECTION_SEPARATORS = /(?:—|–|\s--\s|\s-\s)\s*\S/

// Regex-escape a heading before splicing it into a pattern. A heading is caller-supplied text,
// not a pattern: without this, `Out.of.Scope` would match `Out of Scope`, and a heading with a
// `(` in it would throw instead of simply not matching.
function escapeForPattern(heading) {
  return String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The body of a `## <heading>` section, plus the 1-based line number the heading sits on.
//
// The section ends at the next heading of ANY level, not just `##`. A task heading is `###` and
// its file list is a bullet list; terminating only on `##` would sweep every task's files into
// the section. Scanning for the terminator with a second exec on the remainder — rather than one
// regex with a lookahead — keeps the end-of-file case honest: JS has no `\Z` anchor, and `\Z`
// inside a pattern is an identity escape matching a literal "Z", which would silently drop a
// section that ends the file.
function sectionBody(markdown, heading) {
  const text = String(markdown ?? '')
  // Trailing whitespace is matched with `[^\S\n]*` rather than `\s*`, so the match ends at the
  // end of the heading's own line. `\s*$` is equally happy to swallow the newline and land on
  // the blank line below, which costs the section body its first line and shifts every reported
  // line number by one.
  const match = new RegExp(`^##\\s+${escapeForPattern(heading)}[^\\S\\n]*$`, 'm').exec(text)
  if (!match) return null
  const rest = text.slice(match.index + match[0].length)
  const next = /^#{1,6}\s/m.exec(rest)
  return {
    body: next ? rest.slice(0, next.index) : rest,
    // `rest` begins at the end of the heading line, so splitting it on newlines puts the
    // remainder of the heading line at index 0. Offsetting by the heading's own line number
    // therefore makes index i the true 1-based line of the (i)th element.
    headingLine: text.slice(0, match.index).split('\n').length,
  }
}

/**
 * The bullet entries of a `## <heading>` section.
 *
 * @param {string} markdown plan markdown
 * @param {string} heading the `##` heading text, without the `##`
 * @returns {{ text: string, line: number }[]} one entry per bullet, `line` being the 1-based
 *   line number of the bullet's FIRST line (a wrapped bullet reports where it starts)
 */
// Same marker three or more times, each optionally separated by spaces or tabs — the
// CommonMark thematic break. `_` is included for fidelity even though it can never reach the
// bullet pattern, so this reads as the rule it is rather than a bullet-collision special case.
const THEMATIC_BREAK = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/

export function bulletSection(markdown, heading) {
  const section = sectionBody(markdown, heading)
  if (!section) return []
  const items = []
  // A bullet wrapped over two lines is one entry, not a truncated one. Keeping only the first
  // line would hand a reader the opening clause of a rule and silently drop the rest — the
  // failure is invisible, because what remains reads as a complete sentence. An indented,
  // non-blank line directly under an item is joined onto it; a blank line closes the item, so a
  // following indented paragraph is not swallowed. A nested bullet matches the bullet pattern
  // first and so stays a standalone entry.
  //
  // The continuation test excludes an indented line that is itself bullet-shaped (a marker from
  // the `-`/`*`/`+` class followed by a space, or a bare marker), so a line the bullet pattern
  // rejects is dropped rather than appended. Joining it would fuse two unrelated entries into one
  // that reads as a single sentence and says what neither author wrote; a dropped malformed entry
  // is the lesser failure, and the only one that cannot silently misinform a reader. The
  // lookahead is `[-*+]\s|[-*+]$` rather than a bare marker character, so a continuation that
  // merely *starts* with a marker character still joins: `--no-ff` opens a rule's second line in
  // this project's own constraints, and excluding every leading hyphen would truncate it into a
  // sentence that reads complete. Both patterns share the same `[-*+]` class deliberately, but
  // NOT for the reason this comment used to give. It claimed a narrow lookahead would let a
  // `*`/`+` continuation be mistaken for a fresh bullet and split a multi-line entry in two;
  // that cannot happen, because the bullet pattern is tested FIRST, so an indented `  * and b`
  // becomes its own entry under either lookahead — measured, identical output both ways. What
  // the shared class actually decides is the one line the bullet pattern rejects: a BARE `*` or
  // `+` marker with no content. Narrow, it is appended to the entry above (`alpha *`); wide, it
  // is dropped. That is the opposite direction from splitting — joining, not severing.
  //
  // Neither pattern below uses `.` to span a bullet's text: `.` does not match U+2028/U+2029
  // while `\s` does, so a bullet whose text contains one failed the bullet pattern entirely and
  // was dropped with no diagnostic — a line the plan states that reaches nobody. Any future
  // widening of either pattern has to keep that property.
  let open = false
  const lines = section.body.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // A thematic break outranks a list item, per CommonMark, and without this check a spaced
    // one parses AS a list item: `[-*+]` takes the first marker, `\s+` takes the space, and the
    // capture group swallows the rest, so `* * *` yields an entry reading `* *`. That entry
    // reaches both consumers — `parseConstraints` puts it in every teammate brief, and
    // `parsePlanSections` refuses a plan whose only defect is a horizontal rule. Only `-` and
    // `*` collide: `_` is a break character but never a bullet marker, and `+` is a bullet
    // marker but never a break character, so `+ + +` stays the list item it is.
    const bullet = THEMATIC_BREAK.test(line) ? null : /^\s*[-*+]\s+([^\n]*\S)\s*$/.exec(line)
    if (bullet) {
      items.push({ text: bullet[1], line: section.headingLine + i })
      open = true
    } else if (open && /^\s+(?![-*+]\s|[-*+]$)\S/.test(line)) {
      items[items.length - 1].text += ` ${line.trim()}`
    } else {
      open = false
    }
  }
  return items
}

/**
 * The prose body of a `## <heading>` section as a single line.
 *
 * Internal runs of whitespace collapse to single spaces, so a destination wrapped across four
 * markdown lines is one line when `finish` reports it back to an operator.
 *
 * @param {string} markdown plan markdown
 * @param {string} heading the `##` heading text, without the `##`
 * @returns {string | null} the collapsed, trimmed text, or `null` when the heading is absent
 */
export function proseSection(markdown, heading) {
  const section = sectionBody(markdown, heading)
  if (!section) return null
  return section.body.replace(/\s+/g, ' ').trim()
}

/**
 * A plan section defect: a malformed entry, or a section that requires another one.
 *
 * `line`, `entry`, `reason` and `index` are own properties so a caller can format a refusal
 * without re-parsing the message. `line`, `entry` and `index` are `null` on a document-level
 * defect, which has no offending bullet to quote.
 */
export class PlanSectionError extends Error {
  constructor(message, { line = null, entry = null, reason = null, index = null } = {}) {
    super(message)
    this.name = 'PlanSectionError'
    this.line = line
    this.entry = entry
    this.reason = reason
    // The 1-based ordinal of the offending entry within its section. Not part of the spec's
    // named trio, but a caller rendering "Out of Scope entry 2 (line 34)" cannot recover it:
    // the throw happens before the section is returned, so there is no array left to index.
    this.index = index
  }
}

/**
 * Parse a plan's three optional header sections, refusing a malformed one.
 *
 * @param {string} markdown plan markdown
 * @returns {{ destination: string | null, notYetSpecified: { text: string, line: number }[],
 *   outOfScope: { text: string, line: number }[] }}
 * @throws {PlanSectionError} on a defect in `## Out of Scope` or `## Not Yet Specified`
 */
export function parsePlanSections(markdown) {
  const destination = proseSection(markdown, 'Destination')
  const notYetSpecified = bulletSection(markdown, 'Not Yet Specified')
  const outOfScope = bulletSection(markdown, 'Out of Scope')
  const hasOutOfScope = sectionBody(markdown, 'Out of Scope') !== null

  // Checked before the per-entry rules because it is a defect in the document rather than in any
  // one entry: quoting a bullet here would point at a line that is not what is wrong.
  //
  // Two separate readings, and they do not point the same way. What TRIGGERS the requirement is
  // the presence of the `## Out of Scope` heading, not the number of bullets under it: an author
  // who opened the section has declared a boundary exists, and a plan with a boundary needs the
  // destination it is a boundary of. What SATISFIES it is prose, not a heading — `!destination`
  // rather than `destination === null`, so an empty `## Destination` is refused along with an
  // absent one. The dependency exists because an unwritten destination leaves Out of Scope
  // unjudgeable and makes it a place to park anything inconvenient, and a heading with nothing
  // under it buys exactly none of that back. Decided by the user in phase 1 of run `fog`. The
  // plan's Step 6 and the design spec both read as mere heading presence for a while and have
  // since been corrected to state prose, so the three now agree.
  if (hasOutOfScope && !destination) {
    throw new PlanSectionError('this plan has an Out of Scope section but no Destination', {
      reason: 'missing-destination',
    })
  }

  // A reason clause is defined by SHAPE, not by judgement: a separator with at least one
  // non-whitespace character after it. Nothing here checks that the text after the separator is
  // a *good* reason — that is not decidable, and pretending otherwise would refuse honest
  // entries. What the rule buys is that a boundary cannot be recorded as a bare noun.
  outOfScope.forEach((entry, i) => {
    if (SECTION_SEPARATORS.test(entry.text)) return
    throw new PlanSectionError(`Out of Scope entry ${i + 1} (line ${entry.line}) has no reason`, {
      line: entry.line,
      entry: entry.text,
      reason: 'missing-reason',
      index: i + 1,
    })
  })

  // CONTAINS a `?`, not ends with one. This was written as "ends with" first and broke
  // immediately: a fog entry worth reading is a question plus the context that makes it one —
  // what it depends on, what it would change. Requiring the final character to be `?` forbids
  // that context and pushes the author toward a bare question they then explain nowhere.
  // Containment still refuses the work item wearing a note's clothes, which has no `?` anywhere.
  notYetSpecified.forEach((entry, i) => {
    if (entry.text.includes('?')) return
    throw new PlanSectionError(
      `Not Yet Specified entry ${i + 1} (line ${entry.line}) asks no question`,
      {
        line: entry.line,
        entry: entry.text,
        reason: 'missing-question',
        index: i + 1,
      },
    )
  })

  return { destination, notYetSpecified, outOfScope }
}
