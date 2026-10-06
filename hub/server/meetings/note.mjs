import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readInside } from './history.mjs'

/** Largest meeting note read. */
export const NOTE_CAP = 1024 * 1024

const NO_DECISIONS = 'Nenhuma decisão registrada.'
const NO_ITEMS = 'Nenhum action item registrado.'
const OWNER_MAX = 40

const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)
const inside = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * The frontmatter `session_id` of a note, or null.
 * @param {string} text
 * @returns {string|null}
 */
export function frontmatterSessionId(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0] !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return null
    const m = /^session_id:\s*(.*?)\s*$/.exec(lines[i])
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2')
  }
  return null
}

/**
 * Find a meeting's synthesized note on disk (MTG-O1): list `<vaultPath>/<meetingsFolder>` (its realpath inside
 * the vault's), keep regular `.md` files of at most 1 MiB whose name starts with `<date> <tag> `, read each with
 * `O_NOFOLLOW` and return the vault-relative path of the one whose frontmatter `session_id` is `id`.
 * @param {{ vaultPath: string, meetingsFolder: string, id: string, tag: string, date: string }} where
 * @returns {Promise<string|null>}
 */
export async function findNote({ vaultPath, meetingsFolder, id, tag, date }) {
  if (![vaultPath, meetingsFolder, id, tag, date].every(v => typeof v === 'string' && v && !v.includes('\0'))) return null
  let vault
  let folder
  try {
    vault = await fs.realpath(vaultPath)
    folder = await fs.realpath(path.resolve(vault, meetingsFolder))
  } catch (error) { if (missing(error)) return null; throw error }
  if (folder === vault || !inside(vault, folder)) return null
  const relFolder = path.relative(vault, folder)
  const prefix = `${date} ${tag} `
  const entries = await fs.readdir(folder, { withFileTypes: true })
  const names = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name.startsWith(prefix)).map(e => e.name).sort()
  for (const name of names) {
    let file
    try { file = await readInside(vault, [relFolder, name], NOTE_CAP) } catch { continue }
    if (file && frontmatterSessionId(file.bytes.toString('utf8')) === id) return path.join(relFolder, name)
  }
  return null
}

/**
 * Read a meeting note by its vault-relative path, with the realpath inside the vault, `O_NOFOLLOW`, a regular-file
 * check and the 1 MiB cap.
 * @param {{ vaultPath: string, notePath: string }} where
 * @returns {Promise<string|null>} null when the note does not exist
 * @throws {import('./history.mjs').MeetingFileError} for a refused file
 */
export async function readNote({ vaultPath, notePath }) {
  if (typeof notePath !== 'string' || !notePath.endsWith('.md') || notePath.includes('\0') || path.isAbsolute(notePath)) return null
  const file = await readInside(vaultPath, notePath.split(/[\\/]/), NOTE_CAP)
  return file ? file.bytes.toString('utf8') : null
}

/**
 * The dismissal key of an action item: sha1 hex of its text normalized with NFC, trimmed and with whitespace
 * runs collapsed to one space.
 * @param {string} text
 * @returns {string}
 */
export function itemKey(text) {
  return createHash('sha1').update(text.normalize('NFC').trim().replace(/\s+/g, ' ')).digest('hex')
}

/**
 * The owner of an action item: the text before the first `:` when it is at most 40 characters and holds no
 * `.`, `!` or `?`; else null.
 * @param {string} text
 * @returns {{ owner: string|null, text: string }}
 */
export function splitOwner(text) {
  const i = text.indexOf(':')
  if (i <= 0) return { owner: null, text }
  const owner = text.slice(0, i).trim()
  if (!owner || owner.length > OWNER_MAX || /[.!?]/.test(owner)) return { owner: null, text }
  return { owner, text: text.slice(i + 1).trim() }
}

const stripFrontmatter = text => {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0] !== '---') return lines
  const end = lines.indexOf('---', 1)
  return end < 0 ? lines : lines.slice(end + 1)
}

/**
 * Parse a postmeet meeting note (contract 2.9): `title` from the H1, `summary` from `## Resumo`, `decisions`
 * from `## Decisões` list items and `actionItems` from the `- [ ] ` lines of `## Action items`. The placeholders
 * "Nenhuma decisão registrada." and "Nenhum action item registrado." give empty lists; `## Transcript`,
 * `## Perguntas ao vivo` and any other section are skipped. Everything comes back as plain text.
 * @param {string} text
 * @returns {{ title: string|null, summary: string, decisions: string[], actionItems: { key: string, text: string, owner: string|null }[] }}
 */
export function parseNote(text) {
  let title = null
  let section = null
  const summary = []
  const decisions = []
  const actionItems = []
  for (const line of stripFrontmatter(String(text))) {
    const h1 = /^# (.+?)\s*$/.exec(line)
    if (h1) { if (title === null) title = h1[1]; section = null; continue }
    const h2 = /^## (.+?)\s*$/.exec(line)
    if (h2) { section = h2[1]; continue }
    if (/^#{1,6} /.test(line)) { section = null; continue }
    if (section === 'Resumo') summary.push(line)
    else if (section === 'Decisões') {
      const m = /^\s*[-*] (.+?)\s*$/.exec(line)
      if (m && m[1] !== NO_DECISIONS) decisions.push(m[1])
    } else if (section === 'Action items') {
      const m = /^\s*[-*] \[[ xX]\] (.+?)\s*$/.exec(line)
      if (m && m[1] !== NO_ITEMS) {
        const { owner, text: rest } = splitOwner(m[1])
        actionItems.push({ key: itemKey(m[1]), text: rest, owner })
      }
    }
  }
  return { title, summary: summary.join('\n').trim(), decisions, actionItems }
}
