# Neural tier classifier — design notes (trigger met, not pursued)

Date: 2026-09-22. Status: **trigger met on 2026-09-24; not pursued.** See "Outcome of the linear
attempt" below. The evidence says a better classifier is not where the saving is.

This note becomes a plan only if the linear classifier in
`docs/plans/2026-09-22-local-tier-classifier.md` misses a release gate twice (the initial attempt
plus one data-improvement retry). Until then nothing here is scheduled.

## Shape, if activated

A three-class encoder fine-tuned on the same dataset, exported to INT8 ONNX, and run by a
separately downloaded, hash-pinned `worker.mjs` as a short-lived child process during `init-run`.
The weights, tokenizer, worker and WASM are GitHub Release assets under a `classifier-v*` tag.
A signed-by-provenance `classifier/catalog.json` in the npm package pins every asset's bytes and
SHA-256. `classifier enable` is the only download path; everything else is offline.

## Runtime facts (checked against `@huggingface/transformers@4.3.0`, 2026-09-22)

- **In Node, Transformers.js loads the native `onnxruntime-node` addon and imports `sharp`.**
  `device: 'wasm'` throws `Unsupported device: "wasm"`. The browser build has an empty ONNX
  object and a stubbed `fs` in Node. The working route is to bundle the **Node** build with
  esbuild, stub `onnxruntime-node` with a plugin (it is loaded through `createRequire`, so an
  alias does not catch it) and stub `sharp`. Set `globalThis[Symbol.for('onnxruntime')]` to
  `onnxruntime-web` before the import, and leave `device` unset.
- **By default the library fetches the ORT `.wasm` from `cdn.jsdelivr.net`.** For offline use
  set `env.allowRemoteModels = false`, `env.useWasmCache = false`, `ort.env.wasm.wasmBinary` to a
  local buffer, `numThreads = 1` (Node supports only single-threaded WASM) and fixed-width SIMD,
  and replace `env.fetch` with a function that throws.
- **`--max-old-space-size` does not bound WASM memory.** Enforce the ceiling with a worker-reported
  `process.resourceUsage().maxRSS` instead.
- **Windows has no `kill(-pid)`.** Use `taskkill /PID <pid> /T /F`.
- **INT8 results differ between x64 AVX2 and VNNI/arm64 on native ORT.** Fixed-SIMD WASM is the
  route to cross-platform determinism.
- **GitHub Release asset URLs 302 to `release-assets.githubusercontent.com`.** Enable immutable
  releases, but keep the SHA-256 pins as the trust anchor.

## Candidate encoders (Hugging Face metadata, 2026-09-22)

| Model | License | Params | Max tokens | INT8 ONNX |
|---|---|---|---|---|
| `all-MiniLM-L6-v2` | Apache-2.0 | 22.7M | 256 (the tokenizer claims 512) | 23.0 MB |
| `bge-small-en-v1.5` | MIT | 33.4M | 512 | 34.0 MB |
| `e5-small-v2` | MIT | 33.4M | 512 | 34.0 MB |
| `ModernBERT-base` | Apache-2.0 | 149.7M | 8192 | 151.1 MB |

## Outcome of the linear attempt (2026-09-24)

The linear classifier (run `tier-classifier`, archived on branch `run/tier-classifier`, never
merged) missed release gates on both permitted attempts, so this note's trigger was met. Nothing
shipped.

- **Attempt 1:** holdout of 162 rows. It missed cheap precision (Wilson lower bound 0.83 < 0.85),
  cheap recall (26% < 50%), calibration (ECE 0.25) and speed (117 ms p95).
- **Retry:** feature extraction was made about 9x faster with byte-identical output, and speed
  then passed at 41 ms. The retry also added temperature scaling folded into the weights,
  validation reweighted by origin to match the holdout, and threshold tuning that enforces the
  gates. The training step then refused, because no threshold met the cheap gates even on
  validation. The operator amended cheap recall to 30%, set from the validation frontier. On the
  holdout of 153 rows, evaluated once, the model then missed catastrophic under-tier (2 capable
  rows sent to cheap), all under-tiering (Wilson upper bound 8.3%), cheap precision (Wilson
  lower bound 0.78) and calibration (ECE 0.136). Validation had shown every one of those as
  passing.

What was learned:

1. **The measured cost of a tier is not monotonic.** A controlled replay ran 30 real tasks × 3
   tiers with Claude on the operator's repos. Per task, opus averaged $1.52 and 5.4 min, sonnet
   $3.87 and 14.1 min, and haiku $1.09 and 10.6 min. Opus needed far fewer turns than sonnet,
   so opus was cheaper and faster than sonnet per task. Haiku passed 26/30, sonnet 29/30,
   opus 29/30.
2. **Under that cost, "always capable (opus)" beats the classifier.** Weighted holdout loss was
   0.197 for always-opus, 0.286 for the model and 1.72 for the heuristic. On the 30 outcome
   (ground-truth) rows it was 0.385 for always-opus against 0.467 for the model. The model's
   large win over the heuristic came from avoiding sonnet, not from telling tiers apart.
3. **The data could not support the cheap gates.** There were 124 own tasks and no public ones,
   186 synthetic rows, 104 training rows, and operator–GPT agreement of κ = 0.40. The operator's
   judged labels matched the replay outcome on only 5 of 30 tasks, mostly by rating tasks higher
   than the tier that passed. Validation (53 rows) did not predict the holdout.

Why the neural path is not pursued: a stronger encoder would learn the same noisy labels, and
the cost it would optimise is already captured by a far simpler change, routing the `mid` tier to
opus. That change is its own plan. Revisit a classifier only if the tier costs become monotonic
again (for example after a model or pricing change): rerun the replay first, then reconsider.

Reusable pieces on the archived branch: the replay tool and cost-matrix loss (salvaged to master
by the mid→opus plan), the evaluator with release gates, the feature extractor, the
predictor/policy, the dataset tooling and the frozen dataset. The dataset holds the operator's
scrubbed task text; it stays on the archived branch and is not pushed.

## Sources

- <https://huggingface.co/docs/transformers.js/api/env>
- <https://onnxruntime.ai/docs/get-started/with-javascript/web.html>
- <https://onnxruntime.ai/docs/api/js/interfaces/Env.WebAssemblyFlags.html>
- <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>
- <https://nodejs.org/api/child_process.html>
- <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>
