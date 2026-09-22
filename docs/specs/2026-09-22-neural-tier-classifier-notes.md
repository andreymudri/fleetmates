# Neural tier classifier — design notes (inactive)

Date: 2026-09-22. Status: **inactive**.

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

## Sources

- <https://huggingface.co/docs/transformers.js/api/env>
- <https://onnxruntime.ai/docs/get-started/with-javascript/web.html>
- <https://onnxruntime.ai/docs/api/js/interfaces/Env.WebAssemblyFlags.html>
- <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>
- <https://nodejs.org/api/child_process.html>
- <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>
