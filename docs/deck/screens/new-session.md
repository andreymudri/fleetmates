# New session (launch form)

| | |
|---|---|
| Canvas board | none: not on the canvas. Specified from D-17 ("new-session form asks only for a repo picked from a scan of ~/dev plus a task field"; same-repo warning) and state-machines 1.7 row 1. |
| Route | `/new` (dialog over the previous route; query `repo=<repoKey>`, `task=<text>`) |
| Milestone | M2 |
| Status | **Proposed** as a whole. The two fields and "warn, never block" are Decided direction; everything else is this spec's recommendation. Same-repo behaviour is Decided (D-68). |

## 1. Purpose

Answers **"Start Claude Code on this repo with this task, now."** Two fields, nothing else: no permission mode, no model, no worktree option (Decided: worktrees belong to the job, D-17).

## 2. Route and entry points

| Entry | Prefill |
|---|---|
| `Alt N` anywhere (keyboard.md 2), Home "Launch a ship", HomeCalm hero, Focus list "Launch a ship" | none |
| HomeCalm recent harbor chip, Palette "Launch a ship in rustot", `> launch rustot` | `repo` |
| Meetings and HomeCalm "Launch as session" (MEET-O6) | `task` = action item text |

`/new` renders over the route it was opened from; a direct load renders over `/`. Close returns to that route.

## 3. Layout

Dialog `variant="form"` (`--layout-dialog`, `--radius-3xl`), top 110px, scrim. Stack: title + subtitle, Repo field (combobox with a result list), same-repo Banner (conditional), Task field, footer (note left, Cancel + Launch right).

| Width | Behaviour |
|---|---|
| 1920, 1440, 1280 | same 700px dialog; the repo list shows at most 8 rows and scrolls |
| Height under 800 | dialog body scrolls; footer stays |

## 4. Content inventory

| Element | Component | Data binding | Copy (EN) | Notes |
|---|---|---|---|---|
| Title | Dialog title | | "Launch a ship" | themed form dialog title (components Dialog allows it) |
| Subtitle | Dialog description | | "Pick a repo and say what to do. The session starts in its own terminal and shows up on the Sessions grid." | |
| Repo | Field combobox (TextInput `lg` + listbox), required | `GET /api/repos`: repos found by scanning `config.scanRoot` (`~/dev`, Decided) for git roots, worktrees resolved to their main repo | label "Repo", placeholder "Search repos in ~/dev" | initial focus when `repo` is not prefilled |
| Repo option | ListRow `option`: CrewAvatar sm pose none, name, mono path, trailing active count | `repo.name`, `repo.id` with `~`, current branch (git), active plain sessions count | "rustot", "~/dev/rustot · combat-tick", "1 active" | recent repos first (by latest session), then alphabetical |
| Recent group | Eyebrow in the list | 5 most recent repos | "Recent harbors" | shown with an empty query |
| Same-repo warning | Banner `hint` (warn, never block) | other sessions with the same `repoId`, `role = solo`, not `ended` | "rustot already has an active session: rustot · combat-tick (Needs approval). Two plain sessions share one working tree, so their changes mix." | lists up to 2 sessions, then "and {n} more" |
| Warning action | Button `teal-outline sm` | | "Run as a fleetmates job" | behaviour Decided (D-68) |
| Warning link | link | the other session | "Open rustot · combat-tick" | |
| Task | Field Textarea (rows 4), optional | `task` | label "Task", hint "optional", placeholder "What should Claude do? Leave empty to start at the prompt." | sent as the initial prompt (`claude "<task>"`, state-machines 1.6) |
| Footer note | text muted | | "Runs claude in {path} · you can type in the terminal or here" | |
| Cancel | Button `secondary lg` | | "Cancel" | |
| Launch | Button `primary lg` + Kbd | | "Launch a ship" + `Alt Enter` | Proposed chord, consistent with the research form; added to [keyboard.md](../interaction/keyboard.md) section 3 |

## 5. States

| State | What shows |
|---|---|
| Loading repos | listbox shows 4 ListRow skeletons; the field is usable (typing filters when the list arrives) |
| Empty scan | list shows "No git repos found in ~/dev." + "Change the repos folder" (link to Settings, Connections) |
| No match | "No repo matches \"{q}\"." |
| Scan root missing | Banner `error` in the form: "The repos folder ~/dev does not exist." + "Fix in Settings" |
| Repo selected, no conflict | no banner |
| Repo selected, conflict | same-repo Banner (4); Launch stays enabled (never block) |
| Validation | submit without a repo: Field error "Pick a repo." |
| Submitting | Launch `loading`; fields read-only |
| deckd down | Launch disabled with visible reason "deckd is reconnecting. Launching needs deckd." (state-machines 4.2) |
| Hooks not installed | Banner `hint`: "Observation hooks are not installed, so the deck will only see this session through its terminal." Launch allowed |
| Spawn failed | Banner `error` at the top of the form: "Could not start claude in rustot: {message}." inputs kept, focus on the banner |
| Success | dialog closes; route `/s/:newId` with the terminal focused (Proposed); the new card fades in on Home |
| Overflow | long repo paths middle-truncate; 200+ repos: the list virtualises (Proposed) |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Type in Repo | filters options (name and path, substring + word prefix) | client |
| Up / Down, Enter in the repo list | move and pick | combobox pattern |
| Pick a repo | task field focused; conflict check | `GET /api/repos/:repoKey/sessions?active=1` |
| "Run as a fleetmates job" | D-68: launch the session with the task wrapped as a fleetmates request | `POST /api/sessions {repoKey, task, mode:'fleetmates'}` |
| "Open rustot · combat-tick" | Focus on that session; form closes | route |
| "Launch a ship", `Alt Enter` | validate, launch | `POST /api/sessions {repoKey, task}` = `U.Launch(repo, task)` (state-machines 1.7 row 1) |
| Enter in Task | new line (Textarea); `Alt Enter` submits | |
| "Cancel", Esc | close; inputs kept in sessionStorage for 10 minutes (same rule as the research form) | client |

## 7. Real-time updates

`session.upserted` for any session in the selected repo updates the conflict banner while the form is open (for example the other session ends: the banner leaves). `health.changed` (deckd) toggles the Launch disabled state.

## 8. Accessibility

- `role="dialog"` + `aria-modal`, labelled by the title, described by the subtitle; focus trap; initial focus on Repo (or Task when `repo` is prefilled); Esc closes; focus returns to the trigger.
- Repo field: WAI-ARIA combobox with `aria-activedescendant`; options named "rustot, ~/dev/rustot, 1 active session".
- The conflict banner is `role="status"` so it is announced once when it appears.
- Disabled Launch keeps its reason visible.

## 9. Copy deck

| Key | EN |
|---|---|
| `newSession.title` | Launch a ship |
| `newSession.subtitle` | Pick a repo and say what to do. The session starts in its own terminal and shows up on the Sessions grid. |
| `newSession.repo` | Repo |
| `newSession.repo.placeholder` | Search repos in {root} |
| `newSession.repo.recent` | Recent harbors |
| `newSession.repo.active` | {n} active |
| `newSession.repo.active.a11y` | {n, plural, one {# active session} other {# active sessions}} |
| `newSession.repo.error` | Pick a repo. |
| `newSession.repo.empty` | No git repos found in {root}. |
| `newSession.repo.changeRoot` | Change the repos folder |
| `newSession.repo.noMatch` | No repo matches "{q}". |
| `newSession.repo.rootMissing` | The repos folder {root} does not exist. |
| `newSession.fixInSettings` | Fix in Settings |
| `newSession.conflict` | {repo} already has an active session: {sessions}. Two plain sessions share one working tree, so their changes mix. |
| `newSession.conflict.session` | {repo} · {task} ({state}) |
| `newSession.conflict.more` | and {n} more |
| `newSession.conflict.fleetmates` | Run as a fleetmates job |
| `newSession.conflict.open` | Open {repo} · {task} |
| `newSession.task` | Task |
| `newSession.task.hint` | optional |
| `newSession.task.placeholder` | What should Claude do? Leave empty to start at the prompt. |
| `newSession.footer` | Runs claude in {path} · you can type in the terminal or here |
| `newSession.cancel` | Cancel |
| `newSession.launch` | Launch a ship |
| `newSession.deckdDown` | deckd is reconnecting. Launching needs deckd. |
| `newSession.noHooks` | Observation hooks are not installed, so the deck will only see this session through its terminal. |
| `newSession.spawnError` | Could not start claude in {repo}: {message}. |

## 10. Acceptance criteria

1. **Given** Home, **when** pressing `Alt N`, **then** the dialog opens with the Repo combobox focused and "Recent harbors" listed first.
2. **Given** `/new?repo=rustot`, **then** rustot is selected and the Task field is focused.
3. **Given** rustot has an active plain session, **when** selecting rustot, **then** the conflict banner names "rustot · combat-tick (Needs approval)" and Launch stays enabled.
4. **Given** a valid form, **when** pressing `Alt Enter`, **then** `POST /api/sessions` carries `repoKey` and `task`, the dialog closes, the route becomes `/s/<new id>` and the terminal has focus.
5. **Given** an empty Task, **then** the launch is allowed and the session ends up `idle` after `SessionStart` (state-machines row 5).
6. **Given** fixture `deckdDown`, **then** Launch is disabled with the visible text "deckd is reconnecting. Launching needs deckd."
7. **Given** a spawn error, **then** the error banner shows the message and the inputs keep their values.
8. **Given** Esc and reopening within 10 minutes, **then** the previous repo and task are restored.
9. **Given** a repo name containing markup characters, **then** it renders as text.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| NEW-O1 | Same-repo second plain session and the "Run as a fleetmates job" behaviour (Q3, SM-O5). | **Decided** (D-68): warn, never block; the button launches a `launched` session whose initial prompt asks Claude to handle the task as a fleetmates run (fleetmates makes per-task worktrees, so changes do not mix). |
| NEW-O2 | Scan depth and what counts as a repo under `~/dev` (direct children only, nested repos, submodules). | **Open**. Default: direct children of the scan root that are git roots, plus repos already known from hooks anywhere. |
| NEW-O3 | Themed "Launch a ship" (design-system 15.1). | Open. |
| NEW-O5 | After launch: go to Focus or stay on the current screen. | Proposed: Focus with the terminal focused. |

The launch submit chord (`Alt Enter`) was a gap here; it is now added to [keyboard.md](../interaction/keyboard.md) section 3.

## 12. Changes from the canvas

Not on the canvas. HomeCalm drew the "Launch a ship" button with `Alt N` and the recent harbor chips that open this form.
