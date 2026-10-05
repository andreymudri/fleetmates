# Team run (fleetmates run)

| | |
|---|---|
| Canvas board | `Team` (Team run · timeline + tasks + crew) |
| Route | `/runs/:repoKey/*runId` (`runId` may nest, for example `2026/substop`, fleetmates contract 2) |
| Milestone | M2 (read-only run view from `status.json`, `plan.json`, derived phase, attributed hook activity). M3 adds "Review N requests" answering through the drawer. |
| Status | Decided (layout, sections, gate lane), Proposed (data mapping), several Open items where the canvas shows data fleetmates does not have |

## 1. Purpose

Answers **"Where is this fleetmates run, who is blocked, and on what?"**: phases and gates on one line, the current phase's tasks with literal states, and each worker's recent activity. The run is read-only for the deck; it never writes `status.json` (fleetmates contract 6, risk 2).

## 2. Route and entry points

| Entry | Result |
|---|---|
| Home team card title | `/runs/:repoKey/:runId` |
| Focus "Open run" (lead session) | same |
| Palette session row of a lead session (Alt Enter opens Focus instead) | same |

`repoKey` is the repo `name` as shown (disambiguated `work/api` when names collide, 02-domain 2.1), URL-encoded; the server resolves it to `repo.id`. Unknown run: not-found state.

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Header | PageHeader `size="lg"` | back link, title, mono subtitle, pill, elapsed, actions |
| Phases | `section aria-label="Phases"`, PhaseBar `timeline`, gate lanes `--layout-gate-lane` | full width, bottom border |
| Tasks | `section aria-label="Current phase tasks"`, width `--layout-panel-md` | TaskRow list, "Later phases", gate Banner at the bottom |
| Workers | `section aria-label="Crew activity"`, grid 2 x 2 | one panel per worker (TerminalTail `crew` inside an `article`) |

| Width | Behaviour (design-system 8.3) |
|---|---|
| 1920 | tasks 600, workers 2 x 2 |
| 1440 | tasks `--layout-panel-sm` (440), workers 2 x 2 |
| 1280 | tasks 440; workers 1 column x N, the workers section scrolls |
| more than 4 workers | grid adds rows of `minmax(280px, 1fr)` and scrolls (Proposed) |

## 4. Content inventory

### 4.1 Header

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Back | link | | "All ships" | `Alt Esc` |
| Title | h1 | lead session `task`, else plan H1, else `runId` (HOME-O5) | "Extract the phase gate into a CLI" | |
| Subtitle | mono MetaLine | `repo.name`, `plan.runBranch`, `plan.planPath` | "fleetmates · run/gate-cli · plan docs/plans/2026-09-20-gate-cli.md" | branch item omitted when `runBranch` absent |
| Aggregate pill | StatePill, label override | most urgent teammate state (02-domain 3 order); needs count / worker count | "2 of 4 need you" | |
| Elapsed | text `type.body-sm` muted, tabular nums | lead session `startedAt`, else earliest task `startedAt`; hidden when neither exists | "running 1h 12m" | TEAM-O3 |
| Review | Button `amber sm` | open requests attributed to this run | "Review 2 requests" | hidden at 0; opens the drawer filtered to the run |
| Open plan | Button `secondary sm` | `plan.planPath` | "Open plan" | opens the plan file (TEAM-O5) |
| Stop run | Button `danger sm` | lead session PTY origin | "Stop run…" | confirm; stops the lead session (`U.Stop`) |

### 4.2 Phases timeline

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Phase | PhaseBar phase | phases `1..plan.totalPhases`; status `done` when integrated (derived), `active` for `derivedPhase`, else `pending`; segments from task states in that phase | name "Phase 1" (TEAM-O1); sub "tasks 1 to 2 · done", "tasks 3 to 7 · 1 done, 2 need you, 1 running" |
| Gate | PhaseBar gate between phases | `status.gates[String(n)]`: `verdict` PASS gives `passed`, FAIL gives `failed`; absent gives `pending`; a gate run in progress gives `checking` (not observable today, TEAM-O4) | "Gate 1 passed", "Gate 2" |
| Gate detail | Tooltip and sr text | `recordedAt`, `failed[]` | "Recorded by fleetmates gate at 13:02. The deck does not re-run gates." |

`status.phase` is never read (stale, fleetmates contract 3); the current phase is `run.derivedPhase` from git, polled slowly (state-machines 5.3).

### 4.3 Tasks column

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Heading | Eyebrow `h2` | `derivedPhase`, its task ids | "Phase 2 · tasks 3 to 7" | canvas "Build · tasks 3 to 7" |
| Task row | TaskRow | `plan.tasks[]` of the current phase joined with `status.tasks[]` and attributed requests | id "T3", title "Move verifyDelivery into packages/gate" | |
| Task sub | TaskRow sub | derived (4.3.1) | "merged · 4 files", "waiting on your approval (npm install, Caution)", "unblocked when T3 merged", "not started" | |
| Task crew | CrewAvatar sm with team hat | teammate seed `<repo>#<taskId>` (crew.md 5) | | absent for `pending` |
| Task state | StatePill `text` | 4.3.2 | "Done", "Needs approval", "Running", "Pending" | |
| Later heading | Eyebrow | | "Later phases" | |
| Later row | TaskRow `later` | tasks of phases after the current one | "T8 · Phase 3 · end-to-end test of fleetmates-gate check" / "after Gate 2" | |
| Gate summary | Banner `gate` | latest recorded gate + next gate | "Gate 1 passed at 13:02: plan parsed, 9 tasks, every claimed file found in a commit. Gate 2 runs when tasks 3 to 7 are merged." | TEAM-O2 for the checks sentence |

#### 4.3.1 Task sub line (Proposed)

| Condition (first match) | Sub |
|---|---|
| an open request is attributed to the task | "waiting on your approval ({summary short}, {tier})" or "waiting on your answer" |
| task branch merged into the run branch (derived) | "merged · {n} files" (`plan.tasks[].files.length`) |
| `status` state `blocked` with `blockedBy` | "blocked by {blockedBy}" |
| `running` with `startedAt` | "running {duration}" |
| `pending` and all `deps` merged | "unblocked when {deps} merged" becomes "ready" once merged; before: "waiting for {deps}" |
| `pending` | "not started" |
| `failed`, `orphaned`, unknown | "{state} · see fleetmates doctor" |

#### 4.3.2 Task state label (Proposed)

| Source | Label | Pill tokens |
|---|---|---|
| attributed permission request open | Needs approval | `state.needs-approval` |
| attributed question open | Asked you | `state.asked-you` |
| `status` `running` (or activity attributed in the last `staleMinutes`) | Running | `state.running` |
| `running` with no attributed activity for `staleMinutes` (liveness `stalled`) | No activity {n}m | `state.stale` |
| `done` | Done | `state.done` |
| `pending` | Pending | `state.idle` tokens (Proposed) |
| `blocked` | Blocked | `state.stale` tokens (Proposed) |
| `failed` | Failed | `state.crashed` tokens |
| `orphaned` | Orphaned | `state.crashed` tokens |
| anything else | Unknown | `state.ended` tokens |

These labels extend TaskRow's `state` type beyond `SessionState | 'pending'` (components TaskRow); add `blocked`, `failed`, `orphaned`, `unknown` there.

### 4.4 Crew activity panels

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Panel | `article` with header + TerminalTail `crew` (12 lines, `role="log"`, `aria-live="off"`) | one per worker: the lead session and each task with attributed activity in the current phase | |
| Header | CrewAvatar sm (team hat), who, task, StatePill `text` | lead: "lead" + its task id when known; teammate: task id | "lead · T6 · Running", "T4 · Needs approval" |
| Lines | TailLine tones | lead: its own hook steps (or PTY screen when available); teammate: hook tool steps attributed by worktree `cwd` via `.fleetmates/index/` (state-machines 11) | "● Write packages/gate/bin/cli.mjs", "● Wants to run a command", "$ npm install commander@14 -w packages/gate", "Caution: adds a dependency" |

Teammate panels show tool steps only; assistant prose lines ("Ported 14 tests") are not available from hooks (TEAM-O6). Headless teammates (`dispatch`) read `sessions/<taskId>.stream.jsonl` instead (Proposed).

## 5. States

| State | What shows |
|---|---|
| Loading | header renders from the snapshot; phases section shows a skeleton bar; tasks show 5 SkeletonCard `row`; worker panels show skeleton lines |
| Empty (run has no tasks in the current phase) | "No tasks in this phase." ; fully integrated run (`derivedPhase = null`): phases all done, tasks column shows "Run integrated. Every phase is merged." (Proposed) |
| `status.json` unreadable after 3 retries (state-machines 5.3) | Banner `error` under the header: "status.json could not be read: {error}. Retrying." Phases and tasks keep the last good data, dimmed, "as of 18:42" |
| `status.json` missing | "This run has no status.json yet. fleetmates init-run writes it." |
| Derive failed (repo not on the run branch, fleetmates contract 5) | phases show "Phase unknown: {phaseError}" and tasks fall back to `status.tasks` order without phase grouping |
| deckd down | lead panel from hooks only; Stop run disabled with "deckd is reconnecting" |
| Lead session unknown | pill computed from tasks only; "Review" still works through attributed requests (none without a lead); Stop run hidden |
| Overflow: many tasks | tasks column scrolls; later phases collapse to one line per phase "Phase 4 · 6 tasks" with a disclosure (Proposed) |
| Overflow: many phases (6+) | PhaseBar labels truncate to "P5"; full names in the sr text and tooltip |
| Overflow: long titles | TaskRow title 1 line ellipsis; sub 1 line |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| "All ships" / `Alt Esc` | Home | route |
| "Review 2 requests" | drawer filtered to the run, focus on its first request | UI (`?needs=run:<runId>`) |
| Task row with a request | same, focused on that task's request | UI |
| Task row otherwise | scrolls to and highlights its crew panel (Proposed; D-69 sets where teammate links go) | client |
| Crew panel header | Focus on the lead session (teammates have no Focus, D-69) | route |
| "Open plan" | opens `plan.planPath` (TEAM-O5) | `POST /api/open { kind: 'runPlan', ref: { repoId, runId } }` (Proposed; D-57, kinds in [08-security.md](../08-security.md) 4.9) |
| "Stop run…" | confirm Dialog "Stop the fleetmates run gate-cli?" body "Stops the lead session. Teammates stop with it. Worktrees and branches stay; fleetmates never deletes runs." | `U.Stop` on the lead |
| Gate diamond focus or hover | Tooltip with recorded time and failed checks | client |

## 7. Real-time updates

| Event | Effect |
|---|---|
| `run.updated` (file watcher on `status.json` and `plan.json`, re-read with retry) | tasks, pill, gates |
| `run.derived` (slow poll of git derive, Proposed 30s) | phase statuses, current phase, later rows |
| `request.opened` / `closed` attributed to the run | task states, header Review count, pill |
| `session.steps` of the lead, attributed teammate steps | crew panels append lines |
| Animation | bar fills 280ms width transition; task state changes 200ms colour; no reordering of task rows (plan order is stable) |

## 8. Accessibility

- h1 run title; sections labelled "Phases", "Current phase tasks", "Crew activity".
- PhaseBar is an `ol` of phases and gates with full text ("Phase 2, active: tasks 3 to 7, 1 done, 2 need you, 1 running"; "Gate 1 passed, recorded 13:02"); bars `aria-hidden`.
- Task rows are links or buttons named "T4 CLI entry: fleetmates-gate check, Needs approval".
- Crew panels are `role="log"` with `aria-live="off"`; AppShell announces requests.
- Stop run confirm focuses Cancel first.

## 9. Copy deck

| Key | EN |
|---|---|
| `team.back` | All ships |
| `team.pill` | {needs} of {total} need you |
| `team.elapsed` | running {duration} |
| `team.review` | {n, plural, one {Review # request} other {Review # requests}} |
| `team.openPlan` | Open plan |
| `team.stopRun` | Stop run… |
| `team.stop.title` | Stop the fleetmates run {runId}? |
| `team.stop.body` | Stops the lead session. Teammates stop with it. Worktrees and branches stay; fleetmates never deletes runs. |
| `team.stop.confirm` | Stop run |
| `team.phase.name` | Phase {n} |
| `team.phase.sub.range` | tasks {from} to {to} |
| `team.phase.sub.single` | task {id} |
| `team.phase.sub.done` | done |
| `team.phase.sub.mix` | {done} done, {needs} need you, {running} running |
| `team.gate.name` | Gate {n} |
| `team.gate.passed` | Gate {n} passed |
| `team.gate.failed` | Gate {n} failed |
| `team.gate.checking` | Gate {n} · checking |
| `team.gate.tooltip` | Recorded by fleetmates gate at {time}. The deck does not re-run gates. |
| `team.tasks.heading` | Phase {n} · tasks {from} to {to} |
| `team.tasks.later` | Later phases |
| `team.tasks.laterAfter` | after Gate {n} |
| `team.task.sub.waitingApproval` | waiting on your approval ({summary}, {tier}) |
| `team.task.sub.waitingAnswer` | waiting on your answer |
| `team.task.sub.merged` | merged · {n, plural, one {# file} other {# files}} |
| `team.task.sub.blockedBy` | blocked by {id} |
| `team.task.sub.running` | running {duration} |
| `team.task.sub.waitingFor` | waiting for {ids} |
| `team.task.sub.ready` | ready |
| `team.task.sub.notStarted` | not started |
| `team.task.sub.other` | {state} · see fleetmates doctor |
| `team.task.state.pending` | Pending |
| `team.task.state.blocked` | Blocked |
| `team.task.state.failed` | Failed |
| `team.task.state.orphaned` | Orphaned |
| `team.task.state.unknown` | Unknown |
| `team.gateBanner.passed` | Gate {n} passed at {time}: {checks}. |
| `team.gateBanner.next` | Gate {n} runs when tasks {from} to {to} are merged. |
| `team.crew.lead` | lead |
| `team.crew.noProse` | Tool steps only. Teammate messages are not visible to the deck. |
| `team.empty.phase` | No tasks in this phase. |
| `team.integrated` | Run integrated. Every phase is merged. |
| `team.error.status` | status.json could not be read: {error}. Retrying. |
| `team.error.noStatus` | This run has no status.json yet. fleetmates init-run writes it. |
| `team.error.derive` | Phase unknown: {error} |
| `team.notFound` | This run is not on the deck. |
| `team.plan.label` | Plan |
| `team.plan.close` | Close |
| `team.plan.openInEditor` | Open in editor |
| `team.plan.loading` | Loading the plan |
| `team.plan.truncated` | The plan is longer than 256 KiB; the rest is not shown. |
| `team.plan.error` | Could not read the plan: {error} |
| `team.plan.openFailed` | Could not open the plan: {error} |
| `team.stop.deckdDown` | deckd is reconnecting |
| `team.stop.failed` | Could not stop the run: {message} |
| `team.subtitle.plan` | plan {path} |
| `team.phases.label` | Phases |
| `team.phase.short` | P{n} |
| `team.phase.status.done` | done |
| `team.phase.status.active` | active |
| `team.phase.status.pending` | pending |
| `team.phase.sr` | {name}, {status}: {detail} |
| `team.gate.sr` | {label}, recorded {time} |
| `team.tasks.label` | Current phase tasks |
| `team.task.verified` | Claimed by the teammate; verified by Gate {n} |
| `team.gateBanner.failed` | Gate {n} failed at {time}: failed: {checks}. |
| `team.crew.label` | Crew activity |
| `team.crew.empty` | No activity recorded yet. |
| `team.crew.loading` | Loading activity |
| `team.loading` | Loading the run |
| `team.asOf` | as of {time} |
| `team.error.plan` | plan.json could not be read: {error}. Retrying. |
| `team.error.deriveDefault` | the run branch could not be compared with the task branches |

## 10. Acceptance criteria

1. **Given** fixture `team` (the canvas run with 9 tasks, gate 1 PASS recorded at 13:02, `derivedPhase` 2), **when** opening the run, **then** the timeline shows 4 phases and 3 gates, Gate 1 "passed", Gate 2 pending, and the heading reads "Phase 2 · tasks 3 to 7".
2. **Given** `team`, **then** task rows read T3 Done, T4 Needs approval, T5 Needs approval, T6 Running, T7 Pending, and the header pill reads "2 of 4 need you".
3. **Given** `status.json` with `phase: 1` but git derive says 2, **then** the UI shows phase 2 as active (status.phase is ignored).
4. **Given** `status.json` replaced by invalid JSON, **then** after 3 retries the error banner appears and the last good data stays visible, dimmed.
5. **Given** a task state `failed`, **then** its row shows "Failed" with the crashed tokens and the sub "failed · see fleetmates doctor".
6. **Given** "Review 2 requests", **then** the drawer opens with only the run's two requests in view and focus on the T4 row.
7. **Given** 1280 wide, **then** crew panels stack in one column and the section scrolls; no horizontal page scroll.
8. **Given** a teammate hook event attributed to T5's worktree, **then** a line appends to the T5 panel within 1s and no other panel changes.
9. **Given** a task title containing HTML, **then** it renders as text.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| TEAM-O1 | Phase names (Plan, Build, Verify, Integrate) are not in fleetmates; phases are numbered. | **Open** (same as HOME-O2). Default "Phase N". |
| TEAM-O2 | Gate banner checks sentence ("plan parsed, 9 tasks, every claimed file found in a commit") is not stored: `status.gates` keeps `verdict`, `failed`, `pending`, `skipped`, not the check list or messages. | **Open**. Default: "Gate 1 passed at 13:02." plus "failed: {checks}" on FAIL. |
| TEAM-O3 | Run elapsed time: fleetmates stores no run start. | **Open**. Default: lead session `startedAt`, else earliest task `startedAt`, else hidden. |
| TEAM-O4 | Gate "checking" state: a running `fleetmates gate` is not observable from files. | **Open**. Default: never shown; only recorded verdicts. |
| TEAM-O5 | "Open plan": open in which app (editor, browser view, Obsidian)? | **Open**. Default: render the plan markdown read-only in a Drawer (sanitised). |
| TEAM-O6 | Teammate terminals: teammates are subagents without a PTY; only tool steps are attributable; prose and results are in harness-internal transcripts (not a public API). | **Open**. Default: tool steps only with the "Tool steps only" note. |
| TEAM-O7 | "lead" concept: fleetmates has none; the deck calls the orchestrator session `role = lead` (02-domain). Which task (if any) the lead works on is not recorded. | Proposed: show "lead" alone unless a task claim names the orchestrator. |
| TEAM-O8 | Task "Done" is a claim until a gate verifies it (fleetmates contract 6, risk 7). | Proposed: keep "Done"; tooltip "Claimed by the teammate; verified by Gate {n}" once a later PASS is recorded. |

## 12. Changes from the canvas

1. "teammate 1/2/3" and "task 3/4/5" become task ids (T3, T4, T5); task numbers show as "T3" not "3".
2. Phase names become "Phase N"; the en dash ranges "tasks 1 to 2" use the word "to" (design-system 14).
3. Task state "Needs you" becomes the literal pill "Needs approval" (or "Asked you").
4. Crew terminal prose lines are dropped for teammates (TEAM-O6).
5. Gate banner copy shortened until TEAM-O2 is decided.
6. Header "Review 2 requests" pluralises; "running 1h 12m" hides when no start time exists.
7. Task column 620 becomes 600 (`--layout-panel-md`, design-system 14).
