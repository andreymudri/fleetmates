import { codexAdapter } from './codex.mjs'

// Maps a `--harness` name to its adapter. Adding a second harness (Gemini, OpenCode — later
// plans) means adding one entry here; nothing else in the driver or the CLI names a harness
// directly.
const ADAPTERS = { codex: codexAdapter }

export function getAdapter(name) {
  const adapter = ADAPTERS[name]
  if (!adapter) {
    throw new Error(`unknown harness: ${name} (known: ${Object.keys(ADAPTERS).join(', ')})`)
  }
  return adapter
}

export const HARNESS_NAMES = Object.keys(ADAPTERS)
