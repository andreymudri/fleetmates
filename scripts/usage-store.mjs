// Per-run token reporting: the half that touches disk.
//
// THE LAYOUT THIS READS IS HARNESS-INTERNAL AND NOT A PUBLIC API:
//
//   <projectsDir>/<projectSlug(root)>/<session-id>/subagents/agent-<id>.jsonl
//   <projectsDir>/<projectSlug(root)>/<session-id>/subagents/agent-<id>.meta.json
//
// Anthropic can change it without notice. Every failure below is therefore reported rather than
// absorbed: when the store is missing this throws NAMING THE PATH, and never returns an empty
// report, because a zero reads as "no usage" and would be a lie the reader has no way to catch.

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { isUnsafePathComponent, printable } from './reviews.mjs'
import { projectSlug, summarizeTranscript } from './usage.mjs'

// The shipped default bound. Exported because injecting `maxEntries` verifies only that the
// truncation notice fires, never what the default is.
//
// READING THIS CONSTANT IS NOT READING THE BOUND THE WALK APPLIES — an earlier comment here said
// it was, and that was false: the default is resolved from `maxEntries ?? this` at a site nothing
// pinned, so raising it by one token (in the signature, or in the `??`) left the walk effectively
// unbounded with the entire suite green. The applied cap is returned on the report as `cap`, and
// that is what the test asserts against.
export const DEFAULT_MAX_ENTRIES = 20_000

// Tagged, not matched by text. The catch below has to tell THIS error apart from a raw fs error,
// and the message it would have matched on embeds a caller-controlled path — so a session named
// `no transcripts found` made an ENOENT from `realpath` match the regex and be rethrown verbatim,
// losing the one sentence this module exists to print. A property cannot be spelled by a caller.
const HARNESS_LAYOUT = Symbol('harness-layout')

function missing(dir) {
  const err = new Error(`no transcripts found at ${dir} — this is a harness-internal layout and may have changed`)
  err[HARNESS_LAYOUT] = true
  return err
}

// A session is identified by the store it carries, not by being the newest directory. The project
// directory holds more than sessions — the harness keeps `memory/` beside them — and that one is
// written on every session, so it won every mtime comparison and the command reported on a
// directory that can never hold a transcript. Requiring `subagents/` is the same test the read
// below performs, moved to where the choice is made.
async function newestSession(projectDir) {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    throw missing(projectDir)
  }
  const sessions = []
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const dir = path.join(projectDir, entry.name)
    let store
    try {
      // lstat, NOT stat: `stat` FOLLOWS the link, so a `subagents` symlink pointing anywhere on
      // disk answered `isDirectory()` with true and the session became a candidate — then won on
      // mtime and was auto-selected with no `--session` given. `lstat` describes the link itself,
      // which is not a directory, so the session is passed over here.
      store = await lstat(path.join(dir, 'subagents'))
    } catch {
      continue
    }
    if (!store.isDirectory()) continue
    // The later of the two: the session directory is stamped when its store is created, the store
    // when a transcript is added to it. Taking the max keeps the current session ahead of an older
    // one whichever of the two the harness last touched.
    const own = (await stat(dir)).mtimeMs
    sessions.push({ name: entry.name, mtime: Math.max(own, store.mtimeMs) })
  }
  // Named for the layout rather than for whichever directory happened to be newest, which would
  // read as "that session is empty" instead of "no session here has a store at all".
  if (sessions.length === 0) throw missing(path.join(projectDir, '<session-id>', 'subagents'))
  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions[0].name
}

// `maxEntries` is injectable so the cap can be TESTED without building a store past it. Creating
// 20,000 real files to exercise a bound is slow everywhere and fails outright where the open-file
// limit is lower than the fixture — macOS CI refused it with EMFILE. A bound nothing can reach in
// a test is a bound nothing verifies.
export async function readSessionUsage({ projectsDir, root, sessionId = null, maxEntries = null }) {
  // `root` is resolved here rather than trusted. The CLI passes `flags.root ?? process.cwd()`
  // verbatim, so `--root .` arrives as the literal ".", whose slug is "." — and `path.join`
  // then collapses to the projects directory itself, where the newest PROJECT gets mistaken for
  // a session. Resolving is idempotent for a path that is already absolute.
  // Refused by NAME. Unvalidated, 0 / negative / NaN left the walk unable to run and the store
  // reported as "layout may have changed" — a lie about a perfectly readable store, and exactly
  // the failure this module's header forbids. `null` crashed on toLocaleString, because a default
  // applies only to `undefined`.
  // Resolved from the constant HERE rather than as a default parameter, so the bound this function
  // applies and the bound a test can read are the same value. As a default parameter they were two:
  // changing the signature to Number.MAX_SAFE_INTEGER left the walk unbounded in production with
  // the suite green, because the only assertion about the default read the constant and never
  // observed it being used.
  const cap = maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!Number.isInteger(cap) || cap < 1) {
    // NOT `JSON.stringify` alone: it THROWS on a BigInt, so `2n` produced a serialization
    // TypeError naming neither the argument nor the value, from the very line whose contract is
    // that a bad cap is refused BY NAME. It also renders NaN and Infinity as `null`, so the
    // message quoted a value the caller had not passed. `String` first for those three.
    const shown = typeof maxEntries === 'bigint'
      ? `${maxEntries}n`
      : typeof maxEntries === 'number' && !Number.isFinite(maxEntries)
        ? String(maxEntries)
        : JSON.stringify(maxEntries) ?? String(maxEntries)
    throw new Error(`maxEntries must be a positive integer, got ${shown}`)
  }
  const projectDir = path.join(projectsDir, projectSlug(path.resolve(root)))
  const session = sessionId ?? await newestSession(projectDir)
  // Checked before it is joined, and checked here rather than only at the CLI: `--session` is not
  // the only way a name reaches this line. `newestSession` returns a directory name that is
  // joined again, so a directory an attacker can create under the projects directory is the same
  // primitive. Unvalidated, `../` walked out of the store entirely and read .jsonl files
  // elsewhere on disk, disclosing the first bytes of one through a parse-error line.
  // The SAME function `reviewFileName` uses, not a second copy of its rule. The two were separate
  // implementations and drifted: both missed that Windows strips trailing spaces and dots, so
  // `'.. '` reached the filesystem as `..`.
  if (isUnsafePathComponent(session)) {
    throw new Error(`a session must be a non-empty name with no path separators, got ${JSON.stringify(printable(session))}`)
  }
  const subagentsDir = path.join(projectDir, session, 'subagents')

  // VALIDATING THE COMPONENT'S NAME CANNOT VALIDATE ITS TARGET. The check above refuses a session
  // that spells an escape; it cannot see an ordinary name whose directory — or whose `subagents`
  // — is a SYMLINK out of the store. `readdir`, `stat` and `readFile` all follow links, so the
  // walk's own entry point was reachable from anywhere on disk while the comment below correctly
  // described the links found INSIDE the walk as closed. It had closed half the hole.
  //
  // EXACT MATCH, ANCHORED AT `projectsDir`. Three earlier shapes of this check were defeated:
  //
  //   1. Comparing against `realpath(projectDir)` anchors on a DERIVED name — `<projectsDir>/
  //      <slug>` — which whoever writes the store can replace with a symlink. `realpath` then
  //      follows it and the attacker's store resolves "inside" the attacker's own directory, so
  //      the pass-6 escape reopened with ONE link instead of two, auto-selected with no flag.
  //      `projectsDir` is supplied by the caller and is the only path here nobody plants.
  //   2. `rel.startsWith('..')` is string math on a path: it refuses a legitimate in-store session
  //      named `..foo`, which `isUnsafePathComponent` two lines up accepts — the two checks
  //      disagreeing about one value — while a sibling session's store (`rel` = `sess-other/
  //      subagents`) passed and reported another session's spend under this session's id.
  //   3. Anything prefix-based needs a separate `rel === ''` arm to stop a store resolving to the
  //      project directory itself, which walked EVERY session into one session's report.
  //
  // Comparing the fully resolved store against the one path it is allowed to be removes all three
  // classes at once: there is no prefix arithmetic to get wrong. Both sides are resolved, so a
  // link the operator put ABOVE `projectsDir` still works (a macOS temp dir is `/var` ->
  // `/private/var`) — and a link anywhere at or below it does not, including one that stays inside
  // the project. That last case worked at c2d0398 and is DELIBERATELY refused now: telling a
  // benign relocation link apart from a hostile one means trusting the directory the attacker
  // writes to, and the layout this reads is harness-internal, not an operator-arranged one.
  let resolvedStore
  try {
    const resolvedRoot = await realpath(projectsDir)
    const expected = path.join(resolvedRoot, projectSlug(path.resolve(root)), session, 'subagents')
    resolvedStore = await realpath(subagentsDir)
    if (resolvedStore !== expected) throw missing(subagentsDir)
  } catch (err) {
    throw err?.[HARNESS_LAYOUT] ? err : missing(subagentsDir)
  }

  // The walk has to RECURSE, because a workflow-dispatched run keeps its transcripts under
  // `subagents/workflows/<wf-id>/` rather than flat, and a flat read reported five real
  // transcripts as zero.
  // It is written out by hand rather than using `readdir(..., { recursive: true })`, for three
  // reasons — each found by review after the recursive read shipped:
  //
  //   1. Node's recursive readdir FOLLOWS DIRECTORY SYMLINKS. One link planted inside the store
  //      made this command read and report transcripts from anywhere on disk, and the walk
  //      re-entered itself until ELOOP, multiplying every total. The session-name check above
  //      cannot help: it validates the one component this module joins, while that traversal
  //      happens inside the walk. `withFileTypes` + `isDirectory()` is false for a symlink, so a
  //      link is neither descended nor read as a transcript. That covers links found INSIDE the
  //      walk ONLY — the walk's ROOT is reached by the `readdir` below, which follows. The
  //      realpath containment check above is what closes the root; neither check subsumes the
  //      other, and this comment claimed the whole hole was shut when it had shut half of it.
  //   2. It propagates a NESTED failure to the caller. One unreadable subdirectory aborted the
  //      whole report, and the catch relabelled it "no transcripts found" — dropping a readable
  //      transcript sitting in the directory that message names, and blaming a layout change that
  //      had not happened. A directory removed mid-walk does the same, during exactly the live run
  //      an operator reports on.
  //   3. It is unbounded. The cap is cheap insurance, and this repo's worktree walk carries one.
  //
  // Only the TOP-LEVEL read failing is the "layout has changed" case; that is the one that throws.
  const transcripts = []
  const unreadable = []
  const pending = ['']
  let budget = cap
  let readAnything = false
  let truncated = false
  while (pending.length > 0 && !truncated) {
    const relative = pending.shift()
    let entries
    try {
      // `resolvedStore`, not `subagentsDir`: the check above resolved a NAME and the walk then
      // re-opened the same name, so repointing the `subagents` link between the two got a
      // transcript from outside the store into the report — measured at 16.5% of invocations
      // against a concurrent `rename()`. Reading from the resolved path means no open below here
      // traverses an unresolved link component. The window is not zero — the components of the
      // resolved path can still be swapped after `realpath` returns, which Node cannot close
      // without fd-relative opens — but it collapses to that one call, and an attacker who can
      // write inside the store can simply put a transcript there without racing anything.
      entries = await readdir(relative === '' ? resolvedStore : path.join(resolvedStore, relative), { withFileTypes: true })
      readAnything = true
    } catch {
      if (relative === '') break
      unreadable.push({ name: relative, reason: 'directory could not be read', kind: 'directory', dropped: 0, kept: 0 })
      continue
    }
    for (const entry of entries) {
      // Set where the walk ACTUALLY stops short, not inferred from the counter afterwards. The
      // post-decrement leaves `budget === 0` for a walk that consumed exactly `maxEntries` and saw
      // everything, so a `budget <= 0` test afterwards declared a complete report incomplete —
      // telling an operator that correct totals were untrustworthy.
      if (budget-- <= 0) { truncated = true; break }
      // Kept with `/` regardless of platform: it is a display name and a `path.join` argument,
      // and `path.join` accepts a forward slash on Windows.
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) pending.push(name)
      // `agent-` as well as the extension: the walk reaches a workflow's `journal.jsonl`, which is
      // valid JSONL carrying no usage and produced a phantom row of zeros for an agent that never
      // ran. The header above names the transcript file `agent-<id>.jsonl`; that is the filter.
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('agent-')) transcripts.push(name)
    }
  }
  // The cap must not stop the walk SILENTLY. Truncating without a word is the understatement this
  // module exists to prevent: a store past the cap under-reported its totals at exit 0, and with
  // nothing else in it reproduced the very "layout may have changed" throw reason 2 above says
  // this walk was written to eliminate — reintroduced by the bound added for reason 3.
  if (truncated) {
    unreadable.push({
      name: '(walk)',
      reason: `stopped after ${cap.toLocaleString('en-US')} entries; this report is incomplete`,
      kind: 'truncated',
      dropped: 0,
      kept: 0,
    })
  }
  if (!readAnything) throw missing(subagentsDir)

  const agents = []
  for (const name of transcripts.sort()) {
    const full = path.join(resolvedStore, name)
    let body
    try {
      body = await readFile(full, 'utf8')
    } catch (err) {
      // Named and counted, then carry on with the rest. Skipping silently would understate the
      // totals this command exists to make trustworthy.
      unreadable.push({ name, reason: 'could not be read', kind: 'unreadable', dropped: 0, kept: 0 })
      continue
    }

    // Per line, not per file. A transcript is appended to while its session runs, so reading one
    // during a live fleet run — exactly when an operator reports on it — catches a half-written
    // last line. Parsing the whole file in one try sent every record in it here, so an agent's
    // entire spend vanished while `fixed prefix = N%` was still computed from what survived.
    const records = []
    let dropped = 0
    for (const raw of body.split('\n')) {
      if (raw.trim() === '') continue
      try {
        records.push(JSON.parse(raw))
      } catch {
        // The count, never the parse message: that message quotes the offending source text back,
        // and the source is the operator's real transcript, so the snippet put private
        // conversation content into a printed report.
        dropped += 1
      }
    }
    if (dropped > 0) {
      unreadable.push({
        name,
        reason: `${dropped} of ${dropped + records.length} line(s) did not parse`,
        // `partial` asserts the transcript IS in the table minus some lines. With nothing parsed
        // it is absent from the table entirely and its whole spend is missing from TOTAL, so that
        // label states the opposite of what happened — the same misstatement this `kind` split was
        // introduced to remove, inverted.
        kind: records.length > 0 ? 'partial' : 'unreadable',
        dropped,
        kept: records.length,
      })
    }
    // Nothing parsed at all: there is no spend to attribute, so no row. An EMPTY file reaches here
    // with `dropped === 0`, so it recorded nothing and vanished from the report entirely — and
    // alone in a store it tripped the empty-report throw below and blamed a layout change that had
    // not happened. It is the ordinary state between a dispatch creating the transcript and the
    // first turn being appended, which is exactly when an operator reports on a live run.
    if (records.length === 0) {
      if (dropped === 0) unreadable.push({ name, reason: 'no records yet', kind: 'empty', dropped: 0, kept: 0 })
      continue
    }

    // A transcript with no readable meta is still an agent that spent tokens, so it gets a row
    // with its role unknown rather than being dropped.
    let agentType = '(unknown)'
    let model = '(unknown)'
    // DERIVED, never enumerated — so this is the one read here that passes neither the walk's
    // `withFileTypes` + `isFile()` filter nor the containment check above, both of which only ever
    // see paths the walk listed. Unguarded it was a constrained arbitrary file read (a symlinked
    // `.meta.json` printed any JSON file's `agentType` and `model` into the operator's table) and
    // a hang: `readFile` on a FIFO blocks with no writer, no timeout and no AbortSignal, and the
    // pending read keeps the event loop alive, so `usage` never returned and the process would
    // not exit. `lstat` describes the link or the FIFO itself, and only a regular file is read.
    const metaPath = full.replace(/\.jsonl$/, '.meta.json')
    try {
      const meta = await lstat(metaPath)
      if (!meta.isFile()) throw new Error('meta is not a regular file')
      const parsed = JSON.parse(await readFile(metaPath, 'utf8'))
      if (typeof parsed.agentType === 'string') agentType = parsed.agentType
      if (typeof parsed.model === 'string') model = parsed.model
    } catch { /* no meta, not a regular file, or unreadable: the row stays, the role does not */ }

    agents.push({ name, agentType, model, ...summarizeTranscript(records) })
  }

  // The invariant the header states, enforced at the one place it can be: a store that yielded no
  // transcript AND no unreadable file is not a session that cost nothing, it is a session whose
  // transcripts are not where this module looked. Returning `agents: []` rendered a table of zeros
  // at exit 0 — the lie the reader has no way to catch. A report carrying unreadable entries is
  // NOT empty: it names what it could not read, which is the whole point of carrying them.
  if (agents.length === 0 && unreadable.length === 0) throw missing(subagentsDir)

  // Largest per-turn tax first. Ordering by a total would bury exactly the finding this command
  // was built to surface: an agent with few turns and a large prefix.
  agents.sort((a, b) => (b.prefix * b.turns) - (a.prefix * a.turns))
  // `cap` is RETURNED so the shipped bound is observable in a one-file store. It was two values
  // joined at an unpinned site — the signature default and the `??` — and a test that reads
  // DEFAULT_MAX_ENTRIES and asserts "no truncation happened" never observes either being applied:
  // raising the effective default by one token left the whole suite green, twice over, which is
  // the exact defect the comment on that constant claims is impossible. Reading it back closes
  // that without building 20,001 files, which is the fixture that took macOS CI down with EMFILE.
  return { sessionId: session, agents, unreadable, cap }
}
