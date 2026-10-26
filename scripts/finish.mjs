// Whether a whole run is finished, phase by phase.
//
// `gate` computes ONE phase — the first un-integrated one — so verifying a completed run meant
// driving it once per phase by hand and reading each JSON verdict separately, with the phase list
// taken from `status.gates`: a file written by the agents being enforced. The phases here come
// from the plan at the anchor, and every verdict is recomputed now. Nothing recorded is consulted.
//
// The split that matters is failed versus pending. A failed check is a phase that was verified
// and did not hold. A pending one was never computed at all — an `agent` or `mcp` check has no
// runner, so it stays pending until a caller supplies it through `gate --results`. Reporting them
// together would turn "nobody reviewed phase 3" into "phase 3 is broken", which invites a retry
// of work that was never wrong.

import { printable } from './reviews.mjs'

// The per-phase counterpart of `gate --results`. `finish` recomputes every phase, and every
// phase with an `agent` check comes back pending, because nothing runs an agent check — so on
// this repository's own manifest `finish` could never report a run complete, which it proved on
// run `codemap` against three phases that each held a CLI-computed PASS.
//
// Keyed by phase, because a run's phases are reviewed separately and a single flat list could
// silently satisfy phase 3 with phase 1's review. `validateSuppliedPhases` below validates only
// the SHAPE of the supplied file — that phases is an object keyed by canonical phase numbers,
// each holding a results array. It does not know or enforce gate's rule that only `agent` and
// `mcp` results may be supplied, or check the `status`/`source` of an individual result: that
// is the caller's job, via `validateSuppliedResults` in scripts/cli.mjs, which must run over
// each phase's results array before any of it is merged.
export function suppliedForPhase(supplied, phase) {
  if (!supplied || typeof supplied !== 'object') return []
  const byPhase = supplied.phases ?? {}
  const entry = byPhase[String(phase)]
  return Array.isArray(entry?.results) ? entry.results : []
}

export function validateSuppliedPhases(supplied) {
  if (supplied === null || supplied === undefined) return null
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    return '--results must be a JSON object shaped { "phases": { "<n>": { "results": [...] } } }'
  }
  const byPhase = supplied.phases
  if (byPhase === undefined) return '--results names no phases: expected { "phases": { "<n>": { "results": [...] } } }'
  if (byPhase === null || typeof byPhase !== 'object' || Array.isArray(byPhase)) {
    return '--results "phases" must be an object keyed by phase number'
  }
  for (const [phase, entry] of Object.entries(byPhase)) {
    const asNumber = Number(phase)
    if (!Number.isInteger(asNumber)) return `--results names a non-numeric phase: ${JSON.stringify(phase)}`
    // A key that parses to a phase number but is not that number's OWN canonical string form
    // ('01', '1.0', ' 1', '1e0', '0x1', or '' — which `Number('')` coerces to 0) would match
    // nothing at lookup: `suppliedForPhase` looks up `String(phase)`, so only the canonical
    // form is ever read back. Refusing here (rather than canonicalising at lookup) keeps this
    // module's rule consistent — every other malformed shape above is refused, not guessed at
    // — and the consequence is that the caller must supply keys exactly as `String(n)` renders
    // them, or the evidence is rejected up front instead of silently going missing.
    if (String(asNumber) !== phase) {
      return `--results names a non-canonical phase key: ${JSON.stringify(phase)} (use ${JSON.stringify(String(asNumber))})`
    }
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.results)) {
      return `--results phase ${phase} must be an object with a results array`
    }
  }
  return null
}

export function summarizeRun(phaseResults = []) {
  const failedPhases = []
  const pendingPhases = []
  for (const entry of phaseResults) {
    const verdict = entry.verdict ?? {}
    // Failure first: a phase that both failed a computed check and is missing a review is a
    // failing phase. Recording it as merely unverified would understate it.
    if ((verdict.failed ?? []).length > 0) failedPhases.push(entry.phase)
    else if ((verdict.pending ?? []).length > 0) pendingPhases.push(entry.phase)
  }
  // An empty run is not a passing one. A plan that parsed to zero phases produces no evidence
  // at all, and "no phase failed" is not the same claim as "every phase passed".
  const complete = phaseResults.length > 0 && failedPhases.length === 0 && pendingPhases.length === 0
  return { complete, failedPhases, pendingPhases }
}

// Each check name here is read out of the manifest, so it is agent-written text arriving inside a
// rendered table. `printable` rather than `printableBlock`: the block form keeps newlines by
// design, and a name carrying one would ADD A LINE shaped like a row this code wrote — a forged
// row in the table an operator reads to decide whether a run is finished, needing no escape
// sequence at all. Wrapping at the print site in cli.mjs cannot close that, because by then the
// name is already part of a block whose newlines are the table itself.
//
// Stated exactly, so the comment claims no more than the code does: this neutralises the C0 and
// C1 control bytes plus U+2028 and U+2029, replacing each with a visible `<0x..>` token. The bidi
// and format controls U+202E, U+2066–2069, U+200E/200F and U+061C are NOT neutralised and pass
// through — they can reorder how a row reads, but cannot erase a line or start one. See the
// comment on `printable` in `scripts/reviews.mjs` for why that line is drawn where it is.
export function renderRunSummary(runId, phaseResults = []) {
  const summary = summarizeRun(phaseResults)
  // `runId` reaches this line by a different route from the names below — it is whatever string
  // the `--run` flag carried, not a value read out of an agent-written file — but it is wrapped
  // for the same reason and it is the only thing wrapping it. `cli.mjs` prints this block
  // unwrapped, so with this `printable` removed a control byte in `--run` reaches stdout inside
  // a line an operator reads as this CLI's own verdict. Two tests hold it: the run id row in the
  // sanitising table in `tests/cli.test.mjs` and the `renderRunSummary` unit test beside it.
  const lines = [`run ${printable(runId)} — every verdict below was recomputed from git just now, not read from a record`]

  for (const entry of phaseResults) {
    const verdict = entry.verdict ?? {}
    const blocking = [
      ...(verdict.failed ?? []).map((n) => `failed: ${printable(n)}`),
      ...(verdict.pending ?? []).map((n) => `pending: ${printable(n)}`),
      ...(verdict.skipped ?? []).map((n) => `skipped: ${printable(n)}`),
    ]
    lines.push(`  phase ${entry.phase}   ${verdict.verdict ?? 'FAIL'}${entry.supplied ? ' (review supplied)' : ''}${blocking.length ? `   ${blocking.join(', ')}` : ''}`)
  }

  // A test skipped at every gate is invisible to the verdict by design (standing skips never fail),
  // so the end of the run is where it is named: the rustot-stats case, five live assertions skipped
  // at every gate because the environment was never provisioned.
  const standing = phaseResults.at(-1)?.standing ?? []
  if (standing.length > 0) {
    const units = [...new Set(standing.map((s) => s.unit))]
    lines.push(`standing skips at the last gate: ${standing.length} (units: ${units.map((u) => printable(u)).join(', ')})`)
  }

  if (summary.complete) {
    lines.push('every phase passes: the run branch is ready to land')
    return lines.join('\n')
  }

  lines.push('not finished')
  if (summary.failedPhases.length) {
    lines.push(`  phases with a failing check: ${summary.failedPhases.join(', ')} — fix those, do not land`)
  }
  if (summary.pendingPhases.length) {
    lines.push(`  phases with an unverified check: ${summary.pendingPhases.join(', ')} — run those checks and supply them with gate --results; a check nobody ran is not a check that passed`)
  }
  if (phaseResults.length === 0) {
    lines.push('  the plan produced no phases at all, so there is nothing verified here')
  }
  return lines.join('\n')
}

// Report the destination and open fog entries from a plan. This is for REPORTING — the verdict
// is computed elsewhere and is not affected by what this function returns. A run with open fog
// is exactly as landable as the same run without it. Making a verdict turn on these fields would
// put landability behind free-text prose that the enforced agents can write.
//
// Both `destination` and each fog entry's `text` are agent-written — they arrive from `plan.json`,
// not from this CLI — and reach the same operator's terminal `renderRunSummary` above defends, so
// both go through `printable` before they are printed. Two mutation-pinned tests hold each call:
// removing either one leaves the rest of this file's suite green, because nothing else in this
// module exercises what `printable` neutralises.
//
// `destination` is additionally wrapped in `JSON.stringify`, the same `JSON.stringify(printable(v))`
// shape `cli.mjs` uses everywhere else it prints an agent-written value (see `show` at
// `scripts/cli.mjs:655`). A destination that is a lone zero-width character — U+200B, invisible in
// a terminal — used to render as `Destination: ` with nothing visibly after it, which an operator
// reads as this function having failed to render rather than as the destination the plan actually
// declared. Quoting draws the boundary the missing text could not: `Destination: "​"` still shows
// an empty-looking value, but the quote marks say a value is there. Fog entries are NOT quoted:
// they are read as a bulleted list of prose reminders, each already bounded by its own `  - `
// prefix and the entries around it, and quoting every one would make that list harder to read for
// a cosmetic case `printable` has already made inert (a control byte or U+2028 in an entry cannot
// forge a line; see `renderRunSummary` above). If an invisible fog entry proves as misleading in
// practice as the invisible destination did, apply the same fix there too.
// INPUT-SHAPE DEFENSE LIVES HERE, not at the call site. `plan.json` is teammate-writable and
// gitignored, so this function is fed hostile input by construction, and a caller's `?? {}` can
// only ever cover the null case. Everything else it used to do wrong was a MISRENDER, not a
// throw — a string `notYetSpecified` iterated per character into `  - undefined` rows, a
// non-string destination printed `Destination: "[object Object]"` — and a surrounding `try`
// cannot catch a misrender. So each field is checked for the shape it is documented to have and
// ignored when it does not have it.
//
// Unreadable entries are COUNTED AND REPORTED rather than silently skipped: the count on the
// heading is what an operator reads as "how much fog is left", so it must describe what is on
// screen, and dropping four entries without a word would report the fog as smaller than it is.
// This block prints AFTER the verdict, and `plan.json` is teammate-writable and gitignored, so
// an unbounded list scrolls the "do not land" lines off the operator's screen — measured at
// 50,000 entries: 50,005 lines, 3.1 MB, the verdict on lines 3 and 4. The exit code was never
// affected, so no scripted caller could be fooled; this cap exists for the human reading the
// tail of a terminal. The heading still reports the TRUE total and the tail names what was
// withheld, because a cap that quietly shrinks the count would trade one misreport for another.
const FOG_LINE_CAP = 20

export function renderPlanNotes(plan = {}) {
  const blocks = []
  const source = (plan !== null && typeof plan === 'object') ? plan : {}
  const destination = typeof source.destination === 'string' ? source.destination : null
  const entries = Array.isArray(source.notYetSpecified) ? source.notYetSpecified : []
  const readable = entries.filter(
    (entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string',
  )
  const unreadable = entries.length - readable.length

  if (destination) {
    blocks.push(`Destination: ${JSON.stringify(printable(destination))}`)
  }

  // Silence when NOTHING is readable, which is the established contract for a corrupt
  // `plan.json` — an unparseable one is swallowed without a word, and a wholly wrong-shaped one
  // is the same failure seen one layer in. The notes block exists to report fog; with no fog it
  // can report, printing a bare "(0 open)" heading would add noise to the verdict report for a
  // condition the operator cannot act on from here. But once there IS something to show, the
  // count beside it has to be honest, so drops are named rather than quietly subtracted.
  if (readable.length > 0) {
    const fogLines = [`Not yet specified (${readable.length} open):`]
    for (const entry of readable.slice(0, FOG_LINE_CAP)) {
      fogLines.push(`  - ${printable(entry.text)}`)
    }
    const withheld = readable.length - Math.min(readable.length, FOG_LINE_CAP)
    if (withheld > 0) fogLines.push(`  ... ${withheld} more (capped; the full list is in plan.json)`)
    if (unreadable > 0) {
      fogLines.push(`  (${unreadable} unreadable ${unreadable === 1 ? 'entry' : 'entries'} in plan.json omitted)`)
    }
    blocks.push(fogLines.join('\n'))
  }

  // Blocks, not lines: the plan's Step 2 sample shows a blank line between the destination and
  // the fog block, so a reader does not mistake the last fog bullet for a continuation of the
  // destination's wrapped prose.
  return blocks.join('\n\n')
}
