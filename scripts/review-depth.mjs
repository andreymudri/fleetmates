// How much review a change needs, as a suggestion.
//
// ADVISORY, and that is the design rather than a first step toward enforcement. The coupling map
// this reads is correlation in history, and its standing rule is that no gate consults it: a map
// that could fail a phase would be a map worth gaming. So this returns a suggestion, the command
// that prints it exits 0 whatever it says, and nothing reads it but the skill that sizes the
// inline final review. A fleet phase keeps the lenses its manifest declares.
//
// The limits are starting values chosen without measurement. They are constants here so that
// changing them is one edit with the boundary tests beside it.
export const DEPTH_LIMITS = Object.freeze({
  smallFiles: 3,
  smallLines: 60,
  largeFiles: 15,
  largeLines: 600,
  // A neighbour counts as coupled when it changed in at least this share of the commits that
  // touched a file of the diff. Any lower and one shared commit in a long history counts, which
  // would make every change to an old file look coupled.
  coupledConfidence: 0.5,
})

const whole = (value, name) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`review depth needs ${name} as a whole number >= 0`)
  return value
}

// Pure. `coupled` is the number of files OUTSIDE the diff that history couples to it.
export function reviewDepth({ files, lines, coupled }) {
  const measured = { files: whole(files, 'files'), lines: whole(lines, 'lines'), coupled: whole(coupled, 'coupled') }
  if (files > DEPTH_LIMITS.largeFiles || lines > DEPTH_LIMITS.largeLines) {
    // null, not a list: "every lens the project's manifest declares" is not this module's to name.
    return { suggestion: 'all-lenses', lenses: null, ...measured }
  }
  if (files <= DEPTH_LIMITS.smallFiles && lines <= DEPTH_LIMITS.smallLines && coupled === 0) {
    return { suggestion: 'tests-only', lenses: [], ...measured }
  }
  return { suggestion: 'two-lenses', lenses: ['correctness', 'tests'], ...measured }
}

const MEANING = {
  'tests-only': 'run the test suite; no reviewer',
  'two-lenses': 'one review of the whole diff through two lenses: correctness and tests',
  'all-lenses': 'one review of the whole diff through every lens the gate manifest declares',
}

export function renderReviewDepth(result) {
  return [
    `diff: ${result.files} file${result.files === 1 ? '' : 's'}, ${result.lines} changed line${result.lines === 1 ? '' : 's'}, ${result.coupled} coupled file${result.coupled === 1 ? '' : 's'} outside it`,
    `suggestion: ${result.suggestion} (${MEANING[result.suggestion]})`,
    'advisory: this is a suggestion from size and history; no gate reads it and it never fails anything',
  ].join('\n')
}
