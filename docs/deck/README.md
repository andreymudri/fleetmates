# fleetmates deck: developer handoff

fleetmates deck is a local web UI for running parallel Claude Code sessions. It shows which sessions need you and lets you answer, steer and launch them. It also connects that work to an Obsidian vault (through vault-mcp) and to recorded meetings (through TurbidAssist). It will live in `hub/` in this repo.

This folder is the complete handoff from design to build. It covers what was decided and why, how the system is built, every screen, and the remaining open questions. It was written for a developer or a Claude Code team run that starts with M0 and knows nothing about the design sessions.

![Home, from the design canvas](canvas/Home.webp)

## Start here

1. [01-product.md](01-product.md): what it is, for whom, goals, non-goals, principles.
2. [02-domain.md](02-domain.md): the vocabulary and the entities (session, request, rule, run, meeting). Every other doc uses these names.
3. [03-architecture.md](03-architecture.md): processes, repo layout, key flows, files, commands, performance budgets.
4. [12-milestones.md](12-milestones.md): what to build first, exit criteria, and task breakdowns per milestone.
5. [15-open-questions.md](15-open-questions.md): what still needs an owner decision, and when.

## Status labels

Every doc marks its statements as one of these:

- **Decided**: the owner chose it. Logged in [14-decisions.md](14-decisions.md).
- **Proposed**: the handoff's recommendation. Safe to build.
- **Open**: needs a decision. Listed in [15-open-questions.md](15-open-questions.md), with a default that is safe to build.

## Map

### System

| Doc | Covers |
|---|---|
| [01-product.md](01-product.md) | Purpose, users, experience goals, principles, non-goals, success measures |
| [02-domain.md](02-domain.md) | Vocabulary, entities, session states, counting rules, identifiers |
| [03-architecture.md](03-architecture.md) | deckd, web server, hook, `fm` CLI; `hub/` layout and dependencies; flows; files and commands |
| [04-integrations.md](04-integrations.md) | fleetmates, Claude Code hooks and `claude -p`, vault-mcp, TurbidAssist, notifications, git |
| [05-api.md](05-api.md) | REST endpoints, WebSocket events and terminal channel, error codes, deckd protocol, hook envelope, JSDoc types |
| [06-storage.md](06-storage.md) | SQLite schema, retention, migrations, what lives outside the database, backup |
| [07-approvals.md](07-approvals.md) | Risk tiers, classification, `tiers.json` defaults, rules in `.claude/settings.local.json`, answering, audit |
| [08-security.md](08-security.md) | Threat model, token and Origin/Host rules, CSP, rendering rules, confidential meetings, release checklist |
| [09-testing.md](09-testing.md) | Fake `claude`, hook and screen fixtures, Playwright, contract tests, CI, dogfood week |
| [10-memory-and-research.md](10-memory-and-research.md) | Ask engine, misses, captures, `vault_graph`, the `vault_learn` preview PR, deep research runs |
| [11-meetings.md](11-meetings.md) | scribed client, recording flow, live ask, pins, post-meeting notes, proposed TurbidAssist changes |
| [12-milestones.md](12-milestones.md) | M0 to M6 scope, deliverables per repo, exit criteria, open items per milestone, task breakdowns |
| [13-operations.md](13-operations.md) | Install, `init`, systemd units, config, logs, upgrade, uninstall, troubleshooting, release |
| [14-decisions.md](14-decisions.md) | Decision log (owner decisions and handoff-time choices) |
| [15-open-questions.md](15-open-questions.md) | Owner questions Q1 to Q19 and the register of all open items |

### Interaction and design

| Doc | Covers |
|---|---|
| [interaction/state-machines.md](interaction/state-machines.md) | Session, request, shared input, connection, dependency health, meeting, research, ask, notification and first-run machines, with transitions and UI per state |
| [interaction/keyboard.md](interaction/keyboard.md) | Keyboard map (overrides the canvas) |
| [design/design-system.md](design/design-system.md) | Color, type, spacing, radii, layout, icons, motion, accessibility, voice and copy |
| [design/tokens.json](design/tokens.json), [design/tokens.css](design/tokens.css) | Design tokens (DTCG JSON source, generated CSS) |
| [design/contrast.md](design/contrast.md) | WCAG contrast table for every token pair in use |
| [design/tools/](design/tools/build-tokens.mjs) | Token build script and the pixel crew reference implementation |
| [design/components.md](design/components.md) | One spec per React component: props, states, tokens, accessibility |
| [design/crew.md](design/crew.md) | Pixel crew avatars: shape hash, color slots, poses, hats |
| [screens/README.md](screens/README.md) | Index of 14 screen specs with routes and milestones |
| [canvas/README.md](canvas/README.md) | Renders of the 18 reviewed canvas boards (the 1-cell Crew board is left out) |
| [qa/qa-checklist.md](qa/qa-checklist.md) | Design QA checklist for every build |

### Reference

| Doc | Covers |
|---|---|
| [reference/fleetmates-contract.md](reference/fleetmates-contract.md) | What fleetmates v2.2.0 actually does (status.json, liveness, digest, CLI), with `file:line` |
| [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) | What vault-mcp v0.3.0 and TurbidAssist `scribed` actually do, with `file:line` |

## Work in other repos

The deck needs changes outside this repo. They are specified as small PRs:

| Repo | Change | Spec | Milestone |
|---|---|---|---|
| vault-mcp | `vault_learn` with `preview: true` (dry run) | [10-memory-and-research.md](10-memory-and-research.md) section 7 | M6 (needed by research; can land during M5) |
| vault-mcp | `vault_graph` tool | [10-memory-and-research.md](10-memory-and-research.md) section 6 | M5 |
| TurbidAssist | T0 protocol fixture exporter, T1 `pin`, T2 status push, T3 vault-mcp in live ask, T4 `scribed.service` | [11-meetings.md](11-meetings.md) | M4 (T0 optional before M4; M0 uses hand-copied fixtures) |

## Sources

These docs were written from the design sessions of 2026-09-26 and 27. Those sessions covered roughly 20 rounds of questions with the owner, the reviewed canvas, three critique passes, and reading the code of fleetmates, vault-mcp and TurbidAssist. Part of the conversation was lost to context compaction; decisions that survive only in the canvas are tagged as such in [14-decisions.md](14-decisions.md). The design canvas itself is a private artifact; [canvas/](canvas/README.md) has renders of it.

## Conventions for editing these docs

- English, plain prose. Do not use the em dash character.
- Keep status labels current. When an Open item is decided: add a D entry to 14, update the owning doc, and remove the row from 15.
- Use placeholders for client names and personal paths (`client-a`, `/home/you`). This repo is public.
