// Aliased: this module already has a `NAMES` — the set of state file names it reads and writes.
import { NAMES as ON_DISK } from './names.mjs'
import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
// The single definition of `fleetmates/<runId>/<taskId>`. Imported rather than restated so the
// branch a record is allowed to name cannot drift from the branch the run actually uses.
// enforce.mjs imports only names.mjs, which imports nothing, so this costs the stop-time hook no
// extra module graph.
import { taskBranchName } from './enforce.mjs'

const NAMES = new Set(['plan', 'status', 'findings'])

// Every bound in this file is UTF-8 BYTES, measured with Buffer.byteLength, so that a field
// bound and the record bound below are in the same unit and can be reasoned about together.
//
// They still do not compose into a proof, and this comment no longer claims they do: JSON
// escaping is multiplicative, not additive, so a field can pass its own bound and expand on the
// way into the record. The record bound is the backstop for that, and it is a real check rather
// than a formality.
const MAX_RECORD_BYTES = 64 * 1024

// A branch name is a refname; git's own limit is the filesystem's, and this is far above any
// real one. The canonical maximum this project generates is 394 bytes.
const MAX_BRANCH_BYTES = 512

// Above any real path: win32 extended-length paths stop at 32,767 and POSIX PATH_MAX is
// typically 4096. This exists because `isLocalAbsolute` checks a prefix and nothing else.
const MAX_WORKTREE_BYTES = 32_767

// An id is a label a human types; these are generous. Bytes, so a non-ASCII id is bounded by
// what it costs on disk rather than by how JavaScript happens to count its characters.
const MAX_RUN_ID_BYTES = 255
const MAX_TASK_ID_BYTES = 128

// O_NONBLOCK is POSIX-only; on win32 `constants.O_NONBLOCK` is undefined and 0 leaves the open
// flags untouched, which is the correct no-op there (win32 has no FIFO to block on).
const { O_RDONLY } = constants
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

export function runDir(root, runId) {
  return path.join(root, ON_DISK.stateDir, runId)
}

function statePath(root, runId, name) {
  if (!NAMES.has(name)) throw new Error(`unknown state file: ${name}`)
  return path.join(runDir(root, runId), `${name}.json`)
}

export async function readState(root, runId, name) {
  try {
    return JSON.parse(await readFile(statePath(root, runId, name), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function writeState(root, runId, name, data) {
  const target = statePath(root, runId, name)
  await mkdir(path.dirname(target), { recursive: true })
  // Unique temp name so concurrent writers never share a scratch file.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

export async function claimTask(root, runId, taskId, teammate) {
  const dir = path.join(runDir(root, runId), 'claims')
  await mkdir(dir, { recursive: true })
  const record = JSON.stringify({ taskId, teammate })
  try {
    // 'wx' fails with EEXIST if the file exists — this is the atomicity guarantee.
    await writeFile(path.join(dir, `${taskId}.json`), record, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Worktree location records: `.fleetmates/index/<sha256 of the normalised worktree>.json`.
//
// Both callers ship. `cli.mjs` writes a record from `locate`, and `scripts/subagent-stop.mjs` reads
// one through `findTaskByWorktree` to resolve a stopping teammate to its task — that lookup, not the
// recorded run branch, is what performs the resolution. The comments below describe running code.
// The threat model is stated in the present tense because the file format is what it constrains,
// whoever writes it.
//
// The layout is keyed rather than searched, and that is the whole security argument: a reader
// derives one file name from the path it is asking about and opens it. Nothing enumerates the
// store, so the number of records in it — records are never deleted, and nothing deletes them —
// costs a lookup nothing, and no quantity of files anyone can write changes what a reader does.
// The previous scanning layout had no correct bound: every axis that could be capped (records,
// directories, bytes) was chosen by whoever wrote the files, and the order they were visited in
// was chosen by the filesystem, which also made its tests unportable between NTFS, ext4 and APFS.
//
// KNOWN LIMITATION, by design rather than oversight, and narrower than it first looks: the key
// is the hash of the RESOLVED path, so a record is missed after its worktree is deleted ONLY if
// resolving that path used to change it — a symlinked parent, an 8.3 short name, a case
// difference. For an ordinary path realpath simply throws once the directory is gone,
// `normaliseWorktree` falls back to the lexical form, that form is what was hashed at write
// time, and the record is still found. Where it does miss, the lookup returns null and a hook
// fails open — no enforcement rather than enforcement against the wrong task.
// ---------------------------------------------------------------------------------------------

// Trailing separators are noise EXCEPT at a filesystem root, where the separator is part of the
// path: stripping it turns `C:\` into the drive-RELATIVE `C:`, which realpath then expands to the
// process's current directory on that drive. A record claiming `worktree: "C:\\"` would otherwise
// match whichever directory the reader happens to be standing in.
// Only the platform's OWN separators: on win32 both `\` and `/` end a path, but on POSIX a
// backslash is an ordinary filename character, so stripping it there would collapse `/a/foo\`
// and `/a/foo` onto one key — two different directories answered by one record, and the
// reader's key-agreement check would recompute the same collapsed form and agree with it.
const TRAILING_SEPARATORS = process.platform === 'win32' ? /[\\/]+$/ : /\/+$/

function stripTrailingSeparator(p) {
  return path.parse(p).root === p ? p : p.replace(TRAILING_SEPARATORS, '')
}

// Compared, never displayed. One directory has several spellings: what git prints, what the
// harness sends in a hook payload, and what a shell reports differ in separator, in drive-letter
// and path case on Windows, in trailing separators, and — because a worktree can be reached
// through a symlinked parent (/var vs /private/var) or an 8.3 short name — in the identity of
// the directory components themselves. Trailing separator, case and separator style are folded
// lexically; the rest needs the filesystem, so `resolveLinks` resolves the path through realpath.
//
// That branch is a filesystem call, and its cost is bounded by the filesystem, not by this code:
// realpath on a path that does not exist returns quickly, but on win32 an unreachable UNC share
// blocks the calling thread for as long as the network stack takes to give up — 26.8 s measured
// once on this host, synchronously, with the event loop stopped. It is therefore NOT a cheap
// fallback, and callers holding untrusted paths pass `resolveLinks: false` and decide for
// themselves (see `isLocalAbsolute`).
//
// What remains uncovered even with links resolved: a path that no longer exists at compare time
// falls back to its lexical form and so still fails to match a differently-spelled record, and
// two genuinely distinct paths that a bind mount points at one target compare equal. Both cost
// only the early catch — a missed match lets the hook allow the stop, its fail-open default.
export function normaliseWorktree(p, { resolveLinks = true } = {}) {
  if (typeof p !== 'string' || p === '') return ''
  const resolved = stripTrailingSeparator(path.resolve(p))
  let real = resolved
  if (resolveLinks) {
    try {
      // .native canonicalises case and expands 8.3 short names on Windows; both platforms
      // resolve symlinks. It throws for a path that does not exist — compare that lexically.
      real = realpathSync.native(resolved)
    } catch { /* fall back to the lexical form */ }
  }
  const trimmed = stripTrailingSeparator(real)
  return process.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed
}

// Whether a path is safe to hand to realpath. A record's worktree is attacker-supplied — anyone
// with a shell can write a file under `.fleetmates/` — and a UNC path to an unreachable host is
// the measured stall above. Ten such records would keep every stop inside this lookup for
// minutes, past the hook's own timeout, which switches enforcement off for the whole run at no
// cost to whoever wrote them. What this predicate buys is that the obvious network spellings —
// `//host/share` and `\\host\share` — never reach realpath at all.
//
// RESIDUAL, stated rather than fixed, and NOT win32-only, which an earlier version of this
// comment implied by naming only the win32 case and claiming "a plain local absolute path
// cannot do that". Any path that merely looks local while resolving over the network still pays
// the stall: on win32 a drive letter mapped to an unreachable share, and on POSIX an automounter
// path such as `/net/<host>/wt`, or any autofs or NFS mount point, which is an ordinary absolute
// path by every syntactic test. Nothing cheap separates those from local directories, and
// rejecting them by prefix would reject ordinary paths, so the residual stands on both platforms.
// UNVERIFIED on the POSIX side: this host is win32 with no autofs, so that half is reasoned from
// how autofs behaves rather than measured. Confirming it needs a Linux host with an autofs map
// pointing at an unreachable server, then timing `normaliseWorktree('/net/<unreachable>/wt')`.
//
// Exported so the classification is testable on its own: as a private helper its only witness
// was the shape of its call site, which pins the name and not one decision it makes.
export function isLocalAbsolute(p) {
  if (typeof p !== 'string' || p === '') return false
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p)
  return p.startsWith('/') && !p.startsWith('//')
}

// True when `segment` names a child of `baseDir` directly: not empty, not `.` or `..`, not
// absolute, not climbing out, and not descending either. This is deliberately STRICTER than
// `assertContained` in scripts/cli.mjs, which tests containment only: `a/b` is a contained
// path and that function accepts it, while this one rejects it, because a location record
// lives directly in `worktrees/` and a nested id would only fail later as an ENOENT. The
// error message below was copied from that function to keep the two readable side by side,
// but nothing cross-checks the wording — if cli.mjs is reworded, this text simply stays as
// it is. Treat the match as a convention, not a guarantee.
function relativeInside(baseDir, value) {
  if (typeof value !== 'string' || value === '') return null
  const rel = path.relative(path.resolve(baseDir), path.resolve(path.join(baseDir, value)))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

// Containment only — nesting allowed. This is `assertContained`'s semantics from
// scripts/cli.mjs:633, and it has to be, because `init-run --run 2026/substop` is accepted
// there and creates `.fleetmates/2026/substop/`. A stricter rule here would throw for a run the
// CLI legitimately made, `locate` would abort, and enforcement would be off for that whole run.
function isContained(baseDir, value) {
  return relativeInside(baseDir, value) !== null
}

// Containment AND single-segment. A taskId names one file in one directory and never descends.
function isSegment(baseDir, value) {
  const rel = relativeInside(baseDir, value)
  return rel !== null && !rel.includes(path.sep)
}

// IDS ARE ALLOWLISTED: letters, marks, digits, and the three punctuation characters these ids
// use. An allowlist rather than a list of forbidden characters, because the forbidden set is
// open — every Unicode revision can add another invisible or confusable code point, and a rule
// that has to be updated to stay correct will not be.
//
// An id that is not already in NFC is REFUSED rather than folded, so that one rendering has one
// representation without this file rewriting anyone's input. Folding here would have been the
// only normalisation in the repository — `init-run` creates the run directory byte-exactly and
// `taskBranchName` builds the ref byte-exactly — so a folded id would name a directory that does
// not exist and a branch git does not hold.
//
// STATED LIMIT, not fixed: this addresses invisibility, not confusability. Latin `T1` and
// Cyrillic `Т1` are both accepted and render identically. A single-script restriction would be
// the fix and would refuse legitimate multilingual ids, so the trade is taken deliberately.
//
// The rule refuses `;`, which `init-run` currently accepts. THE STORE'S RULE IS AUTHORITATIVE
// and `init-run` (scripts/cli.mjs, a later task's file) has to adopt it; until it does, such a
// run id is creatable by the CLI and unrecordable here, which is a visible failure on the CLI's
// side rather than a record nobody can read.
//
// It also refuses ZWJ and ZWNJ, which a Persian or Devanagari id may legitimately want. That
// follows UAX #31: `Join_Control` is permitted in general identifiers and excluded from the
// RESTRICTED profile intended for security-sensitive ones. These ids become git refs and
// terminal text, where being invisible is the attack, so the restricted profile is the right one.
const ID_COMPONENT = /^[\p{L}\p{M}\p{N}._-]+$/u

// Some code points pass the allowlist and still render as nothing — a few are classified as
// letters. An id nobody can see is not an identifier: it makes a second git ref that looks
// exactly like the honest one, and a forged record supplies both the id and the branch, so the
// canonicality check compares the forgery against itself and agrees. Anything invisible is
// therefore refused, with no exception: the alternative is an id that cannot be told from
// another by reading it.
const INVISIBLE = new RegExp('\\p{Default_Ignorable_Code_Point}', 'u')

function isIdComponent(component) {
  if (component === '.' || component === '..') return false
  // The id is spent as argv, so no component may look like an option.
  if (component.startsWith('-')) return false
  if (!ID_COMPONENT.test(component)) return false
  return !INVISIBLE.test(component)
}

// `..` is checked over the WHOLE value rather than per component, because it is revision-range
// syntax wherever it appears: `a..b` inside one component matters as much as a `..` component.
//
// A non-NFC id is REFUSED, not folded. Folding was worse than the problem: nothing else in the
// repository normalises — `init-run` creates `.fleetmates/<runId>/` byte-exactly and
// `taskBranchName` builds the ref byte-exactly — so a folded id names a directory that does not
// exist and recomputes a branch that is not the one git holds. Refusing is a closed rule: it
// changes nothing behind the caller's back, and it cannot drift from consumers that do not
// normalise. The caller keeps whichever spelling it chose, or is told to pick one.
function isIdPath(value, { maxBytes }) {
  if (typeof value !== 'string' || value === '') return false
  // Bytes, matching how the record's own size is measured, so a non-ASCII id is bounded by what
  // it costs on disk rather than by how JavaScript counts its characters. Checked against the
  // same bytes that get stored, which is only true because nothing rewrites the value.
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return false
  if (value.normalize('NFC') !== value) return false
  if (value.includes('..')) return false
  return value.split('/').every(isIdComponent)
}

// A run id may nest, because init-run creates nested ones. A task id is one component, which
// `isSegment` below is what enforces.
const isRunId = (root, runId) => isContained(path.join(root, ON_DISK.stateDir), runId)
  && isIdPath(runId, { maxBytes: MAX_RUN_ID_BYTES })
const isTaskId = (root, taskId) => isSegment(path.join(root, ON_DISK.stateDir), taskId)
  && isIdPath(taskId, { maxBytes: MAX_TASK_ID_BYTES })

// A worktree path is not an id — it comes from the filesystem, and both filesystems permit
// bytes an id may not have, including DEL and the C1 range. Only C0 is refused: those cannot
// appear in a path from any real source, and they are what makes a stored path undiagnosable
// in an error message. The record's size is guaranteed by the record bound rather than here.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]', 'u')

// OUTPUT ESCAPING, deliberately independent of the id rule: this answers "is this safe to
// print", it is applied to values that are not ids such as worktree paths, and it must stay
// correct even if the id rule is relaxed. Anything invisible, control-like, or rendering as
// blank is escaped — a refusal message that silently drops the character it is complaining
// about cannot be acted on.
const UNPRINTABLE = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2800]|\\p{Cf}|\\p{Zs}|\\p{Zl}|\\p{Zp}'
  + '|\\p{Default_Ignorable_Code_Point}',
  'gu',
)
const shown = (value) => JSON.stringify(String(value))
  .replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`)

// Applied inside the writer rather than at each call site, so that any caller added later
// inherits it rather than having to remember it. The writer refuses exactly what the reader
// refuses: a record that could be written but never read would take a worktree's enforcement
// away silently.
function assertIds(root, runId, taskId) {
  if (!isContained(path.join(root, ON_DISK.stateDir), runId)) {
    throw new Error(`--run ${shown(runId)} escapes the run directory`)
  }
  if (!isSegment(path.join(root, ON_DISK.stateDir), taskId)) {
    throw new Error(`--task ${shown(taskId)} escapes the run directory`)
  }
  if (!isRunId(root, runId)) throw new Error(`--run ${shown(runId)} is not a usable run id`)
  if (!isTaskId(root, taskId)) throw new Error(`--task ${shown(taskId)} is not a usable task id`)

}

// The record's address IS its worktree. Hashing the normalised path gives a fixed-length,
// separator-free file name, so the lookup opens one known file instead of searching for it —
// which is what removes the scan, and with it every bound that had to be chosen (records,
// directories, bytes) over input an attacker writes and a filesystem orders.
export function worktreeKey(worktree, options) {
  const normalised = normaliseWorktree(worktree, options)
  if (normalised === '') return ''
  return createHash('sha256').update(normalised).digest('hex')
}

export function indexDir(root) {
  return path.join(root, ON_DISK.stateDir, 'index')
}

// Written by the teammate at start through `cli.mjs locate`, and read by the stop-time hook.
// Overwritable on purpose: a teammate that re-enters the same worktree rewrites that worktree's
// record in place. A respawn into a DIFFERENT worktree writes a different key, and the old
// record stays — nothing deletes records, and nothing needs to, because no reader enumerates
// them any more. A stale record is only reachable by asking about the exact directory it names.
export async function writeLocation(root, runId, taskId, { worktree, branch }) {
  assertIds(root, runId, taskId)
  // The SAME predicate the reader applies, on BOTH the value handed in and the value stored.
  // The raw check keeps a reader-dependent spelling (`.`, `relative/x`) from being recorded as
  // whatever directory the writer happened to stand in.
  //
  // The check on the NORMALISED value is the one that matters: a directory symlink whose target
  // is a UNC path has a raw spelling that looks local and a resolved one that does not, so
  // without it the write succeeds and every later read of that record returns null — written
  // successfully, unreadable forever.
  if (!isLocalAbsolute(worktree)) {
    throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  }
  // Stored normalised, not raw, so the value on disk is the one the key was computed from and
  // the two cannot disagree about which directory this record is for.
  const normalised = normaliseWorktree(worktree)
  // A worktree path is the one attacker-influenced field that is not an id, so it gets the two
  // rules a path still needs. Control characters first: no real path on either platform has
  // them, they make a stored path undiagnosable in an error, and each one costs six bytes in the
  // serialised record while counting as one here.
  if (CONTROL_CHARS.test(normalised)) {
    throw new Error(`--worktree ${shown(worktree)} contains control characters`)
  }
  // And a length, because `isLocalAbsolute` only inspects the prefix: without it a path resolves
  // lexically (realpath throws for a path that does not exist) and writes a record no read can
  // ever return. Well above any real path — win32 extended paths stop at 32,767 and POSIX
  // PATH_MAX is typically 4096.
  const worktreeBytes = Buffer.byteLength(normalised, 'utf8')
  if (worktreeBytes > MAX_WORKTREE_BYTES) {
    throw new Error(`--worktree is ${worktreeBytes} bytes, over the ${MAX_WORKTREE_BYTES} allowed`)
  }
  if (!isLocalAbsolute(normalised)) {
    throw new Error(`--worktree ${shown(worktree)} resolves to ${shown(normalised)}, which no record can name`)
  }
  const key = worktreeKey(normalised)
  if (key === '') throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  // `branch` was the one field with no bound, and it is enough on its own to defeat every other
  // check here: a 70 KB branch string writes a record the size cap then refuses on every read,
  // which is the "written successfully, unreadable forever" asymmetry the guards above exist to
  // prevent. It is not required to be canonical — a teammate that never created its task branch
  // legitimately records the harness's own branch, and that is the case the hook exists to
  // catch — so only its type and length are constrained here; the reader decides what it means.
  if (branch !== null && branch !== undefined && typeof branch !== 'string') {
    throw new Error(`--branch ${shown(branch)} is not a branch name`)
  }
  if (typeof branch === 'string' && Buffer.byteLength(branch, 'utf8') > MAX_BRANCH_BYTES) {
    throw new Error(`--branch ${shown(branch.slice(0, 40))}... is longer than ${MAX_BRANCH_BYTES} bytes`)
  }
  const dir = indexDir(root)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${key}.json`)
  const serialised = `${JSON.stringify({ runId, taskId, branch, worktree: normalised })}\n`
  // Refuse to write a record this module's own reader would then reject on size. The field
  // bounds above are measured on the values themselves; this one is measured on the bytes that
  // actually reach the disk, which is the only place JSON's escaping is accounted for. Its job
  // is to keep "the writer accepted it" and "the reader can return it" from ever diverging.
  if (Buffer.byteLength(serialised, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error(`record for ${shown(taskId)} is larger than ${MAX_RECORD_BYTES} bytes and could never be read back`)
  }
  // Unique temp name, then rename: a concurrent reader never sees a half-written record.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, serialised, 'utf8')
  await rename(tmp, target)
  return target
}

// Returns { runId, taskId, branch } for the location record naming `worktree`, or null.
// Reads exactly one file, whose name is derived from the query, so there is no directory to
// enumerate, nothing to order, and no quantity of records anyone can write that changes the
// cost of a lookup. A missing file is the ordinary answer and is not an error.
//
// Every rejection below returns null rather than throwing: the caller is a hook whose failure
// mode must be "allow the stop", never "crash every agent on this machine".
export async function findTaskByWorktree(root, worktree, { maxRecordBytes = MAX_RECORD_BYTES } = {}) {
  // The query comes from the caller (a hook payload's cwd), and it is the only path this
  // function resolves through the filesystem on trust.
  const key = worktreeKey(worktree)
  // A path this module cannot name is not a lookup: stop here rather than building a filename
  // out of an empty key and letting the open decide.
  if (key === '') return null
  let handle
  try {
    // Open once, then fstat and read THROUGH that handle. A stat-then-read pair is a
    // time-of-check/time-of-use race — rename(2) is atomic and the record's author can swap a
    // FIFO in between, and a blocking open(2) on a FIFO with no writer never returns, which is
    // enforcement switched off rather than merely slowed. One descriptor closes it: the file
    // that is fstat'd is the file that is read. O_NONBLOCK keeps the open itself from blocking;
    // it does not exist on win32, where 0 leaves the flags unchanged.
    handle = await open(path.join(indexDir(root), `${key}.json`), O_RDONLY | O_NONBLOCK)
    const info = await handle.stat()
    // Only a regular file is a record. A directory or a FIFO in its place happens to fail the
    // read below anyway, so this line is defence in depth rather than the sole barrier: it is
    // one field of an fstat already performed, and it is what still holds if a future edit
    // makes the read more forgiving than this one.
    if (!info.isFile()) return null
    // LOAD-BEARING, unlike the line above, and an earlier comment calling it redundant was
    // wrong: the bounded read only truncates: `{"…valid record…"}` followed by 200 kB of spaces
    // parses perfectly from its first bytes, so without this an oversized file is accepted in
    // full. Rejecting on the fstat'd size is what makes the cap real.
    if (info.size > maxRecordBytes) return null
    // Bounded read, not handle.readFile: readFile drains to EOF regardless of what fstat said,
    // so a file that grows between the two would defeat the size check entirely and the cap
    // would be advisory. Reading a fixed count makes the cap the actual limit; a file that grew
    // is then truncated mid-JSON and fails to parse, which is the same null as any other
    // malformed record.
    const want = Math.min(info.size, maxRecordBytes)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, 0)
    const record = JSON.parse(buffer.toString('utf8', 0, bytesRead))

    // Cheap string validation before anything touches the filesystem again. Both ids now arrive
    // from file CONTENT — runId used to be a directory name and could not lie; under this layout
    // it can — so each is checked for containment AND for being a usable token. They are not
    // checked identically: a run id may nest (`2026/substop`), a task id may not, which is why
    // there are two predicates rather than one applied twice. A failure is a skip, not a throw.
    if (!isRunId(root, record.runId)) return null
    if (!isTaskId(root, record.taskId)) return null

    // The record must name a worktree that hashes back to the file it was found in. This
    // replaces the old filename-equality check and is strictly stronger, but state its reach
    // exactly: it buys one thing only, that a record cannot be filed under key A while naming
    // directory B. It does NOT stop a record being planted to answer for a directory its writer
    // does not own — anyone who knows a victim's worktree path can file under the hash of that
    // path and name it honestly, satisfy this check, and win by being the newest writer. That
    // wider limit is the one spelled out near `readFixRounds` below, and this check does not
    // narrow it.
    //
    // `isLocalAbsolute` first, because the hash below realpaths a value the record supplies:
    // a UNC path to an unreachable host blocks the thread for tens of seconds, and a relative
    // value — or a win32 `\foo`, which is `path.isAbsolute` yet drive-relative — is completed
    // from the READER's own state, so it would hash back to whatever directory the reader is
    // standing in and answer for it.
    //
    // One comparison, on the RESOLVED form, matching how the key was computed. An earlier
    // version also compared the unresolved form as a disjunction; mutation testing showed no
    // test could distinguish it, and reasoning agrees — the two forms differ only when links
    // are involved, and in that case the resolved form is the one both sides agree on, while a
    // path that does not exist resolves to its own lexical form at both ends anyway.
    if (!isLocalAbsolute(record.worktree)) return null
    if (worktreeKey(record.worktree) !== key) return null

    return {
      runId: record.runId,
      taskId: record.taskId,
      // `branch` is the field that survives an honest taskId and an honest worktree, so nothing
      // cross-checked above constrains it. Unvalidated it is a lever on the caller: any
      // existing ref waves past a teammate that created no branch at all, and a ref of the
      // record's choosing reaches the caller's remediation text, which then tells a blocked
      // teammate to create and commit under another task's name — its work lands there and the
      // gate reads those commits as that task's. A record may name exactly one branch — the one
      // this run gives this task — and anything else drops to null rather than discarding the
      // record, because the record that legitimately carries a non-canonical branch is the
      // teammate that never checked its task branch out, i.e. precisely the do-nothing case the
      // hook exists to catch. Null is what the caller falls back on, and it recomputes the same
      // name from runId and taskId.
      branch: record.branch === taskBranchName(record.runId, record.taskId) ? record.branch : null,
    }
  } catch {
    // ENOENT is the ordinary "no record for this directory" answer and says nothing further.
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Returns the task to the pool. Idempotent: releasing an unclaimed or already-released
// task is not an error, so callers never need to check before releasing.
export async function releaseClaim(root, runId, taskId) {
  const target = path.join(runDir(root, runId), 'claims', `${taskId}.json`)
  try {
    await unlink(target)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return true
}

// Round counts are bookkeeping, not enforcement. status.json is written by the agents the
// gate enforces, so a teammate can reset its own count and buy more retries. That costs
// tokens; it cannot produce a false PASS, because every verdict is recomputed from git.
//
// State the bound precisely, because the obvious phrasing is wrong: the gate does NOT read
// nothing under .fleetmates/ — `gate` and `complete` both read status.json (scripts/cli.mjs:3463
// and :3652). What holds is the half that matters: no forgery here manufactures a PASS. The
// files under .fleetmates/ are read for bookkeeping, and a corrupt one fails the run CLOSED —
// non-JSON in status.json makes readState rethrow, and gate then reports FAIL with `run-state`
// among the failures and exits 1 even with every check passing. Denial, not escalation.
//
// The worktree location record above is weaker still,
// and not in the way "a teammate can only hurt itself" would suggest: nothing binds a record to
// a writer. Any teammate in the run can write any record, including one naming a DIFFERENT
// teammate's worktree, and newest-wins then resolves that directory to the forged record — so
// the victim is blocked, or judged against a branch that is not its work, while the author of
// the record pays nothing. What that still cannot do is manufacture a PASS: the gate recomputes
// every verdict from git, so the reachable damage is a wrong or missing early catch, never a
// task that ships unverified.
export function readFixRounds(status, phase) {
  return status?.fixRounds?.[String(phase)] ?? {}
}

export function recordFixRound(status, phase, taskId) {
  const key = String(phase)
  const fixRounds = { ...(status?.fixRounds ?? {}) }
  fixRounds[key] = { ...(fixRounds[key] ?? {}) }
  fixRounds[key][taskId] = (fixRounds[key][taskId] ?? 0) + 1
  return { ...status, fixRounds }
}
