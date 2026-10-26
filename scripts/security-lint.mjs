import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGit } from './git.mjs'

export const MAX_INSTRUCTION_FILES = 256
export const MAX_INSTRUCTION_BYTES = 512 * 1024
const finding = (file, line, rule) => ({ path: file, line, rule })
export const isInstructionPath = file => /(?:^|\/)(?:skills|agents)\/.+\.md$/i.test(file) || /(?:^|\/)AGENTS\.md$/.test(file)

/** Heuristic findings are review signals, not proof that an instruction is safe. */
export function lintInstructionText(text, file) {
  if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_BYTES) return [finding(file, 1, 'file-too-large')]
  const results = []
  const add = (index, rule) => {
    if (results.length > 100) return
    if (results.length === 100) { results.push(finding(file, 1, 'finding-limit')); return }
    results.push(finding(file, text.slice(0, index).split('\n').length, rule))
  }
  for (const match of text.matchAll(/[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/gu)) {
    if (!['\t', '\n', '\r'].includes(match[0])) add(match.index, 'invisible-unicode')
  }
  for (const match of text.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    if ((/\p{Script=Latin}/u.test(match[0]) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(match[0])) || (match[0].normalize('NFKC') !== match[0] && /^[A-Za-z0-9_-]+$/.test(match[0].normalize('NFKC')))) add(match.index, 'confusable-word')
  }
  let commentAt = 0
  while ((commentAt = text.indexOf('<!--', commentAt)) !== -1) {
    const end = text.indexOf('-->', commentAt + 4)
    if (end === -1) { add(commentAt, 'hidden-text'); break }
    if (!/^[a-z0-9_-]{1,50}$/i.test(text.slice(commentAt + 4, end).trim())) add(commentAt, 'hidden-text')
    commentAt = end + 3
  }
  for (const match of text.matchAll(/<[^<>]{1,2000}>/g)) {
    if (/(?:\s)hidden(?:\s|=|>)|display\s*:\s*none|opacity\s*:\s*0(?:\.0+)?(?=[;\s"'/>]|$)|font-size\s*:\s*0(?:\.0+)?(?:px|em|rem|%)?(?=[;\s"'/>]|$)|[;\s"']color\s*:\s*transparent/i.test(match[0])) add(match.index, 'hidden-text')
  }
  const rules = [
    ['padded-text', /[ \t]{80}/g],
    ['refusal-override', /\b(?:never refuse|do not refuse|always comply|ignore (?:all )?(?:previous|system|safety) instructions|disregard (?:all )?(?:safety|security) policies)\b/gi],
    ['provider-shell-out', /\b(?:ollama\s+(?:run|chat)|codex\s+exec|claude\s+(?:-p|--print)|gemini\s+(?:-p|--prompt))\b/gi],
    ['provider-shell-out', /\b(?:curl|wget|Invoke-WebRequest)\b[^\n]{0,1000}https?:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)(?:\/|\b)/gi],
  ]
  for (const [rule, pattern] of rules) for (const match of text.matchAll(pattern)) add(match.index, rule)
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (header) {
    const match = /^description:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/m.exec(header[1])
    const description = match?.[1].replace(/\s+/g, ' ').trim()
    // The shipped entrypoint intentionally routes session startup. Its exact scope is approved;
    // a different name, description or path does not inherit this exception.
    const entrypoint = file === 'skills/using-fleetmates/SKILL.md' && /^name: using-fleetmates$/m.test(header[1]) && description === 'Use when starting any conversation or task - establishes how to find and use skills, and routes to the right process or fleet skill before anything else happens.'
    if (!entrypoint && /\b(?:always (?:use|apply|invoke|trigger)|(?:for|on) (?:anything|everything)|(?:any|every|all) (?:requests?|prompts?|tasks?|conversations?)|regardless of (?:topic|request|task))\b/i.test(description ?? '')) add(text.indexOf('description:'), 'trigger-abuse')
  }
  return results
}

export async function lintCommittedInstructions(git, sha, files) {
  const findings = []
  const paths = [...new Set(files)].filter(isInstructionPath)
  if (paths.length > MAX_INSTRUCTION_FILES) return [finding('(instruction set)', 1, 'file-limit')]
  for (const file of paths) {
    const mode = await git.fileModeAtCommit(sha, ':(literal)' + file)
    if (mode === null) continue // Deleted files have no instruction content to scan.
    if (!['100644', '100755'].includes(mode)) { findings.push(finding(file, 1, 'non-regular-file')); continue }
    if (await git.fileSizeAtCommit(sha, file) > MAX_INSTRUCTION_BYTES) { findings.push(finding(file, 1, 'file-too-large')); continue }
    const text = await git.fileAtCommit(sha, file)
    findings.push(...lintInstructionText(text, file))
  }
  return findings
}

export async function scanShippedInstructions(root) {
  const base = await fs.realpath(root instanceof URL ? fileURLToPath(root) : root)
  const result = { files: 0, findings: [] }
  let entries = 0
  async function walk(relative) {
    if (++entries > 5000) throw Error('Instruction scan exceeds its 5000-entry bound')
    const absolute = path.join(base, relative)
    let info
    try { info = await fs.lstat(absolute) } catch (error) { if (error.code === 'ENOENT' && ['skills', 'agents'].includes(relative)) return; throw error }
    const file = relative.split(path.sep).join('/')
    if (info.isSymbolicLink()) { result.findings.push(finding(file, 1, 'non-regular-file')); return }
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await walk(path.join(relative, name))
      return
    }
    if (!isInstructionPath(file)) return
    result.files++
    if (result.files > MAX_INSTRUCTION_FILES) throw Error('Instruction scan exceeds its 256-file bound')
    if (!info.isFile()) { result.findings.push(finding(file, 1, 'non-regular-file')); return }
    if (info.size > MAX_INSTRUCTION_BYTES) { result.findings.push(finding(file, 1, 'file-too-large')); return }
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || await fs.realpath(absolute) !== absolute) throw Error('Instruction file changed during scan')
      const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
        if (!read.bytesRead) break
        bytes += read.bytesRead
      }
      if (bytes > MAX_INSTRUCTION_BYTES) result.findings.push(finding(file, 1, 'file-too-large'))
      else result.findings.push(...lintInstructionText(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)), file))
    } finally { await handle.close() }
  }
  await walk('skills'); await walk('agents')
  return result
}

export async function securityLintMain(args, out = console.log) {
  let root = process.cwd(), changed, ref = 'HEAD', json = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--json') { json = true; continue }
    if (!['--root', '--changed', '--ref'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Usage: security-lint.mjs [--root path] [--changed base [--ref tip]] [--json]')
    const value = args[++i]
    if (flag === '--root') root = value
    if (flag === '--changed') changed = value
    if (flag === '--ref') ref = value
  }
  if (!changed && ref !== 'HEAD') throw Error('--ref requires --changed')
  let result
  if (changed) {
    const git = createGit({ cwd: path.resolve(root) })
    const resolve = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value : value === 'HEAD' ? git.headSha() : git.resolveRef(value.startsWith('refs/') ? value : 'refs/heads/' + value)
    const base = await resolve(changed), sha = await resolve(ref)
    const files = await git.changedFiles({ base, branch: sha })
    result = { files: files.filter(isInstructionPath).length, findings: await lintCommittedInstructions(git, sha, files) }
  } else result = await scanShippedInstructions(path.resolve(root))
  if (json) out(JSON.stringify(result))
  else {
    for (const f of result.findings) out(`${JSON.stringify(f.path)}:${f.line}: ${f.rule}`)
    out(`Instruction security lint: ${result.files} files, ${result.findings.length} findings`)
  }
  return result.findings.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await securityLintMain(process.argv.slice(2)) }
  catch (error) { console.error(JSON.stringify(error.message)); process.exitCode = 2 }
}
