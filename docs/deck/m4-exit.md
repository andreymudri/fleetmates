# M4 exit report (Meetings)

Status: **code ready, milestone not complete.** The suites below were run on 2026-10-04 on the
integrated M4 tree (run branch `run/deck-m4` at `8c988e7`, phases 1 to 5 of run deck-m4a, plus this
task's version, build label and documentation changes). Exit criterion 1 is owner-pending because
TurbidAssist has no fixture exporter, and exit criterion 5 needs the owner and real meetings; both
are PENDING. So are the "M4 before exit" defaults, the restart of the dogfood web server and the tag
and publication of `deck-v0.4.0`. None of them is claimed here.

Exit criteria from [12-milestones.md](12-milestones.md) section 6:

| # | Criterion | State |
|---|---|---|
| 1 | scribed contract tests green against fixtures exported from the current TurbidAssist commit | PENDING (owner). The contract tests are green on the hand-copied `d4ffb9d` set with the placeholder tag `acme` (section 1.1); TurbidAssist has no exporter (D-108, owner, 2026-10-04) |
| 2 | With fake scribed: start, recording, a `stop` taking 30 s, post-states through `synthesized`; socket loss mid-recording; scribed down keeps past meetings listed | Green (section 1.1) |
| 3 | Confidential tag: zero sentinel transcript strings in the database, WAL, logs and spool (automated) | Green (section 1.1) |
| 4 | Quiet mode: during a recording, requests produce popups and no bell (integration test with the notify and `pw-play` shims) | Green (section 1.1) |
| 5 | Manual: three real meetings recorded end to end from the deck, at least one with a confidential tag; a web server restart during a recording does not stop it (OPS-O1) | PENDING (owner). Log template in section 8 |

## 1. Test suites

Run from the task worktree on 2026-10-04. The hub suites need `npm ci --prefix hub` first and a
short `TMPDIR`, because Unix socket paths are limited to about 108 bytes. The e2e specs run against
the built app (`npm --prefix hub run build`; `hub/web/dist` was deleted afterwards).

| Suite | Command | Result |
|---|---|---|
| Root (fleetmates) | `npm test` | 2796 tests, 2779 pass, 0 fail, 17 skipped |
| Hub | `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test` | 1707 tests, 1707 pass, 0 fail, 0 skipped, 0 todo (1706 at `8c988e7`; this task drops two tests from `m3-release.test.mjs` and adds three in `m4-release.test.mjs`) |
| Meetings e2e (M4) | `TMPDIR=/tmp/hx timeout 600 node --test --test-concurrency=1 test/e2e/meetings.spec.mjs` from `hub/` | 19 tests, 19 pass, 0 todo |
| Security e2e | same, `test/e2e/security.spec.mjs` | 18 tests, 18 pass, 0 todo |
| Accessibility e2e | same, `test/e2e/accessibility.spec.mjs` | 23 tests, 23 pass, 0 todo |
| Unblock, observe, control, settings-save and archive e2e | same, the five specs in one call | 84 tests, 84 pass, 0 todo |
| Exit criteria subset | `TMPDIR=/tmp/hx node --test test/contract/scribed.test.mjs test/integration/meetings-exit.test.mjs test/integration/meetings-confidential.test.mjs test/integration/meetings-quiet.test.mjs` from `hub/` | 25 tests, 25 pass (also inside the hub run above) |

Notes:

- The e2e specs are not part of `npm --prefix hub test`, and the hub suite is not in CI yet.
- Never run a bare `node --test` in this repository: its default glob includes
  `hub/test/capture/capture-cc.mjs`, which starts real Claude Code. No real Claude Code, scribed,
  `systemd-run`, `systemctl`, `notify-send`, `pw-play` or `xdg-open` ran in any of these suites; the
  tests use the fake scribed (`hub/test/fakes/fake-scribed.mjs`) and shims (section 3).
- Load flakes seen during the run (section 9) did not occur in these runs.

### 1.1 Exit criteria 1 to 4: the evidence

Exit criterion 1 (contract tests): `hub/test/contract/scribed.test.mjs`, 16 tests, green on
`hub/test/fixtures/scribed/d4ffb9d/`. Its `MANIFEST.json` says `"exporter": null` and
`"method": "hand-copied, reviewed"`: the lines were serialized with `Message.encode()` of
`protocol.py` at `d4ffb9d` by a throwaway script, and the tag value was replaced with the placeholder
`acme` on 2026-10-04 (D-111; "fixtures use placeholder tags only" checks it). Commands are checked as
JSON that parses equal with raw UTF-8 (D-120), and an unknown event type is ignored and counted
(D-110). The criterion asks for fixtures exported from the current TurbidAssist commit; TurbidAssist
at `d4ffb9d` has no exporter (`scripts/export_protocol_fixtures.py` does not exist yet, D-108), and
the fleet never touches TurbidAssist, so the criterion stays owner-pending (owner, 2026-10-04).

Exit criterion 2 (fake scribed): `hub/test/integration/meetings-exit.test.mjs`:

- "a recording through the API streams meeting.transcript, a stop answered after 30 s stays
  stopping, and recorded, transcribed, synthesized arrive in order with the note path last";
- "subscribers ended mid-recording: lines appended to transcript.jsonl reach the client with
  meeting.recovered" (socket loss mid-recording);
- "with the fake stopped and its socket removed, GET /api/meetings still lists every past meeting and
  the recorder is unavailable".

The browser side is in `meetings.spec.mjs` "meetings AC4" (start), "meetings AC8" (a stop that says
"Still stopping" after 60 s), "meetings AC10" and "failures-and-loading AC6" (scribed down).

Exit criterion 3 (confidential): `hub/test/integration/meetings-confidential.test.mjs` "client-a: a
recorded, pinned, asked, searched, read and synthesized meeting and a spooled hook leave zero
sentinel hits" and "pessoal: the same leaves zero sentinel hits except the pin labels in deck.db".
They grep the database, its WAL, the server's stdout and stderr (M4 has no debug log, D-121) and the
spool. In the browser: `meetings.spec.mjs` "meetings AC9" and `security.spec.mjs` "confidential live
meeting (M4): browser storage and the Cache API hold no sentinel, and every meeting.transcript frame
is ephemeral".

Exit criterion 4 (quiet mode): `hub/test/integration/meetings-quiet.test.mjs` "a deck recording
quiets the chime but not the popup; after the stop nothing rings late, and a new session rings
once", "a recording another client started quiets the chime within one poll, and nothing rings when
it ends" and "with quietInMeetings false a request during a recording rings", with the
`notify-send` and `pw-play` shims. In the browser: `meetings.spec.mjs` "meetings AC6".

## 2. The run: phases, tasks and gate verdicts

Read for this report: the review rounds and gate files under `.fleetmates/deck-m4a/handoff/`
(gitignored run state) and `status.json`.

| Phase | Tasks | Gate |
|---|---|---|
| 1 | T1 docs, T2 scribed client, T4 config reader, T5 migration 0005 and store, T6 history and note, T12 web plumbing | Review rounds 0 to 4; PASS (`gate-phase1.json`) |
| 2 | T3 contract fixtures, T7 recorder, T8 post-watch, T9 start scribed, T10 ask, T13 Meetings screens, T14 live view and recording bar | FAIL on review in round 0, PASS in round 1 |
| 3 | T11 meeting routes and server wiring, T15 screen registration, Home "Last meeting", Settings status | PASS in rounds 0 and 1 |
| 4 | T16 exit-criteria integration tests, T17 e2e, security and accessibility evidence | PASS in round 0 |
| 5 | T19, T20 (fix tasks for Task 17's findings) | PASS in rounds 0 and 1 |
| 6 | T18 (this task) | not gated yet |

Plan amendments during the run: `8f81a34` (Task 11 test line), `d2d0575` (Task 15 screen-list
assertions), `0c29119` (Task 11 `m1-server-fixes` health rows), `e7c6238` (Tasks 19 and 20) and
`51f1d69` (Task 19 file set).

## 3. Incident: a test mutation reached the real scribed

On 2026-10-04, during Task 9, a test mutation that passed `process.env` through reached the real
`systemd-run` and started the owner's real scribed as the user unit `turbidassist-scribed`. The
orchestrator stopped it with the owner's OK. After that, every test that could reach a host binary
injects the spawn function or runs shims by absolute path, and child servers and Chromium run with no
session bus, display, agent or token variables (`meetings.spec.mjs` "host isolation: every host
binary resolves to its shim, and no session bus, display, agent or token reaches a child", and "the
shims are what a test resolves for every host binary" in the integration files). No other host
binary ran for real in the run, according to the run ledger; this task ran none.

## 4. Accessibility audit and the fix tasks

Task 17 audited the Meetings list, the detail, the Full transcript drawer, the open tag menu, the live
view, the recording bar and the degraded card with axe and the keyboard. Findings and their fix tasks
(added by amending the plan after Task 17, as in M2 and M3):

| Id | Severity | Finding | State |
|---|---|---|---|
| M4-T17-F1 | S2 | While recording, the Rail shrank by 16 px instead of the bar height and the shell overflowed the viewport by 25 px (content-box Rail with 12 px padding; a 41 px bar against a 40 px token) | Fixed by Task 19: border-box bar of exactly `--layout-rec-bar`, Rail height minus its padding ("rail-and-shell AC6: while recording the Rail is 40 px shorter and the shell fits the viewport") |
| M4-T17-F2 | S2 | U+202E, ESC and BEL in meeting text reached the DOM raw on the list, the detail, the transcript drawer and the live view | Fixed by Task 20 (those surfaces through `titleText` inside `<bdi>`) and by Task 19 for the recording bar title and Home "Last meeting" (plan amendment `51f1d69`); "untrusted text (M4): escape, bell and bidi controls in meeting text never reach the DOM raw" |
| M4-T17-F3 | S3 | axe `landmark-main-is-top-level`, `landmark-no-duplicate-main`, `landmark-unique`: the Meetings detail pane was a second `main` | Fixed by Task 20: the shell's `main#main` is the only main |
| M4-T17-F4 | S3 | axe `region`: with the recording bar showing, the skip link and the bar sat outside every landmark | Fixed by Task 19: the bar is a region labelled "Recording" that holds the skip link as its first child |

`meetings.spec.mjs`, `security.spec.mjs` and `accessibility.spec.mjs` hold no todo test (0 todo in
the runs above). The Orca smoke on the new surfaces is PENDING (section 8).

## 5. Release preparation

- Version 0.4.0 in `hub/package.json` (still `"private": true`) and in the two root entries of
  `hub/package-lock.json`. `hub/CHANGELOG.md` has the `v0.4.0` entry: tested Claude Code 2.1.285
  (unchanged), "deckd changed: no", "Database migration: yes (`0005-meetings` ...)", and that a web
  server restart is needed to pick M4 up.
- Build label: `GET /api/version` reports `build: 'm4'` and `BUILD` in `hub/web/src/state/api.js` is
  `'m4'`. Assertions updated: the two `hello` builds and the reload-guard key
  (`fleetmates-deck.reloaded.m4`) in `web-shell.test.mjs`, the `/api/version` body in
  `m1-web-fixes.test.mjs`. `m3-release.test.mjs` keeps its CHANGELOG check ("the 0.3.0 CHANGELOG entry
  says deckd changed") and drops its version and build tests, which `m4-release.test.mjs` takes over
  (the version equals the newest CHANGELOG heading and stays private; the 0.4.0 entry says "deckd
  changed: no" and names `0005-meetings`; `GET /api/version` reports the newest CHANGELOG version with
  `build: 'm4'`).
- Mutations: with the CHANGELOG heading changed to `v0.4.1`, `m4-release.test.mjs` failed 3 of 3
  (`'0.4.1' !== '0.4.0'`); restored, 3 of 3 pass. With the build label reverted to `'m3'` in
  `api.mjs` and `api.js`, four tests failed: the `/api/version` test of `m4-release.test.mjs`, "the
  REST client hands screens the bare body the real deck server sends" of `m1-web-fixes.test.mjs`, and
  "reconnect sends lastSeq and epoch ..." and "heartbeat silence reconnects ..." of
  `web-shell.test.mjs`; restored, they pass.
- README: Meetings, where the deck finds `config.yaml`, "Start scribed" and its `systemd-run` unit,
  quiet mode, the confidential rules and the M4 limits (transcript-only ask, deck-only pins, no
  speaker naming, notes read from disk).
- Publication: PENDING. Tag `deck-v0.4.0` and publish only after this report, the owner checks and Q1.

## 6. Spec deviations recorded

What the build added beyond Task 1's corrections, and the rules Task 1 wrote that the build did not
follow, each corrected in the doc named:

- `POST /api/meetings/start` after a start timeout answers 202 with the recorder `idle`, not
  `starting`; the next poll decides and the screen says scribed did not confirm. Task 1 wrote
  `starting` in [05-api.md](05-api.md) 2.11 and D-117; both corrected. The build follows
  [interaction/state-machines.md](interaction/state-machines.md) 6.3 row 7, which already moves
  `starting` to `idle` on the start timeout.
- The recorder's busy error is 409 `invalid_state` with `details.state` while `starting`, `recording`
  or `stopping` ([05-api.md](05-api.md) 2.11, D-117).
- The meeting kinds of `POST /api/open` (`meetingNote`, `postmeetLog`) answer 422
  `validation_failed` with `details.reason: 'kind_not_available'` without a readable `config.yaml`
  ([05-api.md](05-api.md) 2.11, [08-security.md](08-security.md) 4.9).
- `GET /api/meetings` returns `{ meetings, recorder, tags, model, configError, configPath }`, and the
  detail `{ meeting (with title, stuck, logAt), note (with title, items with dismissed), pins,
  speakers (an array of names), model, asks (only while that meeting records) }`
  ([05-api.md](05-api.md) 2.11). `MeetingListItem` gains `interrupted`, `title` may be null and
  `TranscriptLine` may carry `asrModel` ([05-api.md](05-api.md) 7).
- Search answers `{ hits, meetingCount, partial }` with `ranges` on every hit and one JSON body, not
  pages ([05-api.md](05-api.md) 2.11, [11-meetings.md](11-meetings.md) 14, which also named
  `offsetSeconds` and `textRange`). Search reads `transcript.json` first, then `transcript.md`, then
  `transcript.jsonl`.
- The ephemeral `meeting.recovered` event, and `ephemeral: true` on `meeting.transcript`,
  `meeting.recovered` and the three ask events ([05-api.md](05-api.md) 3.4); `scribed_unavailable`
  is retryable ([05-api.md](05-api.md) 4).
- The hook guard keeps the last good `session_dir` when `config.yaml` stops reading, and the server
  without `XDG_RUNTIME_DIR` never falls back to another socket ([04-integrations.md](04-integrations.md)
  4.2).
- The ask cancel route stays M5: "Stop" keeps the composer busy until the stopped answer ends
  ([05-api.md](05-api.md) 2.11, [11-meetings.md](11-meetings.md) 9.1).
- The recording bar is a labelled region holding the skip link while it shows, not `role="status"`
  ([screens/meetings.md](screens/meetings.md) 8, [screens/rail-and-shell.md](screens/rail-and-shell.md)
  4.2 and 8).
- A pin's label comes from the ring line whose `t0` equals the sent `t`, else the newest line
  ([05-api.md](05-api.md) 2.11, [11-meetings.md](11-meetings.md) 10.1).
- "Recording interrupted" also needs more than an hour without a write in the session directory
  ([11-meetings.md](11-meetings.md) 11.1).
- [06-storage.md](06-storage.md) 4.9 and 7: migration `0005-meetings.sql` as built.
- [08-security.md](08-security.md) 4.8, 4.9 and 4.12: the `systemd-run` environment, the open kinds,
  confidentiality that only rises, the no-op meeting log sink and the neutralised meeting text.
- [09-testing.md](09-testing.md) 11.1: the M4 security tests that exist.
- [13-operations.md](13-operations.md) 3.3: "Start scribed" as built and how to inspect the
  `turbidassist-scribed` transient unit.
- [14-decisions.md](14-decisions.md): D-112 to D-124 say "shipped in 0.4.0"; D-117 corrected.
- [15-open-questions.md](15-open-questions.md), [11-meetings.md](11-meetings.md) 17,
  [04-integrations.md](04-integrations.md) 4.3 and [screens/meetings.md](screens/meetings.md) 11:
  MEET-O1, O2, O3, O5, O6, O8, HOME-O8, Q6, SM-O14, MTG-O1, MTG-O4 and DB-O2 read "Default shipped in
  0.4.0", still the owner's.
- Copy decks: [screens/meetings.md](screens/meetings.md) gained `meetings.tag.option`,
  `meetings.post.interrupted` ("Recording interrupted"), `meetings.duration`, `meetings.drawer.close`,
  `meetings.toast.dismiss`, `meetings.ask.stop`, `meetings.ask.stopped` ("Stopped here; the answer may
  still be saved to the meeting") and `meetings.ask.retry`; [screens/settings.md](screens/settings.md)
  gained `settings.conn.turbid.missing` and `settings.conn.turbid.read` ("Read {n} tags from
  {path}."); [screens/home.md](screens/home.md) already held the four `home.calm.meeting.*` strings
  and got an as-built note; [screens/rail-and-shell.md](screens/rail-and-shell.md) got the recording
  bar as built. Checked with a script that reads each screen's `*_COPY` object in `hub/web/src` and
  looks for every string in the screen's copy deck: every M4 string is now in a deck (the `fail.*`
  strings of `Meetings.jsx` are in [screens/failures-and-loading.md](screens/failures-and-loading.md),
  the recording bar strings in [screens/meetings.md](screens/meetings.md)).

## 7. Owner decisions

Recorded in [14-decisions.md](14-decisions.md) section 1 as D-104 to D-111 (owner, 2026-10-04, two
rounds while the plan was drafted) and D-112 to D-124 (plan decisions, owner may revisit before exit):

- MS-O2 gate WAIVED (D-104): M4 started after M3 without the M1 one-week test. The M1 dogfood week
  is still PENDING in [m1-exit.md](m1-exit.md); M4 does not claim it.
- MEET-O4 (D-105): the live ask is scribed's `ask`, transcript only, no citations.
- OPS-O1, SM-O13, MEET-O10, FAIL-O1, FR-O2 (D-106): "Start scribed" runs the `systemd-run` command.
- MEET-O11 (D-107): the Settings field "TurbidAssist config", default `~/dev/turbidassist/config.yaml`
  when present. The owner's checkout is not at the default, so the owner sets the field.
- TEST-O3, MTG-O3 (D-108): the exporter belongs in TurbidAssist; none exists, so exit criterion 1 is
  owner-pending.
- MEET-O7 (D-109): confidential meetings are searched on demand, never indexed, cached or persisted.
- D-110: protocol limits of 1 MiB per line, 16 MiB for a `tail` answer, unknown event types ignored
  and counted.
- D-111: the placeholder tag `acme` in the hub scribed fixtures; git history is not rewritten.
- Standing: run autonomously with extra fix rounds while medium or high findings remain; ask the
  owner for design decisions, dogfood updates and deckd restarts.

## 8. Owner checks still PENDING, and the exit criterion 5 log template

| Check | Reference |
|---|---|
| Exit criterion 1: add the fixture exporter to TurbidAssist (`scripts/export_protocol_fixtures.py`), export from the current commit into `hub/test/fixtures/scribed/<sha>/` with placeholder tags, and run `test/contract/scribed.test.mjs` on it | D-108, [11-meetings.md](11-meetings.md) 15 and 16 (T0) |
| Exit criterion 5: three real meetings from the deck, one confidential, and a web server restart during one recording | Template below |
| Restart the dogfood web server to pick up M4 (deckd unchanged, so no PTY session ends; migration `0005-meetings` runs on start with a `deck.db.pre-0005.bak` backup) and set Settings, Connections, "TurbidAssist config.yaml" to the real checkout | [13-operations.md](13-operations.md) section 4 |
| "M4 before exit" defaults with what shipped: MEET-O1 (`routed_apps` seen while polling), MEET-O2 (deck-only pins), MEET-O3 ("{Tag} · started {time}"), MEET-O5 ("Listening…" after 5 s), MEET-O6, HOME-O8 and Q6 (Launch as session and Dismiss; no Research first), MEET-O8 (no Save button, the muted line), SM-O14 (`postmeet name` hint), MTG-O1 (notes from disk), MTG-O2 (2 s poll), MTG-O4 (deck-only item state), DB-O2 (unknown tag is confidential) | [15-open-questions.md](15-open-questions.md), [12-milestones.md](12-milestones.md) section 9 "M4" |
| Plan decisions D-112 to D-124 | [14-decisions.md](14-decisions.md) |
| Pre-migration backups and a confidential rise (section 9, the first finding) | [06-storage.md](06-storage.md) 4.9 |
| Orca screen reader smoke on Meetings, the live view and the recording bar | [09-testing.md](09-testing.md) section 11.2 |
| M1 dogfood week: still PENDING; waived as a gate for M4 only | [m1-exit.md](m1-exit.md) |
| Tag `deck-v0.4.0` and publish | PENDING, after this report and Q1 (`"private": true`) |

Copy to `docs/deck/dogfood/<yyyy-mm-dd>-m4.md` and fill in one block per meeting. The criterion
passes with three meetings recorded end to end from the deck, at least one with a confidential tag,
and one web server restart during a recording that leaves the recording running.

    # M4 exit criterion 5, <start date> to <end date>

    Build: deck <version or commit>, deckd <version from fleetmates-deck doctor>
    TurbidAssist: <commit>; config.yaml path set in Settings: <yes / no>

    ## Meeting N, <weekday yyyy-mm-dd hh:mm>

    Tag: <tag> (confidential: <yes / no>)
    Started from: <deck Record / other client>; source apps shown: <list or none>
    Live transcript in the deck: <yes / no>; pins: <n>; asks: <n>, answered: <n>
    Web server restarted during the recording: <no / yes at hh:mm>
      If yes: recording still running after the restart (scribe status / deck bar): <yes / NO>
      `systemctl --user status turbidassist-scribed` showed the unit running: <yes / no>
    Stop from the deck: <hh:mm>; "Still stopping" shown: <yes / no>
    Post states seen: <recorded, transcribed, awaiting_names, synthesized>
    Note found and shown in the detail: <yes / no>; action items: <n>
    Confidential only: `sqlite3 deck.db` and the WAL hold no transcript, ask or pin text: <checked / not checked>
    Bugs filed (severity): <none or list>
    Result: <pass / fail, why>

    ## Summary

    Meetings: <n> of 3; confidential: <n, at least 1>; restart during a recording: <done / not done>
    Verdict: <passed / not passed>

Meetings 1 to 3: PENDING.

## 9. Open findings

The non-blocking review findings carried from phases 1 to 5, handed over by the orchestrator with
file and line at the run tip (`8c988e7`). Severity is the reviewer's. This task did not re-run
them, except where the State column says so.

### Security and confidentiality

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `hub/server/db/index.mjs:31-37,63` | The pre-migration backups (`deck.db.pre-NNNN.bak`, `VACUUM INTO` before each migration) keep the pin labels and the title-bearing `note_path` of a meeting that becomes confidential after the backup, until three newer backups rotate it out | Open, owner decision before or in M5: scrub or delete the backups on a confidential rise, or document the exception in 08-security 4.12. Documented as a known limit in 06-storage 4.9 |
| Low | `hub/server/meetings/store.mjs` (checkpoint after a confidential rise) | A concurrent read snapshot (the audit CLI) can block the `TRUNCATE` checkpoint, so a scrubbed label stays in the WAL until a later checkpoint | Open, documented in `store.mjs` and 06-storage 4.9 |
| Low | `hub/server/meetings/store.mjs` | A raw SQL `INSERT` of a confidential row with a `note_path` is not blocked by a trigger (the store API nulls it) | Open, documented in 06-storage 4.9 |
| Low | `hub/server/meetings/note.mjs` | `readNote` limits reads to the vault, not the meetings folder. Matters only once a route passes outside paths | Open |
| Observation | `hub/server/main.mjs:280` | `meetingsLog` defaults to a no-op, so a default server writes no recorder or ask log; "never log transcript text" holds trivially | Open: decide in M5 whether a real log sink is wanted. Read for this report (line 280) |
| Low | `hub/web/src/screens/meetings/MeetingDetail.jsx:365` | The Open log drawer renders `postmeet.log` text without `titleText` (not in Task 20's list) | Open. Noted in 08-security 4.12 |

### Correctness and display

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `hub/server/meetings/recorder.mjs` (`lineOf`) | Transcript lines drop the event's `lang`, so an English meeting's live meta reads PT-BR | Open. Read for this report: `lineOf` keeps `t0`, `t1`, `speaker`, `text` and `asrModel` only |
| Low | `hub/server/http/api.mjs:248`, `hub/web/src/screens/meetings/MeetingDetail.jsx:115` | An existing but empty transcript sends `speakers: []` and the detail meta shows "Você + 0 speakers on Sala" | Open |
| Low | `hub/web/src/state/actions.js:248` | The JSDoc still types `speakers` as a number (it is an array of names) | Open, outside this task's files |
| Low | `hub/server/meetings/post-watch.mjs` | A recorded row flips back to `stopping` when `session.json` is absent after the stop answer; the contract has scribed write the manifest first, so only a test-ordering artefact | Open |

### Tests that do not pin their claim (a mutation survived)

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `hub/server/meetings/ask.mjs:115` | The `stop()` and `close()` AbortController abort and the `FINISHED_CAP` trim are unpinned | Open |
| Low | `hub/server/meetings/recorder.mjs` | The start-path confidential stickiness and the `\|\| stopInFlight` clause are unpinned | Open |
| Low | `hub/server/meetings/post-watch.mjs` | The `\|\| row?.confidential` half of the sync note-lookup guard is unpinned | Open |
| Low | `hub/server/http/api.mjs:306` | The pin route's null label for a confidential view is unpinned at the route (the store and the migration 0005 triggers also null it) | Open |
| Low | `hub/web/src/screens/meetings/Meetings.jsx` and the stateful wrappers of `MeetingLive`, `Meetings`, Home and Settings | Only the pure helpers are unit tested (the `startView` other-client branch, `askView` busy, `askFailure`, `ASK_WAIT_MS`, `onUnconfirmed`, the clock); the e2e specs cover the main flows | Open |
| Low | `hub/web/src/screens/meetings/MeetingDetail.jsx:115` | The speakers array branch is not driven by a unit test | Open |
| Low | `hub/test/e2e/meetings.spec.mjs:240`, `hub/test/e2e/security.spec.mjs:349` and `:621`, several older unit tests | Literal U+202E characters in test sources (should be escapes) | Open |

### Flakes and environment

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `approvals-shell.test.mjs:278`, `scrollback-history.test.mjs:401`, `run-watch.test.mjs:224`, `contract/hooks.test.mjs:143`, the fleetmates-adapter watcher, `deliver`; root `tests/inventory-gate.test.mjs` when gates run concurrently in a shared `TMPDIR` | Timing flakes under many parallel agents (load average about 60); all pass alone | Open. None failed in this task's runs (section 1) |
| Info | `meetings.spec.mjs` "meetings AC6", "rail-and-shell AC6" | The tightest new wait: 2.5 s for a 2 s poll | Open; both passed in this task's run |

## 10. Follow-ups outside this task's files

- `hub/web/src/state/actions.js:248` (the `speakers` JSDoc) and `MeetingDetail.jsx:365` (the Open log
  drawer) need a web follow-up (section 9). Not edited here.
