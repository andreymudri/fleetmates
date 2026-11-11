# Running on DeepSeek

fleetmates runs unchanged on DeepSeek models. No adapter is involved: Claude Code itself talks to
DeepSeek's Anthropic-compatible endpoint, so the orchestrator, every teammate, the reviewers and
the integrator all run on DeepSeek, with the same worktrees, hooks and gate as on Claude.

## Setup

Put both variables in the `env` block of `~/.claude/settings.json`, or export them in the shell
that starts Claude Code:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<your DeepSeek API key>"
  }
}
```

Then install and use the plugin exactly as the README describes. Billing goes to the DeepSeek
account that owns the key; no Anthropic subscription or API key is used while these are set.

Remove the two variables to go back to Claude. A key in `settings.json` applies to every Claude
Code session on the machine, so prefer exporting it in one shell when you only want some sessions
on DeepSeek.

## Models

The endpoint maps Claude model names to DeepSeek models itself
([DeepSeek docs](https://api-docs.deepseek.com/guides/anthropic_api)):

| Claude name | DeepSeek model |
|---|---|
| `opus` | `deepseek-v4-pro` |
| `sonnet`, `haiku` | `deepseek-flash` |

fleetmates' tier map (`cheap -> haiku`, `mid -> opus`, `capable -> opus`) therefore lands on
`deepseek-flash` for `cheap` and `deepseek-v4-pro` for `mid` and `capable`, with no configuration.

The endpoint ignores `cache_control`, but DeepSeek caches repeated prompt prefixes on its own, so a
teammate's fixed prefix is not paid in full on every turn.

## What was measured

One run, on 2026-10-30, of a plan with three parallel tasks in one phase, against the same plan on
Claude:

| | DeepSeek | Claude (opus) |
|---|---|---|
| Gate on the first attempt | PASS | PASS |
| Fix rounds / orphaned tasks | 0 / 0 | 0 / 0 |
| Tests | 11/11 | 11/11 |
| Subagent turns | 560 | 202 |
| Cache read / output tokens | 12.2M / 300k | 2.5M / 100k |
| Wall-clock | 23 min | 9 min |
| Cost | about US$0.80 (5.79 CNY, DeepSeek dashboard) | US$4.57 (Claude Code's list-price estimate) |

This is one easy plan. DeepSeek took about three times the turns, so the cost gap is expected to
narrow on plans whose gates fail and need fix rounds. Claude Code's own cost figure for a DeepSeek
session is not meaningful, because it prices the tokens at Claude rates; read the DeepSeek
dashboard instead.

## Limits

- Expect runs to take roughly 2.5 times longer.
- `node scripts/cli.mjs usage` reports DeepSeek token counts correctly. Claude Code's own cost
  figure uses Claude prices; to have `usage` price the run in DeepSeek's currency, set
  `cost.prices` (see below).
- The code leaves your machine for DeepSeek's servers. Check that this is allowed for the
  repository before you run a fleet on it.

## Pricing a DeepSeek run

`usage` prices each subagent from the `cost` block in `fleetmates.local.json` (or the tracked
manifest). With every request going to DeepSeek, one `*` entry covers every model name the report
shows. The numbers below are placeholders: copy the current prices per million tokens from
DeepSeek's pricing page, because they change.

    {
      "cost": {
        "currency": "CNY",
        "budget": 20,
        "prices": { "*": { "input": 2, "output": 8, "cacheRead": 0.5, "cacheWrite": 2 } },
        "contextWindows": { "*": 128000 }
      }
    }

DeepSeek prices input by cache hit and cache miss. Put the hit price in `cacheRead` and the miss
price in `input`. How the endpoint reports cache creation was not measured, so `cacheWrite` at the
miss price is a starting assumption. The result is an estimate from tokens: compare it with the
DeepSeek dashboard before relying on it.

When the DeepSeek balance runs out mid-run, the provider refuses with an error that waiting does
not fix. A headless teammate (`--harness`) is then orphaned with that error as its reason;
`limitWaitMinutes` only waits out errors the harness marks as retriable.
