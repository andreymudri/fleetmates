// The effective tiers set (docs/deck/07-approvals.md 4.1): the shipped defaults, minus the
// entries the user's tiers.json disables, plus the user's entries. The user file is watched; a
// parse or schema error keeps the last valid set and is reported by `status()`, so an edit can
// never fall back to a more permissive set.
import { readFileSync, watch as watchFs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_TIERS, tiersSha256 } from './tiers.mjs'

const TOP_KEYS = Object.freeze(['$schema', 'version', 'extends', 'disable', 'entries'])
/** The entry fields tiers.schema.json allows. */
export const ENTRY_KEYS = Object.freeze(['id', 'tier', 'tool', 'cmd', 'anyArg', 'noneArg', 'allowOpts', 'outputOpts', 'longOpts', 'pathOperands', 'operandOpts', 'forwardOpts', 'script', 'sql', 'path', 'domain', 'rule', 'ruleNote', 'description', 'confirm', 'count', 'floor'])
const TIER_NAMES = ['safe', 'caution', 'destructive']
const COUNTS = ['push_overwritten', 'reset_files', 'clean_files', 'rm_paths']
const ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_:-]+)+$/

class TiersError extends Error {
  constructor(message, id = null) {
    super(message)
    this.id = id
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringList = (value, name, id) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) throw new TiersError(`${name} of ${id} must be a list of non-empty strings`, id)
}

function checkEntry(entry, { user }) {
  if (!isObject(entry)) throw new TiersError('every entry must be an object')
  const id = typeof entry.id === 'string' ? entry.id : null
  if (!id || !ID.test(id)) throw new TiersError(`entry id ${JSON.stringify(entry.id ?? null)} must be dotted, such as safe.family.name`, id)
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) throw new TiersError(`${id} has an unknown field ${key}`, id)
  if (!TIER_NAMES.includes(entry.tier)) throw new TiersError(`${id} needs a tier of safe, caution or destructive`, id)
  if (typeof entry.tool !== 'string' || !entry.tool) throw new TiersError(`${id} needs a tool`, id)
  if (entry.cmd !== undefined && (typeof entry.cmd !== 'string' || !entry.cmd.trim() || entry.tool !== 'Bash')) throw new TiersError(`cmd of ${id} must be a non-empty string on a Bash entry`, id)
  for (const key of ['anyArg', 'noneArg', 'allowOpts', 'outputOpts', 'operandOpts', 'forwardOpts', 'script']) if (entry[key] !== undefined) stringList(entry[key], key, id)
  if (entry.longOpts !== undefined && (!Array.isArray(entry.longOpts) || entry.longOpts.some(option => typeof option !== 'string' || !/^--[^=*]+$/.test(option)))) throw new TiersError(`longOpts of ${id} must be long options such as --force`, id)
  if (entry.pathOperands !== undefined && !['all', 'none', 'afterFirst'].includes(entry.pathOperands)) throw new TiersError(`pathOperands of ${id} must be all, none or afterFirst`, id)
  if (entry.sql !== undefined && !['read', 'write'].includes(entry.sql)) throw new TiersError(`sql of ${id} must be read or write`, id)
  if ((entry.script !== undefined || entry.sql !== undefined) && entry.cmd === undefined) throw new TiersError(`${id} needs cmd for script or sql`, id)
  if (entry.path !== undefined && !['inRepo', 'outsideRepo'].includes(entry.path)) stringList(entry.path, 'path', id)
  if (entry.domain !== undefined && (typeof entry.domain !== 'string' || !entry.domain)) throw new TiersError(`domain of ${id} must be a string`, id)
  if (entry.rule !== undefined && entry.rule !== null && typeof entry.rule !== 'string') throw new TiersError(`rule of ${id} must be a string or null`, id)
  if (typeof entry.rule === 'string' && entry.tier !== 'safe') throw new TiersError(`only a Safe entry can carry a rule (${id})`, id)
  if (entry.ruleNote !== undefined && (entry.ruleNote !== 'anyFlags' || entry.tier !== 'safe')) throw new TiersError(`ruleNote of ${id} must be anyFlags on a Safe entry`, id)
  if (entry.description !== undefined && typeof entry.description !== 'string') throw new TiersError(`description of ${id} must be a string`, id)
  if (entry.confirm !== undefined && (typeof entry.confirm !== 'string' || !entry.confirm || entry.tier !== 'destructive')) throw new TiersError(`confirm of ${id} must be a label on a Destructive entry`, id)
  if (entry.count !== undefined && (!COUNTS.includes(entry.count) || entry.tier !== 'destructive' || entry.confirm === undefined)) throw new TiersError(`count of ${id} must be one of ${COUNTS.join(', ')} on a Destructive entry with confirm`, id)
  if (entry.floor !== undefined && typeof entry.floor !== 'boolean') throw new TiersError(`floor of ${id} must be true or false`, id)
  if (user && entry.floor !== undefined) throw new TiersError(`floor is for the shipped defaults only (${id})`, id)
}

/**
 * Validate a parsed tiers file against tiers.schema.json, and a user file against the defaults
 * (no duplicate ids, no disabled floor entry).
 * @param {unknown} value
 * @param {{ user?: boolean, defaults?: { entries: object[] } }} [options]
 * @returns {{ ok: true } | { ok: false, message: string, id: string|null }}
 */
export function validateTiers(value, { user = false, defaults = DEFAULT_TIERS } = {}) {
  try {
    if (!isObject(value)) throw new TiersError('the file must hold a JSON object')
    for (const key of Object.keys(value)) if (!TOP_KEYS.includes(key)) throw new TiersError(`unknown field ${key}`)
    if (value.version !== 1) throw new TiersError('version must be 1')
    if (value.extends !== undefined && value.extends !== 'default' && value.extends !== null) throw new TiersError('extends must be "default" or null')
    if (value.$schema !== undefined && typeof value.$schema !== 'string') throw new TiersError('$schema must be a string')
    if (value.disable !== undefined) {
      stringList(value.disable, 'disable', 'the file')
      if (new Set(value.disable).size !== value.disable.length) throw new TiersError('disable lists an id twice')
    }
    if (value.entries !== undefined && !Array.isArray(value.entries)) throw new TiersError('entries must be a list')
    const ids = new Set(user ? (defaults.entries ?? []).map(entry => entry.id) : [])
    for (const entry of value.entries ?? []) {
      checkEntry(entry, { user })
      if (ids.has(entry.id)) throw new TiersError(`id ${entry.id} is used twice; disable the default entry to replace it`, entry.id)
      ids.add(entry.id)
    }
    if (user) {
      const floors = new Set((defaults.entries ?? []).filter(entry => entry.floor === true).map(entry => entry.id))
      const floor = (value.disable ?? []).find(id => floors.has(id))
      if (floor) throw new TiersError(`${floor} is a floor entry and cannot be disabled`, floor)
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof TiersError) return { ok: false, message: error.message, id: error.id }
    throw error
  }
}

/**
 * The effective set for a valid user file: the defaults minus `disable` plus the user's entries.
 * With `extends: null` the user's entries replace the defaults, except the floor entries.
 * @param {{ entries: object[] }} defaults
 * @param {object|null} user
 * @returns {{ entries: object[] }}
 */
export function effectiveTiers(defaults, user) {
  const base = defaults.entries ?? []
  if (!user) return { entries: [...base] }
  const disabled = new Set(user.disable ?? [])
  const kept = user.extends === null ? base.filter(entry => entry.floor === true) : base.filter(entry => entry.floor === true || !disabled.has(entry.id))
  return { entries: [...kept, ...(user.entries ?? [])] }
}

const lineAt = (text, index) => text.slice(0, Math.max(0, index)).split('\n').length

function parseError(text, error) {
  const message = String(error?.message ?? error)
  const line = /line (\d+)/.exec(message)?.[1]
  if (line) return { line: Number(line), message }
  const position = /position (\d+)/.exec(message)?.[1]
  return { line: position ? lineAt(text, Number(position)) : 1, message }
}

/**
 * Load, validate and watch the user's tiers.json over the shipped defaults.
 * @param {{ file: string, defaults?: { entries: object[] }, watch?: boolean, debounceMs?: number }} options
 * @returns {{ current: () => { entries: object[] }, sha256: () => string, status: () => { ok: boolean, line: number|null, message: string|null }, onChange: (fn: (tiers: { entries: object[] }) => void) => () => void, reload: () => boolean, close: () => void }}
 */
export function createTiersStore({ file, defaults = DEFAULT_TIERS, watch = true, debounceMs = 50 } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('tiers store needs an absolute file path')
  let current = effectiveTiers(defaults, null)
  let sha = tiersSha256(current)
  let state = { ok: true, line: null, message: null }
  const listeners = new Set()
  let watcher = null
  let timer = null

  const reload = () => {
    let text
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') { state = { ok: false, line: null, message: `could not read tiers.json: ${error.code ?? error.message}` }; return false }
      text = null
    }
    let user = null
    if (text !== null) {
      try { user = JSON.parse(text) } catch (error) {
        const { line, message } = parseError(text, error)
        state = { ok: false, line, message }
        return false
      }
      const verdict = validateTiers(user, { user: true, defaults })
      if (!verdict.ok) {
        const at = verdict.id ? text.indexOf(JSON.stringify(verdict.id)) : -1
        state = { ok: false, line: at >= 0 ? lineAt(text, at) : 1, message: verdict.message }
        return false
      }
    }
    const next = effectiveTiers(defaults, user)
    const nextSha = tiersSha256(next)
    state = { ok: true, line: null, message: null }
    if (nextSha === sha) return true
    current = next
    sha = nextSha
    for (const listener of listeners) {
      try { listener(current) } catch {}
    }
    return true
  }

  reload()
  if (watch) {
    try {
      watcher = watchFs(path.dirname(file), (event, name) => {
        if (name !== null && name !== path.basename(file)) return
        clearTimeout(timer)
        timer = setTimeout(reload, debounceMs)
      })
      watcher.on('error', () => {})
    } catch { watcher = null }
  }
  return {
    current: () => current,
    sha256: () => sha,
    status: () => ({ ...state }),
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    reload,
    close() {
      clearTimeout(timer)
      watcher?.close()
      watcher = null
      listeners.clear()
    }
  }
}
