import { NAMES } from './names.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
// `printable` only. scripts/reviews.mjs imports NOTHING — it is a leaf — so this cannot cycle back
// through git.mjs and drags no other module in with it. Wrapping at this single point rather than
// at each print site is deliberate: the ref below reaches nine commands' stdout, and a per-site
// wrap is the same per-site drift that took three review rounds to close for the HEAD rule itself.
import { printable } from './reviews.mjs'

export class GitError extends Error {}

// Every ref-consuming command in this module passes --end-of-options, added to git in 2.24
// (November 2019). On an older git the option itself is unrecognised — but git's rejection
// text for an unrecognised long option is not one shape, and it depends on which command's
// argument parser rejects it. Confirmed against real git (the git installed here is >= 2.24
// and accepts --end-of-options itself, so it cannot be made to reject it directly) by
// substituting a different unrecognised long option for --end-of-options at each call site's
// exact argument position:
//
//   COVERED — `error: unknown option \`<name>'` on stderr, exit 129: merge-base (mergeBase,
//   isAncestor), fetch (fetchRefspec), worktree add/remove (addWorktreeDetached,
//   removeWorktree), merge (mergeInto), ls-tree (fileModeAtCommit).
//
//   COVERED — `fatal: unrecognized argument: <name>` on stderr, exit 128: log
//   (commitSubject), show (fileAtCommit).
//
//   NOT COVERED — diff (changedFiles) and rev-list (mergedBranchTips, commitsBetween,
//   commitParents) print only their usage wall on an unrecognised flag, with no line naming
//   the flag or saying "unknown" anything — confirmed nothing in that text to match on. A
//   phase gate running one of these on git < 2.24 gets a bare, unexplained usage dump; this
//   module cannot turn that into an explained failure without risking a match broad enough to
//   fire on an unrelated usage error, which is worse than no match at all.
//
//   NOT AT RISK — rev-parse --verify (qualifyBranch, branchSha, resolveRef) silently ignores
//   an unrecognised long option and still resolves the ref correctly: confirmed real git
//   `rev-parse --verify --quiet --bogus-flag refs/heads/master --` prints the sha, exit 0, as
//   if the flag were never there. --end-of-options is therefore a harmless no-op for these
//   calls on git < 2.24, not a failure this module needs to explain.
function isOldGitRejectingEndOfOptions(stderr) {
  return /unknown option `end-of-options'/.test(stderr) ||
    /unrecognized argument: --end-of-options/.test(stderr)
}

// Builds the message a failed git invocation raises as. Not a version probe — this only
// inspects the stderr of a call that already failed, so it costs nothing on the success path
// that dominates this module's use (once-per-call-that-errors, not once-per-call).
function describeGitFailure(args, code, stderr) {
  const trimmed = stderr.trim()
  if (isOldGitRejectingEndOfOptions(stderr)) {
    return `git ${args.join(' ')} failed: the installed git is too old to run this plugin — ` +
      `--end-of-options requires git >= 2.24, got: ${trimmed || `exit ${code}`}`
  }
  return `git ${args.join(' ')} failed: ${trimmed || `exit ${code}`}`
}

// Where the Claude Code harness creates agent worktrees, relative to the repo root.
const HARNESS_WORKTREES = /^\.claude\//

// Record separator for commitFileSets' `git log --name-only -z` stream. It has to be a token no
// tracked path can ever equal, because the paths and the separator arrive in the same NUL-framed
// stream with nothing else to tell them apart. A bare word cannot do it: with "commit" as the
// marker, a repository tracking a file literally named "commit" reported that one commit as two,
// dropped the path, and truncated the path that followed it (git prefixes the first path of each
// commit with "\n", so the next token got its first character eaten). A trailing slash makes the
// marker unforgeable by construction rather than by luck: a git tree entry name cannot contain
// "/" at all, so no path git ever reports ends with one. Exported so the tests assert against
// this exact token instead of restating it.
export const COMMIT_MARKER = 'commit/'

// argv array, shell: false. Branch names reach git as a single argv entry, so a name
// containing shell metacharacters is data, never a command.
//
// The second argument is the cwd as a bare string for every existing call site, which passes
// no env. The hardened helpers below (fetchTaskBranch, gitDirWritable) pass an options object
// `{ cwd, env }` instead, so both forms are accepted here: when an env is given it is layered
// over `process.env` rather than replacing it, so a helper that sets GIT_OPTIONAL_LOCKS keeps
// PATH and the rest of the inherited environment.
export function defaultGitExec(args, cwdOrOpts, env) {
  let cwd = cwdOrOpts
  if (cwdOrOpts !== null && typeof cwdOrOpts === 'object') {
    cwd = cwdOrOpts.cwd
    env = cwdOrOpts.env
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, env ? { cwd, env: { ...process.env, ...env } } : { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    // A downstream caller's `if (!(err instanceof GitError)) throw err` (Task 3's check
    // wrappers) must not see a plain Error here — spawn failure (git missing from PATH,
    // cwd absent) has to read as a gate FAIL with a message, not an uncaught crash.
    child.on('error', (err) => reject(new GitError(err.message)))
    // SIGNAL SURFACED SEPARATELY, because `code ?? 1` is lossy in a way FIVE readers below
    // cannot recover from. A killed child reports `code: null, signal: 'SIGKILL'` (measured),
    // so collapsing it to 1 produces `{code: 1, stdout: '', stderr: ''}` — byte for byte the
    // shape git uses for ORDINARY answers from `symbolic-ref --quiet` (detached HEAD),
    // `rev-parse --verify --quiet` (not a branch), `ls-files --error-unmatch` (untracked) and
    // `merge-base --is-ancestor` (not an ancestor). In every one of them exit 1 is the
    // PERMISSIVE answer, so a process that never ran to completion would read as a definite
    // negative and open the thing the check exists to close. `signal` is the only field that
    // still tells them apart once `code` has been defaulted, which is why the field is asserted
    // on a REAL call in tests/git.test.mjs rather than only through a fake exec: a double that
    // supplies `signal` itself cannot notice this layer no longer producing it.
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal: signal ?? null, stdout, stderr }))
  })
}

// What HEAD is, as a value rather than as a convention. Returns `{ ok, name, ref, reason }`:
// `ok` with the short name and the full ref when HEAD is on a real branch, and otherwise `ok:
// false` with `name: null` and a sentence naming the state.
//
// THREE REJECTED STATES, each with its own `kind`. They are NOT all "HEAD does not designate a
// branch" — the third one does — and they are kept apart because consumers build their own
// sentence from `kind`, so a state folded in with another is a state some command will describe
// wrongly. That has happened twice: a diagnostic saying "detached" for a repointed HEAD, and one
// saying "not a branch" for a ref git itself lists as the current branch. Adding a state here
// means adding a `kind` and visiting the consumers, not widening an existing one.
//
//   - DETACHED. `symbolic-ref --quiet` exits 1, so there is no target at all. The string a caller
//     might invent for this state is the danger: `HEAD` was used once, and `refs/heads/HEAD` is a
//     ref `git update-ref` creates without complaint.
//   - POINTING OUTSIDE refs/heads/. `git symbolic-ref HEAD refs/tags/x` exits 0 — git refuses only
//     targets outside `refs/` entirely (`fatal: Refusing to point HEAD outside of refs/`), and the
//     same state is reachable by writing `ref: refs/mine/rb` straight into `.git/HEAD`, which no
//     pseudo-ref guard sees. A `refs/heads/` strip is a no-op on such a ref, so the "branch name"
//     becomes the whole ref string and prefixing `refs/heads/` back onto it lands on
//     `refs/heads/refs/tags/x`, an ordinary ref any teammate can create.
//   - A BRANCH WHOSE NAME IS ITSELF A REF PATH (`kind: 'ref-path-name'`). This one IS a real
//     branch: `refs/heads/refs/heads/run-branch` lives under refs/heads/, `git status -sb` prints
//     it as the current branch, `git branch --list` shows it and `git checkout` says "Already on".
//     Nothing is wrong with HEAD — what is wrong is the NAME, because consumers re-qualify it
//     inconsistently (see the comment on that return below). Describing it as "not a branch"
//     contradicts git itself, which is why it does not share the kind above.
//
// Pure and exported so the rule can be tested without a repository, and so no caller has to
// restate it. `name` is deliberately null on every rejection: a caller that ignores `ok` and reads
// `name` gets an absence, never a hostile string.
export function classifyHeadRef(ref) {
  if (ref === null || ref === undefined) {
    return { ok: false, kind: 'detached', ref: null, name: null, reason: 'HEAD is detached, so it is on no branch' }
  }
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
    return {
      ok: false,
      kind: 'not-a-branch',
      ref: typeof ref === 'string' ? ref : null,
      name: null,
      // NEUTRALISED, because this sentence is printed verbatim by nine commands and the value in
      // it is chosen by whoever wrote HEAD. git accepts U+2028, U+0085 and the C1 range in a
      // refname (measured on 2.55.0), and U+2028 is UAX#14 class BK inside the `pre` block a
      // transcript is rendered in — so a ref named
      // `refs/mine/x<U+2028>gate<NBSP>phase<NBSP>default<NBSP>PASS<U+2028>z` drew a whole forged
      // verdict line under this CLI's own name, needing no escape sequence at all. Reproduced
      // across nine commands before this wrap: sixteen raw U+2028 emitted, four neutralised.
      // `printable` already covers exactly this class, and `reviews.mjs:33-40` records why.
      reason: `HEAD points at ${typeof ref === 'string' ? printable(ref) : JSON.stringify(ref)}, which is not a branch — a run branch must be a ref under refs/heads/`,
    }
  }
  const name = ref.slice('refs/heads/'.length)
  // THE NAME MUST NOT ITSELF LOOK LIKE A REF, and this is the one rejection that is about a
  // CONSUMER rather than about HEAD. `derive` hands `deriveContext` the NAME, and a consumer is
  // free to re-qualify it differently from the way this module does: `qualifyBranch` returns any
  // `refs/`-prefixed string UNCHANGED, and gate-runner.mjs:1703 passes the name straight through
  // as the merge-preview base. So HEAD symref'd at `refs/heads/refs/heads/run-branch` — the third
  // ref of this project's own documented plant, plus one main-worktree HEAD write — strips to
  // `refs/heads/run-branch`, which resolves to the REAL branch, while `ctx.runBranchRef` is the
  // planted one. Measured: `gate --phase 1` exited 0 with verdict PASS and merge=pass, on a tree
  // where merging the task branch into `ctx.runBranchRef` actually CONFLICTS; the tree before
  // this task exits 1 and fails `derive`, so it was a regression to permissive.
  //
  // Worth being precise about why the round-trip proof did not cover it, because the lesson
  // generalises: `refs/heads/${name}` really does reconstruct `ref` byte for byte, so that
  // reasoning held for the path it described. The divergence is downstream, at a consumer that
  // takes the name and qualifies it by a different rule. Rejecting here closes it at the single
  // point instead of at one more consumer — and a branch literally named `refs/heads/x` is
  // creatable but pathological, so refusing it costs nothing real.
  if (name.startsWith('refs/')) {
    return {
      ok: false,
      kind: 'ref-path-name',
      ref,
      name: null,
      reason: `HEAD points at ${printable(ref)}, whose branch name would be ${printable(name)} — a name that is itself a ref path, which consumers re-qualify inconsistently, so it is refused rather than resolved`,
    }
  }
  return { ok: true, kind: 'branch', ref, name, reason: null }
}

export function createGit({ cwd = process.cwd(), exec = defaultGitExec } = {}) {
  // `env` is forwarded so a caller can disable optional locks or hooks for one command; every
  // existing call site omits it and so inherits the process environment unchanged.
  const runRaw = (args, env) => exec(args, cwd, env)

  const run = async (args, env) => {
    const { code, stdout, stderr } = await runRaw(args, env)
    if (code !== 0) throw new GitError(describeGitFailure(args, code, stderr))
    return stdout
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

  // --end-of-options blocks flag injection but not NAMESPACE PRECEDENCE: git resolves a bare
  // name through refs/tags/ BEFORE refs/heads/, warns on stderr only, and exits 0. One
  // ordinary `git tag fleetmates/r1/T1 <fork-point>` inside a teammate's own worktree is
  // therefore enough to make `worktree add` check out, and `merge` merge, a commit that
  // carries none of the teammate's work — the gate then runs the suite against a tree missing
  // the code it is meant to be testing and records a pass. It also fires by accident wherever
  // a release tag and a branch share a name. Every name that reaches a ref-consuming git
  // command goes through here first: if a branch of that name exists, its sha wins outright.
  // Anything that is not a branch (a sha, HEAD, an already-qualified refs/… ref) is passed on
  // unchanged, so the qualification never narrows what a caller can ask for.
  const qualifyBranch = async (name, prefix = []) => {
    if (!isNonEmptyString(name)) {
      throw new GitError(`a branch name must be a non-empty string, got ${JSON.stringify(name)}`)
    }
    if (name.startsWith('refs/')) return name
    const { code, stdout, signal } = await exec(
      [...prefix, 'rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}`, '--'],
      cwd,
    )
    // A KILLED probe is not an answer. The fallback below hands the BARE name onward, and a bare
    // name is exactly what this function exists to stop git resolving through refs/tags/ first —
    // so reading a signal death as "no such branch" reopens the tag-shadowing hazard at the worst
    // possible moment, silently and for every caller at once. Fail instead: a name that could not
    // be checked is not a name that was checked and found absent.
    if (signal) {
      throw new GitError(`git rev-parse --verify refs/heads/${name} was killed by ${signal} — the branch could not be resolved, and continuing would pass an unqualified name to git`)
    }
    // Exit 1 with no output is git's "no such branch"; only a resolved sha displaces the name.
    if (code === 0 && stdout.trim() !== '') return stdout.trim()
    return name
  }

  return {
    async changedFiles({ base, branch }) {
      // base/branch build the rev range by string interpolation below, so an empty or
      // non-string value silently becomes "HEAD" (git's default side of "..."): base: ''
      // yields "...branch" = "HEAD...branch", branch: '' yields "base..." = "base...HEAD".
      // Both produce an exit-0 answer against the wrong ref instead of failing — never the
      // caller's job to have checked first.
      if (!isNonEmptyString(base) || !isNonEmptyString(branch)) {
        throw new GitError(`changedFiles requires non-empty base and branch strings, got base=${JSON.stringify(base)} branch=${JSON.stringify(branch)}`)
      }
      // Three dots: diff against the merge base, so commits that landed on the run
      // branch while the teammate worked are not attributed to the teammate.
      // core.quotePath=false plus -z: paths come back NUL-delimited and unquoted, so a
      // non-ASCII path round-trips intact and a leading/trailing space in a filename is
      // never mistaken for line-trimming whitespace.
      // --no-renames: without it git reports only the post-image of a rename, hiding the
      // deletion of a pre-image path that may belong to a different task's declared set.
      // --end-of-options stops a base/branch beginning with "-" from reaching option
      // position; the trailing -- stops git from reinterpreting the rev range as a
      // pathspec when no such rev exists but a same-named file does. Without both, an
      // untracked file named exactly like the rev string makes the diff resolve to a
      // pathspec and report a silent, empty "no changes" instead of failing.
      const out = await run([
        '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
        '--end-of-options', `${base}...${branch}`, '--',
      ])
      return out.split('\0').filter(Boolean)
    },
    async headSha() {
      return (await run(['rev-parse', 'HEAD'])).trim()
    },
    // HEAD RESOLVED SYMBOLICALLY, never through git's abbreviation rules. `git rev-parse
    // --abbrev-ref HEAD` shortens only as far as stays UNAMBIGUOUS: plant a tag named like
    // the run branch and it answers `heads/<name>`; add a branch literally named
    // `heads/<name>` on top and it answers `refs/heads/<name>`. Every caller then prefixes
    // `refs/heads/`, so that last one resolves `refs/heads/refs/heads/<name>` — an ordinary
    // ref an unprivileged teammate can create in its own worktree, and thereby choose the sha
    // a whole run treats as the run branch. `symbolic-ref` reads the ref HEAD literally
    // points at and abbreviates nothing, so no ref any third party can create changes its
    // answer. All four resolutions confirmed against real git (2.55.0) by running that exact
    // three-ref plant; it is the regression test in tests/git.test.mjs.
    //
    // `--quiet` is what makes a detached HEAD a value: it exits 1 with EMPTY stdout and EMPTY
    // stderr rather than writing a diagnostic, so an empty stderr on a non-zero exit that was
    // NOT a signal death is detachment, and anything else is a real failure that still throws.
    // Confirmed on the same git: detached, `--quiet` exits 1 silently while the bare form exits
    // 128 printing `fatal: ref HEAD is not a symbolic ref`; outside a repository it exits 128
    // with `fatal: not a git repository` on stderr, which this therefore raises rather than
    // mistaking for detachment. The signal test below is what keeps a killed process out of the
    // detachment arm, since a kill produces that same empty-and-non-zero shape.
    async currentBranchRef() {
      const { code, stdout, stderr, signal } = await runRaw(['symbolic-ref', '--quiet', 'HEAD'])
      // ONLY THE TRAILING NEWLINE git appends, never JS `trim()`. Git's refname rules and
      // JavaScript's whitespace set are different sets, and that mismatch is the whole defect:
      // git accepts U+00A0 and other non-ASCII whitespace in a refname, `trim()` removes them, so
      // HEAD on `refs/heads/run-branch<NBSP>` answered the name `run-branch` — a DIFFERENT ref
      // that also exists. Measured: `doctor` then printed `main worktree on run-branch` while HEAD
      // sat on the decoy at a commit the real branch did not hold. Bounded to the diagnosis,
      // because `derive`'s round trip still compares SHAS and refuses when they differ, but a
      // report that names the wrong branch is exactly what this one exists not to do.
      if (code === 0) return stdout.replace(/\r?\n$/, '')
      // Before the empty-stderr test, because a killed process produces an EMPTY stderr and a
      // defaulted exit 1 — indistinguishable from `--quiet`'s detached-HEAD answer by the two
      // fields that test reads. Measured: SIGKILL yields `{code: null, signal: 'SIGKILL'}`, which
      // the exec layer defaults to code 1. Reporting that as "detached" would be inventing a
      // repository state out of a scheduling accident.
      if (signal) {
        throw new GitError(`git symbolic-ref --quiet HEAD was killed by ${signal} — whether HEAD is detached is unknown, and it must not be guessed`)
      }
      if (stderr.trim() === '') return null
      throw new GitError(describeGitFailure(['symbolic-ref', '--quiet', 'HEAD'], code, stderr))
    },
    // The short name, taken off the SYMBOLIC ref rather than from abbreviation — see
    // `currentBranchRef`. The name and `refs/heads/<name>` therefore round-trip by
    // construction: the prefix every caller adds lands back on the ref HEAD actually points
    // at, whatever else exists in the ref namespace.
    //
    // `null` ON A DETACHED HEAD, AND NEVER THE STRING `'HEAD'`. An earlier revision of this
    // function returned that string, on the reasoning that it preserved the old `--abbrev-ref`
    // contract. It did — and it was a hole, because `refs/heads/HEAD` is a ref git will happily
    // CREATE: `git update-ref refs/heads/HEAD <sha>` exits 0 (only `git branch HEAD` refuses the
    // name, with `fatal: 'HEAD' is not a valid branch name`). So every caller that prefixed
    // `refs/heads/` onto this value resolved an ordinary ref that any teammate can write, and the
    // abbreviation hazard this function was written to close came straight back under a different
    // spelling. Executed end to end against that revision: with the main worktree detached at a
    // merge commit reachable from no branch and `refs/heads/HEAD` pointed at it, `prune-run --yes`
    // exited 0 and deleted an UNMERGED task branch whose tip was then reachable from the planted
    // ref alone. The same plant against the tree before this task exits 4 and deletes nothing, so
    // the sentinel was a regression, not an inherited defect.
    //
    // Returning null makes the detached case unrepresentable as a branch name rather than
    // representable as a hostile one. Callers must format it for display themselves — there is no
    // string this could return that is both readable and incapable of naming a ref.
    //
    // NULL ALSO FOR A HEAD THAT POINTS OUTSIDE refs/heads/, via the shared classifier: `git
    // symbolic-ref HEAD refs/tags/x` is accepted, and the old `replace(/^refs\/heads\//, '')`
    // was a NO-OP on such a ref, so this used to hand back the whole string `refs/tags/x` as
    // though it were a branch name. Every caller that stored or printed it then recorded a
    // non-branch as a branch. "Not on a branch" is the honest answer for that state, and it is
    // the same answer detachment gets, because for a caller that only wants a NAME the two are
    // the same fact. A caller that needs to tell them apart asks `headBranch` instead.
    async currentBranch() {
      return (await this.headBranch()).name
    },
    // THE ONE PLACE THAT DECIDES WHAT HEAD HAS TO BE, so that four call sites cannot drift apart
    // by each carrying their own conditional. They did: three successive rounds of review each
    // closed the site a reviewer happened to reproduce and left the other three trusting HEAD's
    // target, which is why each round found the next one. Everything that needs the run branch
    // goes through here now, and what differs between callers is only what they DO with a
    // rejection — throw, exit non-zero, or report it as a diagnosis.
    async headBranch() {
      return classifyHeadRef(await this.currentBranchRef())
    },
    // `--porcelain` reports untracked paths, and the harness stores each teammate's worktree
    // under `.claude/` inside the repo. Those directories exist for the whole run, so counting
    // them would fail the ownership check at every phase of every fleet — in a repo that has
    // not happened to ignore that path. The plugin, not the project, chose that location, so
    // the exemption belongs here rather than in each adopting project's .gitignore.
    //
    // Only that one path is exempt. Every other untracked file still counts: a stray file in
    // the main worktree is exactly what this check exists to catch.
    async isDirty() {
      const lines = (await run(['-c', 'core.quotePath=false', 'status', '--porcelain']))
        .split('\n')
        .filter((line) => line.trim() !== '')
      return lines.some((line) => !HARNESS_WORKTREES.test(line.slice(3)))
    },
    // `--porcelain` here is the worktree listing's own stable format (one `key value` line per
    // attribute, entries separated by a blank line), unrelated to `status --porcelain`. Parsed
    // rather than regexed so a path containing a space — the normal case on Windows — stays one
    // field: only the FIRST space separates the key from its value.
    async worktrees() {
      const out = await run(['worktree', 'list', '--porcelain'])
      const entries = []
      let current = null
      for (const line of out.split(/\r?\n/)) {
        if (line.trim() === '') { if (current) { entries.push(current); current = null } continue }
        const sp = line.indexOf(' ')
        const key = sp === -1 ? line : line.slice(0, sp)
        const value = sp === -1 ? '' : line.slice(sp + 1)
        if (key === 'worktree') current = { path: value, head: null, branch: null, detached: false }
        else if (!current) continue
        else if (key === 'HEAD') current.head = value
        else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
        else if (key === 'detached') current.detached = true
      }
      // git omits the trailing blank line after the last entry when the output does not end in
      // one; without this the final worktree — often the only one — is dropped silently.
      if (current) entries.push(current)
      return entries
    },
    // The paths behind isDirty's boolean. Same `.claude/` exemption, for the same reason stated
    // there: the plugin chose that location, so an adopting project is not asked to ignore it.
    async dirtyPaths() {
      return (await run(['-c', 'core.quotePath=false', 'status', '--porcelain']))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
        .filter((entry) => !HARNESS_WORKTREES.test(entry.path))
    },
    // Whether the index carries anything under a path. `--error-unmatch` turns "nothing
    // matched" into exit 1 rather than an empty success, so the two answers are distinguishable
    // without parsing stdout; `--` keeps a pathspec that looks like an option in pathspec
    // position.
    async tracks(pathspec) {
      if (!isNonEmptyString(pathspec)) {
        throw new GitError(`tracks requires a non-empty pathspec, got ${JSON.stringify(pathspec)}`)
      }
      const args = ['ls-files', '--error-unmatch', '-z', '--', pathspec]
      const { code, stderr, signal } = await runRaw(args)
      if (code === 0) return true
      // A killed probe is not "untracked". `preview-check` reads a false here as permission to
      // link a path into a preview worktree, and prints `preview.link is usable` and exits 0 —
      // so a signal death would clear a path that IS tracked, which is the one answer this
      // question exists to prevent.
      if (signal) {
        throw new GitError(`git ${args.join(' ')} was killed by ${signal} — whether the path is tracked is unknown`)
      }
      if (code === 1) return false
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    },
    // Every tracked path, for the inventory half of the map. `-z` with core.quotePath=false so a
    // path containing a space, a quote or a non-ASCII character comes back as written rather than
    // as git's escaped display form.
    async listFiles() {
      const out = await run(['-c', 'core.quotePath=false', 'ls-files', '-z'])
      return out.split('\0').filter(Boolean)
    },
    // One entry per commit, each the list of paths that commit touched, newest first. The record
    // separator is an explicit marker rather than a blank line: a commit that touched no file at
    // all (an empty commit, a pure merge) would otherwise be indistinguishable from the gap
    // between two commits, and dropping it silently changes every support count derived from it.
    //
    // --no-renames for the same reason changedFiles uses it: with rename detection on, git reports
    // only the post-image, so the pre-image path looks untouched in the commit that removed it.
    //
    // Confirmed against real `git log -z --name-only --format=%x00commit%x00` output (see
    // scripts/git.mjs test fixtures): with -z, git NUL-delimits paths rather than joining them
    // with newlines. Splitting on '\0' therefore already yields one token per path, verbatim and
    // unquoted (core.quotePath=false), with two exceptions that are artifacts of git's own framing,
    // not part of any path: (1) every token between one commit's NUL-delimited path list and the
    // next '\0commit\0' marker is an empty string — a real path is never empty, so empty tokens are
    // always framing and are dropped; (2) git prepends a single literal '\n' before the FIRST path
    // of a commit's name-list only (a stand-in for the blank line that separates the commit header
    // from its file list when -z is not used) — subsequent paths in the same commit carry no such
    // prefix. Stripping exactly that one leading character from exactly the first path token — never
    // trimming, never splitting on interior newlines — is what lets a path with a leading or
    // trailing space, or an embedded newline, round-trip byte for byte, matching listFiles().
    async commitFileSets({ limit = 500 } = {}) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new GitError(`commitFileSets requires a positive integer limit, got ${JSON.stringify(limit)}`)
      }
      const out = await run([
        '-c', 'core.quotePath=false', 'log', `--max-count=${limit}`,
        '--no-renames', '--name-only', `--format=%x00${COMMIT_MARKER}%x00`, '-z', 'HEAD', '--',
      ])
      const sets = []
      let current = null
      let atFirstPath = false
      for (const token of out.split('\0')) {
        if (token === COMMIT_MARKER) { if (current) sets.push(current); current = []; atFirstPath = true; continue }
        if (current === null) continue
        if (token === '') continue
        // Only the first path of a commit carries git's synthetic leading "\n", and only when it
        // is really there: a path may itself begin with "\n", and stripping unconditionally would
        // corrupt it. Every later path in the commit is passed through untouched.
        current.push(atFirstPath && token.startsWith('\n') ? token.slice(1) : token)
        atFirstPath = false
      }
      if (current) sets.push(current)
      return sets
    },
    async commitSubject(ref) {
      if (!isNonEmptyString(ref)) {
        throw new GitError(`commitSubject requires a non-empty ref, got ${JSON.stringify(ref)}`)
      }
      return (await run(['log', '-n', '1', '--format=%h %s', '--end-of-options', ref, '--'])).trim()
    },
    // The paths a worktree's own ignore rules exclude, as git decides them rather than as a
    // hardcoded list guesses them. A wholly ignored directory comes back once with a trailing
    // slash instead of as its contents, which is what makes the result usable as a set of
    // prefixes to prune a filesystem walk at.
    //
    // `.git` is NOT in the result and cannot be: git does not report it as ignored, because it is
    // not ignored — it is simply not part of the working tree. A caller pruning a walk still has
    // to skip it by name.
    //
    // No `--end-of-options` and no trailing `--`, against this module's habit everywhere else,
    // and that is measured rather than assumed: `git status --porcelain --ignored -z
    // --end-of-options --` prints NOTHING and exits 0 on real git (2.53, checked directly). Adding
    // them for consistency would turn "every ignored path" into "no ignored path" silently, which
    // is the exact class of failure the flags exist to prevent elsewhere. There is also no
    // pathspec position to defend here: `dir` reaches git as the argument of `-C`, never as a
    // pathspec. `tests/git.test.mjs` pins the absence so a later sweep cannot re-add them quietly.
    async ignoredPaths(dir) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`ignoredPaths requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      const out = await run(['-C', dir, '-c', 'core.quotePath=false', 'status', '--porcelain', '--ignored', '-z'])
      return out.split('\0').filter((entry) => entry.startsWith('!! ')).map((entry) => entry.slice(3))
    },
    // Committer date, in milliseconds, of a sha the caller already resolved. %ct rather than %at:
    // the author date survives a rebase and would report a teammate's work as older than the
    // commit that carries it.
    async commitTime(sha) {
      if (!isNonEmptyString(sha)) {
        throw new GitError(`commitTime requires a non-empty sha, got ${JSON.stringify(sha)}`)
      }
      const out = (await run(['log', '-n', '1', '--format=%ct', '--end-of-options', sha, '--'])).trim()
      const seconds = Number(out)
      // The empty string is checked separately because `Number('')` is `0`, which IS finite — so
      // a `%ct` that came back empty passed this guard and returned epoch 0, and `livenessRows`
      // then reported the tip as roughly fifty-six years old: a `stalled` row and a non-zero exit
      // for a teammate that is working normally. An absent date must fail loudly, not date the
      // commit to 1970.
      if (out === '' || !Number.isFinite(seconds)) {
        throw new GitError(`commitTime read a non-numeric committer date for ${sha}: ${JSON.stringify(out)}`)
      }
      return seconds * 1000
    },
    async branchExists(name) {
      // The same type guard `resolveRef` and `mergeBase` carry, and it was missing here while
      // every other reader had it. Without it the name is INTERPOLATED: `branchExists(null)`
      // asks git about `refs/heads/null`, which answers false in most repositories and TRUE in
      // one that happens to have a branch named `null` (both measured). A caller that reached
      // this with a null had already lost track of which branch it meant, and the honest answer
      // is a failure rather than a verdict about whatever ref that spelling collided with.
      if (!isNonEmptyString(name)) {
        throw new GitError(`branchExists requires a non-empty branch name, got ${JSON.stringify(name)}`)
      }
      const args = ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]
      const { code, stderr, signal } = await runRaw(args)
      if (code === 0) return true
      // A killed probe is not an absence. `code ?? 1` in the exec layer turns a signal death into
      // the same exit 1 git uses for "no such ref", and callers act on a false here by skipping a
      // branch or judging that a task contributed nothing.
      if (signal) {
        throw new GitError(`git ${args.join(' ')} was killed by ${signal} — whether the branch exists is unknown`)
      }
      // Exit 1 is git's answer for "no such ref" — a real absence, not a failure.
      // Any other non-zero (e.g. 128 outside a repository) is a failure carrying stderr.
      if (code === 1) return false
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    },
    // merge-base (both plain and its --is-ancestor form) takes no pathspec and rejects a
    // trailing "--" outright — confirmed against real git ("fatal: Not a valid object name
    // --" / "fatal: --is-ancestor takes exactly two commits"). No "--" is added to either.
    async mergeBase(a, b) {
      if (!isNonEmptyString(a) || !isNonEmptyString(b)) {
        throw new GitError(`mergeBase requires non-empty refs, got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
      }
      return (await run(['merge-base', '--end-of-options', a, b])).trim()
    },
    async isAncestor(ancestor, descendant) {
      if (!isNonEmptyString(ancestor) || !isNonEmptyString(descendant)) {
        throw new GitError(`isAncestor requires non-empty refs, got ancestor=${JSON.stringify(ancestor)} descendant=${JSON.stringify(descendant)}`)
      }
      const args = ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]
      const { code, stderr, signal } = await runRaw(args)
      if (code === 0) return true
      // A killed probe is not "no". This is the predicate behind the side-door check in
      // gate-runner.mjs and behind `prune-run`'s containment proof, and in both a false is the
      // permissive answer: a signal death would make ownership report no violation for a branch
      // that really was landed into the base.
      if (signal) {
        throw new GitError(`git ${args.join(' ')} was killed by ${signal} — the ancestry question was not answered`)
      }
      // Exit 1 is git's answer for "not an ancestor". Anything else (128 for a bad ref,
      // for instance) is a failure and must not read as a clean "no".
      if (code === 1) return false
      throw new GitError(describeGitFailure(args, code, stderr))
    },
    // The set of shas the run branch merged IN as secondary parents, past the anchor — that is,
    // the tips of the branches this run's integrator actually carried onto the run branch.
    //
    // Ancestry cannot answer that question. "Is this sha reachable from the run branch" is true
    // of every commit the run branch has ever passed through, including the one a teammate's ref
    // was parked at when it was created. Being NAMED as a merge parent is a fact about the merge
    // that carried the branch, so a branch that was never merged cannot satisfy it by standing
    // still.
    //
    // --parents prints "<commit> <parent1> <parent2>..."; everything past the first parent is a
    // branch that merge carried in. The anchor..run range bounds the walk to this run rather
    // than the repository's whole history — the range form rather than "--not <anchor>", because
    // git rejects "--not" after a non-option argument ("fatal: option '--not' must come before
    // non-option arguments"), and the options have to precede --end-of-options. Trailing "--"
    // for the same reason commitsBetween carries one: a file named exactly like the range must
    // not be resolvable as a pathspec.
    //
    // The range bounds which MERGE COMMITS are walked. It does NOT filter the parents they
    // print, and that distinction is the whole reason this method filters them itself. This
    // plugin's plan-amendment procedure merges the BASE branch into the run branch, so the base
    // tip is printed as a secondary parent of a merge inside the range — and for a run whose
    // amendments have all landed, merge-base(base, run) IS that base tip. Left in, the anchor
    // would be a member of this set, and a task branch parked at the anchor (a teammate that
    // committed on another ref and left the conventional ref where `git checkout -B <task>
    // <base>` put it) would read as merged, suppressing the very emptiness complaint that shape
    // exists to trigger. The same route admits older base tips, via a task branch that merged
    // the base into itself.
    //
    // So a parent counts only if it is itself inside the range. Every parent of a commit on the
    // run branch is reachable from the run branch by construction, so "inside anchor..run" is
    // exactly "not reachable from the anchor" — the filter expressed as a bound rather than as
    // an isAncestor call per parent. Dropping --min-parents=2 is what makes it one walk instead
    // of two: the unfiltered walk prints every commit in the range, so the same output carries
    // both the range membership and the merge parents. Non-merge lines contribute no parents,
    // since everything past the first is empty for them.
    async mergedBranchTips({ runSha, anchorSha }) {
      if (!isNonEmptyString(runSha) || !isNonEmptyString(anchorSha)) {
        throw new GitError(`mergedBranchTips requires non-empty refs, got runSha=${JSON.stringify(runSha)} anchorSha=${JSON.stringify(anchorSha)}`)
      }
      const out = await run(['rev-list', '--parents', '--end-of-options', `${anchorSha}..${runSha}`, '--'])
      const inRange = new Set()
      const parents = []
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) continue
        inRange.add(parts[0])
        for (const parent of parts.slice(2)) parents.push(parent)
      }
      return new Set(parents.filter((parent) => inRange.has(parent)))
    },
    async commitsBetween({ from, to }) {
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
        throw new GitError(`commitsBetween requires non-empty refs, got from=${JSON.stringify(from)} to=${JSON.stringify(to)}`)
      }
      // rev-list accepts a trailing "--" (confirmed against real git), so a file or
      // directory named exactly like the "from..to" range cannot make this resolve as a
      // pathspec instead of a revision range.
      const out = await run(['rev-list', '--end-of-options', `${from}..${to}`, '--'])
      return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    },
    async commitParents(sha) {
      if (!isNonEmptyString(sha)) {
        throw new GitError(`commitParents requires a non-empty sha, got ${JSON.stringify(sha)}`)
      }
      const out = await run(['rev-list', '--parents', '-n', '1', '--end-of-options', sha, '--'])
      return out.trim().split(/\s+/).slice(1)
    },
    async branchSha(name) {
      if (!isNonEmptyString(name)) {
        throw new GitError(`branchSha requires a non-empty branch name, got ${JSON.stringify(name)}`)
      }
      return (await run(['rev-parse', '--verify', '--end-of-options', `refs/heads/${name}`, '--'])).trim()
    },
    async fileAtCommit(sha, filePath) {
      if (!isNonEmptyString(sha) || !isNonEmptyString(filePath)) {
        throw new GitError(`fileAtCommit requires a non-empty sha and path, got sha=${JSON.stringify(sha)} path=${JSON.stringify(filePath)}`)
      }
      return run(['show', '--end-of-options', `${sha}:${filePath}`, '--'])
    },
    // The mode fileAtCommit deliberately drops. A chmod is a real change that carries no bytes,
    // so any caller comparing two commits by content alone concludes nothing touched the file —
    // which reads as "this file has no legitimate source" in the ownership check. Returns the
    // six-digit tree mode, or null when the path is absent at that commit (`ls-tree` exits 0
    // with empty output for a path it does not find, so absence is not a GitError here).
    async fileModeAtCommit(sha, filePath) {
      if (!isNonEmptyString(sha) || !isNonEmptyString(filePath)) {
        throw new GitError(`fileModeAtCommit requires a non-empty sha and path, got sha=${JSON.stringify(sha)} path=${JSON.stringify(filePath)}`)
      }
      const out = await run(['ls-tree', '--end-of-options', sha, '--', filePath])
      const match = /^(\d{6}) /.exec(out)
      return match ? match[1] : null
    },
    // A bare name is resolved through refs/tags/ BEFORE refs/heads/, so a teammate that
    // creates a tag named like its branch makes every range command read a different
    // object while branchSha still reports the honest tip. Confirmed bypass. Callers
    // resolve names to shas through this, once, and pass only shas onward.
    async resolveRef(fullRef) {
      if (!isNonEmptyString(fullRef) || !fullRef.startsWith('refs/')) {
        throw new GitError(`resolveRef requires a fully-qualified ref, got ${JSON.stringify(fullRef)}`)
      }
      return (await run(['rev-parse', '--verify', '--end-of-options', fullRef, '--'])).trim()
    },
    async fetchRefspec({ from, src, dst }) {
      if (!isNonEmptyString(from) || !isNonEmptyString(src) || !isNonEmptyString(dst)) {
        throw new GitError(`fetchRefspec requires non-empty from/src/dst, got ${JSON.stringify({ from, src, dst })}`)
      }
      if (!src.startsWith('refs/') || !dst.startsWith('refs/')) {
        throw new GitError(`fetchRefspec requires fully-qualified refs, got src=${src} dst=${dst}`)
      }
      // --no-tags: without it a fetch drags the clone's tags into the project, reintroducing
      // the shadowing primitive the boundary exists to remove.
      await run(['fetch', '--no-tags', '--end-of-options', from, `+${src}:${dst}`])
      return (await run(['rev-parse', '--verify', '--end-of-options', dst, '--'])).trim()
    },
    async addWorktreeDetached(dir, ref) {
      if (!isNonEmptyString(dir) || !isNonEmptyString(ref)) {
        throw new GitError(`addWorktreeDetached requires non-empty dir and ref, got dir=${JSON.stringify(dir)} ref=${JSON.stringify(ref)}`)
      }
      await run(['worktree', 'add', '--detach', '--end-of-options', dir, await qualifyBranch(ref)])
      return dir
    },
    async removeWorktree(dir) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`removeWorktree requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      await run(['worktree', 'remove', '--force', '--end-of-options', dir])
      return true
    },
    // -D, not -d. `-d` measures "merged" against the branch's configured upstream, or against
    // HEAD when it has no upstream (both verified on git 2.55.0) — never against the run
    // branch. So it refuses branches that ARE merged into the run branch, whenever the
    // operator's worktree happens to sit on any other branch, and accepts branches that are
    // NOT, whenever some upstream contains them. Either way its answer is a fact about where
    // the caller stands, not about the run. The proof belongs to the caller (`isAncestor`
    // against the run branch) and this deletes what the caller proved.
    //
    // The force ends there, and the limit is the one prune-run will meet: -D still refuses a
    // branch checked out in a worktree. That arrives here as a GitError, never as a deletion
    // that did not happen, so removing the worktree has to come first.
    //
    // No `qualifyBranch` here, deliberately: `git branch -D` resolves its argument in
    // refs/heads only, so the tag-precedence hazard that helper exists for cannot apply. The
    // cost of that: bare branch names only — `git branch -D refs/heads/x` answers "branch
    // 'refs/heads/x' not found".
    async deleteBranch(name) {
      if (!isNonEmptyString(name)) {
        throw new GitError(`deleteBranch requires a non-empty branch name, got ${JSON.stringify(name)}`)
      }
      await run(['branch', '-D', '--end-of-options', name])
      return true
    },
    // Returns null when every branch merged, or the conflicted paths when one did not.
    // Throws a GitError when the merge FAILED rather than conflicted — the two are different
    // answers and the caller cannot act on them the same way.
    //
    // One merge per branch, in order. Handing git three or more heads at once selects the
    // octopus strategy, which RESETS the working tree and index before exiting (verified on
    // git 2.53.0: exit 2, "Merge with strategy octopus failed", and nothing left carrying U
    // status). Read after that reset, --diff-filter=U comes back empty — and an empty array is
    // truthy, so the caller took the conflict branch and reported a conflict naming no
    // branches and no paths. A phase with three or more task branches is the normal case, not
    // an edge one. Merging one at a time keeps every merge on the recursive/ort strategy,
    // which leaves the unmerged index entries in place, and matches the order tm-integrator
    // merges in — so the preview's shape stays the one the integrator will actually produce.
    //
    // `--no-ff` keeps each merge a real merge commit, as tm-integrator produces.
    async mergeInto(dir, branches) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`mergeInto requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      if (!Array.isArray(branches) || branches.length === 0 || !branches.every(isNonEmptyString)) {
        throw new GitError(`mergeInto requires a non-empty array of branch names, got ${JSON.stringify(branches)}`)
      }
      for (const branch of branches) {
        const ref = await qualifyBranch(branch, ['-C', dir])
        const mergeArgs = ['-C', dir, 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options', ref]
        const { code, stderr } = await exec(mergeArgs, cwd)
        if (code === 0) continue
        const out = await exec(['-C', dir, 'diff', '--name-only', '--diff-filter=U'], cwd)
        const conflicted = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        // A conflict is a merge that failed AND left unmerged paths. Everything else — an
        // unset user.email in CI, a branch deleted out from under the run, unrelated
        // histories, a stale index.lock, or (on git < 2.24) --end-of-options itself being
        // unrecognised — is a failure whose reason lives only in git's stderr. Returning []
        // for those would discard the reason and dress the failure up as a conflict that
        // names nothing. Routed through describeGitFailure rather than building the message
        // inline, so an old-git failure here reports the same 2.24 floor every other command
        // in this module does, instead of sending the operator hunting a merge problem that
        // is actually a version problem.
        if (conflicted.length > 0) return conflicted
        throw new GitError(describeGitFailure(mergeArgs, code, stderr))
      }
      return null
    },
  }
}

export function teammateRef(runId, taskId) {
  return `${NAMES.refPrefix}/${runId}/${taskId}`
}

// Fetch one branch from a teammate's git dir into this repo. Runs with hooks, fsmonitor and
// optional locks disabled and a null hooksPath so a config the teammate planted in <fromGitDir>
// cannot execute on the host. Fast-forward only: a non-ff means the run branch advanced under
// the task and the gate's merge check must judge it, not a silent reset.
export async function fetchTaskBranch(git, { fromGitDir, branch }) {
  return git([
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    'fetch', '--no-tags', '--no-write-fetch-head',
    '--end-of-options', fromGitDir,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ], { env: { GIT_OPTIONAL_LOCKS: '0' } })
}

// Returns { ok: true } if this process can write the repo's git dir, else { ok: false, dir, code }.
// Used by every CLI command that writes git, so a sandboxed orchestrator fails fast with a fixable
// message instead of deep inside a worktree add.
export async function gitDirWritable(git, root) {
  const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }))
    .stdout.trim()
  try {
    const probe = await mkdtemp(path.join(common, '.fm-writable-'))
    await rm(probe, { recursive: true, force: true })
    return { ok: true, dir: common }
  } catch (err) {
    return { ok: false, dir: common, code: err.code || 'EACCES' }
  }
}
