// The agent-returned half of the map: prose about what a target project's modules are FOR,
// which no statistic over git history can supply. Returned by a dispatched read-only agent and
// written by the orchestrator.
//
// It is stored, unlike the coupling half, because an agent wrote it and rewriting it costs a
// model call. So it carries the commit it was written at, and a reader that finds the repository
// has moved treats it as stale rather than as fact. That is the same bargain the gate strikes
// with the anchor: derived state is allowed to exist as long as it names what it was derived
// from and anything reading it can check.
//
// The header is treated as provenance to be compared, not validated as a sha: a malformed
// value like "UNKNOWN" is accepted, then reported as a mismatch when the repository is at
// a different commit, rather than rejected as invalid.
//
// Advisory only. No check reads it, and nothing in it can fail a phase.

import { NAMES } from './names.mjs'
const HEADER = new RegExp(`^<!--\\s*${NAMES.mapHeader}\\s+run=(\\S+)\\s+sha=(\\S+)\\s*-->`)

export function mapNotesHeader({ runId, sha }) {
  if (!runId || !sha) throw new Error(`map notes need a run id and a sha, got ${JSON.stringify({ runId, sha })}`)
  return `<!-- ${NAMES.mapHeader} run=${runId} sha=${sha} -->`
}

export function readMapNotesHeader(text) {
  const match = HEADER.exec(String(text ?? '').trimStart())
  return match ? { runId: match[1], sha: match[2] } : null
}

// Returns a reason string when the notes must not be used as-is, or null when they are current.
// A missing or unreadable header is stale, never "probably fine": notes with no provenance are
// exactly the artefact this design refuses to trust elsewhere.
export function mapNotesStale(text, { runId, sha }) {
  if (!text || String(text).trim() === '') return 'no map notes have been written for this run'
  const header = readMapNotesHeader(text)
  if (!header) return `the map notes carry no ${NAMES.mapHeader} header, so nothing says which commit they describe`
  if (header.sha !== sha) return `the map notes describe commit ${header.sha}, but the repository is at ${sha}`
  if (header.runId !== runId) return `the map notes were written for run ${header.runId}, not ${runId}`
  return null
}

// The prompt handed to an Explore agent. Written here rather than in the skill so the file path,
// the header line and the instruction not to guess stay in one place with the parser above.
export function mapNotesPrompt({ runId, sha, notesPath, topDirectories = [] }) {
  return [
    'Map this repository for a fleet about to work on it. Return the map as your final output —',
    'do NOT write it to a file. You are dispatched read-only on purpose: the orchestrator writes',
    `it to ${notesPath}, because nothing a teammate writes is trusted by this design.`,
    '',
    `Begin your output with exactly this line, unchanged: ${mapNotesHeader({ runId, sha })}`,
    '',
    'Then, for each significant area of the codebase: what it is for, what depends on it, and the',
    'one thing a newcomer would get wrong about it. Prefer naming the module that owns a concept',
    'over listing files. Say "unclear" where the code does not tell you — a guess dressed as a',
    'fact is worse here than a gap, because implementers will act on it.',
    '',
    topDirectories.length ? `The largest directories by file count are: ${topDirectories.join(', ')}.` : '',
    '',
    'Read the code. Do not infer the architecture from README claims alone, and do not modify any',
    'file in this repository — you are reading it, not changing it.',
  ].filter((line) => line !== '').join('\n')
}

// The orchestrator writes the notes, so it needs one place to decide whether what an agent
// returned is writable. A returned map missing its header is not "close enough": the header is
// the only thing that lets a later reader tell which tree the prose describes, and inventing one
// on the agent's behalf would manufacture exactly the provenance this design refuses to fake.
export function mapNotesWritable(text, { runId, sha }) {
  const body = String(text ?? '')
  if (body.trim() === '') return 'the agent returned nothing to write'
  const header = readMapNotesHeader(body)
  if (!header) return `the returned map does not begin with the ${NAMES.mapHeader} header it was given`
  if (header.sha !== sha) return `the returned map claims commit ${header.sha}, but the dispatch named ${sha}`
  if (header.runId !== runId) return `the returned map claims run ${header.runId}, but the dispatch named ${runId}`
  // The header alone is not a map: an agent that echoes back only the line it was handed has
  // produced nothing a reader can use, and that text still passes every check above, because
  // the header IS the provenance it claims. Strip the matched header off the front and require
  // something beyond blank lines or spaces to remain. No minimum length beyond that: a small
  // repository can legitimately produce a short map, and this guard is about presence of a
  // body, not its quality.
  const afterHeader = body.trimStart().slice(HEADER.exec(body.trimStart())[0].length)
  if (afterHeader.trim() === '') return 'the returned map has no body beyond the header, so there is nothing to write as a map'
  return null
}
