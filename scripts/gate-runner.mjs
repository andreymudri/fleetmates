import { NAMES } from './names.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { mkdtemp, rm, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readReport, compareInventories } from './test-report.mjs'
import { reportPathParts } from './config.mjs'
import { filesetViolations, ownershipViolations, baseExplainedNote, resolveTaskBranch, derivePhase, planHash, normalizePath } from './enforce.mjs'
import { GitError } from './git.mjs'
import { lintCommittedInstructions } from './security-lint.mjs'
import { protectedPaths } from './gate-config.mjs'
import { withMergePreview, conflictPairs, previewClaimPath } from './merge-preview.mjs'

// 15 minutes. A command check is the project's own suite, so the default has to clear a
// slow one on a cold cache; what it exists to stop is the check that never returns at all.
export const COMMAND_TIMEOUT_MS = 15 * 60_000

// Between SIGTERM and SIGKILL. A suite that traps SIGTERM to write a coverage report gets
// to finish; one that ignores it does not get to outlive the gate.
//
// WHAT THE TESTS HOLD AND WHAT THEY DO NOT, because this comment used to imply a two-sided
// bound it never had. The LOWER side is behavioural: a trap that does real work — 300ms of it —
// must reach its `echo`, so a zero or near-zero grace fails. The UPPER side is not behavioural
// at all and cannot cheaply be made so: raising this to 60_000 leaves every test green, because
// the only run that lets the constant's own value reach a signal is the one whose trap exits
// inside the window, and `cleanup` then clears the timer as soon as the group is observed empty.
// So the upper side is held by a change-detector on the number and nothing else, and the cost it
// guards against is a SIGTERM-ignoring member surviving that much longer after the verdict.
export const KILL_GRACE_MS = 5_000

// How often a registered pid is re-probed once nothing else is left to announce its group's
// end. See `startReaper`: this is the width of the window in rule 2 below, and it is the only
// number that bounds it.
//
// Held the same two ways for the same reason: the retirement tests allow REAP_BOUND_MS, which is
// deliberately loose against flake, so raising this to 2_000 would leave them green. The
// change-detector is what makes that edit deliberate.
export const REAP_INTERVAL_MS = 250

const TAIL_LINES = 40

// ── WHO OWNS A GROUP'S LIFETIME, DECIDED ONCE ────────────────────────────────────────────────
// Four separate defects turned out to be four readings of one question, so the answer is written
// here and every call site below obeys it rather than deciding again.
//
// The question: `defaultExec`'s promise SETTLING and the check's process group BEING OVER are
// different events, and `cleanup` used to treat them as the same one. They come apart in the
// ordinary case: `close` fires when OUR END OF THE PIPES closes, which is the top-level
// `/bin/sh` dying — and `/bin/sh` takes SIGTERM's DEFAULT disposition. A member that ignores
// SIGTERM with its stdio redirected keeps running while `close` fires milliseconds later. That
// member is precisely the population KILL_GRACE_MS exists for; if nothing ever survived a
// SIGTERM the grace SIGKILL would have no purpose.
//
// The three rules:
//
//   1. THE GROUP DECIDES, NEVER THE PROMISE. A pid leaves `liveGroups` only when the group it
//      names is OBSERVED empty. Not when a verdict is reported, not when the leader dies — a
//      group with surviving members keeps its pgid reserved and is still exactly the right
//      thing to kill.
//   2. RETIREMENT IS TERMINAL, AND TERMINAL PER CALL RATHER THAN PER NUMBER. Once a pid leaves
//      the set, nothing in this module signals it again, on any platform. The number is free for
//      the OS to hand out and the probe is a LIVENESS test, not an identity test, so a second
//      look would answer "alive" for a stranger — a second look is not a second chance.
//      "Per call" is the part membership alone cannot express: a timer armed by check A fires
//      against A's registration, not against whoever holds that number when it fires, so each
//      call latches its own retirement and stops signalling from that instant. `startReaper` is
//      what keeps the interval between "the group emptied" and "we noticed" down to one probe
//      period instead of one timeout.
//   3. AFTER THE VERDICT THE GATE NEVER WAITS. Anything still owed to a surviving group is owed
//      by an UNREF'D timer or by the exit sweep, so a group that outlives every signal we can
//      send cannot hold node open. Holding node open is the unbounded check the timeout exists
//      to stop, and it must not come back in through the cleanup path.
//
// The residual, stated plainly rather than implied: rule 1 keeps a live group on the sweep list,
// rule 2 takes it off within REAP_INTERVAL_MS of it emptying, and neither can survive pid reuse
// inside that interval, because reuse is not observable from inside a process.

// The whole process group, not the direct child. With `shell: true` the direct child is
// `/bin/sh -c`, so killing it alone leaves everything the suite spawned running — measured:
// `spawn('sleep 300 & wait', { shell: true, timeout: 500, killSignal: 'SIGKILL' })` ends
// with the shell dead and the grandchild ALIVE. That is why node's own `timeout` option is
// not what this uses.
function killGroup(pid, signal) {
  // RULE 2, checked before anything else and on BOTH platforms, because it is the only part of
  // this that win32 can honour. `taskkill /pid <pid> /T /F` force-kills an entire process TREE
  // at a number Windows recycles aggressively; a retired pid no longer names our tree, and this
  // is what stops that command being aimed at it.
  //
  // NO TEST CAN SEE THIS GUARD ALONE ANY MORE, and that is worth knowing before deleting it.
  // Since every signal `defaultExec` sends goes through `signalGroup`, whose per-call `retired`
  // latch refuses first, the two are INDEPENDENTLY SUFFICIENT on every path that exists: measured,
  // removing this line leaves the suite green, removing the latch leaves the suite green, and
  // only removing BOTH turns the retired-pid test red. It is kept because it is the invariant
  // `killGroup` itself enforces — the latch belongs to one call, this belongs to the function,
  // and the sweep in `installTeardown` calls it without any latch of its own. A future caller
  // that is not `signalGroup` gets rule 2 from here or not at all.
  if (!liveGroups.has(pid)) return
  // RULE 1's probe, and it runs BEFORE the win32 branch rather than after it — the ordering is
  // the same on both platforms even though only one of them learns anything from the call.
  //
  // The platform limit, stated where the claim is made rather than left to be inferred: this is
  // probed on every signal path ON POSIX. On win32 `retireIfGroupGone` answers false
  // unconditionally, because there is no process group to probe — `detached` is false there, the
  // child is `cmd.exe`, and the teardown is the tree walk below. What retires a win32 pid is the
  // direct child's own exit, in `defaultExec`. All of this is UNVERIFIED ON-PLATFORM: every test
  // that drives a signal path in this file is behind POSIX_ONLY.
  if (retireIfGroupGone(pid)) return
  if (process.platform === 'win32') {
    // A negative pid is POSIX. On win32 the equivalent is taskkill walking the child tree.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (err) {
    // ESRCH: the group went away between the probe above and here, which is the outcome this
    // wanted, and the pid stops being signalled from now on.
    if (err.code === 'ESRCH') retire(pid)
  }
}

// Whether the GROUP is empty — NOT whether its leader died. A group whose leader has exited
// while members are still running keeps its pgid RESERVED and is still exactly the right thing
// to kill, so `child.exitCode !== null` is not this test: it would drop a live suite from the
// sweep and let it outlive the gate. Retires the pid the first time the group answers ESRCH,
// and answers whether it did.
//
// What this closes: the escaped-grandchild path, which is the case the timeout exists for.
// Measured with a `setsid` run string, the direct child is reaped in about a millisecond and
// Linux frees a pgid as soon as its group has no members — after which the module used to signal
// that number three ways, SIGTERM at the timeout, SIGKILL at the grace, and a SIGKILL from the
// sweep on every Ctrl-C. The `catch` above cannot detect that on its own: once the number is
// reused no ESRCH is raised, because it names something real.
//
// ITS LIMIT, AND THE EARLIER VERSION OF THIS COMMENT CLAIMED A TIGHTER ONE THAN THE CODE HELD.
// This is a LIVENESS test, not an identity test: it answers "does some group still hold this
// pgid", and a pgid the OS has already handed back out answers YES. So the exposure is not the
// microseconds between the probe and the signal after it. It is the WHOLE interval from the
// group emptying to the next time anything looks — and on a call-site-driven probe alone that
// interval is the timeout. Measured: group empty at 310ms, pid still registered at 5016ms with
// timeoutMs 5000, which on the 15-minute production default is fifteen minutes.
//
// `startReaper` below is what closes the closable part of that: the minutes shrink to
// REAP_INTERVAL_MS. What stays open is one probe period, and nothing inside a process can close
// THAT, because pid reuse is not observable from here.
function retireIfGroupGone(pid) {
  // No process group to probe: `detached` is false on win32 and the teardown is a tree walk. A
  // win32 pid is retired by the direct child's exit instead — see `defaultExec`.
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return false
  } catch (err) {
    // EPERM says the group exists and is not ours, which is a signal that could not land
    // either way; it stays registered rather than being treated as gone. Rated low and pinned
    // anyway: retiring here would drop a LIVE group from the sweep on the strength of an error
    // that says the opposite, and the claim is only worth making if something checks it.
    if (err.code !== 'ESRCH') return false
    retire(pid)
    return true
  }
}

// The one place a pid leaves the set, so it is the one place that can tell the call which
// registered it. Everything else — the ESRCH catch in `killGroup`, the win32 exit branch,
// `cleanup`, the reaper — goes through here rather than deleting from the map itself, because a
// deletion nobody is told about is precisely the hole rule 2's "per call" clause closes.
function retire(pid) {
  const onRetire = liveGroups.get(pid)
  liveGroups.delete(pid)
  onRetire?.()
}

// The one place a pid ENTERS the set, and it exists because `Map.set` on an occupied key
// discards the old value silently — and the value IS the displaced call's only channel for
// learning it was retired.
//
// THE ORDERING THIS CLOSES, which is the mirror image of the one rule 2 already handles. Rule 2
// covers reuse AFTER retirement: the pid left the set, the OS handed the number on, and a late
// timer must not chase it. This is reuse BEFORE retirement — `cleanup` keeps a pid registered
// with its grace armed whenever it probes a non-empty group, that group's last member then
// exits, and the pgid is free from that instant while the reaper does not look for up to
// REAP_INTERVAL_MS. Inside that window the number can be handed to a NEW spawn. Overwriting the
// map entry there would strand the first call's callback: nothing could ever set its `retired`
// flag, because `retireIfGroupGone` answers false for a group that is now the SECOND call's and
// very much alive. The first call's grace would then fire with `retired === false`, find the pid
// registered (to someone else), probe a group that answers alive (someone else's), and deliver
// its SIGKILL into the middle of a running check — a spurious FAIL, which is the exact harm the
// Map was added to prevent.
//
// AND THIS ONE IS TESTABLE, unlike its mirror. Being handed a pid that is ALREADY in this map is
// itself proof that the previous holder's group has ended, because a live group keeps its pgid
// reserved and the OS cannot hand it out twice. That makes the re-registration the observable
// event — the single moment pid reuse is visible from inside a process — so `retire` is called
// on the way in and the displaced call learns of it. Exported for the test that pins exactly
// that, alongside `liveGroupPids`.
export function registerGroup(pid, onRetire) {
  // A no-op unless the number was still registered to an earlier call: `retire` on an absent
  // pid gets `undefined`, deletes nothing and calls nothing. Routed through `retire` rather than
  // reading the map here so that "the one place a pid leaves the set" stays literally true.
  retire(pid)
  liveGroups.set(pid, onRetire)
}

// RULE 2's clock. Once a check's promise has settled there is no `close`, no `exit` and no
// signal left to notice its last member finally going, so without this a pid registered under
// rule 1 sits on the sweep list until the next signal attempt — the timeout, or a Ctrl-C.
// Re-probing on a timer turns that into one probe period.
//
// UNREF'D, which is the whole reason this is safe to add and is rule 3 in one line. A ref'd
// repeating timer would hold node open for as long as any group survived — for a grandchild that
// escaped the group, forever — and that is the unbounded gate the timeout exists to stop. Unref'd
// it narrows the window while the gate is alive anyway and vanishes the moment node wants to
// exit; what covers the group from then on is the `exit` sweep, which sends the same SIGKILL.
let reaper = null
function startReaper() {
  // Nothing to probe on win32, so this would spin without ever retiring anything.
  if (process.platform === 'win32' || reaper) return
  reaper = setInterval(() => {
    // A copy: `retireIfGroupGone` deletes from the set it is iterating.
    for (const pid of [...liveGroups.keys()]) retireIfGroupGone(pid)
    if (liveGroups.size === 0) { clearInterval(reaper); reaper = null }
  }, REAP_INTERVAL_MS)
  reaper.unref?.()
}

// Groups still running, so a Ctrl-C does not leave a suite behind. A pid is retired the first
// time its GROUP is observed empty — at the child's exit, at the settle, at the next signal, or
// at the next reaper tick — never merely when its leader dies, and never merely because the
// check's promise settled, because a group with surviving members still holds its pgid and the
// promise settles on a pipe closing. Membership is the invariant the whole file rests on and it
// is stated in full above `killGroup`.
//
// SIGKILL is deliberately absent and cannot be added: it is untrappable, and the
// 120-second caller kill that orphans a suite inside a merge preview is exactly a SIGKILL.
// Nothing in this file can cover that case. What covers it is the claim file the orphan
// holds itself instead of depending on its parent surviving.
// A MAP, pid -> the retirement callback of the call that registered it, not a bare Set. The
// callback is rule 2's "per call" clause and the value is never read for anything else: the
// membership test is still what withholds a signal from a number nobody owns, and this is what
// tells a call it no longer owns the number it is about to signal.
//
// EXACTLY WHAT THAT COVERS, because this used to say "withholds one from a number SOMEBODY ELSE
// now owns" flatly and that is true of only one of the two orderings. Reuse comes in two, and
// they are closed by different things and pinned to different depths:
//
//   BEFORE RETIREMENT — the number is handed to a new call while the old one is still in this
//   map. Closed by `registerGroup`, which retires the displaced call on the way in. Pinned in
//   TWO PIECES, and the distinction matters to anyone editing either one:
//
//     the HELPER, behaviourally — the re-registration is itself proof the old group ended, so a
//     test stages the collision directly and asserts the displaced call was latched;
//
//     the CALL SITE, as source text only — that `defaultExec` registers THROUGH this helper is
//     not reachable by any test, because it would need the kernel to hand a staged number to a
//     real spawn. Rewrite the call below to a bare `liveGroups.set` and every behavioural test
//     in the suite stays green while this whole hazard is back. What notices is an assertion
//     that reads this file as text and requires `liveGroups.set` to occur exactly once, inside
//     `registerGroup`. So: keep it to one call site, and do not read the sentence above as
//     saying a running test would catch you.
//
//   AFTER RETIREMENT — the number is handed out once the old call has already left the map, and
//   its armed timers still hold it. Closed by the `retired` latch those timers read through
//   `signalGroup`, and NOT pinned, because reaching it needs the OS to recycle a pid inside a
//   grace window and that is not arrangeable from inside a process.
//
// The hole it closes, which the Set could not: `killGroup`'s guard was a test on the NUMBER. A
// grace timer armed by check A and fired 3.1s after A's pid was retired was withheld only by A's
// pid being absent from the set — and a later `defaultExec` spawn puts that same number back the
// moment the OS hands it out, after which the probe answers "alive" for the NEW holder and the
// SIGKILL is delivered to it. The victim is bounded to one of our own later checks, which dies
// mid-run and reads as a spurious FAIL.
//
// STATED, NOT TESTED, and it cannot be otherwise: reaching it requires the OS to hand the same
// pid back inside a grace window, which is not arrangeable from inside a process — the same
// unreachable class as the reuse hazard rule 2 exists for. What the tests DO hold is the other
// direction, that the latch never withholds a signal from a group that is still ours: latch
// `retired` at its declaration and seven tests go red, one of them named for the reason.
//
// The corollary, so nobody draws the wrong conclusion from a green run: DELETING the latch is
// also invisible, because `killGroup`'s membership guard catches the same signals one frame
// later on every path a test can reach. The two are independently sufficient today and only
// removing both is visible. See the note above that guard.
const liveGroups = new Map()
let teardownInstalled = false

// A SNAPSHOT of that set, never the set itself — a caller that could mutate it could disarm the
// sweep. A snapshot and nothing more: a pid it lists may have exited between the read and the
// caller's use of it, so this answers "was this registered" and never "is this alive".
export function liveGroupPids() {
  return [...liveGroups.keys()]
}

function installTeardown() {
  if (teardownInstalled) return
  teardownInstalled = true
  const sweep = () => { for (const pid of [...liveGroups.keys()]) killGroup(pid, 'SIGKILL') }
  process.once('exit', sweep)
  // Installing a handler displaces node's default disposition, so each one exits itself
  // with the conventional 128 + signal code rather than leaving the process running.
  process.once('SIGINT', () => { sweep(); process.exit(130) })
  process.once('SIGTERM', () => { sweep(); process.exit(143) })
  // SIGHUP and SIGQUIT terminate by DEFAULT, and a default disposition runs neither a handler
  // nor the `exit` sweep above — so a closed terminal or a dropped ssh session used to leave the
  // whole check tree orphaned with its timer gone. `detached` made that worse rather than
  // better: setsid() moves the check out of node's session, so the hangup the terminal delivers
  // to node's own group no longer reaches the group node spawned. Measured on that shape: parent
  // dead, grandchild alive in a session of its own.
  //
  // POSIX only. Win32 has no SIGQUIT, its SIGHUP is a console-control event with different
  // semantics, and its teardown is the `taskkill` tree walk rather than a group signal.
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => { sweep(); process.exit(129) })
    process.once('SIGQUIT', () => { sweep(); process.exit(131) })
  }
}

// `graceMs` overrides KILL_GRACE_MS. It exists so a test can drive the SIGKILL path without
// five seconds of wall clock; production callers pass neither it nor anything but `timeoutMs`
// and `onSpawn`, and shortening it changes only when the second signal is sent, never which
// path runs.
export function defaultExec(cmd, cwd, { timeoutMs = COMMAND_TIMEOUT_MS, onSpawn = null, graceMs = KILL_GRACE_MS, env = null } = {}) {
  return new Promise((resolve, reject) => {
    installTeardown()
    const child = spawn(cmd, {
      cwd,
      // Merged over the gate's own environment: a report contract adds one variable, it does not
      // replace PATH and everything the suite needs.
      ...(env ? { env: { ...process.env, ...env } } : {}),
      shell: true,
      // Its own process group, which is the only thing that makes the kill above reach the
      // suite rather than just the shell.
      detached: process.platform !== 'win32',
      // `detached` on win32 otherwise opens a console window.
      windowsHide: true,
    })
    let output = ''
    let timedOut = false
    let timer = null
    let grace = null
    let settled = false
    // RULE 2's "per call" clause, latched from THIS call's registration and never re-read from
    // the set. Set by the retirement callback registered below, so every retirement path sets it
    // — the exit listener, `cleanup`, the ESRCH catch, and the reaper, which is the one no
    // call-site flag could otherwise see. Once it is true the timers this call armed are inert:
    // they still FIRE, because the timeout timer is what settles the promise, but they signal
    // nothing.
    let retired = false
    // Every signal this call sends goes through here rather than calling `killGroup` directly.
    // `killGroup`'s own guard asks whether the NUMBER is registered; this one asks whether it is
    // still registered TO US, which is the only question a timer armed seconds ago can answer
    // safely.
    const signalGroup = (sig) => { if (!retired && child.pid !== undefined) killGroup(child.pid, sig) }

    // Runs on EVERY exit path there is — a normal close, a spawn error, a throw out of
    // `onSpawn`, and the grace expiry that settles without a close.
    //
    // WHAT IT MAY ASSUME, and this is the decision the three rules above are written for: THAT
    // THIS PROMISE HAS SETTLED. No further resolve or reject, our end of the pipes ours to drop.
    // It may NOT assume the work is over, because `close` is the pipes closing and nothing more.
    // Undoing the timeout is safe on that assumption alone; retiring the pid and cancelling the
    // pending SIGKILL are not, and used to be done anyway.
    const cleanup = () => {
      // The timeout, unconditionally: its job was to bound how long this promise waits, and this
      // promise has stopped waiting. Leaving it armed to SIGTERM a leftover group at the
      // fifteen-minute mark would buy nothing the exit sweep does not already do, and would keep
      // a timer per finished check.
      clearTimeout(timer)
      timer = null
      if (child.pid === undefined) { clearTimeout(grace); grace = null; return }
      // RULE 1: the group decides. Empty — retire the pid, and drop the pending SIGKILL with it,
      // because there is nothing left to kill and the number is now free to be handed out.
      if (retireIfGroupGone(child.pid)) { clearTimeout(grace); grace = null; return }
      // NON-EMPTY: keep both. The pid stays registered so the sweep still reaches the group, and
      // the grace stays ARMED so the escalation this check already committed to still fires.
      //
      // Chosen over the alternative deliberately. The other candidate fix was to send the
      // SIGKILL inline on the timed-out `close` path — it passes every test here, and it is
      // WRONG for the case KILL_GRACE_MS promises: a member legitimately flushing a coverage report
      // with its stdio redirected would be killed the instant the shell died, with none of the
      // grace it was granted. Leaving the timer armed spends the grace on exactly the group that
      // still exists, and spends nothing on the group that does not.
      //
      // UNREF'D from here on, which is rule 3: before the verdict the gate waits for this
      // SIGKILL, after the verdict it does not. If node exits first the `exit` sweep sends the
      // same signal, so the kill is delivered either way and a survivor cannot delay the gate.
      grace?.unref()
    }
    // Our end of the pipes. Dropping them is what stops a process that escaped the group from
    // holding this promise open; the limit is that anything it writes afterwards is lost, which
    // is output from a process the gate has already given up on.
    const dropPipes = () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    // FIRST SETTLE WINS, and cleanup happens with it. A timeout that settles on the grace expiry
    // usually DOES see a `close` afterwards — destroying the pipes below tends to produce one —
    // and that must not re-run a cleanup whose `liveGroups.delete` would by then name whatever
    // holds that pid. Stated, not tested: the second `resolve` a missing guard allows is a no-op
    // the promise machinery swallows, and the delete only misfires once the OS has recycled the
    // pid, which no test here can make happen on demand.
    const settle = (fn) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    // `code || 1`, not `code ?? 1`. `?? 1` converts the `null` of a signal-killed child but not
    // a `0` — and a suite that TRAPS SIGTERM and exits cleanly inside the grace, the exact case
    // the grace exists to accommodate, closes with 0. `runCommandCheck` reads `code === 0` as a
    // pass and blanks the output on that branch, taking the timeout notice with it: a green
    // check with no output for a suite that never finished. The price of `||` is that a command
    // which genuinely finished 0 in the race between the timer firing and `close` is reported as
    // a fail — for a gate, that is failing closed, which is the direction to be wrong in.
    const resolveTimedOut = (code) => settle(() => {
      // Whole seconds at a second or more; the exact millisecond count below that. Rounding to
      // seconds for the whole domain reports EVERY bound under 500ms as "0s" and everything from
      // 500ms to 999ms as "1s" — both wrong, and `timeoutMs` is a manifest-validated value with
      // no floor of its own (see `timeoutFault`), so a sub-second bound is a real value this
      // notice has to be able to name.
      const notice = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
      resolve({
        code: code || 1,
        output: `${output}\n— timed out after ${notice}; its process group was killed`,
      })
    })

    timer = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      grace = setTimeout(() => {
        signalGroup('SIGKILL')
        // SETTLED ON THE KILL BEING DELIVERED, not on `close`. `close` waits for the stdio
        // pipes rather than for the direct child, and a grandchild that left the group while
        // inheriting them — a `setsid`, or a `spawn(..., { detached: true, stdio: 'inherit' })`
        // — survives everything this can signal and holds them open. Waiting on that is the
        // unbounded check the timeout exists to stop, reachable from an ordinary manifest `run`
        // string. So the bound is timeoutMs + graceMs and nothing here waits past it.
        //
        // The limit: this says the kill was SENT, not that the suite is gone. Nothing in a
        // process can end a process that left its group, and the output that grandchild would
        // still have written is lost with the pipes.
        dropPipes()
        resolveTimedOut(null)
      }, graceMs)
    }, timeoutMs)

    // ATTACHED BEFORE `onSpawn` RUNS. `onSpawn` writes the preview claim file and so can throw
    // on EACCES or ENOSPC; called first, its throw left no `close` or `error` listener attached
    // at all, so nothing ever ran the cleanup — both timers stayed armed, the pid stayed in
    // `liveGroups`, the pipes were never drained, and a later `error` event was an uncaught
    // exception. Measured on that shape: the promise rejected at 9ms and the process stayed
    // alive to 8016ms.
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', (err) => {
      settle(() => {
        signalGroup('SIGKILL')
        reject(err)
      })
    })
    // Retirement at the earliest moment the group can be OBSERVED empty — for an escaped
    // grandchild the direct child is already gone and its group already has no members, so a
    // pid held past here names a number the OS is free to hand out. A group that still has
    // members keeps its pid registered: `retireIfGroupGone` is what makes that distinction,
    // never the exit code this listener carries.
    //
    // WHAT THIS BUYS IS LATENCY, NOT CORRECTNESS, and the earlier comment claimed otherwise.
    // `startReaper` reaches the same pid within REAP_INTERVAL_MS of the same moment, so deleting
    // this call leaves the whole suite green — every retirement test allows REAP_BOUND_MS, which
    // is ten probe intervals, and nothing in the file distinguishes retirement-at-exit from
    // retirement-at-reap. Making that distinction testable would mean asserting a sub-probe
    // latency, which races the delivery of this very event under load. So: one probe period
    // earlier, pinned by nothing, and the safety it is often read as providing is the reaper's.
    child.on('exit', () => {
      if (child.pid === undefined) return
      // WIN32 HAS NO GROUP, so the probe cannot answer and the direct child's exit is the last
      // moment this pid names anything addressable: `taskkill /T` walks the tree under `cmd.exe`
      // and finds nothing once that root is gone. Holding the pid past it only aims `/T /F` at a
      // number Windows recycles aggressively. The gap this leaves, stated rather than hidden: a
      // win32 grandchild that outlives `cmd.exe` is not reachable by anything in this file. The
      // POSIX group kill has no such gap. Unverified on-platform — nothing here runs on win32.
      if (process.platform === 'win32') { retire(child.pid); return }
      retireIfGroupGone(child.pid)
    })
    child.on('close', (code) => {
      if (timedOut) { resolveTimedOut(code); return }
      settle(() => resolve({ code: code ?? 1, output }))
    })

    if (child.pid !== undefined) {
      registerGroup(child.pid, () => { retired = true })
      startReaper()
      // Called synchronously, before this promise can yield, so a holder registered here is
      // registered before anything can observe the process it names. A throw propagates — a
      // claim that cannot be written must not read as a check that ran unclaimed — but it
      // propagates through the SAME cleanup an ordinary exit runs, plus the kill, so a gate
      // that reports this failure can still exit and leaves nothing of the child behind.
      try {
        if (onSpawn) onSpawn(child.pid)
      } catch (err) {
        settle(() => {
          signalGroup('SIGKILL')
          dropPipes()
          reject(err)
        })
      }
    }
  })
}

function tail(text, n) {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

export async function runCommandCheck(check, { cwd = process.cwd(), previewDir = null, exec = defaultExec } = {}) {
  // `runCheckList` refuses a faulty bound before reaching here, so this guards the EXPORTED
  // api — `runChecks` is called directly from cli.mjs and from tests, and a programmatic
  // caller can pass a shape the manifest path already rejected. Throwing lands as
  // `check threw:` in the list, which is a stated failure rather than a default applied
  // behind the caller's back.
  const fault = timeoutFault(check)
  if (fault) throw new Error(fault)
  const claims = []
  // No preview means no claim to hold: a solo run's checks stand in the repository itself,
  // and a claim file written next to it would be litter naming nothing the reaper reads.
  const onSpawn = previewDir === null ? null : (pid) => {
    const claim = previewClaimPath(previewDir, pid)
    // Synchronous on purpose, and the only sync filesystem calls in this file: `onSpawn` is
    // called from inside the spawn site before the promise yields, so the claim has to be on
    // disk by the time that call returns. An `await` there would put the claim behind an
    // event-loop turn the spawned process is already running in.
    //
    // `wx` (O_CREAT|O_EXCL) rather than the default `w` (O_CREAT|O_TRUNC): the default follows
    // a symlink and truncates whatever it points at, so a planted symlink at this exact path
    // redirects the write into any file this process can write and destroys it. `wx` refuses to
    // follow a symlink and refuses to overwrite an existing file, which is exactly what a claim
    // write needs — the pid this claim path names is not supposed to already hold one.
    try {
      writeFileSync(claim, `${pid}\n`, { encoding: 'utf8', flag: 'wx' })
      claims.push(claim)
    } catch (err) {
      // EEXIST means something is already at this exact path — a stale claim of our own left
      // by a recycled pid, or a plant. Neither can be told apart from here, and neither may be
      // unlinked: not the stale claim, because a claim this call did not create is not this
      // call's to release (the `finally` below only unlinks what `claims` recorded, and this
      // path deliberately never pushes to it); not a plant, for the same reason a stale claim
      // is not one either — this call has no way to know which it is. So the failure to create
      // is swallowed rather than thrown: `onSpawn` runs inside the spawn site, and a throw
      // there fails the check for a reason that has nothing to do with what the check ran. The
      // consequence, stated rather than hidden: a claim this call could not create is a claim
      // this call is not holding, so the preview this check runs inside may be reaped while the
      // check is still using it. That gap is smaller than the alternatives — deleting a claim
      // this call does not own, or failing an unrelated check — but it is real.
      if (err?.code !== 'EEXIST') throw err
    }
  }
  const contract = check.report ? await prepareReport(check.report, cwd, previewDir) : null
  try {
    const { code, output } = await exec(check.run, cwd, {
      timeoutMs: check.timeoutMs ?? COMMAND_TIMEOUT_MS,
      onSpawn,
      ...(contract ? { env: contract.env } : {}),
    })
    const passed = code === 0
    const result = {
      name: check.name,
      kind: 'command',
      status: passed ? 'pass' : 'fail',
      exitCode: code,
      output: passed ? '' : tail(output, TAIL_LINES),
      optional: check.optional === true,
    }
    // Read whatever the exit code: a failing suite still has an inventory. Kept off `output`, which
    // is what a person reads; the inventory is what `runChecks` compares.
    if (contract) result.report = contract.refused ? { error: contract.refused } : await collectReport(contract, cwd)
    return result
  } finally {
    if (contract?.cleanup) await contract.cleanup()
    // Released whatever happened, including a throw. A claim left behind by a check that
    // returned normally is worse than no claim at all: it keeps a preview unreapable until
    // its pid is recycled.
    for (const claim of claims) {
      try { unlinkSync(claim) } catch { /* already gone */ }
    }
  }
}

// The report contract of a `command` check (docs/specs/2026-09-26-test-inventory-design.md). The
// dir form hands the runner a fresh directory outside every tree; the path form deletes the
// in-tree report first, so a report left by an earlier run can never stand in for this one.
async function prepareReport(report, cwd, previewDir) {
  if (report.dir === true) {
    const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-'))
    return { target: dir, env: { FLEETMATES_REPORT_DIR: dir }, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
  }
  // The in-tree form deletes before it runs, so it runs only inside a worktree the gate built and
  // owns (the preview or the baseline) — never in the tree a person works in, which is where a
  // solo gate or a branchless phase runs its checks.
  if (previewDir === null || path.resolve(cwd) !== path.resolve(previewDir)) {
    return { refused: 'an in-tree report is read only in a worktree the gate owns; this run has none', env: {}, cleanup: null }
  }
  // Validated again here for a caller that did not go through the manifest validator, and the
  // delete target is built from exactly the segments the symlink walk checks — never from the raw
  // string, which is how a backslash once meant one path to the check and another to `rm`.
  const parts = reportPathParts(report.path)
  if (!parts) return { refused: 'the report path is not a plain path inside the tree', env: {}, cleanup: null }
  const unsafe = await symlinkOnPath(cwd, parts)
  if (unsafe) return { refused: `the report path passes through a symbolic link (${unsafe})`, env: {}, cleanup: null }
  // A window remains between the walk and the delete: a process an earlier check left running in
  // this worktree could swap a component for a link inside it. The worktree is the gate's own and
  // is removed after the run; that process is teammate code the gate already runs. The read side
  // has no such window: `readReport` opens each file once with O_NOFOLLOW and judges the handle.
  const target = path.join(cwd, ...parts)
  await rm(target, { recursive: true, force: true })
  return { target, parts, env: {}, cleanup: null }
}

// Every component from the tree root down to the report, not only the last: a committed
// `reports -> ../elsewhere` made the pre-run delete reach outside the worktree (review, reproduced).
async function symlinkOnPath(root, parts) {
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const info = await lstat(current).catch(() => null)
    if (!info) return null
    if (info.isSymbolicLink()) return path.relative(root, current)
  }
  return null
}

async function collectReport({ target, parts }, cwd) {
  try {
    // Checked again after the run: the suite is teammate code and can plant a link while it runs.
    const unsafe = parts ? await symlinkOnPath(cwd, parts) : null
    if (unsafe || (await lstat(target).catch(() => null))?.isSymbolicLink()) return { error: 'the report path is a symbolic link' }
    const roots = [cwd, await realpath(cwd).catch(() => cwd)]
    const inventory = await readReport(target, { root: roots })
    return inventory ? { inventory } : { error: 'absent: the suite wrote no report' }
  } catch (err) {
    return { error: err.message }
  }
}

// `optional: true` is meaningful on a `command` check — "this lint is advisory". On an
// enforcement check (`fileset`, `ownership`, `merge`) it would mean "detect the violation and
// ship anyway", which is never coherent to want. All three are forced non-optional here, at
// the point the result is built, so an uncommitted manifest cannot disable enforcement while
// appearing to record it.
const ALWAYS_ENFORCED_KINDS = new Set(['fileset', 'ownership', 'merge'])

// A CHECK KIND MUST BE A STRING BEFORE ANYTHING IS DECIDED FROM IT.
//
// JavaScript coerces on property lookup and does not coerce in a Set, and a manifest is JSON, so
// `"kind": ["command"]` is expressible and lands on the wrong side of every guard at once:
//
//     ['command'] !== 'command'              true     survives cli.mjs's --enforcement-only filter
//     Object.hasOwn(RUNNERS, ['command'])    true     the guard that looks like a type check
//     RUNNERS[['command']]                   runner   executes
//     ALWAYS_ENFORCED_KINDS.has(['fileset']) false    so `optional: true` is honoured
//
// The consequences were both reached end to end against the merged tree. `["command"]` runs an
// arbitrary shell command through the stop hook — which fires for every subagent on the machine —
// with cwd at the main worktree. `["fileset"] + optional: true` runs the REAL fileset check and
// then declines to block it, producing `{"verdict":"PASS","failed":[],"optionalFailed":["fileset"]}`
// — a forged manifest reaching a false gate PASS, which is a bound this design has claimed since
// phase 1. `fleetmates.gate.json` is writable by any teammate, so neither needs a further foothold.
//
// The type test lives HERE, at the runner lookup and at the two places `optional` is computed,
// rather than in the callers' filters: `cli.mjs`'s `--enforcement-only` filter is one call site of
// several, and fixing it would close the execution path while leaving the false PASS. The earlier
// prototype-key guard on the line below is a different defect — `'toString'` is a string and was
// always handled; an array is the spelling JSON can express and nothing covered it.
const hasUsableKind = (check) => typeof check?.kind === 'string'

// The position `malformedKindResult` reports must locate the entry in `fleetmates.gate.json`, and
// the list this module is handed is not always that file's list — `cli.mjs` narrows it in more
// than one place, and counting the surviving entries then names a different entry than the message
// tells the operator to fix.
//
// `ctx.checkPositions[i]` is the manifest position of the i-th entry of the list as handed over.
// Where it is absent this falls back to the list's own index, which is correct only if nothing was
// filtered out — so the fallback is a default, not a guarantee, and this cannot detect a caller
// that filtered and stayed silent. What keeps callers right is on the cli.mjs side: narrowing goes
// through `narrowChecks`, which returns the list and its positions together.
function manifestPosition(ctx, index) {
  const positions = ctx?.checkPositions
  return Array.isArray(positions) && Number.isInteger(positions[index]) ? positions[index] : index
}

// A FAIL rather than a pending or a skip: a manifest this file cannot understand is a
// configuration fault, so it must not run and must not be capable of passing.
//
// Built through `checkResult` rather than as its own object literal, so that `optional` is decided
// in exactly ONE place — and the entry's OWN `kind` and `optional` are handed over unchanged, so
// the decision `checkResult` makes is a real one. An earlier version passed a synthesized literal
// with no `optional` at all; `checkResult`'s `hasUsableKind` clause then had nothing to refuse, and
// restoring that shape and deleting the clause leaves tests/gate-runner.test.mjs fully green
// (measured) — the unpinned-guard-that-reads-as-load-bearing shape this review has rejected
// repeatedly. Now `{"kind":["fileset"],"optional":true}` reaches that clause carrying
// `optional: true`, and deleting the clause alone turns the false-PASS test red.
//
// `index` is the entry's position in the manifest's check list (see `manifestPosition`), and it is
// the whole point of this function's diagnosis. A malformed entry frequently has no `name` —
// `null` and `"just a string"` are both reachable from a hand-written manifest — and `name` is the
// only field `aggregateVerdict` reports, so two such entries both surfaced as `{"failed":[null]}`
// while the text told the operator to fix a `kind` on an entry they could not identify. The
// position is put in BOTH the message and the fallback `name`, so the verdict line alone locates
// the entry.
//
// The `try` is not reachable from a manifest: that file is `JSON.parse`-only, so the kinds it can
// express are exactly the JSON value shapes and `JSON.stringify` serialises all of them. It guards
// the EXPORTED api instead — `runChecks` is called directly from `cli.mjs` and from tests, and a
// programmatic caller can pass a `10n`, which is what the bigint test pins. Its scope is that one
// serialisation and nothing wider: the reads that reach the entry's own fields happen outside the
// `try`, so a throwing GETTER on the entry throws out of `runChecks` with no verdict recorded. No
// manifest can express a getter, so that is programmatic callers only.
function malformedKindResult(check, index) {
  const position = `entry #${index} in this phase's check list`
  let shown
  try {
    shown = JSON.stringify(check?.kind)
  } catch {
    // A BigInt, or any other value `JSON.stringify` refuses: it still has to be reportable.
    shown = String(check?.kind)
  }
  // Only `name`, `kind` and `optional` are read out of this; `kind` and `optional` are passed
  // through unchanged so that `checkResult`'s own `hasUsableKind` clause — not a second copy of
  // the rule here — is what forces `optional: false`.
  return checkResult(
    { name: typeof check?.name === 'string' ? check.name : position, kind: check?.kind, optional: check?.optional },
    'fail',
    `check kind must be a string, got ${shown} (${position})`
    + ' — a manifest entry this gate cannot understand is a configuration fault, not a check.'
    + ` Fix the \`kind\` in ${NAMES.gateFile}.`,
  )
}

// 60 minutes. A manifest may lower the default; it may not raise it past here.
const TIMEOUT_CEILING_MS = 60 * 60_000

// `timeoutMs` is read off an entry of a file any teammate can write, and `validateGate` in
// scripts/config.mjs checks only that `phases[*].checks` is an ARRAY — the same hole
// `hasUsableKind` exists to plug, so this takes the same answer: diagnose the entry and
// fail it. It must never fall back to the default, because a silent fallback is exactly
// how an edit that disables the bound would look like a bound that held.
//
// NO FLOOR, by design — docs/specs/2026-08-26-purge-and-teardown-design.md defines the accepted
// domain as "a positive integer no greater than a hard 60-minute ceiling", and a sub-second
// bound is a valid value in that domain, not a defect in this function. What used to look like a
// defect in a sub-second bound was `defaultExec`'s timeout notice rounding to whole seconds and
// reporting "timed out after 0s" — fixed at its source instead, in `resolveTimedOut`, which is
// where every caller of `defaultExec` reaches it, not just the manifest path through this
// function.
export function timeoutFault(check) {
  const value = check?.timeoutMs
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return `timeoutMs must be a positive integer of milliseconds, got ${JSON.stringify(value)}`
  }
  if (value > TIMEOUT_CEILING_MS) {
    return `timeoutMs must not exceed ${TIMEOUT_CEILING_MS} (60 minutes), got ${value}`
  }
  return null
}

// Built through `checkResult` for the same reason `malformedKindResult` is: `optional` is
// decided in one place. Unlike a malformed `kind`, a malformed `timeoutMs` reaches `checkResult`
// with a genuinely usable, non-enforced `kind` — `'command'` — so `hasUsableKind` and
// `ALWAYS_ENFORCED_KINDS` have nothing to catch it on and `checkResult` would honour the entry's
// own `optional`. `optional: false` is forced here, on the copy handed to `checkResult`, so a
// `{"timeoutMs": 0, "optional": true}` entry cannot fail and be waved through at once.
//
// `name` is substituted the same way `malformedKindResult` substitutes it, and for the same
// reason: a malformed entry frequently carries no `name`, `name` is the only field
// `aggregateVerdict` reports, and passing `check.name` through unchanged would surface a
// nameless entry as `{"failed":[null]}` — a verdict line that tells the operator nothing about
// which entry to fix.
function malformedTimeoutResult(check, index, fault) {
  const position = `entry #${index} in this phase's check list`
  return checkResult(
    { ...check, name: typeof check?.name === 'string' ? check.name : position, optional: false },
    'fail',
    `${fault} (${position})`,
  )
}

export function describePendingCheck(check) {
  return {
    name: check.name,
    kind: check.kind,
    status: 'pending',
    // An always-enforced kind cannot buy its way out here either. `pending` blocks only while
    // it is non-optional, so a manifest entry of an enforced kind that found no runner —
    // `{ "kind": "merge", "optional": true }`, the computed check a manifest must not be able
    // to supply or suppress — would otherwise land as a pending that waves the phase through.
    // A non-string kind is forced non-optional here too. `Set.has` does not coerce, so without
    // this an unusable kind would slip past the always-enforced forcing and honour `optional`.
    optional: !hasUsableKind(check) || ALWAYS_ENFORCED_KINDS.has(check.kind) ? false : check.optional === true,
    check,
  }
}

function checkResult(check, status, output) {
  const optional = !hasUsableKind(check) || ALWAYS_ENFORCED_KINDS.has(check.kind)
    ? false
    : check.optional === true
  return { name: check.name, kind: check.kind, status, output, optional }
}

// The files a merge commit M in `anchor..run` actually carried, indexed by every one of its
// NON-first parents that is ITSELF a commit inside `anchor..run` — built once, shared by
// `deriveContext`'s own integration credit and `runFilesetCheck`'s empty-diff test, which each
// build their own copy (a phase-gate invocation and a `complete` invocation neither owns the
// other's cache).
//
// Three earlier designs asked a different question — "is this sha suspicious" — by classifying
// a shared sha as parked or benign from properties of the sha alone: shared-by-anyone,
// not-the-run-tip, a member of `git.mergedBranchTips`. Every one of them was wrong, because a
// sha's innocence depends on how a ref CAME to point at it, which a sha carries no trace of.
// Concretely: `git.mergedBranchTips` answers "is this sha a secondary parent of some merge in
// range" — but a teammate that runs `git merge --no-ff run-branch` on ITS OWN branch, to pick
// up a sibling's interfaces, makes the OLD run tip a secondary parent of that sync merge too,
// poisoning `mergedBranchTips` for every idle ref that happened to be dispatched at that old
// tip. The REF was never merged; the COMMIT it points at can be, for reasons that have nothing
// to do with that ref.
//
// The question this check actually needs answered is narrower and per-task: when a branch
// reads as "landed" (its own diff off the run branch is empty because it is already on the run
// branch), did the merge that put it there actually carry THIS TASK's declared files? A parked
// ref's sha is named by a merge, but that merge carried the SIBLING's files, never the parked
// task's own declared set — so filtering by the merge's own diff against its own first parent,
// rather than by sha membership alone, is what actually tells a parked ref from a genuine one,
// and it does so without needing to reason about any OTHER ref at all: `landedForFiles` takes
// only this task's own sha and this task's own declared files, so a sibling moving its OWN ref
// off the shared sha in a later fix round changes nothing — the merge that already landed is
// unaffected by where any ref currently points.
//
// Built by walking only the run branch's OWN first-parent chain — from `runSha` back through
// `parents[0]` until `anchorSha` — not every commit in `anchor..run`. Those chain commits are
// the integrator's own merges, the only ones that actually integrate a branch; a merge commit
// reachable from `run` but NOT on that chain is one a TASK made on its own branch (a sync merge,
// `git merge --no-ff run-branch`, run to pick up an earlier phase's interface) and must never
// grant credit.
//
// An earlier version of this walk visited every commit in `anchor..run` and attributed a
// merge's ENTIRE first-parent diff to every one of its secondary parents. That double-credited a
// sync merge's target: the sync names the run tip it synced FROM as a secondary parent, and that
// merge's first-parent diff is whatever the sync's own branch changed relative to where the sync
// branch itself forked — which can include files the SYNCED-FROM commit merely carried, not
// originated. Executed repro: T1 (phase 1) creates `a.mjs`, merged. T2 (phase 2) declares
// `a.mjs` and never commits — its ref sits at the post-T1 run tip. T3 (phase 2) forks earlier,
// commits `c.mjs`, then runs `git merge --no-ff run-branch` on its OWN branch to pick up T1's
// interface, and is then integrated normally. The old walk keyed the post-T1 tip (T2's sha) with
// `{a.mjs}` — from T3's sync merge, not from anything T1's own integrating merge did — and T2
// read landed with nothing written. `gate does not credit an idle ref parked on a run tip that
// only a sibling's own sync merge later named` pins the fix.
//
// For each chain commit with more than one parent, and for each of its secondary parents still
// passing the in-range filter below, the value indexed is that secondary parent's OWN
// contribution since it diverged from the chain's prior tip —
// `changedFiles({ base: parents[0], branch: parent })`, which `changedFiles` itself computes as
// a three-dot diff against `mergeBase(parents[0], parent)` (see `scripts/git.mjs:125-126`), not
// the merge commit's own tree. This is the same call shape as before; only WHAT is walked (the
// chain, not every commit) and WHOSE tree the diff reads (the parent's own, not the merge
// commit's) changed. A legitimately integrated branch is unaffected: the integrator's own merge
// still names that branch's tip as a secondary parent, and the three-dot diff from the run
// branch's prior tip still gives exactly that branch's own committed files.
//
// The in-range filter is unchanged, and still answers the same question over the same set built
// from a single `commitsBetween` call:
//
//   - The parent must be in range. A plan amendment merges the BASE branch into the run branch,
//     naming the base tip as a secondary parent — and for a run whose amendment has landed, the
//     anchor IS that base tip. Unfiltered, a task ref parked at the anchor would be keyed here,
//     landed for whatever files that one amendment merge happened to touch. In practice an
//     amendment rarely names a file that collides with a task's own declared set, so the
//     existing real-repo parked-at-anchor test stays green with or without this filter — it is
//     the declared-files predicate itself, not this filter, that defends the common case.
//     The filter is confirmed load-bearing for the narrower, coincidental-filename case: pinned
//     directly against `mergedParentFiles`'s output by
//     `runFilesetCheck does not read a ref parked at the anchor as landed even when a
//     coincidental filename matches`, which goes red without it.
//
// A sha can be named by more than one chain commit (a stale parked position, plus an unrelated
// later sync that happens to reuse the same commit as a parent). The file sets found are unioned
// per sha rather than kept per-merge — pinned by
// `mergedParentFiles unions file sets across two merges naming the same sha, rather than
// keeping only the first` — because "does some merge naming this sha carry a declared file" and
// "does the declared set intersect the union of every merge naming this sha" are the same
// existence claim: a file is in the union exactly when it is in at least one member set.
export async function mergedParentFiles(git, { anchorSha, runSha }) {
  const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
  const inRange = new Set(commits)
  const filesBySha = new Map()
  // The run branch's own first-parent chain can visit at most `commits.length` distinct
  // commits before reaching the anchor: every commit on that chain, short of the anchor
  // itself, is by construction one of the commits `commitsBetween` already returned. Bounded
  // explicitly rather than trusting `cursor` to reach `anchorSha` exactly — a git double whose
  // mocked first-parent chain never passes through the anchor (a test bug, not a real-repo
  // shape) would otherwise walk forever, calling `commitParents` on an ever-changing cursor.
  // Confirmed reachable, not hypothetical: an unbounded version of this loop OOM'd the test
  // process outright.
  let cursor = runSha
  let steps = 0
  while (cursor !== anchorSha && steps <= commits.length) {
    const parents = await git.commitParents(cursor)
    if (parents.length === 0) break
    if (parents.length >= 2) {
      const firstParent = parents[0]
      for (const parent of parents.slice(1)) {
        if (!inRange.has(parent)) continue
        const changed = await git.changedFiles({ base: firstParent, branch: parent })
        let set = filesBySha.get(parent)
        if (!set) { set = new Set(); filesBySha.set(parent, set) }
        for (const file of changed) set.add(file)
      }
    }
    cursor = parents[0]
    steps += 1
  }
  return filesBySha
}

// True when some merge in range named `sha` as a secondary parent AND that merge's own diff
// against its first parent carried at least one of `declaredFiles`. Paths are normalized the
// same way `filesetViolations` normalizes them (backslashes, a leading `./`, a leading `/`),
// so a declared `a.mjs` matches a merge diff reporting `./a.mjs` alike — pinned by
// `runFilesetCheck matches a declared path against a differently-normalized merge diff path`,
// since removing the normalization leaves the suite green otherwise (plans are hand-authored on
// Windows and may declare `./scripts/a.mjs` against a diff reporting `scripts/a.mjs`).
//
// The precondition this predicate actually needs, stated precisely rather than by example: the
// PARKED task's declared set must not intersect what the integrating merge actually carried.
// Within one phase that always holds — `scripts/phases.mjs` assigns two tasks to the same phase
// only when their declared files are disjoint — but declared sets routinely overlap ACROSS
// phases, because a later task modifies a file an earlier task created. When they do overlap,
// this predicate cannot tell a parked ref from a genuine one: both read `landedForFiles` true
// from the identical, real intersection. This is the irreducible case named in the spec's "Not
// defended against" list as sibling-tip self-integration, and it is NOT closed — see the LIMIT
// test below.
//
// What this test has been confirmed to give, by executing each shape below against a real
// repository — not asserted from the design alone. The test named is where each is pinned:
//   - T3 commits `c.mjs`, is merged `--no-ff`, T2 parks on T3's tip, and T2's declared file
//     (`b.mjs`) does NOT intersect what that merge carried (`c.mjs`): `landedForFiles` for T2 is
//     false. `gate fails when a task ref is parked at a merged SIBLING's tip`. This is the
//     disjoint case; the SAME shape with an overlapping declared set is the open LIMIT below.
//   - The same, after T3 makes a further fix-round commit that moves T3's OWN ref off the
//     shared sha: the merge that already named the sha still only ever carried `c.mjs` — this
//     test does not depend on where T3's ref currently sits, only on what that one merge
//     carried, so T2 is still false. This is the shape every earlier design left open once a
//     sibling's ref moved: entry counts, membership sets and run-tip comparisons all keyed on
//     TWO refs sharing something right now, and stopped applying the moment only one of them
//     still did. `gate still fails a parked ref after the sibling it parked on makes a further
//     fix-round commit`.
//   - Two idle refs sharing an old run tip that an UNRELATED merge turned into a secondary
//     parent — a plan amendment merging the base in, or a third task's own
//     `git merge --no-ff run-branch` picking up a sibling's interfaces — where neither idle
//     task's declared file intersects what that merge actually carried: both idle refs read
//     `landedForFiles` false, and fail on the ordinary, true "contributes no file changes"
//     message below — nothing is accused of parking, nothing goes null.
//     `gate does not treat two idle siblings as parked when an unrelated commit moves the run
//     tip past them`; `gate does not credit an idle ref parked on a run tip that only a
//     sibling's own sync merge later named`.
//   - A near-sibling — an empty commit built one commit above a merged sibling's tip, itself
//     later merged under its own name: that merge's own diff against its own first parent is
//     EMPTY (it brings in nothing new), so it can never intersect a non-empty declared set
//     however many merges name the sha. Closed as a side effect of the predicate, not by
//     design intent. `gate fails a ref built one empty commit above a merged sibling's tip, even
//     merged under its own name`.
//   - A legitimately merged branch: the merge naming it carried exactly its own declared files.
//     True. `a compliant two-phase run passes phase 1 ... then derives and passes phase 2`.
export function landedForFiles(filesBySha, sha, declaredFiles) {
  const carried = filesBySha.get(sha)
  if (!carried) return false
  const declared = new Set((declaredFiles ?? []).map(normalizePath))
  for (const file of carried) {
    if (declared.has(normalizePath(file))) return true
  }
  return false
}

// Credit for task refs sitting exactly at the run tip, where `landedForFiles` cannot help: the
// run tip is never keyed in `mergedParentFiles` (that index holds only the NON-FIRST parents the
// chain walk meets), so a sha there carries no attribution at all and the predicate is
// structurally false. That false is correct for a no-op teammate and wrong for a genuinely
// landed task whose ref a fix round re-pointed with the brief's own `git checkout -B <task>
// <run branch>` — and both look identical from the sha.
//
// What separates them is not the position but SCARCITY. A merged secondary parent is a
// contribution that was earned exactly once. If a task's ref points AT such a parent, that task
// has already spent it, and no ref parked at the run tip may be credited with the same one. So a
// run-tip ref is credited only by being matched to a merged parent that (a) carried its WHOLE
// declared set and (b) no other task ref already points at, with at most one run-tip task per
// parent — a bipartite matching, not a containment test.
//
// That distinction is the whole point, and it is what the reverted `f6e2191` lacked. Executed,
// the shape that closure passed and this one fails: T1 (phase 1) declares and merges `a.mjs`
// plus `b.mjs`; T2 (phase 2) declares only `a.mjs` and writes nothing, its ref left at the run
// tip by `checkout -B`. Containment alone credits T2, because T1's merge carried a superset of
// T2's declared set — and a phase-2 task that only MODIFIES files phase 1 created has that
// superset by construction, so it is the routine shape, not a corner. Here T1's own ref still
// points at that parent, so the parent is spent and T2 matches nothing. Two refs both re-pointed
// to the run tip with one parent between them fail for the same reason: the matching is capped
// at the number of distinct parents, so one of them is always left unmatched and its phase does
// not read as integrated.
//
// Attributing by the merge SUBJECT was considered and rejected: no such convention is enforced
// anywhere in this repo, and `tm-integrator` writes that subject while being one of the enforced
// parties — the `status.json` mistake this whole design exists to avoid.
//
// `spent` is supplied by the caller (see `spentParents`) and carries the SPARE-parent closure: a
// task integrated more than once — an initial merge plus a fix round's own merge — leaves parents
// in the index that no ref points AT, and an unclaimed leftover was matchable by a run-tip ref.
// Without a `spent` set this falls back to direct ref positions only, which is what the unit tests
// exercise; the callers that gate a real repository always pass one.
export function creditRunTipTasks({ tasks, shaByTask, runSha, mergedFiles, spent }) {
  // A parent is spent when some task ref points directly at it. Refs at the run tip spend
  // nothing — that is exactly the position with no attribution behind it.
  const claimed = new Set(spent ?? [])
  for (const sha of shaByTask.values()) {
    if (sha !== runSha && mergedFiles.has(sha)) claimed.add(sha)
  }
  const free = [...mergedFiles.keys()].filter((p) => p !== runSha && !claimed.has(p))

  const runTip = tasks.filter((t) => shaByTask.get(t.id) === runSha)
  const candidates = new Map()
  for (const t of runTip) {
    const declared = (t.files ?? []).map(normalizePath)
    // A task declaring nothing is never creditable from the run tip: the empty set is contained
    // in every parent, so without this guard it would match the first free one.
    if (declared.length === 0) { candidates.set(t.id, []); continue }
    candidates.set(t.id, free.filter((p) => {
      const carried = new Set([...mergedFiles.get(p)].map(normalizePath))
      return declared.every((file) => carried.has(file))
    }))
  }

  // Kuhn's augmenting-path matching. Greedy assignment is not enough: an early task can take the
  // only parent a later one could have used, when a different assignment would have satisfied
  // both. Order of `tasks` and of the index decides ties, so the result is deterministic.
  const heldBy = new Map()
  const assign = (taskId, seen) => {
    for (const parent of candidates.get(taskId) ?? []) {
      if (seen.has(parent)) continue
      seen.add(parent)
      const holder = heldBy.get(parent)
      if (holder === undefined || assign(holder, seen)) {
        heldBy.set(parent, taskId)
        return true
      }
    }
    return false
  }
  for (const t of runTip) assign(t.id, new Set())
  return new Set(heldBy.values())
}

// Which merged parents are already accounted for by a task that is NOT sitting at the run tip.
// This is what closes the spare-parent residual `creditRunTipTasks` was first shipped with.
//
// Pointing AT a parent is not the only way to have earned it. A task integrated twice — merged,
// then merged again after a fix round — leaves the first merge's parent behind as an ancestor of
// its current tip, claimed by nobody, and a run-tip ref whose declared set that leftover happens
// to contain in full could match it. So a parent counts as spent when it is an ancestor of some
// task ref AND the files it carried intersect that task's own declared set.
//
// Both halves are load-bearing, and dropping either was measured, not reasoned about:
//
//   - Without the ANCESTOR half, only direct positions are spent and the spare parent stays
//     matchable — the residual this closes.
//   - Without the DECLARED-SET half, ancestry alone spends far too much and reintroduces the
//     original false FAIL. A phase-2 task legitimately forks from the run tip after phase 1 was
//     merged, so phase 1's merged parent is an ancestor of that phase-2 ref. If phase 1's own ref
//     is then re-pointed at the run tip by a fix round, its parent would already read as spent by
//     an unrelated later task and the genuinely landed phase-1 task would fail again. Requiring
//     the carried files to intersect that task's OWN declared set keeps a later task from
//     spending a parent it did not earn.
//
// Run-tip refs spend nothing, here as everywhere: that position carries no attribution, which is
// the whole reason `creditRunTipTasks` exists.
export async function spentParents(git, { tasks, shaByTask, runSha, mergedFiles }) {
  const spent = new Set()
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]))
  for (const [taskId, sha] of shaByTask) {
    if (sha === runSha) continue
    const declared = new Set(((byId.get(taskId)?.files) ?? []).map(normalizePath))
    if (declared.size === 0) continue
    for (const [parent, carried] of mergedFiles) {
      if (spent.has(parent) || parent === runSha) continue
      const intersects = [...carried].some((file) => declared.has(normalizePath(file)))
      if (!intersects) continue
      if (parent === sha || await git.isAncestor(parent, sha)) spent.add(parent)
    }
  }
  return spent
}

// Resolves every task ref in the run to a sha, skipping tasks whose branch cannot be resolved or
// does not exist. Shared so `deriveContext` and `runFilesetCheck` build the SAME map that
// `creditRunTipTasks` reads — the scarcity argument only holds when every ref in the run is
// accounted for, so a caller passing only the current phase's tasks would over-credit.
export async function resolveTaskShas(git, { tasks, runId }) {
  const shaByTask = new Map()
  for (const task of tasks) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) continue
    if (!(await git.branchExists(branch))) continue
    shaByTask.set(task.id, await git.resolveRef(`refs/heads/${branch}`))
  }
  return shaByTask
}

// Takes no `status` argument by design. Three earlier versions of this system were defeated
// by trusting a file the enforced agents can write.
export async function deriveContext({ git, runId, runBranch, baseBranch, planPath }) {
  // Both refs are resolved to shas before mergeBase ever sees them. A bare name resolves
  // through refs/tags/ before refs/heads/ — confirmed bypass: a teammate plants tags named
  // like the base and run branches, mergeBase silently resolves against the tagged (attacker)
  // commits, and the anchor, the plan read at that anchor, and the ownership commit range are
  // all computed against the wrong tree.
  const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
  const runSha = await git.resolveRef(`refs/heads/${runBranch}`)
  const anchorSha = await git.mergeBase(baseSha, runSha)
  const planMarkdown = await git.fileAtCommit(anchorSha, planPath)
  const { parsePlan } = await import('./plan-parser.mjs')
  const { assignPhases } = await import('./phases.mjs')
  const tasks = assignPhases(parsePlan(planMarkdown))

  // A phase is integrated when every one of its task branches is an ancestor of the run
  // branch. Resolved through refs/heads/ so a tag cannot stand in for a branch.
  const byPhase = new Map()
  for (const task of tasks) {
    if (!byPhase.has(task.phase)) byPhase.set(task.phase, [])
    byPhase.get(task.phase).push(task)
  }
  // Built once, shared by every task branch of every phase below — see the comment on
  // `mergedParentFiles` above this function for what it answers and why.
  const mergedFiles = await mergedParentFiles(git, { anchorSha, runSha })
  // Run-wide, never per-phase: a phase-1 ref pointing at its own merged parent is what makes
  // that parent spent for a phase-2 ref parked at the run tip.
  const shaByTask = await resolveTaskShas(git, { tasks, runId })
  const runTipCredited = creditRunTipTasks({
    tasks,
    shaByTask,
    runSha,
    mergedFiles,
    spent: await spentParents(git, { tasks, shaByTask, runSha, mergedFiles }),
  })

  const integratedPhases = []
  for (const [phase, phaseTasks] of byPhase) {
    const states = []
    for (const t of phaseTasks) {
      const branch = resolveTaskBranch(t, runId)
      if (!branch || !(await git.branchExists(branch))) { states.push(false); continue }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      const forkPoint = await git.mergeBase(runSha, sha)
      if (forkPoint !== sha) {
        // Not yet on the run branch: an ordinary "did this branch do its own work" check
        // against its own fork point. isAncestor(sha, runSha) alone is trivially true for a
        // branch with zero commits past the anchor: a branch created at the anchor, or created
        // by pointing at the run tip itself, is an ancestor by reflexivity or by definition,
        // with no work required. Confirmed: a teammate can create every task branch at the run
        // tip, commit nothing anywhere, and every phase reads integrated. Counting commits is
        // not enough either — confirmed separately: a single `git commit --allow-empty`
        // satisfies "has a commit" while changing no file at all. Requiring at least one *file*
        // changed between the fork point and the branch means "integrated" implies "did work".
        const ownChanges = await git.changedFiles({ base: forkPoint, branch: sha })
        states.push(ownChanges.length > 0 && await git.isAncestor(sha, runSha))
        continue
      }
      // Already on the run branch: a diff from `sha` to itself is always empty, so whether
      // this reads as integrated depends entirely on whether some merge in `anchor..run` that
      // named this sha as a secondary parent actually carried task t's own declared files —
      // `landedForFiles`, exactly the predicate `runFilesetCheck`'s empty-diff test applies
      // below. See the comment on `mergedParentFiles`, above this function, for what this
      // closes and what it has been confirmed to give.
      //
      // A branch integrated by FAST-FORWARD leaves no merge commit to name it at all, so it is
      // not a key in `mergedFiles` and reads as not-landed even though the work IS on the run
      // branch. `tm-integrator`'s contract is `--no-ff` for exactly this reason; the state is
      // out-of-contract, and failing closed is the intended direction. Confirmed against a real
      // fast-forward: `deriveContext does not read a fast-forward-integrated branch as
      // integrated (real repo)`.
      //
      // What remains open:
      //   - A teammate that does the integrator's job itself — creating task branches that each
      //     carry real work and merging them itself — is indistinguishable here from legitimate
      //     integration, because at this level it IS the same shape. Unchanged from every
      //     earlier design.
      //   - Sibling-tip self-integration with an OVERLAPPING declared set. Declared files are
      //     disjoint only WITHIN a phase (`scripts/phases.mjs` enforces that); across phases a
      //     later task routinely modifies a file an earlier task created. When a parked ref's
      //     declared set intersects what the integrating merge actually carried, this predicate
      //     cannot tell it apart from the branch that genuinely earned that credit — both read
      //     `landedForFiles` true from the identical, real intersection. Executed: `T1: Create
      //     a.mjs`, `T2: Modify a.mjs, Create b.mjs`; T2 writes nothing and its ref is pointed
      //     at T1's own merged tip; verdict PASS, `b.mjs` never exists. Recorded in the spec's
      //     "Not defended against" list as sibling-tip self-integration; pinned as a LIMIT in
      //     `tests/adversarial.test.mjs`.
      //
      // CLOSED, kept as history because two attempts at it failed in instructive ways:
      //   - `ownWorkBase`: a fix round that re-points an ALREADY-INTEGRATED task's branch onto
      //     the run branch's own current tip — exactly what the brief's own recommended
      //     `git checkout -B fleetmates/<runId>/<taskId> <run branch>` step does — USED TO read as
      //     having done no work, even though the task's files are genuinely already on the run
      //     branch. `sha` then equals `runSha`, `forkPoint` above also equals `sha` (the
      //     "already on the run branch" branch is taken), and `landedForFiles` looks the sha up
      //     in `mergedFiles`, which is keyed only by the NON-FIRST parents `mergedParentFiles`
      //     visits while walking the chain — the run tip itself is never a value indexed there
      //     unless some LATER merge happens to name it as a secondary parent. Executed: T1's
      //     branch is merged `--no-ff` into `run`, then re-pointed with `git branch -f
      //     fleetmates/r1/T1 run` (the same tip `checkout -B` would produce); `deriveContext`
      //     then reads T1 as not integrated, `currentPhase` reopens phase 1, and
      //     `runFilesetCheck` fails it with "contributes no file changes past its fork point"
      //     for a task that is genuinely, fully landed. The declared-files predicate does not
      //     resolve this — it was built to tell a parked ref from a merged one by what a merge
      //     carried, and a ref sitting exactly at the run tip is not named by any merge at all.
      //     That was the state until `creditRunTipTasks` and `spentParents` below; the paragraph
      //     above describes the defect, not current behaviour.
      //
      //     One closure was tried and REVERTED (`f6e2191`, reverted by `227abf2`) — recorded so
      //     it is not re-attempted. It asked, for `sha === runSha` only, whether a SINGLE merged
      //     secondary parent carried the task's WHOLE declared set, on the reasoning that full
      //     containment substitutes for the attribution the run tip does not carry. It does not:
      //     the gate for phase N runs BEFORE any phase-N branch is merged, so every phase-N ref
      //     created by the brief's own `git checkout -B <task> <run branch>` and never committed
      //     to sits exactly at `runSha`. Executed: T1 (phase 1) declares and merges `a.mjs` plus
      //     `b.mjs`; T2 (phase 2) declares only `a.mjs`, writes nothing; T1's merge carried a
      //     superset of T2's declared set, so the gate returned PASS with "every phase in the
      //     plan is integrated" and `a.mjs` was never modified. A phase-2 task that only MODIFIES
      //     files phase 1 created has a declared set contained in that merge by construction, so
      //     this is the routine shape, not a corner — it traded the no-op-teammate case the check
      //     exists for against one convenience case. Attributing by the merge SUBJECT instead was
      //     considered and rejected on the same grounds as `status.json`: `tm-integrator` writes
      //     that subject, and it is one of the enforced parties. Failing closed here costs a
      //     misleading message on a genuinely landed re-pointed ref; passing open costs the check.
      //     Closed since, by scarcity rather than containment — see `creditRunTipTasks` above for
      //     what separates the two and which shape each verdict falls on.
      const landed = sha === runSha
        ? runTipCredited.has(t.id)
        : landedForFiles(mergedFiles, sha, t.files)
      states.push(landed && await git.isAncestor(sha, runSha))
    }
    if (states.length > 0 && states.every(Boolean)) integratedPhases.push(phase)
  }

  // An empty task list is not a run with nothing to check — it means the plan path or the
  // plan itself is wrong (a directory anchor renders a tree listing that parses to zero
  // tasks; `derivePhase` would otherwise return `{phase: null}` with no error, which
  // `runFilesetCheck` reads as "every phase is integrated" and passes vacuously). Surfaced
  // as a phaseError, which both fileset and ownership already honour, naming what was read
  // and from where so the operator can see the mistake.
  if (tasks.length === 0) {
    return {
      git, runId, runBranch, baseBranch, anchorSha, runSha,
      planHash: planHash(planMarkdown),
      tasks,
      currentPhase: null,
      phaseError: `plan at ${planPath} (anchor ${anchorSha}) parsed to zero tasks`,
      integratedPhases,
    }
  }

  const derived = derivePhase({ tasks, integratedPhases })
  return {
    git, runId, runBranch, baseBranch, anchorSha, runSha,
    planHash: planHash(planMarkdown),
    tasks,
    currentPhase: derived.phase ?? null,
    phaseError: derived.error ?? null,
    integratedPhases,
  }
}

// `complete` verifies the calling task, not the whole phase, and marks that with
// `ctx.taskScope: <task id>`. `gate` never sets it, so `taskScope == null` is the phase-wide
// path every gate invocation has always taken, byte for byte.
//
// The narrowing travels as a marker rather than as a pre-filtered `ctx.tasks` on purpose:
// `runOwnershipCheck` must stay run-wide. It explains every commit on the run branch, not just
// this task's, so handing it a filtered task list would let a direct write ride in behind
// whichever task happens to finish first. A marker narrows exactly the two consumers that
// should narrow and leaves ownership reading the full list.
function scopedTasks(ctx) {
  const tasks = ctx.tasks ?? []
  return ctx.taskScope == null ? tasks : tasks.filter((t) => t.id === ctx.taskScope)
}

// The phase's tasks, then the scope. A `taskScope` naming a task outside the current phase
// therefore narrows to zero, which the callers' existing "selected no tasks" guard fails —
// fail-closed, never a vacuous pass.
function scopedPhaseTasks(ctx) {
  return scopedTasks(ctx).filter((t) => t.phase === ctx.currentPhase)
}

// The protected set comes from `checksForPhase`, which overwrites whatever the manifest put on the
// entry with `protectedPaths(config)`. A caller that builds a check list by hand gets the default
// set rather than none: the manifest itself is always protected.
function guardedSet(check) {
  const paths = Array.isArray(check?.protected) ? check.protected : protectedPaths({})
  return new Set(paths.map((p) => normalizePath(p).toLowerCase()))
}

// Membership folds case: a case-insensitive filesystem (NTFS on the win32 CI, APFS on macOS) may
// open `Fleetmates.gate.json` as the manifest. Authorisation does NOT fold case: a marking whose
// case differs from the changed path does not authorise it, and the change escalates. Both
// directions err toward escalation. Do not fold the authorisation side — that loosens it.
function protectedViolations(changed, check, task) {
  const guarded = guardedSet(check)
  const marked = new Set((task?.protectedFiles ?? []).map(normalizePath))
  return changed.map(normalizePath).filter((p) => guarded.has(p.toLowerCase()) && !marked.has(p))
}

export async function runFilesetCheck(check, ctx = {}) {
  const { git, runId, runSha, anchorSha, currentPhase, phaseError } = ctx
  if (!git) return checkResult(check, 'fail', 'fileset check has no git access')
  if (phaseError) return checkResult(check, 'fail', phaseError)
  if (currentPhase == null) {
    // Every phase is integrated: there is no in-progress phase whose declared file set is
    // still being written to, so there is nothing left to diff. Re-diffing every historical
    // branch on every gate invocation would repeat work this check already did while each
    // phase was in progress, without adding signal beyond what runOwnershipCheck re-verifies
    // on every invocation regardless of phase (every commit on the run branch since the
    // anchor is reachable from a task branch, and a merge commit contributes nothing beyond
    // what its parents already established). Branch shas are still recorded here, though,
    // so a branch that moves after this verdict is issued is caught by verdictCoversTree
    // even though this path performs no diff of its own.
    const branchShas = {}
    const instructionFindings = []
    try {
      // Scoped too: a task-scoped verdict must not claim to cover a sibling's branch, or a
      // sibling moving its branch would invalidate this task's verdict via verdictCoversTree.
      for (const task of scopedTasks(ctx)) {
        const branch = resolveTaskBranch(task, runId)
        if (branch && await git.branchExists(branch)) {
          branchShas[branch] = await git.resolveRef(`refs/heads/${branch}`)
          for (const hit of await lintCommittedInstructions(git, branchShas[branch], task.files ?? [])) {
            instructionFindings.push(`${task.id}: instruction security lint — ${JSON.stringify(hit.path)}:${hit.line}: ${hit.rule}`)
          }
        }
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      return checkResult(check, 'fail', err.message)
    }
    return { ...checkResult(check, instructionFindings.length ? 'fail' : 'pass', instructionFindings.length ? instructionFindings.join('\n') : 'every phase in the plan is integrated'), branchShas }
  }

  const phaseTasks = scopedPhaseTasks(ctx)
  // Zero tasks is not "nothing to check" — the run and the plan disagree, and an earlier
  // version returned a clean pass for exactly this state.
  if (phaseTasks.length === 0) {
    return checkResult(check, 'fail', `phase ${currentPhase} selected no tasks from the plan`)
  }

  let mergedFiles
  try {
    mergedFiles = await mergedParentFiles(git, { anchorSha, runSha })
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not walk this run's merge history: ${err.message}`)
  }

  // Built from EVERY task in the run, not `phaseTasks`: a ref outside this phase pointing at a
  // merged parent is what spends it, so scoping this to the gated phase would hand a parked ref
  // a parent its real owner already claimed.
  let runTipCredited
  try {
    const allTasks = ctx.tasks ?? []
    const shaByTask = await resolveTaskShas(git, { tasks: allTasks, runId })
    runTipCredited = creditRunTipTasks({
      tasks: allTasks,
      shaByTask,
      runSha,
      mergedFiles,
      spent: await spentParents(git, { tasks: allTasks, shaByTask, runSha, mergedFiles }),
    })
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not resolve this run's task refs: ${err.message}`)
  }

  const problems = []
  const branchShas = {}
  for (const task of phaseTasks) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) { problems.push(`${task.id}: no branch could be resolved`); continue }
    try {
      if (!(await git.branchExists(branch))) {
        problems.push(`${task.id}: branch ${branch} does not exist`)
        continue
      }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      branchShas[branch] = sha
      // Diffed against the branch's actual fork point off the run branch, not the run
      // anchor fixed at the start of the whole run. A phase-2 branch legitimately forks
      // from the run branch after phase 1 has already been merged into it, so a diff
      // against the anchor would blame phase 2 for phase 1's files. Three-dot notation
      // against the anchor does not help either — once the anchor is an ancestor of the
      // branch (true for every phase after the first), merge-base(anchor, branch) is just
      // the anchor again, so it degenerates to the same wrong diff.
      const forkPoint = await git.mergeBase(runSha, sha)
      const changed = await git.changedFiles({ base: forkPoint, branch: sha })
      // An existing branch that changes nothing is not a vacuous pass. A teammate that skips
      // its `git checkout -B fleetmates/<runId>/<taskId>` commits on whatever branch it was
      // handed — the harness's own worktree branch — and leaves the conventional ref sitting
      // at the run tip with no work on it. The ref exists, filesetViolations of an empty list
      // is empty, and the task then merges as a no-op while its result says `done`. The
      // branch is resolved by convention precisely so the enforced party cannot redirect the
      // check; emptiness is what that redirection looks like from here.
      if (changed.length === 0) {
        // What decides it is whether some merge in `anchor..run` that names this sha as a
        // secondary parent actually carried THIS TASK's declared files — `landedForFiles`, over
        // the shared `mergedFiles` index built above. See the comment on `mergedParentFiles`
        // and `landedForFiles` themselves (above `deriveContext`, this file's first export) for
        // the full reasoning, what this closes, and what has been confirmed against it.
        //
        // Three earlier designs asked instead whether this sha was suspicious on its own terms
        // — shared by any other ref, not the run tip, or merely a member of
        // `git.mergedBranchTips` — and each produced a real, executed regression: withholding
        // credit from a legitimate branch sharing a sha with a parked one; failing two entirely
        // idle siblings the moment anything else landed on the run branch; and failing two
        // entirely idle siblings again when an unrelated task's OWN sync merge
        // (`git merge --no-ff run-branch` on its own branch) made an old run tip a secondary
        // parent of an in-range merge that carried neither idle task's files. `landedForFiles`
        // is per-task and reads only the merge's own diff, so none of those three shapes can
        // reach it — a fact confirmed by executing each of them, not asserted from the design
        // alone.
        //
        // A branch integrated by FAST-FORWARD leaves no merge commit and so no secondary
        // parent, so it is not a key in `mergedFiles` and reaches this test and fails it — with
        // a message that names a cause that is not the one, since the work IS on the run
        // branch. `tm-integrator`'s contract is `--no-ff` for exactly this reason. `ownership`
        // reports the same integration too: a fast-forward puts the task's commits on the run
        // branch's first-parent chain, where task-branch ancestry explains nothing. Failing closed is the intended
        // direction; the misleading wording is the price. A SQUASH merge likewise carries no
        // secondary parent, and this plugin's integrator never squashes.
        //
        // The NEAR-sibling shape every earlier design left open — an empty commit built on top
        // of a merged sibling's tip — is closed here too, not by design intent but as a
        // consequence of the predicate: whether that near-sibling commit is left unmerged (not
        // a key in `mergedFiles` at all) or later merged under its own name (a key, but its
        // merge's own diff against its own first parent is empty, since it carries nothing new),
        // `landedForFiles` reads false either way — an empty carried-file set can never
        // intersect a non-empty declared set. Confirmed by executing the merged-under-its-own-
        // name construction; not asserted from the design alone. Pinned as a defended test —
        // no longer a LIMIT — in `tests/adversarial.test.mjs`.
        //
        // What remains open:
        //   - A teammate that does the integrator's job itself — creating branches that each
        //     carry real work and merging them itself — is indistinguishable here from
        //     legitimate integration, because at this level it IS the same shape; unchanged
        //     from every earlier design and was never claimed to be closed.
        //   - Sibling-tip self-integration with an OVERLAPPING declared set: declared files are
        //     disjoint only WITHIN a phase, not across phases, and when a parked ref's declared
        //     set intersects what the integrating merge actually carried, this predicate cannot
        //     tell the parked ref from the branch that genuinely earned that credit. See the
        //     comment on `landedForFiles` above `deriveContext`, and the LIMIT test in
        //     `tests/adversarial.test.mjs`, for the executed repro.
        //
        // NOT open, and listed here only because it is the other branch of the test below: the
        // run-tip position (`sha === runSha`) is answered by `creditRunTipTasks`, which matches
        // such a ref to a merged parent that carried its whole declared set and that is not
        // already spent — spent meaning pointed at by another task ref, or (see `spentParents`)
        // an ancestor of one whose declared set the parent's files intersect. `landedForFiles`
        // cannot answer it at all: the run tip is not a key in the index, so it reads false for a
        // genuinely landed task whose ref a fix round re-pointed. See those two functions for why
        // containment alone was not enough.
        const landed = sha === runSha
          ? runTipCredited.has(task.id)
          : landedForFiles(mergedFiles, sha, task.files)
        if (!landed) {
          problems.push(`${task.id}: branch ${branch} contributes no file changes past its fork point ${forkPoint} — the work is not on the conventional ref, and merging this task would be a no-op`)
        }
        if (landed) {
          for (const hit of await lintCommittedInstructions(git, sha, task.files ?? [])) {
            problems.push(`${task.id}: instruction security lint — ${JSON.stringify(hit.path)}:${hit.line}: ${hit.rule}`)
          }
        }
        continue
      }
      for (const hit of await lintCommittedInstructions(git, sha, changed)) {
        problems.push(`${task.id}: instruction security lint — ${JSON.stringify(hit.path)}:${hit.line}: ${hit.rule}`)
      }
      const violations = filesetViolations(changed, task.files)
      if (violations.length > 0) problems.push(`${task.id}: outside declared set — ${violations.join(', ')}`)
      // Evaluated even for a path the task DECLARES: declaring the manifest is not authorising a
      // change to what the gate checks. A separate line with its own label, so an escalation shows
      // at a glance whether it was scope or protection.
      const unmarked = protectedViolations(changed, check, task)
      if (unmarked.length > 0) {
        problems.push(`${task.id}: protected — ${unmarked.join(', ')} (mark it "Modify (protected)" in the plan, amended on the base branch, or revert it)`)
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      problems.push(`${task.id}: ${err.message}`)
    }
  }
  const result = problems.length === 0
    ? checkResult(check, 'pass', '')
    : checkResult(check, 'fail', problems.join('\n'))
  return { ...result, branchShas }
}

// git show <sha>:<path> fails when the path does not exist at that commit — a real absence,
// not a git failure. `null` is a sentinel distinct from any real file content; every caller
// compares it against another call of this same function, so the sentinel only ever meets
// itself or real content.
// Content AND mode, as one comparable value. Mode is part of it because a chmod is a change
// that carries no bytes: comparing bytes alone reports "this parent never touched the file"
// for a file the diff did list, which leaves the merge with no explained source and fails an
// honest integration. Joined on a NUL, which cannot occur in a six-digit mode, so no
// content can spoof a mode boundary.
async function contentAt(git, sha, filePath) {
  try {
    const content = await git.fileAtCommit(sha, filePath)
    const mode = await git.fileModeAtCommit(sha, filePath)
    return `${mode ?? ''}\u0000${content}`
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return null
  }
}

// The rule, stated once so it is predictable regardless of merge order or which side
// conflicts: a file is accepted when the first parent's own content at the point of
// divergence is unchanged (a clean, verifiable single-side contribution) OR when more than
// one parent's history touched it there (an unverifiable but honest multi-way conflict);
// it is rejected only when the merge's content for that file has no such source at all.
//
// True when every byte that differs between the merge commit and its first parent is
// attributable to one of the merge's *other* parents (the caller has already confirmed
// every one of those is itself an ancestor of one of this run's task branches). For each
// file the merge changed relative to its first parent:
//
//   - A secondary parent "touched" the file when its content differs from the pairwise
//     merge-base with the first parent — the file's actual point of divergence, regardless
//     of how many other phases have since landed on the run branch.
//   - Exactly one clean toucher (the first parent's own content at that same base is
//     unchanged): a clean merge takes that side verbatim, so the merge's content must equal
//     it byte for byte. Matching filename with different bytes — the confirmed attack this
//     closes — fails right here.
//   - The first parent's content at that base *also* differs (a genuine two-way conflict),
//     or more than one secondary parent independently disagrees: git itself would have
//     required a hand resolution here, which cannot be verified byte-for-byte without
//     re-implementing the merge algorithm. Accepted — the ancestry check already confirmed
//     every contributor is an honest task branch, so this is a conflict between legitimate
//     contributions, not smuggled content.
//   - No parent touched the file at all: content with no legitimate source. Fails, even
//     under a name that matches nothing suspicious.
//
// Every secondary parent is checked for every file — nothing here stops at the first parent
// that explains part of the commit, which is what let content hide in the gap between two
// parents' contributions in an octopus merge.
//
// The candidate file list is the *union* of what changed between the first parent and the
// merge commit, and what each secondary parent itself changed relative to the first parent —
// not just the former. A file a secondary parent added and the merge commit then deleted
// (`git rm` after `--no-ff --no-commit`, before completing the commit) shows zero diff
// between the first parent and the merge commit — added, then removed, nets to invisible —
// so it would never reach the check at all if only that one diff were consulted. Deletion is
// a content change with no legitimate source, exactly like a fabricated addition; the merge
// commit must still explain why a file its own second parent introduced is now gone.
// `guard` narrows the one acceptance this rule makes without verifying bytes — a hand-resolved
// conflict — for a protected path: there it is accepted only when `guard.authorised` holds the file:
// the exact paths marked `(protected)` by the tasks that integrate a secondary parent (see
// `runOwnershipCheck`), plus the files only a base parent changed.
// An integrator that resolves a conflict on the manifest otherwise chooses its content freely.
//
// Returns `{ ok: true }` or `{ ok: false, protectedFile }`, the latter only when the one failure
// is that narrowing, so the caller can name the file.
async function mergeContentExplainedByParents(git, firstParent, secondaryParents, mergeSha, guard = null) {
  const mergedFiles = new Set(await git.changedFiles({ base: firstParent, branch: mergeSha }))
  for (const parent of secondaryParents) {
    for (const file of await git.changedFiles({ base: firstParent, branch: parent })) mergedFiles.add(file)
  }
  for (const file of mergedFiles) {
    const mergeContent = await contentAt(git, mergeSha, file)
    let genuineConflict = false
    const cleanContributions = new Set()
    for (const parent of secondaryParents) {
      const base = await git.mergeBase(firstParent, parent)
      const baseContent = await contentAt(git, base, file)
      const parentContent = await contentAt(git, parent, file)
      if (parentContent === baseContent) continue // this parent never touched the file
      const firstContentAtBase = await contentAt(git, firstParent, file)
      if (firstContentAtBase !== baseContent) { genuineConflict = true; break }
      cleanContributions.add(parentContent)
    }
    const unverified = genuineConflict || cleanContributions.size > 1
    if (unverified && guard?.paths.has(normalizePath(file).toLowerCase()) && !guard.authorised.has(normalizePath(file))) {
      return { ok: false, protectedFile: file }
    }
    if (genuineConflict) continue
    if (cleanContributions.size === 0) return { ok: false }
    if (cleanContributions.size === 1 && mergeContent !== [...cleanContributions][0]) return { ok: false }
    // size > 1: independent secondary parents disagree without the first parent being
    // involved — git itself would have flagged this as a conflict too. Accepted, for the
    // same reason a genuine conflict is: not verifiable byte-for-byte, but every contributor
    // is already a confirmed task branch.
  }
  return { ok: true }
}

// The run branch's first-parent chain inside `anchor..run`. Bounded by `commits.length` for the
// same reason `mergedParentFiles` bounds its identical walk: a git double whose chain never reaches
// the anchor would otherwise loop forever.
async function firstParentChain(git, { anchorSha, runSha, commits }) {
  const inRange = new Set(commits)
  const chain = []
  let cursor = runSha
  let steps = 0
  while (cursor && cursor !== anchorSha && inRange.has(cursor) && steps <= commits.length) {
    chain.push(cursor)
    const parents = await git.commitParents(cursor)
    if (parents.length === 0) break
    cursor = parents[0]
    steps += 1
  }
  return chain
}

// Whether `parent` lies on the first-parent chain of `tip` — the task's own line of work, as
// opposed to history it merely contains. A later phase's branch forks from the run tip, so it
// contains every earlier task's tip, but only as the second parent of that task's integration
// merge: never on its own first-parent chain. A fix round that merges the run branch into a landed
// task keeps the task's own commits on its chain. The walk stops at the first commit that is an
// ancestor of `parent`, since nothing older can be `parent` itself. Bounded, and a revisited
// commit ends the walk, so a git double whose parents never reach `parent` cannot loop forever.
const FIRST_PARENT_WALK_LIMIT = 10000
async function onFirstParentChain(git, tip, parent) {
  const seen = new Set()
  let cursor = tip
  while (cursor && !seen.has(cursor) && seen.size < FIRST_PARENT_WALK_LIMIT) {
    if (cursor === parent) return true
    if (await git.isAncestor(cursor, parent)) return false
    seen.add(cursor)
    cursor = (await git.commitParents(cursor))[0]
  }
  return false
}

// Why an injected `ownership` may fail on a run nothing ever asked to be explained. It cannot say
// which cause applies: knowing when this version was installed would need a record under
// `.fleetmates/`, which is agent-writable and never consulted by an enforcement check.
const INJECTED_OWNERSHIP_NOTE = 'check injected: the manifest does not declare it; the commits above may predate this fleetmates version, or come from an inline run (use --no-fleet)'

export async function runOwnershipCheck(check, ctx = {}) {
  const { git, runId, runBranch, baseBranch, anchorSha, runSha, tasks } = ctx
  if (!git) return checkResult(check, 'fail', 'ownership check has no git access')

  try {
    const branches = []
    const shas = []
    // Parallel to `shas`: the task each resolved branch belongs to, for its `(protected)` markings.
    const taskOf = []
    for (const task of tasks ?? []) {
      const branch = resolveTaskBranch(task, runId)
      if (branch && await git.branchExists(branch)) {
        branches.push(branch)
        shas.push(await git.resolveRef(`refs/heads/${branch}`))
        taskOf.push(task)
      }
    }

    // Tolerated when it cannot be resolved: a run configured without a base branch, or with
    // one that no longer exists, keeps today's behaviour rather than failing this check for a
    // brand-new reason it was never meant to report.
    let baseSha = null
    if (baseBranch && await git.branchExists(baseBranch)) {
      baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
    }

    const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
    const unexplained = []
    // Merges rejected only because they hand-resolved a conflict on a protected path; named below
    // with the file, so the escalation says why, and kept out of `unexplained`.
    const protectedConflicts = []
    // Merges whose content is explained by their parents but carries files no integrated task
    // declared (or a protected one no integrated task marked).
    const outOfScopeMerges = []
    // Every commit this check admitted only because of base ancestry. Reported on the pass —
    // see `baseExplainedNote`, which also records why no base sha from run start is consulted.
    const baseExplained = []
    const chain = new Set(await firstParentChain(git, { anchorSha, runSha, commits }))
    // Each task branch's own first-parent chain above the anchor, listed once per gate rather than
    // walked once per (merge, task) pair: the walk made ownership cubic in the run's length. A git
    // double without the listing falls back to the bounded walk.
    const taskChains = new Map()
    const integrates = async (i, parent) => {
      if (typeof git.firstParentCommits !== 'function' || !anchorSha) return onFirstParentChain(git, shas[i], parent)
      if (!taskChains.has(i)) taskChains.set(i, new Set(await git.firstParentCommits(shas[i], anchorSha)))
      return taskChains.get(i).has(parent)
    }
    for (const sha of commits) {
      let explained = false
      // A commit on the run branch's own first-parent chain is a write to the run branch itself,
      // and is never explained by being reachable from a task branch: every task branch of a
      // later phase forks from the run tip, so it carries every earlier write to the run branch in
      // its history. Reachability vouched for all of them — an evil merge in phase N, or a direct
      // write, was "explained" by the phase N+1 branch that forked after it, and neither the next
      // gate nor `finish` could ever report it. On the chain, the only explanation is the merge
      // rule below, and that rule judges what each merge CARRIES, so a commit off the chain may
      // still be explained by plain reachability: whatever it holds reaches the run branch only
      // through a chain merge that is judged on its own.
      if (!chain.has(sha)) {
        for (const branchSha of shas) {
          if (await git.isAncestor(sha, branchSha)) { explained = true; break }
        }
      }
      if (!explained) {
        const parents = await git.commitParents(sha)
        const firstParent = parents[0]
        // Only *non-first* parents can explain a commit this way. The first parent is the
        // run branch's own prior history; letting it vouch for a commit would let any commit
        // reachable through a fast-forward onto a task branch (first parent == that branch's
        // tip) trivially explain itself via isAncestor(X, X) — exactly how a direct write
        // riding a fast-forward would be waved through. Confirmed via mutation testing:
        // scanning `parents` instead of `parents.slice(1)` leaves the suite green while
        // silently accepting that write.
        const secondaryParents = parents.slice(1)
        if (firstParent && secondaryParents.length > 0) {
          // Every secondary parent must itself be an ancestor of one of this run's task
          // branches — an octopus merge with one legitimate parent and one rogue parent
          // must not be waved through because the legitimate one matched. Confirmed gap in
          // an earlier version: the scan broke on the first matching parent, so content
          // riding in behind a second, unowned parent was never inspected.
          let allParentsOwned = true
          let usedBase = false
          // What this merge may carry: the declared files of every task that integrates one of its
          // secondary parents, plus whatever only a base parent changed. A task integrates a parent
          // when the parent is on the task branch's own first-parent chain (`onFirstParentChain`):
          // merely holding it is not enough, because every later phase's branch holds every
          // earlier tip, and its declared set would widen the earlier merge — the side-branch and
          // fix-round smuggle this rule exists to close.
          const scope = new Set()
          const baseTouched = new Set()
          const taskTouched = new Set()
          // Per task-side parent: what it changed, and what the tasks integrating it allow. Checked
          // parent by parent, because in an octopus the union would let one task's declared set or
          // marking cover a sibling parent's change.
          const perParent = []
          // Which protected paths it may carry: those marked by a task that integrates a secondary
          // parent, by the same first-parent rule, so a later task's marking authorises nothing.
          const authorised = new Set()
          for (const parent of secondaryParents) {
            let owned = false
            // A merge of the base into the run branch is how a mid-run plan amendment reaches
            // the anchor. Its secondary parent is the base, never a task branch, so without
            // this a legitimate base advance is indistinguishable from a direct write. Base
            // content is already trusted: the anchor is computed from it and `changedFiles`
            // diffs against it, so accepting base ancestry adds no new trust. Asked FIRST: a
            // task branch rebased after an amendment holds the base parent too, and must not
            // lend it its declared set or its markings. A parent at or below the anchor is a base
            // ancestor as well, and contributes nothing (it is its own merge base with the run).
            if (baseSha && await git.isAncestor(parent, baseSha)) {
              owned = true
              usedBase = true
              // Three-dot: only what the base side changed since it met the run. The operator's
              // amendment merge may have to resolve a conflict on a protected path the base also
              // changed, and no task could ever mark that resolution; whoever writes the base is
              // already the trust boundary for `(protected)` itself. Only for those files.
              for (const file of await git.changedFiles({ base: firstParent, branch: parent })) baseTouched.add(normalizePath(file))
            } else {
              const own = { files: [], scope: new Set(), authorised: new Set() }
              for (let i = 0; i < shas.length; i += 1) {
                if (!(await git.isAncestor(parent, shas[i]))) continue
                owned = true
                if (!(await integrates(i, parent))) continue
                for (const file of taskOf[i]?.files ?? []) own.scope.add(normalizePath(file))
                for (const file of taskOf[i]?.protectedFiles ?? []) own.authorised.add(normalizePath(file))
              }
              for (const file of own.scope) scope.add(file)
              for (const file of own.authorised) authorised.add(file)
              for (const file of await git.changedFiles({ base: firstParent, branch: parent })) {
                taskTouched.add(normalizePath(file))
                own.files.push(normalizePath(file))
              }
              perParent.push(own)
            }
            if (!owned) { allParentsOwned = false; break }
          }
          // The base exemption covers a file only when no task-side parent changed it too: in an
          // octopus of [run, base, task] where both changed the manifest, the task side must not
          // ride in on the base's exemption.
          for (const file of taskTouched) baseTouched.delete(file)
          if (allParentsOwned) {
            const verdict = await mergeContentExplainedByParents(
              git, firstParent, secondaryParents, sha, { paths: guardedSet(check), authorised: new Set([...authorised, ...baseTouched]) },
            )
            explained = verdict.ok
            if (verdict.protectedFile) protectedConflicts.push({ sha, file: verdict.protectedFile })
            // Content explained by its parents is not yet content the plan allowed. A task branch
            // that already landed can grow a commit outside its declared set — the manifest, a
            // smuggled file — and be merged again as a routine fix round, or an integrator can
            // commit a payload on a side branch and merge that: either way the change is a clean
            // single-side contribution and `fileset` only diffs the phase in progress. So every
            // integration merge carries only what the tasks it integrates declare (protected paths
            // only where marked), plus whatever the base side changed.
            if (explained) {
              const outside = []
              const guarded = guardedSet(check)
              for (const file of await git.changedFiles({ base: firstParent, branch: sha })) {
                const f = normalizePath(file)
                if (baseTouched.has(f)) continue
                if (!scope.has(f) || (guarded.has(f.toLowerCase()) && !authorised.has(f))) outside.push(f)
              }
              for (const own of perParent) {
                for (const f of own.files) {
                  if (outside.includes(f)) continue
                  if (!own.scope.has(f) || (guarded.has(f.toLowerCase()) && !own.authorised.has(f))) outside.push(f)
                }
              }
              if (outside.length > 0) {
                explained = false
                outOfScopeMerges.push({ sha, files: outside })
              }
            }
            if (explained && usedBase) baseExplained.push(sha)
          }
        }
      }
      // A merge already named by one of the two specific lines below is not also given the generic
      // "reachable from no task branch" line: both causes that line names are false for it.
      const named = protectedConflicts.some((c) => c.sha === sha) || outOfScopeMerges.some((m) => m.sha === sha)
      if (!explained && !named) unexplained.push(sha)
    }

    // Asked of every task branch of the run, not just the current phase's: a branch merged
    // into the base by a side door is a violation whenever it is noticed, and an earlier
    // phase's branch is exactly the one most likely to have been "helpfully" landed already.
    // Skipped entirely when the base could not be resolved — the same tolerance the
    // base-ancestry clause above applies, for the same reason.
    const sideDoor = []
    if (baseSha) {
      for (let i = 0; i < shas.length; i += 1) {
        if (await git.isAncestor(shas[i], baseSha) && !(await git.isAncestor(shas[i], runSha))) {
          sideDoor.push(branches[i])
        }
      }
    }

    const violations = ownershipViolations({
      runBranch,
      baseBranch,
      sideDoorBranches: sideDoor,
      taskBranches: branches,
      unexplainedCommits: unexplained,
      dirty: await git.isDirty(),
    })
    // Only the manifest: it is the one protected file the gate reads from the main worktree. Any
    // other protected path is judged from commits, and a sparse checkout legitimately sets the
    // skip-worktree bit on paths outside its cone.
    const hidden = typeof git.hiddenFromStatus === 'function' ? await git.hiddenFromStatus(protectedPaths({})) : []
    for (const file of hidden) {
      violations.push(`${file} is marked skip-worktree or assume-unchanged, so an edit to it in the main worktree is invisible to status; clear it with \`git update-index --no-skip-worktree --no-assume-unchanged -- <path>\``)
    }
    for (const { sha, files } of outOfScopeMerges) {
      violations.push(`merge ${sha} carries ${files.join(', ')}, which no task it integrates declares (or marks, for a protected path)`)
    }
    for (const { sha, file } of protectedConflicts) {
      violations.push(`merge ${sha} resolved a conflict on protected ${file} that no task it integrates marks (protected)`)
    }
    if (violations.length > 0 && check?.injected === true) violations.push(INJECTED_OWNERSHIP_NOTE)
    return violations.length === 0
      ? checkResult(check, 'pass', baseExplainedNote({ baseBranch, commits: baseExplained }))
      : checkResult(check, 'fail', violations.join('\n'))
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', err.message)
  }
}

// `merge` is deliberately absent: the gate builds the merge preview itself, once, around the
// whole check list. A manifest entry claiming that kind finds no runner and lands as pending,
// which blocks — an editable manifest must not be able to supply or suppress a computed check.
const RUNNERS = Object.assign(Object.create(null), {
  command: runCommandCheck,
  fileset: runFilesetCheck,
  ownership: runOwnershipCheck,
})

const MERGE_CHECK = { name: 'merge', kind: 'merge' }

const CONFLICT_SKIP = 'the phase does not merge cleanly; no merged tree exists to test'

async function runCheckList(checks, ctx, commandCwd, mergeConflicted, previewDir = null) {
  const results = []
  // Counted rather than `checks.entries()`, which would narrow this loop from any iterable to an
  // array and yield `[value, value]` for a Set.
  let index = -1
  for (const check of checks) {
    index += 1
    // BEFORE THE RUNNER LOOKUP at the bottom of this loop, which is the ordering that carries the
    // security property: that lookup coerces (`RUNNERS[['command']]` resolves to a real runner),
    // so an unusable kind reaching it executes. That ordering is pinned: delete this block and the
    // array-spelled execution and false-PASS tests in tests/gate-runner.test.mjs both fail.
    //
    // Its order relative to the merge-conflict skip below matters too, but NOT for the reason a
    // previous version of this comment gave. That version said a non-string kind "slips past" the
    // skip and could be reported as a benign skip; it cannot, because the skip compares
    // `kind === 'command'` strictly and no non-string value satisfies a strict comparison. What
    // the skip actually does is dereference `check.kind` UNGUARDED. Of the entry shapes
    // `fleetmates.gate.json` can express, exactly one throws there: `null`. A string, number, array
    // or boolean entry evaluates `check.kind` to `undefined` harmlessly and is caught below for the
    // ordinary reason, and `undefined` itself throws but JSON has no literal for it, so it can only
    // arrive from a programmatic caller. That one shape is enough — a `null` entry throws a
    // TypeError out of this loop and out of `runChecks`, recording no verdict at all. Pinned: move
    // this block below the skip and the nameless-entry test fails on that throw.
    // See `hasUsableKind`.
    if (!hasUsableKind(check)) {
      results.push(malformedKindResult(check, manifestPosition(ctx, index)))
      continue
    }
    // Before the conflict skip on purpose: a malformed bound is a configuration fault, and a
    // phase that does not merge is exactly where it would otherwise go unreported until the
    // conflict was fixed and the check finally ran.
    if (check.kind === 'command') {
      const fault = timeoutFault(check)
      if (fault) { results.push(malformedTimeoutResult(check, manifestPosition(ctx, index), fault)); continue }
    }
    // A `command` check exists to answer "does the integrated tree work". Without a merged
    // tree there is no honest answer, and running it against the run branch's own tree would
    // answer a different question while looking like the one that was asked. Skipped, with
    // the reason — the block comes from the `merge` check, which fails.
    if (check.kind === 'command' && mergeConflicted) {
      results.push(checkResult(check, 'skip', CONFLICT_SKIP))
      continue
    }
    // Bare property access would resolve a kind of "toString" to Object.prototype.toString
    // and call it as a runner. Confirmed reachable from a hand-written manifest.
    const runner = Object.hasOwn(RUNNERS, check.kind) ? RUNNERS[check.kind] : null
    if (!runner) { results.push(describePendingCheck(check)); continue }
    try {
      // Only `command` checks are relocated. `fileset` and `ownership` read git, not a
      // working tree, and must keep reading the real repository.
      results.push(await runner(check, check.kind === 'command' ? { ...ctx, cwd: commandCwd, previewDir } : ctx))
    } catch (err) {
      // A throwing check previously propagated out of the CLI, so no verdict was recorded
      // and the previous phase's PASS stood.
      results.push(checkResult(check, 'fail', `check threw: ${err.message}`))
    }
  }
  return results
}

// A preview that could not be built at all — a merge that failed without leaving unmerged
// paths (unset user.email, a branch deleted mid-run, unrelated histories), or a worktree that
// could not be created — is neither a clean tree nor a reportable conflict. It is reported as
// a failing `merge` check carrying git's own reason, with the `command` checks skipped: they
// must never run against the unmerged tree, and `aggregateVerdict` blocks on the fail.
async function previewFailure(checks, ctx, reason) {
  return [checkResult(MERGE_CHECK, 'fail', reason), ...await withInventory(checks, await runCheckList(checks, ctx, ctx.cwd, true), ctx, { reason: CONFLICT_SKIP })]
}

// --- test inventory (docs/specs/2026-09-26-test-inventory-design.md) -------------------------

const INVENTORY_SOLO = 'a solo gate has no run tip to baseline against'
const INVENTORY_NO_BRANCHES = 'no phase branches to compare against the baseline'
const INVENTORY_EARLY = 'the early check does not run the baseline; the gate does'
const INVENTORY_LINES = 50

// Each `command` check with a `report` gets a computed `<name>:inventory` result right after its
// own. Computed like `merge`: no runner exists for the kind, so a manifest entry claiming it lands
// pending and blocks — the manifest can neither supply nor suppress it.
async function withInventory(checks, listed, ctx, { reason = null } = {}) {
  const reportChecks = [...checks].filter((c) => c && typeof c === 'object' && c.kind === 'command' && c.report)
  if (reportChecks.length === 0) return listed
  const skipReason = reason ?? (ctx.early ? INVENTORY_EARLY : null)
  const baseline = skipReason ? null : await baselineReports(reportChecks, ctx)
  const out = []
  for (const result of listed) {
    out.push(result)
    const check = result?.kind === 'command' ? reportChecks.find((c) => c.name === result.name) : null
    if (check) out.push(await inventoryResult(check, result, baseline?.get(check.name), ctx, skipReason))
  }
  return out
}

// The suite run again on the tree the preview merges onto, in a worktree of its own, linked and
// claimed like the preview. Nothing is cached: a baseline stored under `.fleetmates/` would be
// agent-writable.
async function baselineReports(reportChecks, ctx) {
  const reports = new Map()
  try {
    await withMergePreview({
      git: ctx.git,
      base: ctx.runBranchRef ?? ctx.runBranch,
      branches: [],
      always: true,
      link: ctx.previewLink ?? [],
      repoRoot: ctx.cwd,
      run: async ({ path: tree }) => {
        for (const check of reportChecks) {
          try {
            const result = await runCommandCheck(check, { ...ctx, cwd: tree, previewDir: tree })
            reports.set(check.name, result.report ?? { error: 'the baseline run produced no report' })
          } catch (err) {
            reports.set(check.name, { error: `the baseline run threw: ${err.message}` })
          }
        }
      },
    })
  } catch (err) {
    for (const check of reportChecks) reports.set(check.name, { error: `the baseline tree could not be built: ${err.message}` })
  }
  return reports
}

function capped(lines, label) {
  if (lines.length <= INVENTORY_LINES) return lines
  return [...lines.slice(0, INVENTORY_LINES), `… and ${lines.length - INVENTORY_LINES} more ${label}`]
}

async function inventoryResult(check, previewResult, baseline, ctx, skipReason) {
  const self = { name: `${check.name}:inventory`, kind: 'inventory' }
  if (skipReason) return checkResult(self, 'skip', skipReason)
  if (previewResult.status === 'skip') return checkResult(self, 'skip', 'the suite did not run in the preview')
  const preview = previewResult.report
  if (!preview) return checkResult(self, 'fail', 'the preview run produced no report')
  if (preview.error) return checkResult(self, 'fail', `preview report: ${preview.error}`)
  if (!baseline || baseline.error) return checkResult(self, 'fail', `baseline report: ${baseline?.error ?? 'missing'}`)

  const phaseTasks = scopedPhaseTasks(ctx)
  const drops = new Set(phaseTasks.flatMap((t) => t.dropFiles ?? []).map(normalizePath))
  const skips = new Set((check.skips ?? []).map(normalizePath))
  const { dropped, newSkips, standing, stale } = compareInventories(baseline.inventory, preview.inventory, { drops, skips })

  const notes = [
    ...capped(standing.map((s) => `standing skip: ${s.id}`), 'standing skips'),
    ...stale.map((s) => `stale skips entry: ${s.unit} (nothing in it is skipped)`),
  ]
  // `standing` rides on the result like `pairs` on a conflicted merge: `finish` names the units at
  // the end of every run, and parsing them back out of `output` would be guessing.
  if (dropped.length === 0 && newSkips.length === 0) return { ...checkResult(self, 'pass', notes.join('\n')), standing }

  const changers = await unitChangers(ctx, phaseTasks, [...dropped, ...newSkips].map((d) => d.unit))
  const by = (unit) => (changers.get(unit)?.length ? ` (changed by ${changers.get(unit).join(', ')})` : '')
  const lines = [
    ...capped(dropped.map((d) => `drop: ${d.id} — ran at the baseline, ${d.now} now${by(d.unit)}`), 'drops'),
    ...capped(newSkips.map((d) => `new skip: ${d.id}${by(d.unit)}`), 'new skips'),
  ]
  if (dropped.length > 0) lines.push('a drop is approved by marking the file "- Test (drops)" in the plan on the base branch')
  if (newSkips.length > 0) lines.push('a new skip is approved by declaring its unit in the manifest\'s "skips", with the reason')
  return { ...checkResult(self, 'fail', [...lines, ...notes].join('\n')), standing }
}

// Diagnosis only — authorisation never depends on it: a drop can come from a change to source,
// not to the test file.
async function unitChangers(ctx, phaseTasks, units) {
  const wanted = new Set(units)
  const changers = new Map()
  for (const task of phaseTasks) {
    const branch = resolveTaskBranch(task, ctx.runId)
    try {
      if (!branch || !(await ctx.git.branchExists(branch))) continue
      for (const file of await ctx.git.changedFiles({ base: ctx.runBranchRef ?? ctx.runBranch, branch })) {
        const unit = normalizePath(file)
        if (!wanted.has(unit)) continue
        changers.set(unit, [...(changers.get(unit) ?? []), task.id])
      }
    } catch { /* diagnosis only */ }
  }
  return changers
}

export async function runChecks(checks, ctx = {}) {
  // A solo (--no-fleet) run has no run branch, no task branches and no git in context: there
  // is nothing to preview, so the checks run where the caller stands.
  if (!ctx.git || ctx.solo) return withInventory(checks, await runCheckList(checks, ctx, ctx.cwd, false), ctx, { reason: INVENTORY_SOLO })

  // The same notion of "this phase's branches" the fileset check uses — same
  // resolveTaskBranch call, same branchExists guard, same phase filter, and the same
  // `taskScope` narrowing. Two different ones in one file would drift.
  //
  // Scoping matters here for the same reason it matters for fileset: with the phase-wide set,
  // the first teammate of a 3-task phase to run `complete` gets every sibling's branch merged
  // into its preview, so a sibling's stray commit — or a sibling branch that does not exist
  // yet — fails the preview and reads to that teammate as "my own work is broken".
  const phaseTasks = scopedPhaseTasks(ctx)
  const branches = []
  try {
    for (const task of phaseTasks) {
      const branch = resolveTaskBranch(task, ctx.runId)
      if (branch && await ctx.git.branchExists(branch)) branches.push(branch)
    }
  } catch (err) {
    return previewFailure(checks, ctx, `merge preview could not resolve the phase's branches: ${err.message}`)
  }

  // Set as soon as the callback runs, so the catch below can tell "the preview was never
  // built" (re-run the list against no merged tree) from the theoretical case of the callback
  // itself throwing after some checks already ran — which must never re-run them.
  let previewed = false
  try {
    return await withMergePreview({
      git: ctx.git,
      // The REF HEAD points at, not the name derived from it, whenever the caller knows it.
      // `qualifyBranch` returns any `refs/`-prefixed string unchanged and prefixes anything else,
      // so a NAME that is itself a ref path qualifies to a different ref than the one HEAD holds
      // — and this preview would then be built on the wrong tree while reporting merge=pass.
      // `classifyHeadRef` refuses that HEAD state upstream, so nothing reaches here with such a
      // name today; this makes the consumer unable to misread what it is given, rather than
      // leaving the guarantee resting on the refusal alone. The fallback keeps every caller that
      // has no ref to give — a `--run-branch` named on the command line, never resolved from HEAD
      // — on exactly the behaviour it had.
      base: ctx.runBranchRef ?? ctx.runBranch,
      branches,
      link: ctx.previewLink ?? [],
      repoRoot: ctx.cwd,
      // Every check runs inside this callback, so the worktree is alive for all of them and
      // removed exactly once, after the last one. The merge check cannot be the thing holding
      // the worktree open — by the time a later check ran, the directory would be gone.
      run: async ({ path, conflict }) => {
        previewed = true
        if (conflict) {
          const pairs = conflictPairs(branches, conflict)
          const merged = { ...checkResult(MERGE_CHECK, 'fail', JSON.stringify(pairs, null, 2)), pairs }
          return [merged, ...await withInventory(checks, await runCheckList(checks, ctx, ctx.cwd, true), ctx, { reason: CONFLICT_SKIP })]
        }
        const merged = checkResult(MERGE_CHECK, 'pass', '')
        // `path` is the preview, or null when the phase had no branches to merge and the
        // checks stand in the run branch's own tree — which is not a preview and holds no
        // claim. Passed explicitly rather than inferred from the cwd: an explicit null is
        // the difference between "not previewing" and "previewing somewhere this code
        // failed to recognise".
        const listed = await runCheckList(checks, ctx, path ?? ctx.cwd, false, path)
        return [merged, ...await withInventory(checks, listed, ctx, path === null ? { reason: INVENTORY_NO_BRANCHES } : {})]
      },
    })
  } catch (err) {
    const reason = `merge preview failed: ${err.message}`
    if (previewed) {
      // Unreachable in practice — runCheckList catches every per-check throw. Kept so a
      // future edit inside the callback can never produce a second, duplicate run of the
      // checks, nor a verdict-less crash out of the CLI.
      return [checkResult(MERGE_CHECK, 'fail', reason), ...checks.map((c) => checkResult(c, 'fail', reason))]
    }
    return previewFailure(checks, ctx, reason)
  }
}

const RECOGNIZED = new Set(['pass', 'fail', 'skip', 'pending'])

// Kinds the gate computes for itself rather than reading from the manifest. They are real
// results — they fail, they block, they are reported — but they are not evidence that anything
// the manifest asked for was actually verified, so they do not satisfy the fail-closed
// "some check ran" clause below.
const GATE_COMPUTED_KINDS = new Set(['merge', 'inventory'])

export function aggregateVerdict(results) {
  // An unrecognized or missing status is a failure, never a pass. This function is the
  // single source of truth for whether a phase proceeds; it must never fail open.
  // The verdict is the AND of all non-optional checks — an optional check that fails
  // is still surfaced, in optionalFailed, but never blocks the gate on its own.
  const unrecognized = results.filter((r) => !RECOGNIZED.has(r.status)).map((r) => r.name)
  const failed = [
    ...results.filter((r) => r.status === 'fail' && !r.optional).map((r) => r.name),
    ...unrecognized,
  ]
  const optionalFailed = results.filter((r) => r.status === 'fail' && r.optional).map((r) => r.name)
  const skipped = results.filter((r) => r.status === 'skip').map((r) => r.name)
  const pending = results.filter((r) => r.status === 'pending' && !r.optional).map((r) => r.name)
  // "At least one check ran" is decided over the manifest-supplied results only. `runChecks`
  // prepends the gate's own `merge` result to every fleet check list, so counting `results`
  // wholesale would read a check list of one self-generated pass as a verified phase — which is
  // exactly what an enforced agent buys by emptying the working-tree manifest, the same edit
  // that stops `fileset` and `ownership` from running. Confirmed reachable: the working tree's
  // manifest is loaded with plain `fs` and never compared against the committed copy. A
  // manifest entry that merely *claims* a gate-computed kind is excluded here too; it lands as
  // a non-optional pending and blocks on its own, so exclusion only ever fails closed.
  const verified = results.filter((r) => !GATE_COMPUTED_KINDS.has(r.kind))
  const passed = verified.length > 0 && failed.length === 0 && pending.length === 0
  return { verdict: passed ? 'PASS' : 'FAIL', failed, optionalFailed, skipped, pending }
}
