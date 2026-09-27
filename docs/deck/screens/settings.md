# Settings

| | |
|---|---|
| Canvas board | `Settings` (Settings · approval rules) |
| Route | `/settings/:section` with `section` = `appearance`, `rules`, `notifications`, `connections`, `crew` (crew: see [crew-sheet.md](crew-sheet.md)). `/settings` redirects to `/settings/rules` (Proposed). |
| Milestone | M1: Notifications, Connections (with the re-run checklist). M2: Appearance. M3: Approval rules. |
| Status | Approval rules: Decided (canvas). Other sections: Proposed from the nav subtitles the canvas shows. |

## 1. Purpose

Answers **"How is the deck set up, and what have I allowed it to do?"** The main job is trust: every approval rule, where it lives and how it got there, with a safe way to revoke it.

## 2. Route and entry points

| Entry | Result |
|---|---|
| Rail "Settings" (`Alt Shift 4`) | `/settings/rules` or the last visited section (Proposed) |
| Degraded card "Fix in Settings" | `/settings/connections#vault` |
| FirstRun footer "Re-run anytime from Settings, Connections" | `/settings/connections` |
| Notifications failure toast "Open settings" | `/settings/notifications` |
| Rule suggestion "Undo" is a toast, not a route | |

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Nav | `nav aria-label="Settings sections"`, width `--layout-nav`, `bg.sidebar` | h1 "Settings" + ListRow per section (title + subtitle) |
| Content | `main`, padding `--space-32 --space-56`, blocks max `--layout-content` | h2 per section |
| Tier aside | `aside aria-label="Risk tiers"`, width `--layout-aside` | Approval rules only |

| Width | Behaviour (design-system 8.3) |
|---|---|
| 1920 | nav 300 + content + tiers aside 380 |
| 1440 | tiers aside moves below the rules content |
| 1280 | nav 240, aside below |

## 4. Content inventory

### 4.1 Nav

| Row | Title | Subtitle (live values) |
|---|---|---|
| appearance | "Appearance and language" | "Density, text size 14px, motion, EN / PT-BR" |
| rules | "Approval rules" | "{n} rules in {m} repos" ("5 rules in 3 repos") |
| notifications | "Notifications" | "Ship's bell, re-notify 10 min, quiet in meetings" |
| connections | "Connections" | "~/dev, vault, scribed, re-run checklist" |
| crew (Proposed) | "Crew" | "Colors, shapes and hats per repo" |

### 4.2 Approval rules (Decided)

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Heading | h2 `type.heading-detail` | | "Approval rules" | |
| Intro | text with inline code (`text.code`) | | "Rules live in each repo's .claude/settings.local.json, so they also apply when you run claude in a plain terminal. Destructive commands can never become rules." | |
| Threshold | setting row: label + Select (`aria-label="Approvals before suggesting"`) | `prefs.ruleSuggestAfter` (5, 3, Never; Decided default 5) | "Suggest a rule after approving the same Safe command", "5 times", "3 times", "Never suggest" | |
| Repo section | RuleRow repo section header | `repo.name`, `repo.id` shown with `~`, rule count | "rustot", "~/dev/rustot", "2 rules" | CrewAvatar sm pose none |
| Rule row | RuleRow | `Rule.pattern`, tier (from tiers.json match), `source` + `approvalsBefore` + `createdAt` | "Safe", "Bash(cargo test:*)", "from 5 approvals · 26 Sep" / "added by hand · 12 Sep" | manual rules found in the file but not written by the deck: "added by hand"; date unknown: "added by hand" only |
| Revoke | Button `secondary xs` | | "Revoke…" | neutral; red only in the confirm (Decided) |
| Revoke confirm | Dialog `confirm` | | title "Revoke Bash(cargo test:*) in rustot?", body "Removes the rule from ~/dev/rustot/.claude/settings.local.json. Claude Code will ask again for this command, also in a plain terminal.", "Cancel", "Revoke rule" (`danger-confirm`) | Cancel focused first |
| Tier aside | TierBadge `sm` x 3 + text | static | h3 "How the deck sorts requests"; Safe "Reads, tests, builds, linters. Can be batched, approved from a popup and turned into a rule."; Caution "Network, installs, writes outside the repo. One at a time; a rule is possible only if you add it by hand."; Destructive "rm, git push --force, git reset --hard, deploys, database writes. Never batched, never a rule, never from a popup, and always behind a confirm checkbox."; footer "Tiers come from pattern lists in ~/.config/fleetmates/deck/tiers.json. Unknown commands default to Caution." | |
| Add by hand (Proposed) | Button `ghost sm` per repo | | "Add a rule…" | Dialog with a pattern field validated against Claude Code permission syntax; Destructive patterns refused with "Destructive commands can never become rules." |

### 4.3 Appearance and language (Proposed)

| Setting | Control | Binding | Copy |
|---|---|---|---|
| Density (Home) | SegmentedControl | `localStorage` `deck.density` (per browser, not in `prefs`) | "Comfortable", "Compact" |
| Text size | Select | `prefs.textSize` (14 default; 13, 15, 16) | "Text size", "14px (default)" |
| Motion | RadioGroup | `prefs.motion`: follow system, reduce always | "Motion", "Follow the system setting", "Always reduce motion" |
| Language | read-only row (SET-O1) | `DECK_LANG` | "Language", "English (set by DECK_LANG)" |
| Terminal screen reader mode | Checkbox | `prefs.terminalScreenReader` (off, design-system 11.6) | "Screen reader mode for terminals", hint "Slower. Lets screen readers read terminal output." |
| Shared colors notice | text + link | repos beyond 9 slots (crew.md 4.3) | "10 repos share 9 colors" + "Customize crew" |

### 4.4 Notifications (Proposed layout, Decided values)

| Setting | Control | Binding | Copy |
|---|---|---|---|
| Desktop notifications status | ChecklistRow-style status line | notifications health | "Desktop notifications work through mako." / "Desktop notifications are not working: notify-send exited 1." |
| Test | Button `secondary` | | "Send test ping" |
| Ship's bell | Checkbox | `prefs.bell` (on) | "Ship's bell when a session needs you", hint "Once per session, not repeated." |
| Re-notify | Select | `prefs.renotifyAfter` (10 min Decided; 5, 10, 20, Never) | "Re-notify if ignored", "after 10 min" |
| Notify on done | Checkbox | `prefs.notifyDone` (on, Decided) | "Notify when a session finishes with changes" |
| Quiet in meetings | Checkbox | `prefs.quietInMeetings` (on, Decided) | "Quiet in meetings", hint "While TurbidAssist records: no sound, popups still show." |
| Crash popups | Checkbox (SM-O4) | `prefs.notifyCrash` | "Popup when a session crashes" |

### 4.5 Connections (Proposed)

| Row | Control | Binding | Copy |
|---|---|---|---|
| Repo scan root | TextInput + "Rescan" | `config.scanRoot` (`~/dev`, Decided) | "Repos folder", "~/dev", "{n} repos found" |
| Vault | TextInput (read-only when set by environment) + status | vault-mcp `VAULT_PATH`, health | "Vault", "VAULT_PATH=/home/you/vault · 76 notes indexed" |
| Obsidian vault name | TextInput | MEM-O5 | "Obsidian vault name" |
| TurbidAssist config | TextInput + status | MEET-O11 | "TurbidAssist config.yaml" |
| scribed | status + "Start scribed" | health | "scribed reachable" / "scribed socket not found" |
| deckd | status + "Start deckd" | health | "deckd running · pid 48213 · up 2 min" |
| Hooks | status + "Install hooks" | first-run check | "Observation hooks installed" |
| Checklist | the FirstRun checklist without the gate, "Done" instead of "Set sail" (state-machines 10.3) | | "Run the setup checklist again" |
| Stale threshold | read-only row | `staleMinutes` 20 | "A running session counts as adrift after 20 min without activity." (not editable in v1, 02-domain 3) |

## 5. States

| State | What shows |
|---|---|
| Loading | nav renders; content shows SkeletonCard `panel` x 3 |
| Empty rules | per section: "No approval rules yet. Rules you accept from suggestions, or add by hand, show up here." |
| Settings file unreadable for a repo | RuleRow section with Banner `error`: "Could not read ~/dev/rustot/.claude/settings.local.json: {error}." + "Retry" (components RuleRow) |
| Write failed (revoke or add) | the same inline Banner with "Could not write {path}: {error}. Nothing changed." |
| Revoking | row `loading`, then fades 160ms; toast "Rule revoked in rustot" |
| Save of a preference | applies immediately (no Save button); failure toast "Could not save {setting}: {error}" and the control reverts |
| deckd down | Connections deckd row "down" with backoff; other sections normal |
| Overflow | many repos: content scrolls; long patterns wrap inside `code` with `overflow-wrap: anywhere` (rules are read, never approved here) |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Nav row | section | route `/settings/:section` |
| Threshold Select | persists; rule machines re-evaluate (Never freezes counters) | `PUT /api/prefs {ruleSuggestAfter}` |
| "Revoke…" → confirm | removes the pattern from the repo settings file (re-read, merge, atomic write) | `DELETE /api/rules/:repoKey/:pattern` = `U.Revoke` (state-machines 2.8) |
| "Add a rule…" | dialog, validate, write | `POST /api/rules {repoKey, pattern, source:'manual'}` |
| Preference controls | persist | `PUT /api/prefs` |
| "Send test ping" | notify-send test | `POST /api/notify/test` (`U.SendTestPing`) |
| "Rescan" | rescans the scan root | `POST /api/repos/rescan` |
| "Start scribed", "Start deckd", "Install hooks" | fix actions as FirstRun | `U.Fix` (state-machines 10.3) |
| "Run the setup checklist again" | checklist inline | state-machines 10 without the gate |

## 7. Real-time updates

`rules.changed` (the deck re-reads settings files on open and on its own writes; external edits appear on the next open or on focus, Proposed) updates rows. `health.changed` updates Connections statuses. `rule.added` from a suggestion elsewhere adds the row live.

## 8. Accessibility

- h1 "Settings" in the nav; h2 per section in content; the tier aside h3.
- Nav rows are links with `aria-current="page"`.
- Every control has a visible label; Select uses the native element.
- Revoke confirm focuses Cancel; the destructive button is not the default.
- TierBadges carry their word ("Safe").

## 9. Copy deck

| Key | EN |
|---|---|
| `settings.title` | Settings |
| `settings.nav.label` | Settings sections |
| `settings.nav.appearance` | Appearance and language |
| `settings.nav.appearance.sub` | Density, text size {size}px, motion, EN / PT-BR |
| `settings.nav.rules` | Approval rules |
| `settings.nav.rules.sub` | {n, plural, one {# rule} other {# rules}} in {m, plural, one {# repo} other {# repos}} |
| `settings.nav.notifications` | Notifications |
| `settings.nav.notifications.sub` | Ship's bell, re-notify {min} min, quiet in meetings |
| `settings.nav.connections` | Connections |
| `settings.nav.connections.sub` | {root}, vault, scribed, re-run checklist |
| `settings.nav.crew` | Crew |
| `settings.nav.crew.sub` | Colors, shapes and hats per repo |
| `settings.rules.title` | Approval rules |
| `settings.rules.intro` | Rules live in each repo's .claude/settings.local.json, so they also apply when you run claude in a plain terminal. Destructive commands can never become rules. |
| `settings.rules.threshold` | Suggest a rule after approving the same Safe command |
| `settings.rules.threshold.label` | Approvals before suggesting |
| `settings.rules.threshold.5` | 5 times |
| `settings.rules.threshold.3` | 3 times |
| `settings.rules.threshold.never` | Never suggest |
| `settings.rules.count` | {n, plural, one {# rule} other {# rules}} |
| `settings.rules.fromApprovals` | from {n} approvals · {date} |
| `settings.rules.byHand` | added by hand |
| `settings.rules.byHandDate` | added by hand · {date} |
| `settings.rules.revoke` | Revoke… |
| `settings.rules.revoke.title` | Revoke {pattern} in {repo}? |
| `settings.rules.revoke.body` | Removes the rule from {path}. Claude Code will ask again for this command, also in a plain terminal. |
| `settings.rules.revoke.confirm` | Revoke rule |
| `settings.rules.revoked` | Rule revoked in {repo} |
| `settings.rules.add` | Add a rule… |
| `settings.rules.add.destructive` | Destructive commands can never become rules. |
| `settings.rules.empty` | No approval rules yet. Rules you accept from suggestions, or add by hand, show up here. |
| `settings.rules.readError` | Could not read {path}: {error}. |
| `settings.rules.writeError` | Could not write {path}: {error}. Nothing changed. |
| `settings.tiers.title` | How the deck sorts requests |
| `settings.tiers.safe` | Reads, tests, builds, linters. Can be batched, approved from a popup and turned into a rule. |
| `settings.tiers.caution` | Network, installs, writes outside the repo. One at a time; a rule is possible only if you add it by hand. |
| `settings.tiers.destructive` | rm, git push --force, git reset --hard, deploys, database writes. Never batched, never a rule, never from a popup, and always behind a confirm checkbox. |
| `settings.tiers.footer` | Tiers come from pattern lists in ~/.config/fleetmates/deck/tiers.json. Unknown commands default to Caution. |
| `settings.appearance.density` | Density |
| `settings.appearance.textSize` | Text size |
| `settings.appearance.textSize.default` | {n}px (default) |
| `settings.appearance.motion` | Motion |
| `settings.appearance.motion.system` | Follow the system setting |
| `settings.appearance.motion.reduce` | Always reduce motion |
| `settings.appearance.language` | Language |
| `settings.appearance.language.value` | {language} (set by DECK_LANG) |
| `settings.appearance.srTerminal` | Screen reader mode for terminals |
| `settings.appearance.srTerminal.hint` | Slower. Lets screen readers read terminal output. |
| `settings.appearance.sharedColors` | {n} repos share 9 colors |
| `settings.appearance.customizeCrew` | Customize crew |
| `settings.notify.ok` | Desktop notifications work through mako. |
| `settings.notify.broken` | Desktop notifications are not working: notify-send exited {code}. |
| `settings.notify.test` | Send test ping |
| `settings.notify.bell` | Ship's bell when a session needs you |
| `settings.notify.bell.hint` | Once per session, not repeated. |
| `settings.notify.renotify` | Re-notify if ignored |
| `settings.notify.renotify.after` | after {n} min |
| `settings.notify.renotify.never` | Never |
| `settings.notify.done` | Notify when a session finishes with changes |
| `settings.notify.quiet` | Quiet in meetings |
| `settings.notify.quiet.hint` | While TurbidAssist records: no sound, popups still show. |
| `settings.notify.crash` | Popup when a session crashes |
| `settings.conn.scanRoot` | Repos folder |
| `settings.conn.repos` | {n, plural, one {# repo found} other {# repos found}} |
| `settings.conn.rescan` | Rescan |
| `settings.conn.vault` | Vault |
| `settings.conn.obsidian` | Obsidian vault name |
| `settings.conn.turbid` | TurbidAssist config.yaml |
| `settings.conn.checklist` | Run the setup checklist again |
| `settings.conn.stale` | A running session counts as adrift after {n} min without activity. |
| `settings.saveError` | Could not save {setting}: {error} |

## 10. Acceptance criteria

1. **Given** fixture `rules5`, **when** opening `/settings/rules`, **then** 3 repo sections with 2, 2 and 1 rules render and the nav subtitle reads "5 rules in 3 repos".
2. **Given** "Revoke…" on `Bash(cargo test:*)`, **then** a dialog opens with Cancel focused; **when** confirming, **then** the fixture settings file no longer contains the pattern, the row fades out and a toast reads "Rule revoked in rustot".
3. **Given** the settings file changed on disk to add a pattern the deck did not write, **when** reopening the page, **then** the row shows "added by hand".
4. **Given** the threshold set to "Never suggest", **then** after 6 Safe approvals of the same command no suggestion appears anywhere.
5. **Given** "Add a rule…" with `Bash(git push --force:*)`, **then** the dialog refuses it with "Destructive commands can never become rules."
6. **Given** 1440 wide, **then** the tier aside sits below the rules; at 1280 the nav is 240px.
7. **Given** a write error, **then** the inline banner shows the path and error and the row remains.
8. **Given** "Send test ping", **then** `notify-send` is invoked once (fixture spy) and the status line updates.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| SET-O1 | Language is `DECK_LANG`, an environment variable (D-40), but the nav promises "EN / PT-BR" as a setting. | **Open**. Default: read-only row showing the current value. |
| SET-O2 | Where deck preferences and config (scan root, vault name, TurbidAssist path) are stored. | **Open**. Default: `config.json` holds boot and connection settings only (port, scan root, language, stale minutes, vault path, Obsidian vault name, TurbidAssist config path); UI behaviour prefs (notifications, rule suggestion threshold, motion, text size) live in the SQLite `prefs` table; Home density is per browser in `localStorage` `deck.density`; environment variables win when set ([06-storage.md](../06-storage.md) section 8). |
| SET-O3 | Only Approval rules was designed; the other sections are specified here from the nav subtitles. | Proposed. |
| SET-O4 | "Rule re-offered after dismissal" and threshold options 5 / 3 / Never (Q13, D-32). | Open (confirm options). |
| SET-O5 | Rule source date: rules the deck did not write have no date. | Proposed: "added by hand" without a date. |

## 12. Changes from the canvas

1. Settings h2 26px becomes `type.heading-detail` (28px).
2. Tier words in sentence case, uppercased by CSS.
3. Select heights follow `size.control` tokens (42 and 36 to 40 and 36).
4. Appearance, Notifications, Connections and Crew sections, "Add a rule…" and all states are new.
