import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Largest `config.yaml` the reader accepts, in bytes. */
export const CONFIG_MAX_BYTES = 256 * 1024

const DEFAULT_RELATIVE = 'dev/turbidassist/config.yaml'
const TRUE_WORDS = new Set(['true', 'True', 'TRUE'])
const NULL_WORDS = new Set(['null', 'Null', 'NULL', '~'])

class ConfigError extends Error {
  constructor(code, line, message) {
    super(message)
    this.code = code
    this.line = line
  }
}

function expandHome(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  return value
}

/**
 * Locate TurbidAssist's `config.yaml` (MEET-O11).
 * @param {{ pref?: string | null, home: string, exists?: (file: string) => boolean }} options
 * @returns {string | null} The `turbidassistConfig` pref with `~/` expanded against `home`; when the pref is
 *   empty, `<home>/dev/turbidassist/config.yaml` if `exists` says it is there; else null.
 */
export function locateConfig({ pref = null, home, exists = fs.existsSync } = {}) {
  if (typeof pref === 'string' && pref.trim() !== '') return expandHome(pref.trim(), home)
  const fallback = path.join(home, DEFAULT_RELATIVE)
  return exists(fallback) ? fallback : null
}

// What the deck needs at each key path: 'scalar' (parsed value), 'map' (a block mapping, anything else is
// unsupported), 'optmap' (descended when it is a block mapping, skipped otherwise), 'presence' (only whether the
// key exists) or null (skipped by indentation whatever it holds).
function needKind(keys) {
  const [a, b, c, d] = keys
  if (keys.length === 1) {
    if (a === 'session_dir') return 'scalar'
    if (a === 'vault' || a === 'batch' || a === 'synthesis') return 'map'
    if (a === 'ask') return 'optmap'
    return null
  }
  if (keys.length === 2) {
    if (a === 'vault' && (b === 'path' || b === 'meetings_folder')) return 'scalar'
    if (a === 'batch' && b === 'model') return 'scalar'
    if (a === 'synthesis' && b === 'default_tag') return 'scalar'
    if (a === 'synthesis' && b === 'tag_policies') return 'map'
    if (a === 'ask' && b === 'vault_mcp') return 'presence'
    return null
  }
  if (a !== 'synthesis' || b !== 'tag_policies') return null
  if (keys.length === 3) return 'map'
  if (keys.length === 4 && d === 'store_transcript' && c !== undefined) return 'scalar'
  return null
}

const isSequenceEntry = body => body === '-' || body.startsWith('- ')

// Parse a quoted scalar starting at body[start]; returns { text, end } where end is the index after the closing quote.
function parseQuoted(body, start, line) {
  const quote = body[start]
  let text = ''
  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i]
    if (quote === "'") {
      if (ch === "'") {
        if (body[i + 1] === "'") { text += "'"; i++; continue }
        return { text, end: i + 1 }
      }
      text += ch
      continue
    }
    if (ch === '"') return { text, end: i + 1 }
    if (ch === '\\') {
      const next = body[i + 1]
      if (next === '"' || next === '\\') text += next
      else if (next === 'n') text += '\n'
      else throw new ConfigError('unsupported', line, `unsupported escape \\${next ?? ''} in a double-quoted value`)
      i++
      continue
    }
    text += ch
  }
  throw new ConfigError('syntax', line, 'unterminated quoted value')
}

function afterValue(rest, line) {
  const trimmed = rest.trim()
  if (trimmed !== '' && !trimmed.startsWith('#')) throw new ConfigError('syntax', line, 'unexpected text after a quoted value')
}

// Split a `key: value` body into the key and the raw text after the colon (leading spaces removed).
function splitKey(body, line) {
  let key
  let index
  if (body[0] === '"' || body[0] === "'") {
    const quoted = parseQuoted(body, 0, line)
    key = quoted.text
    index = quoted.end
    while (body[index] === ' ') index++
    if (body[index] !== ':') throw new ConfigError('syntax', line, 'expected ":" after a quoted key')
  } else {
    const match = /:(?=[ ]|$)/.exec(body)
    if (!match) throw new ConfigError('syntax', line, 'expected "key: value"')
    key = body.slice(0, match.index).trimEnd()
    index = match.index
    if (key === '') throw new ConfigError('syntax', line, 'empty key')
    if (/^[[{&*!|>%@`]/.test(key)) throw new ConfigError('unsupported', line, 'unsupported key syntax')
  }
  const after = body.slice(index + 1)
  if (after !== '' && after[0] !== ' ') throw new ConfigError('syntax', line, 'expected a space after ":"')
  return { key, raw: after.trimStart() }
}

const isEmptyValue = raw => raw === '' || raw.startsWith('#')

// Parse the inline value of a needed scalar key. Returns { text, quoted } or null for an explicit null.
function parseScalar(raw, line, name) {
  const first = raw[0]
  if (first === '"' || first === "'") {
    const quoted = parseQuoted(raw, 0, line)
    afterValue(raw.slice(quoted.end), line)
    return { text: quoted.text, quoted: true }
  }
  if ('[{&*!|>%@`'.includes(first)) throw new ConfigError('unsupported', line, `unsupported value for ${name}`)
  const comment = /\s#/.exec(raw)
  const text = (comment ? raw.slice(0, comment.index) : raw).trimEnd()
  if (NULL_WORDS.has(text)) return null
  return { text, quoted: false }
}

/**
 * Read the subset of TurbidAssist's `config.yaml` the deck needs, without a YAML dependency.
 * Line based: `#` comments outside quotes, space indentation (a tab is `syntax`), `key: value` with plain,
 * single-quoted or double-quoted scalars and nested block mappings. Sequences, flow collections, anchors, aliases,
 * tags and block scalars are skipped by indentation under keys the deck does not need and are `unsupported` as the
 * value of a needed key.
 * @param {string} text
 * @param {{ path?: string | null, home?: string }} [options]
 * @returns {{ ok: true, path: string | null, sessionDir: string, vaultPath: string | null,
 *   meetingsFolder: string | null, defaultTag: string | null,
 *   tags: { tag: string, confidential: boolean, isDefault: boolean }[], batchModel: string | null,
 *   askVaultMcp: boolean } | { ok: false, path: string | null, error: { code: string, line: number | null,
 *   message: string } }}
 */
export function parseConfig(text, { path: file = null, home = homedir() } = {}) {
  try {
    return { ok: true, path: file, ...parseSubset(text, home) }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { ok: false, path: file, error: { code: error.code, line: error.line, message: error.message } }
  }
}

function parseSubset(text, home) {
  const values = new Map()
  const lines = new Map()
  const tags = []
  const stored = new Map()
  let askVaultMcp = false
  let seenContent = false
  const stack = [{ indent: null, keys: [] }]
  let pending = null
  let skip = null

  const idOf = keys => keys.join('\u0000')
  const setScalar = (keys, value, line) => {
    const id = idOf(keys)
    values.set(id, value)
    lines.set(id, line)
    if (keys.length === 4) stored.set(keys[2], value !== null && !value.quoted && TRUE_WORDS.has(value.text))
  }
  const closePending = () => {
    if (pending && pending.kind === 'scalar') setScalar(pending.keys, null, pending.line)
    pending = null
  }
  // PyYAML keeps the last of duplicate mapping keys and drops the earlier value whole (no merge), so a key seen
  // again forgets everything recorded under it. A replaced tag keeps its first position, as a Python dict does.
  const forget = keys => {
    const id = idOf(keys)
    for (const known of [...values.keys()]) {
      if (known === id || known.startsWith(`${id}\u0000`)) { values.delete(known); lines.delete(known) }
    }
    const [a, b] = keys
    if (a === 'synthesis' && (keys.length === 1 || (keys.length === 2 && b === 'tag_policies'))) {
      tags.length = 0
      stored.clear()
    }
    if (keys.length === 3 && a === 'synthesis' && b === 'tag_policies') stored.delete(keys[2])
    if (keys.length === 1 && a === 'ask') askVaultMcp = false
  }

  const source = text.split(/\r?\n/)
  for (let index = 0; index < source.length; index++) {
    const line = index + 1
    const raw = source[index]
    const lead = /^[ \t]*/.exec(raw)[0]
    const body = raw.slice(lead.length).trimEnd()
    const indent = lead.length
    if (skip) {
      // Inside a skipped value only the leading spaces count, so a tab in a block scalar's text is content.
      const spaces = /^ */.exec(raw)[0].length
      if (body === '') continue
      if (spaces > skip.indent) {
        if (skip.fail) throw new ConfigError('unsupported', line, `unsupported multi-line value for ${skip.fail}`)
        continue
      }
      if (skip.sequence && !lead.includes('\t') && indent === skip.indent && isSequenceEntry(body)) continue
      skip = null
    }
    if (body === '' || body.startsWith('#')) continue
    if (lead.includes('\t')) throw new ConfigError('syntax', line, 'tab in indentation')
    if (indent === 0 && (body === '---' || body.startsWith('--- ') || body === '...')) {
      if (seenContent) throw new ConfigError('unsupported', line, 'more than one YAML document')
      continue
    }
    seenContent = true

    if (pending) {
      const sequence = (indent > pending.indent || indent === pending.indent) && isSequenceEntry(body)
      if (sequence || indent > pending.indent) {
        const { kind, keys } = pending
        const name = keys.join('.')
        if (sequence) {
          if (kind === 'scalar' || kind === 'map') throw new ConfigError('unsupported', line, `a sequence is not supported for ${name}`)
          skip = { indent: pending.indent, sequence: true, fail: null }
          pending = null
          continue
        }
        if (kind === 'scalar') throw new ConfigError('unsupported', line, `a nested mapping is not supported for ${name}`)
        if (kind === 'map' || kind === 'optmap') {
          stack.push({ indent, keys })
          pending = null
        } else {
          skip = { indent: pending.indent, sequence: false, fail: null }
          pending = null
          continue
        }
      } else {
        closePending()
      }
    }

    while (stack.length > 1 && stack.at(-1).indent > indent) stack.pop()
    const top = stack.at(-1)
    if (top.indent === null) top.indent = indent
    if (top.indent !== indent) throw new ConfigError('syntax', line, 'unexpected indentation')
    if (isSequenceEntry(body)) throw new ConfigError('unsupported', line, 'a sequence is not supported here')

    const { key, raw: value } = splitKey(body, line)
    const keys = [...top.keys, key]
    const kind = needKind(keys)
    const name = keys.join('.')
    forget(keys)
    if (kind === 'presence') askVaultMcp = true
    if (keys.length === 3 && kind === 'map' && !tags.includes(key)) tags.push(key)

    if (isEmptyValue(value)) {
      pending = { indent, keys, kind, line }
      continue
    }
    if (kind === 'scalar') setScalar(keys, parseScalar(value, line, name), line)
    else if (kind === 'map') throw new ConfigError('unsupported', line, `${name} must be a block mapping`)
    skip = { indent, sequence: false, fail: kind === 'scalar' ? name : null }
  }
  closePending()

  const scalar = name => values.get(idOf(name.split('.')))?.text ?? null
  const absolute = name => {
    const value = scalar(name)
    if (value === null) return null
    const expanded = expandHome(value, home)
    if (!path.isAbsolute(expanded)) throw new ConfigError('unsupported', lines.get(idOf(name.split('.'))) ?? null, `${name} must be an absolute path`)
    return expanded
  }
  const sessionDir = absolute('session_dir')
  if (sessionDir === null) throw new ConfigError('missing_key', null, 'session_dir is missing')
  const defaultTag = scalar('synthesis.default_tag')
  return {
    sessionDir,
    vaultPath: absolute('vault.path'),
    meetingsFolder: scalar('vault.meetings_folder'),
    defaultTag,
    tags: tags.map(tag => ({ tag, confidential: stored.get(tag) !== true, isDefault: tag === defaultTag })),
    batchModel: scalar('batch.model'),
    askVaultMcp
  }
}

/**
 * Read and parse `config.yaml` (see `parseConfig`). Errors: `not_found` (no file, or `file` is null),
 * `unreadable` (not a regular file, or a read error), `too_large` (over 256 KiB), then the parser's codes.
 * @param {string | null} file
 * @param {{ home?: string, fs?: typeof fs }} [options]
 */
export function readConfig(file, { home = homedir(), fs: files = fs } = {}) {
  const fail = (code, message) => ({ ok: false, path: file ?? null, error: { code, line: null, message } })
  if (typeof file !== 'string' || file === '') return fail('not_found', 'no TurbidAssist config located')
  let fd
  try {
    fd = files.openSync(file, 'r')
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? fail('not_found', `${error.code} opening the config`) : fail('unreadable', `${error.code ?? 'error'} opening the config`)
  }
  try {
    const stat = files.fstatSync(fd)
    if (!stat.isFile()) return fail('unreadable', 'the config is not a regular file')
    if (stat.size > CONFIG_MAX_BYTES) return fail('too_large', `the config is over ${CONFIG_MAX_BYTES} bytes`)
    const buffer = Buffer.alloc(CONFIG_MAX_BYTES + 1)
    let length = 0
    for (;;) {
      const read = files.readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
      if (length > CONFIG_MAX_BYTES) return fail('too_large', `the config is over ${CONFIG_MAX_BYTES} bytes`)
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      return fail('syntax', 'the config is not valid UTF-8')
    }
    return parseConfig(text.replace(/^﻿/, ''), { path: file, home })
  } catch (error) {
    return fail('unreadable', `${error.code ?? 'error'} reading the config`)
  } finally {
    try { files.closeSync(fd) } catch {}
  }
}

/**
 * The confidentiality policy of a tag (DB-O2, fail closed): confidential unless the config read ok, lists the tag
 * and its `store_transcript` is true.
 * @param {ReturnType<typeof parseConfig> | null | undefined} config
 * @param {string} tag
 * @returns {{ confidential: boolean }}
 */
export function policyFor(config, tag) {
  if (!config || config.ok !== true) return { confidential: true }
  const entry = config.tags.find(item => item.tag === tag)
  return { confidential: entry ? entry.confidential === true : true }
}

/**
 * Watch the located config's directory and re-read it after a change (debounced) and on `reload()`.
 * `onChange(config)` runs only when the result differs from the last one. The first read happens at creation
 * and is available from `current()` without calling `onChange`.
 * @param {{ locate: () => string | null, read: (file: string | null) => object, onChange?: (config: object) => void,
 *   debounceMs?: number, watch?: typeof fs.watch,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} options
 * @returns {{ current: () => object, reload: () => object, close: () => void }}
 */
export function createConfigWatcher({ locate, read, onChange = () => {}, debounceMs = 1000, watch = fs.watch, timers = { setTimeout, clearTimeout } }) {
  let closed = false
  let timer = null
  let handle = null
  let watchedDir = null
  let config = null
  let signature = null

  function arm(file) {
    const dir = file ? path.dirname(file) : null
    if (dir === watchedDir) return
    if (handle) { try { handle.close() } catch {} }
    handle = null
    watchedDir = dir
    if (!dir) return
    try {
      handle = watch(dir, () => schedule())
      handle?.on?.('error', () => { try { handle?.close() } catch {} handle = null; watchedDir = null })
      handle?.unref?.()
    } catch {
      handle = null
      watchedDir = null
    }
  }
  function schedule() {
    if (closed) return
    if (timer !== null) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => { timer = null; reload() }, debounceMs)
    timer?.unref?.()
  }
  function load() {
    const file = locate()
    arm(file)
    const next = read(file)
    const nextSignature = JSON.stringify(next)
    const changed = nextSignature !== signature
    config = next
    signature = nextSignature
    return changed
  }
  function reload() {
    if (closed) return config
    if (timer !== null) { timers.clearTimeout(timer); timer = null }
    if (load()) onChange(config)
    return config
  }
  load()
  return {
    current: () => config,
    reload,
    close() {
      closed = true
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
      if (handle) { try { handle.close() } catch {} }
      handle = null
    }
  }
}
