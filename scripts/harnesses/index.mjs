import { codexAdapter } from './codex.mjs'
import { cursorAdapter } from './cursor.mjs'

// Maps a `--harness` name to its adapter. Adding a harness means adding one entry here (and its
// name to `KNOWN_HARNESSES` in config.mjs); nothing else in the driver or the CLI names a harness
// directly.
const ADAPTERS = { codex: codexAdapter, cursor: cursorAdapter }

export function getAdapter(name) {
  const adapter = ADAPTERS[name]
  if (!adapter) {
    throw new Error(`unknown harness: ${name} (known: ${Object.keys(ADAPTERS).join(', ')})`)
  }
  return adapter
}

export const HARNESS_NAMES = Object.keys(ADAPTERS)
