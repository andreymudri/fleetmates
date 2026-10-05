// Read-only heuristics before install approvals. Nothing here executes an extension.
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fleetmatesScriptsDir } from '../adapters/fleetmates.mjs'
import { parseCommand, commandBase } from './shell.mjs'
const { scanShippedInstructions, lintInstructionText, MAX_INSTRUCTION_BYTES } = await import(pathToFileURL(path.join(fleetmatesScriptsDir(), 'security-lint.mjs')).href)
const rank = { safe: 0, caution: 1, destructive: 2 }

async function scanFile(file, label) {
  const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await h.stat()
    if (!stat.isFile() || await realpath(file) !== file) throw new Error('unsafe scan target')
    if (stat.size > MAX_INSTRUCTION_BYTES) return [{ path: label, line: 1, rule: 'file-too-large' }]
    const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1)
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_INSTRUCTION_BYTES) return [{ path: label, line: 1, rule: 'file-too-large' }]
    return lintInstructionText(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)), label)
  } finally { await h.close() }
}

export async function scanExtension({ root, kind }) {
  if (!['skill', 'plugin', 'mcp'].includes(kind) || typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('invalid extension scan')
  const base = { kind, coverage: 'instruction-heuristics', externalScanners: false }
  try {
    const absolute = path.resolve(root)
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error('linked scan target')
    let findings = [], files = 0
    if (stat.isFile()) { findings = await scanFile(absolute, path.basename(absolute)); files = 1 }
    else if (stat.isDirectory()) {
      const scan = await scanShippedInstructions(absolute)
      findings = scan.findings; files = scan.files
      for (const name of ['SKILL.md', 'AGENTS.md']) {
        const file = path.join(absolute, name)
        try { findings.push(...await scanFile(file, name)); files += 1 }
        catch (err) { if (err.code !== 'ENOENT') throw err }
      }
    } else throw new Error('non-regular scan target')
    const destructive = findings.some(finding => ['refusal-override', 'provider-shell-out'].includes(finding.rule))
    const tier = destructive ? 'destructive' : findings.length || !files || kind !== 'skill' ? 'caution' : 'safe'
    return { ...base, state: 'scanned', tier, files, findings: findings.slice(0, 100),
      description: destructive ? 'Instruction scan found refusal overrides or model shell-outs.' : tier === 'safe' ? 'Instruction scan found no flagged patterns; review the source before installing.' : 'Review flagged or unscanned extension code before installing.' }
  } catch {
    return { ...base, state: 'unverified', tier: 'caution', files: 0, findings: [], description: 'Extension source could not be scanned locally. Review it before installing.' }
  }
}

export function extensionTargets(row, session) {
  if (row.kind !== 'permission' || row.tool_name !== 'Bash') return []
  let input
  try { input = JSON.parse(row.detail) } catch { return [] }
  const parsed = parseCommand(input?.command ?? '', { cwd: session?.cwd ?? session?.repo_id })
  const targets = []
  for (const segment of parsed.segments ?? []) {
    const words = segment.words
    let kind
    if (commandBase(words?.[0] ?? '') === 'claude' && words[1] === 'plugin' && words[2] === 'install') kind = 'plugin'
    else if (commandBase(words?.[0] ?? '') === 'claude' && words[1] === 'mcp' && ['add', 'add-json'].includes(words[2])) kind = 'mcp'
    else if (['skill', 'skills'].includes(commandBase(words?.[0] ?? '')) && ['add', 'install'].includes(words[1])) kind = 'skill'
    if (!kind) continue
    const local = segment.literal ? words.slice(kind === 'skill' ? 2 : 3).find(word => word.startsWith('./') || word.startsWith('../') || path.isAbsolute(word)) : null
    targets.push({ kind, root: local ? path.resolve(segment.cwd ?? session?.cwd ?? session?.repo_id ?? '.', local) : null })
  }
  return targets
}

export async function scanInstallRequest(row, session) {
  const targets = extensionTargets(row, session)
  if (!targets.length) return null
  const reports = []
  for (const target of targets.slice(0, 20)) reports.push(target.root ? await scanExtension(target) : { kind: target.kind, state: 'unverified', tier: 'caution', files: 0, findings: [], coverage: 'instruction-heuristics', externalScanners: false, description: 'Remote extension source is unverified; review it before installing.' })
  if (targets.length > 20) reports.push({ state: 'unverified', tier: 'caution', description: 'The extension scan limit was reached.' })
  const tier = reports.reduce((best, report) => rank[report.tier] > rank[best] ? report.tier : best, 'safe')
  return { entryId: 'extension.scan', tier, description: reports.find(report => report.tier === tier)?.description, scans: reports }
}
