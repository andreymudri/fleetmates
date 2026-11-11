## Running headless

Measured on Claude Code 2.1.306: in print mode (the non-interactive session), background tasks
still running 10 minutes after the orchestrator's last turn are stopped, and a Workflow phase is a
background task. A batched phase can run longer than that with nothing to wake the orchestrator,
since the watchdog is not started on the Workflow path, and the phase is then killed mid-task. For
a headless fleet run, set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` in the session's environment,
the setting Claude Code itself names for waiting indefinitely. This was measured in print mode
only, on that one version.
