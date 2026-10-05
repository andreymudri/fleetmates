# Native diagram data

`scripts/diagram.mjs` exports the JSON Schema and a zero-dependency validator for version 1.
The top-level keys are `v`, `kind`, `nodes`, and `edges`. `kind` is `architecture` or `phase`.
Each node has an ASCII `id`, a plain-text `label` of at most 120 characters, a numeric `lane`
from 0 to 256, and a lifecycle `state`: queued, running, blocked, done, failed or unknown.
Each edge has `from`, `to`, and a `kind` of depends or connects. References must name distinct
existing nodes; duplicate nodes and edges are rejected. Limits are 256 nodes and 1024 edges.
No HTML, scripts, URLs, styles, coordinates, or rendering instructions are accepted as fields.
Labels remain plain text even when they contain angle brackets.

```json
{"v":1,"kind":"phase","nodes":[{"id":"T1","label":"T1","state":"running","lane":1}],"edges":[]}
```

`node scripts/cli.mjs diagram --run <runId> --root <project>` emits a run's phase graph.
Task states are observations, not gate verdicts. Unknown or unsupported states stay unknown.
The Deck validates the same format and renders SVG nodes and edges directly through React.
No image generation, browser subprocess, or diagram runtime is involved.
