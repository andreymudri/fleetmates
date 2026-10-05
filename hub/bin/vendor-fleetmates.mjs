#!/usr/bin/env node
// Copy the fleetmates root modules the deck server imports (server/adapters/fleetmates.mjs) into
// hub/vendor/fleetmates/, so a packed deck package carries them. Run by `prepack`; `postpack`
// runs it with --clean. The copy is the import closure of ENTRIES: every relative import is
// followed, an import that leaves scripts/ or names a package other than a `node:` builtin is
// refused, and nothing is written unless the whole closure resolves.
//
//   node bin/vendor-fleetmates.mjs [--from <scripts dir>] [--out <dir>]
//   node bin/vendor-fleetmates.mjs --clean
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = fileURLToPath(new URL('..', import.meta.url))
/** The modules server/adapters/fleetmates.mjs loads. */
export const ENTRIES = Object.freeze(['names.mjs', 'liveness.mjs', 'git.mjs', 'state.mjs'])

const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s[^'"`]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*([^)]*)\)/g

/**
 * The import closure of `entries` inside `from`, as relative file names.
 * @param {string} from scripts directory
 * @param {readonly string[]} [entries]
 * @returns {Map<string, string>} relative name to source text
 */
export function closure(from, entries = ENTRIES) {
  const root = path.resolve(from)
  const files = new Map()
  const queue = entries.map((entry) => path.join(root, entry))
  while (queue.length) {
    const file = queue.shift()
    const relative = path.relative(root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${relative} leaves ${root}`)
    if (files.has(relative)) continue
    const source = readFileSync(file, 'utf8')
    files.set(relative, source)
    for (const match of source.matchAll(SPECIFIER)) {
      const dynamic = match[3]
      if (dynamic !== undefined && !/^\s*['"][^'"]+['"]\s*$/.test(dynamic)) throw new Error(`${relative} has a dynamic import that cannot be followed: import(${dynamic.trim()})`)
      const specifier = match[1] ?? match[2] ?? dynamic.trim().slice(1, -1)
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`${relative} imports ${specifier}, which is not a node: builtin or a file in scripts/`)
      queue.push(path.resolve(path.dirname(file), specifier))
    }
  }
  return files
}

function main(argv) {
  const option = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1] }
  const vendorDir = path.join(hub, 'vendor')
  if (argv.includes('--clean')) { rmSync(vendorDir, { recursive: true, force: true }); return }
  const from = option('--from') ?? path.join(hub, '..', 'scripts')
  const out = option('--out') ?? path.join(vendorDir, 'fleetmates')
  if (!existsSync(path.join(from, ENTRIES[0]))) throw new Error(`no fleetmates scripts at ${from}; vendor from a fleetmates checkout`)
  const files = closure(from)
  rmSync(out, { recursive: true, force: true })
  for (const [relative, source] of files) {
    mkdirSync(path.dirname(path.join(out, relative)), { recursive: true })
    writeFileSync(path.join(out, relative), source)
  }
  process.stdout.write(`vendored ${[...files.keys()].sort().join(', ')} into ${out}\n`)
}

if (import.meta.main) {
  try { main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`vendor-fleetmates: ${error.message}\n`)
    process.exitCode = 1
  }
}
