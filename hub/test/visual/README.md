# Visual baselines

The M1 build screenshots come from the `Visual baselines` test in
`hub/test/e2e/observe.spec.mjs`. It renders the built app on the real deck server with the UI
fixtures in `hub/test/fixtures/ui/observe.json`, and captures eight screens at 1920 x 1080 with
reduced motion:

| File | Screen |
|---|---|
| `home-busy.png` | Home, fixture `busy` |
| `drawer-busy.png` | Needs-you drawer over `busy` |
| `palette-busy.png` | Palette over `busy` |
| `focus-rustot-facts.png` | read-only Focus, rustot, Facts tab |
| `settings-connections.png` | Settings, Connections |
| `home-calm.png` | Home, fixture `calm` |
| `home-crowded12.png` | Home, fixture `crowded12` |
| `first-run-hooks-missing.png` | First run with the hooks check failing |

## Capturing

    npm ci --prefix hub
    mkdir -p /tmp/hx/e2e
    DECK_VISUAL_DIR=hub/test/visual/build TMPDIR=/tmp/hx/e2e \
      node --test --test-name-pattern='Visual baselines' hub/test/e2e/observe.spec.mjs

Without `DECK_VISUAL_DIR` the test still renders every screen and runs its privacy check, but
writes no files. `CHROMIUM_PATH` overrides `/usr/bin/chromium`.

## No personal data

Every fixture path uses the `/home/you` placeholder and the repository names are neutral canvas
names. Before each capture the test reads the page text and fails if it contains the current
`USER`, `LOGNAME` or `HOME`, or the temporary directory the server runs in. The default vault-mcp
command names the maintainer's npm scope, so the test sets that preference to `npx -y vault-mcp`
before capturing. Review each image before committing it.

## Status

The PNG files are not committed yet. The task that added this suite could only change the test,
fixture and README files, and `docs/deck/09-testing.md` section 11.3 makes build baselines a
phase 2 gate that needs owner approval. Until then treat a capture as a review aid, following
`docs/deck/qa/qa-checklist.md` section 3.

The clock is not frozen: relative times such as "Finished 40 minutes ago", clock times such as
"Adrift since 18:06" and the calm subtitle's weekday change between runs. A strict pixel gate
needs a frozen clock first (Playwright `page.clock`, 09-testing section 1).
