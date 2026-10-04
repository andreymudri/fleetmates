import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { activeTiers, classify, worktrees } from '../approvals/tiers.mjs'
import { recordAllow, ruleThreshold } from '../approvals/rules.mjs'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

const LINE_MAX = 4000

// LF, CRLF, VT, FF, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR; a lone CR is left for the control strip.
const LINE_BREAK = /\s*(?:\r\n|[\n\u000b\u000c\u0085\u2028\u2029])\s*/u

/**
 * Fold text to one display line: each line break becomes a visible ` ↵ ` and the result is capped.
 * @param {unknown} text
 * @returns {string}
 */
export function oneLine(text) {
  const line = String(text ?? '').trim().split(LINE_BREAK).filter(Boolean).join(' ↵ ')
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line
}

function questionText(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  const first = questions.find(row => typeof row?.question === 'string' && row.question.trim())
  return first ? oneLine(first.question) : null
}

function relativeTo(cwd, file) {
  if (typeof file !== 'string' || !file) return null
  if (typeof cwd === 'string' && cwd && path.isAbsolute(file)) {
    const inside = path.relative(cwd, file)
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return inside
  }
  return file
}

/**
 * One readable line for a tool call: the tool name (or `label`) and its main argument, such as
 * `Read src/main.rs` or `Bash npm test`. Paths inside `cwd` are shown relative to it.
 * @param {string} toolName
 * @param {object} [input] the hook's `tool_input`
 * @param {string} [cwd]
 * @param {Record<string, string>} [labels] display names that replace a tool name
 * @returns {string}
 */
export function toolLine(toolName, input = {}, cwd = '', labels = {}) {
  const name = String(toolName ?? '')
  const args = input && typeof input === 'object' ? input : {}
  const text = value => typeof value === 'string' && value.trim() ? value : null
  let detail
  if (name === 'Bash') detail = text(args.command)
  else if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(name)) detail = relativeTo(cwd, args.file_path)
  else if (name === 'NotebookEdit') detail = relativeTo(cwd, args.notebook_path)
  else if (['Glob', 'Grep'].includes(name)) detail = text(args.pattern)
  else if (name === 'WebFetch') detail = text(args.url)
  else if (name === 'WebSearch') detail = text(args.query)
  else if (['Task', 'Agent'].includes(name)) detail = text(args.description)
  else if (name === 'AskUserQuestion') detail = questionText(args)
  else detail = Object.values(args).find(text) ?? null
  const label = labels[name] ?? name
  return oneLine(detail ? `${label} ${detail}` : label)
}

/**
 * The request summary cards and the drawer show: the question for AskUserQuestion, the command for Bash,
 * else {@link toolLine}. Never raw JSON.
 * @param {string} toolName
 * @param {object} [input]
 * @param {string} [cwd]
 * @returns {string}
 */
export function requestSummary(toolName, input = {}, cwd = '') {
  if (toolName === 'AskUserQuestion') return questionText(input) ?? toolLine(toolName, input, cwd)
  if (toolName === 'Bash' && typeof input?.command === 'string' && input.command.trim()) return oneLine(input.command)
  return toolLine(toolName, input, cwd)
}

/** Match a tool outcome with the request that opened it. */
export function matchKey(hook) {
  let input = hook.tool_input ?? {}
  if (hook.tool_name === 'AskUserQuestion') {
    const { answers, annotations, ...questionInput } = input
    input = questionInput
  }
  return createHash('sha1').update(JSON.stringify([hook.tool_name, canonical(input)])).digest('hex')
}

function shellTokens(command) {
  const tokens = []
  let value = ''
  let quoted = false
  let quote = null
  let start = 0
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) { quote = null; quoted = true }
      else if (char === '\\' && quote === '"' && i + 1 < command.length) value += command[++i]
      else value += char
    } else if (char === "'" || char === '"' || char === '`' && command.indexOf('`', i + 1) >= 0) { quote = char; quoted = true }
    else if (char === '\\' && i + 1 < command.length) value += command[++i]
    else if (/\s/.test(char) || ';|&()<>'.includes(char)) {
      if (value) tokens.push({ value, quoted, start, end: i })
      value = ''
      quoted = false
      start = i + 1
      if ('<>'.includes(char)) tokens.push({ value: char, start: i, end: i + 1 })
      else if (';|&()'.includes(char) || char === '\n') tokens.push({ value: char, separator: true })
    } else value += char
  }
  if (value) tokens.push({ value, quoted, start, end: command.length })
  return tokens
}

function executableWords(words) {
  let index = 0
  while (words[index] && !words[index].quoted && ['{', '}', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!'].includes(words[index].value)) index++
  return words.slice(index)
}

function embeddedCommands(command, onFound = () => {}) {
  const found = []
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && quote !== "'" && i + 1 < command.length) { i++; continue }
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue }
    if (quote === "'") continue
    if (char === '"') { quote = quote === '"' ? null : '"'; continue }
    if (char === '`') {
      const start = i + 1
      let end = start
      while (end < command.length && command[end] !== '`') {
        if (command[end] === '\\') end++
        end++
      }
      if (end < command.length) {
        const inner = command.slice(start, end)
        found.push(inner)
        onFound(inner, start - 1, end + 1)
        i = end
      }
    } else if (char === '$' && command[i + 1] === '(') {
      const start = i + 2
      let depth = 1
      let end = start
      for (; end < command.length; end++) {
        if (command[end] === '(') depth++
        if (command[end] === ')' && --depth === 0) break
      }
      if (depth === 0) {
        const inner = command.slice(start, end)
        found.push(inner)
        onFound(inner, start - 2, end + 1)
        i = end
      }
    }
  }
  return found
}

const executionWrappers = ['env', 'sudo', 'doas', 'nice', 'timeout', 'stdbuf', 'time', 'nohup']

function envSplitTokens(text, location) {
  if (typeof text !== 'string' || text.length > 65536) return null
  const words = []
  let value = ''
  let active = false
  let quote = null
  const finish = () => {
    if (active) words.push({ value, quoted: true, start: location.start, end: location.end })
    value = ''
    active = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (words.length > 1024) return null
    if (!quote && /\s/.test(char)) { finish(); continue }
    if (!quote && char === '#' && !active) break
    if (char === "'" || char === '"') {
      if (!quote) { quote = char; active = true; continue }
      if (quote === char) { quote = null; continue }
    }
    if (char === '$' && quote !== "'") {
      const reference = /^\$\{[A-Z_]+\}/.exec(text.slice(i))?.[0]
      const expanded = reference && knownShellPath(reference)
      if (!expanded || expanded === reference) return null
      value += expanded
      active = true
      i += reference.length - 1
      continue
    }
    if (char === '\\') {
      const next = text[i + 1]
      if (next === undefined) return null
      if (quote === "'" && !['\\', "'"].includes(next)) { value += char; active = true; continue }
      if (next === '_' && !quote) { finish(); i++; continue }
      if (next === 'c') {
        if (quote) return null
        finish()
        return words
      }
      const escapes = { '\\': '\\', "'": "'", '"': '"', '#': '#', '$': '$', _: ' ', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
      if (!Object.hasOwn(escapes, next)) return null
      value += escapes[next]
      active = true
      i++
      continue
    }
    value += char
    active = true
  }
  if (quote) return null
  finish()
  return words.length <= 1024 ? words : null
}

function skipWrapperOptions(words, index, wrapper, onDirectory = () => {}) {
  let offset = index + 1
  let splits = 0
  const expandSplit = (text, count, prefix = '') => {
    if (++splits > 8) return false
    const parsed = envSplitTokens(text, words[offset])
    if (!parsed || words.length - count + parsed.length > 1024) return false
    const options = prefix ? [{ ...words[offset], value: `-${prefix}` }] : []
    words.splice(offset, count, ...options, ...parsed)
    return true
  }
  const takesValue = {
    env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-a', '--argv0'],
    sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type'],
    doas: ['-u'],
    nice: ['-n', '--adjustment'],
    timeout: ['-s', '--signal', '-k', '--kill-after'],
    stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
    time: ['-f', '--format', '-o', '--output'],
    nohup: []
  }[wrapper]
  const directoryOption = wrapper === 'env' ? '-C' : wrapper === 'sudo' ? '-D' : null
  const directoryValue = (option, value) => {
    if (directoryOption && [directoryOption, '--chdir'].includes(option)) onDirectory(value)
  }
  while (offset < words.length) {
    const word = words[offset].value
    if (word === '--') { offset++; break }
    if (wrapper === 'env' && /^[A-Za-z_]\w*=/.test(word)) { offset++; continue }
    if (wrapper === 'env' && ['-S', '--split-string'].includes(word)) {
      if (!expandSplit(words[offset + 1]?.value, 2)) return words.length
      continue
    }
    if (wrapper === 'env' && word.startsWith('--split-string=')) {
      if (!expandSplit(word.slice('--split-string='.length), 1)) return words.length
      continue
    }
    if (takesValue.includes(word)) { directoryValue(word, words[offset + 1]?.value); offset += 2; continue }
    if (word.startsWith('--')) {
      const equal = word.indexOf('=')
      if (equal >= 0) directoryValue(word.slice(0, equal), word.slice(equal + 1))
      offset++
      continue
    }
    if (word.startsWith('-') && word !== '-') {
      const flags = word.slice(1)
      const valueAt = [...flags].findIndex(flag => takesValue.includes(`-${flag}`))
      if (wrapper === 'env' && valueAt >= 0 && flags[valueAt] === 'S') {
        const separate = valueAt === flags.length - 1
        if (!expandSplit(separate ? words[offset + 1]?.value : flags.slice(valueAt + 1), separate ? 2 : 1, flags.slice(0, valueAt))) return words.length
        continue
      }
      if (valueAt >= 0) directoryValue(`-${flags[valueAt]}`, valueAt === flags.length - 1 ? words[offset + 1]?.value : flags.slice(valueAt + 1))
      offset += valueAt >= 0 && valueAt === flags.length - 1 ? 2 : 1
      continue
    }
    break
  }
  return wrapper === 'timeout' && words[offset] ? offset + 1 : offset
}

const gitBooleanOptions = new Set(['--no-pager', '-P', '--paginate', '-p', '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare'])
const gitValueOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--config-env', '--namespace', '--attr-source'])
const gitTerminalOptions = new Set(['--exec-path', '--html-path', '--man-path', '--info-path', '--version', '-v', '--help', '-h'])

function gitSubcommandArgs(args) {
  let offset = 0
  while (offset < args.length && args[offset].startsWith('-')) {
    const option = args[offset]
    if (gitTerminalOptions.has(option) || option.startsWith('--list-cmds=')) return []
    if (gitBooleanOptions.has(option)) { offset++; continue }
    if (gitValueOptions.has(option)) {
      if (offset + 1 >= args.length) return []
      offset += 2
      continue
    }
    const equal = option.indexOf('=')
    if (option.startsWith('--') && equal >= 0 && (gitValueOptions.has(option.slice(0, equal)) || option.slice(0, equal) === '--exec-path')) { offset++; continue }
    return []
  }
  return args.slice(offset)
}

function destructiveSegment(words, depth) {
  words = executableWords(words)
  if (depth > 4 || !words.length) return false
  let index = 0
  while (index < words.length) {
    const raw = words[index].value
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) { index++; continue }
    const word = path.posix.basename(raw)
    if (word === 'command') {
      index++
      while (words[index]?.value === '--' || /^-[pVv]+$/.test(words[index]?.value ?? '')) {
        if (/[Vv]/.test(words[index].value)) return false
        if (words[index++].value === '--') break
      }
      continue
    }
    if (executionWrappers.includes(word)) { index = skipWrapperOptions(words, index, word); continue }
    if (word === 'builtin') { index++; continue }
    if (['uv', 'poetry'].includes(word) && words[index + 1]?.value === 'run' || word === 'pnpm' && words[index + 1]?.value === 'exec' || word === 'npx' && words[index + 1]?.value === '--no-install') { index += 2; continue }
    break
  }
  const command = path.posix.basename(words[index]?.value ?? '')
  const args = words.slice(index + 1).map(word => word.value)
  const gitArgs = command === 'git' ? gitSubcommandArgs(args) : args
  if (command === 'systemctl' && args.some(arg => /^fleetmates-deck/.test(path.posix.basename(arg)))) return true
  if (['rm', 'shred', 'dd', 'wipefs', 'truncate', 'shutdown', 'reboot'].includes(command) || command.startsWith('mkfs')) return true
  if (command === 'find' && (args.includes('-delete') || ['-exec', '-execdir', '-ok'].some(flag => {
    const at = args.indexOf(flag)
    return at >= 0 && destructiveSegment(words.slice(index + at + 2), depth + 1)
  }))) return true
  if (command === 'xargs') {
    const valueOptions = ['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']
    let offset = index + 1
    while (words[offset]?.value.startsWith('-') && words[offset].value !== '-') {
      if (words[offset].value === '--') { offset++; break }
      offset += valueOptions.includes(words[offset].value) ? 2 : 1
    }
    if (destructiveSegment(words.slice(offset), depth + 1)) return true
  }
  if (command === 'rsync' && args.some(arg => arg.startsWith('--delete'))) return true
  if (command === 'git' && gitArgs[0] === 'push' && gitArgs.slice(1).some(arg => ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete'].includes(arg) || /^--(?:force-with-lease|force-if-includes|force|mirror|delete)=/.test(arg) || /^-[A-Za-z]*[fd]/.test(arg) || arg.startsWith('+') || arg.startsWith(':'))) return true
  if (command === 'git' && gitArgs[0] === 'clean' && gitArgs.slice(1).some(arg => arg === '--force' || /^-[A-Za-z]*f/.test(arg))) return true
  if (command === 'git' && gitArgs[0] === 'reset' && gitArgs.some(arg => ['--hard', '--keep', '--merge'].includes(arg))) return true
  // `git config` writes are rated by key in the M3 classifier (approvals/tiers.mjs), so other keys
  // stay Caution (07-approvals 4.3).
  if (['sh', 'bash', 'zsh'].includes(command)) {
    const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    if (at >= 0 && words[index + at + 2]?.quoted && destructiveShell(args[at + 1], depth + 1)) return true
  }
  if (command === 'eval' && words[index + 1]?.quoted && destructiveShell(args[0], depth + 1)) return true
  return false
}

function destructiveShell(command, depth = 0) {
  if (typeof command !== 'string' || depth > 4) return false
  if (/\bcd\s+(?:[^\s;]*\/)?\.git(?:\/[^\s;]*)?\s*(?:&&|;|\n)[^;\n]*(?:>|\btee\b|\bsed\s+-i\b|\bcp\b|\bmv\b)/.test(command)) return true
  if (/\b(?:curl|wget)\b[^|\n]*\|\s*(?:(?:\/[\w.-]+)*\/?(?:env|command|sudo|doas)\s+(?:(?:-[\w-]+|[A-Za-z_]\w*=\S+)\s+)*)*(?:\/[\w.-]+)*\/?(?:sh|bash|zsh|python(?:\d+(?:\.\d+)*)?|node|perl)\b/.test(command) || /\b(?:\/[\w.-]+)*\/?(?:sh|bash|zsh|python(?:\d+(?:\.\d+)*)?|node|perl)\s+<\(\s*(?:curl|wget)\b/.test(command)) return true
  if (embeddedCommands(command).some(inner => destructiveShell(inner, depth + 1))) return true
  const tokens = shellTokens(command)
  let segment = []
  for (const token of tokens) {
    if (token.separator) {
      if (destructiveSegment(segment, depth)) return true
      segment = []
    } else segment.push(token)
  }
  return destructiveSegment(segment, depth)
}

function containsDirectory(text, directory) {
  return !!directory && path.isAbsolute(directory) && (text.includes(`${path.normalize(directory)}/`) || text.includes(`${path.normalize(directory)}"`))
}

function namesDeckControl(input) {
  const text = JSON.stringify(input ?? {})
  const configuredState = process.env.XDG_STATE_HOME
  const deckState = configuredState && path.isAbsolute(configuredState) ? path.join(configuredState, 'fleetmates', 'deck') : null
  const configuredConfig = process.env.XDG_CONFIG_HOME
  const deckConfig = configuredConfig && path.isAbsolute(configuredConfig) ? path.join(configuredConfig, 'fleetmates', 'deck') : null
  const configuredRuntime = process.env.XDG_RUNTIME_DIR
  const deckRuntime = configuredRuntime && path.isAbsolute(configuredRuntime) ? path.join(configuredRuntime, 'fleetmates-deck') : null
  const deckPort = process.env.DECK_PORT ?? '47800'
  return containsDirectory(text, deckState) || containsDirectory(text, deckConfig) || containsDirectory(text, deckRuntime)
    || /(?:\.local\/state|\.config)\/fleetmates\/deck(?:\/|\b)/.test(text)
    || /(?:\$XDG_RUNTIME_DIR|\/run\/user\/\d+)\/fleetmates-deck(?:\/|\b)/.test(text)
    || /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\/api(?:\/|\b)/i.test(text)
    || (text.includes(`:${deckPort}`) && /(?:127\.0\.0\.1|localhost|\[::1\]):\d+\b/i.test(text))
}

function canonicalExistingPath(location) {
  let current = path.resolve(location)
  const missing = []
  for (;;) {
    try { return path.join(realpathSync(current), ...missing.reverse()) }
    catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(location)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function knownShellPath(value) {
  return value.replace(/^\$(?:([A-Z_]+)|\{([A-Z_]+)\})(?=\/|$)/, (match, plain, braced) => {
    const variable = plain ?? braced
    const configured = ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR'].includes(variable) ? process.env[variable] : null
    return configured && (path.isAbsolute(configured) || variable === 'CLAUDE_CONFIG_DIR') ? configured : match
  })
}

function wrapperDirectory(value, cwd) {
  if (typeof value !== 'string' || !value) return null
  const expanded = knownShellPath(value)
  if (/[$*?`]/.test(expanded)) return null
  if (path.isAbsolute(expanded)) return canonicalExistingPath(expanded)
  return path.isAbsolute(cwd ?? '') ? canonicalExistingPath(path.resolve(cwd, expanded)) : null
}

function optionPaths(executable, words, writesOnly = false) {
  const rules = {
    grep: { read: ['--file', '-f'], flags: 'EFGPivwxnsrlLchHbBoqUaIRzZ' },
    sed: { read: ['--file', '-f'], flags: 'Enru' },
    awk: { read: ['--file', '-f'] },
    gawk: { read: ['--file', '-f'] },
    curl: { read: ['--config', '-K', '--netrc-file', '--cacert', '--cert', '--key'], write: ['--output', '-o', '--cookie-jar', '-c', '--dump-header', '-D'] },
    wget: { read: ['--input-file', '-i', '--load-cookies', '--ca-certificate', '--certificate', '--private-key'], write: ['--output-document', '-O', '--output-file', '-o', '--save-cookies'] },
    sort: { read: ['--files0-from'], write: ['--output', '-o'] }
  }
  const rule = rules[executable]
  if (!rule) return []
  const options = writesOnly ? rule.write ?? [] : [...rule.read ?? [], ...rule.write ?? []]
  const targets = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.value === '--') break
    for (const option of options) {
      if (word.value === option && words[i + 1]) { targets.push(words[++i]); break }
      if (option.startsWith('--') && word.value.startsWith(`${option}=`)) { targets.push({ ...word, value: word.value.slice(option.length + 1) }); break }
      if (option.length === 2 && word.value.startsWith('-') && !word.value.startsWith('--')) {
        const at = word.value.indexOf(option[1], 1)
        if (at < 1 || [...word.value.slice(1, at)].some(flag => !rule.flags?.includes(flag))) continue
        if (at + 1 < word.value.length) targets.push({ ...word, value: word.value.slice(at + 1) })
        else if (words[i + 1]) targets.push(words[++i])
        break
      }
    }
  }
  return targets
}

function namesRelativeDeckControl(hook, depth = 0) {
  if (depth > 4) return true
  const namesControl = (value, shell = false, directory = hook.cwd) => {
    if (typeof value !== 'string' || !value) return false
    const expanded = shell ? knownShellPath(value) : value
    if (shell && /[$*?`]/.test(expanded)) return false
    if (path.isAbsolute(expanded)) return namesDeckControl({ path: canonicalExistingPath(expanded) })
    return path.isAbsolute(directory ?? '') && namesDeckControl({ path: canonicalExistingPath(path.resolve(directory, expanded)) })
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(hook.tool_name)) {
    return namesControl(hook.tool_input?.file_path ?? hook.tool_input?.notebook_path)
  }
  if (['Grep', 'Glob'].includes(hook.tool_name)) {
    return namesControl(hook.tool_input?.path ?? hook.cwd)
  }
  if (hook.tool_name !== 'Bash' || typeof hook.tool_input?.command !== 'string') return false
  const commandText = hook.tool_input.command
  const tokens = shellTokens(commandText)
  let directories = new Set([hook.cwd])
  const scopes = []
  let cdMayFail = false
  let segment = []
  const accessesControl = words => {
    words = executableWords(words)
    cdMayFail = false
    if (!words.length) return false
    const raw = commandText.slice(words[0].start, words.at(-1).end)
    for (const cwd of directories) {
      if (embeddedCommands(raw).some(command => namesRelativeDeckControl({ ...hook, cwd, tool_input: { command } }, depth + 1))) return true
    }
    const redirected = new Set()
    for (let i = 0; i < words.length; i++) {
      if (!['<', '>'].includes(words[i].value) || words[i].quoted) continue
      const operator = words[i].value
      let repeated = false
      while (words[i + 1]?.value === operator && !words[i + 1].quoted) { repeated = true; i++ }
      const target = words[i + 1]
      if (!target) continue
      redirected.add(target)
      if (operator === '<' && repeated) continue
      for (const cwd of directories) if (namesControl(target.value, true, cwd)) return true
    }
    let commandDirectories = directories
    let wrapped = false
    let index = 0
    while (words[index]) {
      const wrapper = path.posix.basename(words[index].value)
      if (!/^[A-Za-z_]\w*=/.test(words[index].value) && executionWrappers.includes(wrapper)) {
        wrapped = true
        index = skipWrapperOptions(words, index, wrapper, target => {
          commandDirectories = new Set([...commandDirectories].map(cwd => wrapperDirectory(target, cwd)))
        })
        continue
      }
      if (/^[A-Za-z_]\w*=/.test(words[index].value) || ['command', 'builtin'].includes(wrapper)) {
        index++
        if (wrapper === 'command') {
          while (words[index]?.value === '--' || /^-[pVv]+$/.test(words[index]?.value ?? '')) {
            if (/[Vv]/.test(words[index].value)) return false
            if (words[index++].value === '--') break
          }
        }
        continue
      }
      break
    }
    const executable = path.posix.basename(words[index]?.value ?? '')
    const args = words.slice(index + 1)
    let scriptArgument = null
    if (['sh', 'bash', 'zsh'].includes(executable) || executable === 'eval') {
      const at = executable === 'eval' ? -1 : args.findIndex(word => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.value))
      const inner = args[at + 1]
      if ((executable === 'eval' || at >= 0) && inner?.quoted) {
        scriptArgument = inner
        for (const cwd of commandDirectories) if (namesRelativeDeckControl({ ...hook, cwd, tool_input: { command: inner.value } }, depth + 1)) return true
      }
    }
    for (const target of optionPaths(executable, args)) for (const cwd of commandDirectories) if (namesControl(target.value, true, cwd)) return true
    if (!['echo', 'printf'].includes(executable)) {
      for (const cwd of commandDirectories) if (args.some(word => word !== scriptArgument && !redirected.has(word) && (word.quoted || !['<', '>'].includes(word.value)) && !word.value.startsWith('-') && namesControl(word.value, true, cwd))) return true
    }
    if (executable === 'cd' && !wrapped) {
      const target = args.find(word => word.value !== '--' && !word.value.startsWith('-'))?.value
      if (target && !/[$*?`]/.test(target)) {
        const next = new Set()
        for (const cwd of directories) {
          if (!path.isAbsolute(cwd ?? '')) { next.add(cwd); continue }
          let directory = path.resolve(cwd, target)
          if (args.some(word => word.value === '-P')) directory = canonicalExistingPath(directory)
          next.add(directory)
          try { if (!statSync(directory).isDirectory()) cdMayFail = true } catch { cdMayFail = true }
        }
        directories = next
      } else cdMayFail = true
    }
    return false
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.separator) { segment.push(token); continue }
    const before = directories
    if (accessesControl(segment)) return true
    segment = []
    const paired = ['&', '|'].includes(token.value) && tokens[i + 1]?.separator && tokens[i + 1].value === token.value
    if (paired) i++
    if (token.value === '(') {
      if (scopes.length >= 32) return true
      scopes.push(directories)
      directories = new Set(directories)
    } else if (token.value === ')') directories = scopes.pop() ?? directories
    else if (token.value === '|' && paired || [';', '\n'].includes(token.value) && cdMayFail) directories = new Set([...before, ...directories])
    else if (['|', '&'].includes(token.value) && !paired) directories = before
    if (directories.size > 32) return true
  }
  return accessesControl(segment)
}

function shellWriteTargets(command, cwd, requestedCwd = cwd) {
  let directory = cwd
  let requestedDirectory = requestedCwd
  const targets = []
  const add = (target, cwd = directory, quoted = false, requestedCwd = requestedDirectory) => targets.push({ file_path: target, cwd, quoted, requestedCwd })
  const embedded = []
  embeddedCommands(command, (command, start, end) => embedded.push({ command, start, end }))
  let masked = command
  for (const inner of embedded) masked = masked.slice(0, inner.start) + 'x'.repeat(inner.end - inner.start) + masked.slice(inner.end)
  const tokens = shellTokens(masked)
  const inspect = words => {
    words = executableWords(words)
    if (!words.length) return
    for (const inner of embedded) {
      if (inner.start >= words[0].start && inner.end <= words.at(-1).end) targets.push({ command: inner.command, cwd: directory, requestedCwd: requestedDirectory })
    }
    for (let i = 0; i < words.length; i++) {
      if (words[i].value !== '>' || words[i].quoted) continue
      while (words[i + 1]?.value === '>' && !words[i + 1].quoted) i++
      const target = words[i + 1]
      if (target && !target.separator && target.value !== '&') add(target.value, directory, target.quoted)
    }
    let commandDirectory = directory
    let commandRequestedDirectory = requestedDirectory
    let wrapped = false
    let index = 0
    while (words[index]) {
      const wrapper = path.posix.basename(words[index].value)
      if (!/^[A-Za-z_]\w*=/.test(words[index].value) && executionWrappers.includes(wrapper)) {
        wrapped = true
        index = skipWrapperOptions(words, index, wrapper, target => {
          commandDirectory = wrapperDirectory(target, commandDirectory)
          commandRequestedDirectory = commandDirectory && commandRequestedDirectory ? path.resolve(commandRequestedDirectory, knownShellPath(target)) : null
        })
        continue
      }
      if (/^[A-Za-z_]\w*=/.test(words[index].value) || ['command', 'builtin'].includes(wrapper)) {
        index++
        if (wrapper === 'command') {
          while (words[index]?.value === '--' || /^-[pVv]+$/.test(words[index]?.value ?? '')) {
            if (/[Vv]/.test(words[index].value)) return
            if (words[index++].value === '--') break
          }
        }
        continue
      }
      break
    }
    const executable = path.posix.basename(words[index]?.value ?? '')
    const args = words.slice(index + 1).map(word => word.value)
    for (const target of optionPaths(executable, words.slice(index + 1), true)) add(target.value, commandDirectory, target.quoted, commandRequestedDirectory)
    if (['sh', 'bash', 'zsh'].includes(executable)) {
      const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
      if (at >= 0 && words[index + at + 2]?.quoted) targets.push({ command: args[at + 1], cwd: commandDirectory, requestedCwd: commandRequestedDirectory })
    }
    if (executable === 'eval' && words[index + 1]?.quoted) targets.push({ command: args[0], cwd: commandDirectory, requestedCwd: commandRequestedDirectory })
    if (executable === 'cd' && !wrapped) {
      const target = args.find(arg => arg !== '--' && !arg.startsWith('-'))
      if (target && !/[$*?`]/.test(target)) {
        directory = path.resolve(directory ?? '', target)
        requestedDirectory = path.resolve(requestedDirectory ?? '', target)
      }
    }
    if (executable === 'dd') {
      for (const [at, arg] of args.entries()) if (arg.startsWith('of=')) add(arg.slice(3), commandDirectory, words[index + at + 1].quoted, commandRequestedDirectory)
    }
    const editsInPlace = ['sed', 'perl'].includes(executable) && args.some(arg => arg === '--in-place' || arg.startsWith('--in-place=') || /^-i/.test(arg))
    if (['tee', 'cp', 'mv', 'install', 'touch', 'truncate'].includes(executable) || editsInPlace) {
      for (const [at, arg] of args.entries()) {
        const quoted = words[index + at + 1].quoted
        if (arg.startsWith('--target-directory=')) add(arg.slice('--target-directory='.length), commandDirectory, quoted, commandRequestedDirectory)
        else if (!arg.startsWith('-') && !['<', '>'].includes(arg)) add(arg, commandDirectory, quoted, commandRequestedDirectory)
      }
    }
  }
  let segment = []
  for (const token of tokens) {
    if (token.separator) { inspect(segment); segment = [] }
    else segment.push(token)
  }
  inspect(segment)
  return targets.map(target => target.file_path ? { ...target, file_path: knownShellPath(target.file_path) } : target).filter(target => typeof target.command === 'string' || target.file_path && !/[$`]/.test(target.file_path) && (target.quoted || !/[*?]/.test(target.file_path)))
}

function sensitiveWrite(hook, repoRoot, depth = 0, requestedCwd = hook.cwd ?? repoRoot) {
  if (depth > 4) return true
  const tool = hook.tool_name
  const fileTool = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)
  if (!fileTool && tool !== 'Bash') return false
  const raw = fileTool ? hook.tool_input?.file_path ?? hook.tool_input?.notebook_path ?? '' : hook.tool_input?.command ?? ''
  if (typeof raw !== 'string') return false
  if (!fileTool) return shellWriteTargets(raw, hook.cwd ?? repoRoot, requestedCwd).some(target => sensitiveWrite({ ...hook, cwd: target.cwd, tool_name: target.command === undefined ? 'Write' : 'Bash', tool_input: target.command === undefined ? { file_path: target.file_path } : { command: target.command } }, repoRoot, depth + 1, target.requestedCwd))
  const requested = path.resolve(requestedCwd ?? hook.cwd ?? repoRoot ?? '', raw)
  const location = canonicalExistingPath(path.resolve(hook.cwd ?? repoRoot ?? '', raw))
  const home = process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : homedir()
  const data = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  const installedHook = path.join(data, 'fleetmates-deck', 'hook', 'deck-hook.mjs')
  const hookPaths = new Set([installedHook, path.dirname(installedHook), canonicalExistingPath(installedHook), canonicalExistingPath(path.dirname(installedHook))])
  const configuredSettings = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json')
  const settingsPaths = new Set([configuredSettings, canonicalExistingPath(configuredSettings)])
  return [requested, location].some((candidate, index) => {
    const normalized = candidate.replaceAll('\\', '/')
    if (hookPaths.has(candidate)) return true
    if (settingsPaths.has(candidate)) return true
    if (/(?:^|\/)\.local\/share\/fleetmates-deck\/hook(?:\/deck-hook\.mjs)?$/.test(normalized)) return true
    if (/(?:^|\/)(?:\.git|\.claude)(?:\/hooks)?$/.test(normalized)) return true
    if (/(?:^|[^A-Za-z0-9_.-])\.git\//.test(normalized)) return true
    if (/(?:^|\/)\.claude\/(?:settings[^/]*\.json|hooks\/)/.test(normalized)) return true
    if (/(?:^|\/)\.mcp\.json(?:\b|$)/.test(normalized)) return true
    if (path.posix.basename(normalized) !== 'CLAUDE.md') return false
    if (!repoRoot) return true
    const root = index === 0 ? path.resolve(repoRoot) : canonicalExistingPath(path.resolve(repoRoot))
    return candidate !== path.join(root, 'CLAUDE.md') && !candidate.startsWith(`${root}${path.sep}`)
  })
}

function sqlCode(sql) {
  let code = ''
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) {
      i = sql.indexOf('\n', i + 2)
      if (i < 0) break
      code += ' '
    } else if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (depth && i < sql.length) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) return null
      code += ' '
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]
      let closed = false
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) return null
      code += ' '
    } else if (sql[i] === '$' && /^\$[A-Za-z_0-9]*\$/.test(sql.slice(i))) {
      const marker = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))[0]
      const end = sql.indexOf(marker, i + marker.length)
      if (end < 0) return null
      i = end + marker.length
      code += ' '
    } else code += sql[i++]
  }
  return code
}

/**
 * Whether SQL text writes a database (07-approvals 4.3 psql and sqlite3 rows): a write keyword outside
 * comments and string literals, `COPY ... FROM`, `EXPLAIN ANALYZE`, or text that cannot be read.
 * @param {string} sql
 * @returns {boolean}
 */
export function destructiveSql(sql) {
  const code = sqlCode(sql)
  return code === null || /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CALL|DO)\b/i.test(code)
    || /\bCOPY\b[\s\S]*\bFROM\b/i.test(code) || /\bEXPLAIN\s+ANALYZE\b/i.test(code)
}

/**
 * The M1 Destructive checks (deck controls, Claude Code settings and `.git` writes, destructive MCP
 * names and SQL, and the M1 shell patterns), kept as one floor of the M3 classifier.
 * @param {{ tool_name?: string, tool_input?: object, cwd?: string }} hook
 * @param {{ repoRoot?: string }} [options]
 * @returns {boolean}
 */
export function legacyDestructive(hook, { repoRoot } = {}) {
  if (namesDeckControl(hook.tool_input) || namesRelativeDeckControl(hook) || sensitiveWrite(hook, repoRoot)) return true
  const mcpTool = /^mcp__.+?__(.+)$/.exec(hook.tool_name ?? '')?.[1]
  if (mcpTool && /delete|remove|drop|destroy|purge|truncate|wipe|reset/i.test(mcpTool)) return true
  if (mcpTool && typeof hook.tool_input?.sql === 'string' && destructiveSql(hook.tool_input.sql)) return true
  return hook.tool_name === 'Bash' && destructiveShell(hook.tool_input?.command)
}

/**
 * The classification `classifyHook` returns when the classifier throws (D-92 (d)): Caution with
 * the single reason `classify.error`, so one hook can never stop a session's later hooks or a
 * restart's spool replay from applying.
 * @returns {{ tier: 'caution', reasons: object[], ruleCandidate: null, ruleNote: null, confirm: { template: null, count: null }, description: string }}
 */
export function classifyErrorResult() {
  const description = 'the request could not be classified'
  return { tier: 'caution', reasons: [{ entryId: 'classify.error', tier: 'caution', segment: '', description }], ruleCandidate: null, ruleNote: null, confirm: { template: null, count: null }, description }
}

/**
 * The M3 classification of a hook (approvals/tiers.mjs `classify`) with the active tiers and the
 * repo's cached worktrees. Any exception from the classifier rates the request Caution with reason
 * `classify.error`; only that reason id is logged, never the request or the error text.
 * @param {{ tool_name?: string, tool_input?: object, cwd?: string }} hook
 * @param {{ repoRoot?: string, classifier?: typeof classify }} [options]
 */
export function classifyHook(hook, { repoRoot, classifier = classify } = {}) {
  try {
    return classifier({ toolName: hook.tool_name, toolInput: hook.tool_input, cwd: hook.cwd ?? null, repoRoot: repoRoot ?? null, worktrees: worktrees.get(repoRoot), tiers: activeTiers() })
  } catch {
    try { process.stderr.write('deck: classify.error\n') } catch {}
    return classifyErrorResult()
  }
}

/**
 * The tier of a permission request: `classifyHook(...).tier`, kept for the M1 callers.
 * @param {{ tool_name?: string, tool_input?: object, cwd?: string }} hook
 * @param {{ repoRoot?: string }} [options]
 * @returns {'safe'|'caution'|'destructive'}
 */
export function permissionTier(hook, { repoRoot } = {}) {
  return classifyHook(hook, { repoRoot }).tier
}

function notificationToolName(message) {
  return typeof message === 'string' ? message.match(/\bAllow\s+(Bash|Write|Edit|Read|MultiEdit|NotebookEdit|Glob|Grep|WebFetch|WebSearch|Task|Skill)\b/i)?.[1] ?? null : null
}

function notificationMatchesTool(message, toolName, input) {
  const named = notificationToolName(message)
  if (named && (!toolName || named.toLowerCase() !== toolName.toLowerCase())) return false
  const target = typeof message === 'string' ? message.match(/\bAllow\s+[A-Za-z]\w*\s+to\s+(.+)\?$/i)?.[1]?.trim().replace(/^['"`]|['"`]$/g, '') : null
  if (!target) return true
  return target === (input?.file_path ?? input?.notebook_path ?? input?.path)
}

/** Hook events that provide evidence of resumed work. */
export const resumedActivityEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']

/** Identify hook signals that can open a permission or question request. */
export function isRequestOpening(hook) {
  return hook.hook_event_name === 'PermissionRequest'
    || hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'AskUserQuestion'
    || hook.hook_event_name === 'Notification' && ['permission_prompt', 'elicitation_dialog'].includes(hook.notification_type)
}

/** Reconcile delayed openings against accepted process and conversation history. */
export function reconcileRequestOpenings(store, session, history, { taskFor } = {}) {
  const queue = []
  for (const item of history) {
    const hook = item.hook
    const event = hook.hook_event_name
    if (resumedActivityEvents.includes(event)) {
      for (let index = queue.length - 1; index >= 0; index--) if (queue[index].hook.notification_type === 'elicitation_dialog') queue.splice(index, 1)
    }
    if (event === 'UserPromptSubmit' || event === 'Notification' && hook.notification_type === 'idle_prompt' || event === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source) || event === 'SessionEnd' && !['clear', 'resume'].includes(hook.reason)) {
      queue.length = 0
      continue
    }
    if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
      const kind = event !== 'PermissionDenied' && hook.tool_name === 'AskUserQuestion' ? 'question' : 'permission'
      const matches = candidate => matchKey(candidate.hook) === matchKey(hook)
        || candidate.hook.notification_type === 'permission_prompt' && notificationToolName(candidate.hook.message) && notificationMatchesTool(candidate.hook.message, hook.tool_name, hook.tool_input)
      const index = queue.findIndex(candidate => candidate.kind === kind && matches(candidate))
      const fallback = index < 0 && kind === 'question' ? queue.findIndex(candidate => candidate.kind === 'permission' && matches(candidate)) : index
      if (fallback >= 0) {
        const answeredKind = queue[fallback].kind
        queue.splice(fallback, 1)
        if (hook.tool_name === 'AskUserQuestion') {
          const related = queue.findIndex(candidate => candidate.kind !== answeredKind && matches(candidate))
          if (related >= 0) queue.splice(related, 1)
        }
      }
      continue
    }
    if (!isRequestOpening(hook)) continue
    const kind = event === 'PermissionRequest' || hook.notification_type === 'permission_prompt' ? 'permission' : 'question'
    let createdAt = item.hookTs
    if (hook.notification_type === 'permission_prompt') {
      if (queue.some(candidate => candidate.kind === 'permission' && Math.abs(item.hookTs - candidate.hookTs) <= 2000 && (candidate.hook.notification_type === 'permission_prompt' ? candidate.hook.message === hook.message : notificationMatchesTool(hook.message, candidate.hook.tool_name, candidate.hook.tool_input)))) continue
    }
    if (event === 'PermissionRequest') {
      const fallback = queue.findIndex(candidate => candidate.hook.notification_type === 'permission_prompt' && Math.abs(item.hookTs - candidate.hookTs) <= 2000 && notificationMatchesTool(candidate.hook.message, hook.tool_name, hook.tool_input))
      if (fallback >= 0) {
        createdAt = queue[fallback].createdAt
        queue.splice(fallback, 1)
      }
    }
    queue.push({ ...item, kind, createdAt })
  }
  let changed = false
  for (const pending of queue) {
    const hook = pending.hook
    const existing = store.get('SELECT id FROM requests WHERE session_id=? AND kind=? AND match_key=? AND created_at=?', session.id, pending.kind, matchKey(hook), pending.createdAt)
    if (!existing) changed = applyRequestHook(store, session, pending, { taskId: taskFor?.(pending) }) || changed
  }
  return changed
}

function transcriptQuestion(location) {
  if (typeof location !== 'string' || !path.isAbsolute(location)) return null
  let fd
  try {
    fd = openSync(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
    const offset = Math.max(0, info.size - 65536)
    const buffer = Buffer.alloc(Math.min(info.size, 65536))
    const bytes = readSync(fd, buffer, 0, buffer.length, offset)
    let tail = buffer.subarray(0, bytes).toString('utf8')
    if (offset) tail = tail.slice(tail.indexOf('\n') + 1)
    for (const line of tail.split('\n').reverse()) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (entry?.type !== 'assistant' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue
      const text = entry.message.content.findLast(block => block?.type === 'text' && typeof block.text === 'string')?.text.trim()
      if (text !== undefined) return text.endsWith('?') ? text.slice(-2000) : null
    }
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
  return null
}

/** `delivery` values that mean the deck wrote keys for the request (state-machines 2.7 rows 12, 15, 16). */
export const DECK_DELIVERIES = Object.freeze(['sending', 'verifying', 'did_not_land'])

/**
 * The `answer` a closing hook records. A request the deck sent keys for (`delivery` sending, verifying
 * or did_not_land) keeps the deck's `via` and choice from the in-flight `answer` approvals/deliver.mjs
 * wrote; the hook's own verdict wins when it is a deny. Any other request is answered in the terminal.
 * @param {{ delivery?: string, answer?: string | null }} row
 * @param {string} choice the terminal choice the hook implies
 * @returns {{ via: string, choice: string }}
 */
export function closingAnswer(row, choice) {
  if (!DECK_DELIVERIES.includes(row?.delivery)) return { via: 'terminal', choice }
  let sent = null
  try { sent = JSON.parse(row.answer ?? 'null') } catch {}
  const via = ['browser', 'popup', 'batch'].includes(sent?.via) ? sent.via : 'browser'
  return { via, choice: choice === 'deny' || typeof sent?.choice !== 'string' ? choice : sent.choice }
}

/**
 * Open, answer and expire observe-only requests inside the caller's transaction. A request it opens carries
 * `taskId` (the teammate task the hook is attributed to), which defaults to the session's `run_task_id`.
 */
export function applyRequestHook(store, session, envelope, { late = false, taskId = session.run_task_id ?? null } = {}) {
  const hook = envelope.hook
  const event = hook.hook_event_name
  if (event === 'WorktreeCreate' || event === 'WorktreeRemove') worktrees.drop(session.repo_id)
  const at = envelope.hookTs
  const key = matchKey(hook)
  let resumed = false
  if (resumedActivityEvents.includes(event)) {
    for (const row of store.all('SELECT id, delivery, answer FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source IN (?,?) AND created_at <= ?', session.id, 'question', 'open', 'stop_question', 'elicitation', at)) {
      store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE id = ?', 'answered', JSON.stringify(closingAnswer(row, 'observed')), at, row.id)
      resumed = true
    }
  }
  if (late && !['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'UserPromptSubmit'].includes(event)) return resumed
  let question = null
  if (event === 'Stop' && ['running', 'stale'].includes(session.state) && !session.subagents_active && !store.get('SELECT id FROM requests WHERE session_id = ? AND state = ? LIMIT 1', session.id, 'open')) question = transcriptQuestion(hook.transcript_path ?? session.transcript_path)
  let kind = null
  let source = null
  if (question) { kind = 'question'; source = 'stop_question' }
  if (event === 'PermissionRequest') { kind = 'permission'; source = 'permission_request' }
  if (event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion') { kind = 'question'; source = 'ask_user_question' }
  if (event === 'Notification' && hook.notification_type === 'permission_prompt') { kind = 'permission'; source = 'notification' }
  if (event === 'Notification' && hook.notification_type === 'elicitation_dialog') { kind = 'question'; source = 'elicitation' }
  if (kind) {
    const toolName = source === 'stop_question' ? null : source === 'notification' ? notificationToolName(hook.message) : hook.tool_name ?? null
    if (source === 'notification') {
      const recent = store.all('SELECT source, summary, tool_name, detail FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND created_at BETWEEN ? AND ?', session.id, 'permission', 'open', at - 2000, at + 2000).some(row => row.source === 'notification' ? row.summary === (hook.message ?? 'Needs your answer') : row.source === 'permission_request' && notificationMatchesTool(hook.message, row.tool_name, JSON.parse(row.detail)))
      if (recent) return false
    }
    const summary = source === 'stop_question' ? question.slice(0, 160) : source === 'notification' ? hook.message ?? 'Needs your answer' : toolName ? requestSummary(toolName, hook.tool_input ?? {}, hook.cwd) : hook.message ?? 'Needs your answer'
    if (source === 'permission_request') {
      const fallback = store.all('SELECT id, summary FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC', session.id, 'permission', 'open', 'notification', at - 2000, at + 2000).find(row => notificationMatchesTool(row.summary, toolName, hook.tool_input))
      if (fallback) {
        const classified = classifyHook(hook, { repoRoot: session.repo_id })
        store.run('UPDATE requests SET source = ?, tool_name = ?, summary = ?, detail = ?, match_key = ?, tier = ?, reasons = ?, rule_pattern = ?, task_id = COALESCE(?, task_id) WHERE id = ?', source, hook.tool_name, summary, JSON.stringify(hook.tool_input ?? {}), key, classified.tier, JSON.stringify(classified.reasons), classified.ruleCandidate, taskId, fallback.id)
        return true
      }
    }
    // A notification-only request has no tool input: Caution, no rule candidate (07-approvals 3.1).
    const classified = kind !== 'permission' ? null : source === 'notification' ? { tier: 'caution', reasons: [{ entryId: 'unknown.notification', tier: 'caution', segment: '', description: 'the prompt came without its tool input' }], ruleCandidate: null } : classifyHook(hook, { repoRoot: session.repo_id })
    store.run('INSERT INTO requests(id, session_id, kind, tier, reasons, rule_pattern, tool_name, summary, detail, options, state, source, match_key, task_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), session.id, kind, classified?.tier ?? null, JSON.stringify(classified?.reasons ?? []), classified?.ruleCandidate ?? null, toolName, summary, JSON.stringify(source === 'stop_question' ? { question } : hook.tool_input ?? {}), JSON.stringify(source === 'stop_question' ? [] : hook.tool_input?.questions?.[0]?.options ?? []), 'open', source, key, taskId, at)
    return true
  }
  if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    const outcomeKind = event !== 'PermissionDenied' && hook.tool_name === 'AskUserQuestion' ? 'question' : 'permission'
    const row = store.get('SELECT id, kind, delivery, answer FROM requests WHERE session_id = ? AND state = ? AND match_key = ? AND kind = ? AND created_at <= ? ORDER BY created_at LIMIT 1', session.id, 'open', key, outcomeKind, at)
      ?? (outcomeKind === 'question' ? store.get('SELECT id, kind, delivery, answer FROM requests WHERE session_id = ? AND state = ? AND match_key = ? AND kind = ? AND created_at <= ? ORDER BY created_at LIMIT 1', session.id, 'open', key, 'permission', at) : null)
      ?? store.all('SELECT id, kind, summary, delivery, answer FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source = ? AND created_at <= ? ORDER BY created_at', session.id, 'permission', 'open', 'notification', at).find(candidate => notificationToolName(candidate.summary) && notificationMatchesTool(candidate.summary, hook.tool_name, hook.tool_input))
    if (!row) return resumed
    const closing = closingAnswer(row, event === 'PermissionDenied' ? 'deny' : 'allow')
    store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE id = ?', 'answered', JSON.stringify(closing), at, row.id)
    // D-73: an allow in the terminal counts toward "Make it a rule?"; recordAllow checks the tier,
    // the pattern and that both hooks came from one Claude process (F16). Its failure never stops
    // the hook from applying. A request the deck sent keys for is counted by approvals/deliver.mjs.
    if (event === 'PostToolUse' && row.kind === 'permission' && closing.via === 'terminal') {
      try { recordAllow(store, row, { via: 'terminal', at, threshold: ruleThreshold(store), closingPid: envelope.claudePid ?? null }) } catch {
        try { process.stderr.write('deck: rule.count-error\n') } catch {}
      }
    }
    if (hook.tool_name === 'AskUserQuestion') {
      const relatedKind = row.kind === 'permission' ? 'question' : 'permission'
      const related = store.get('SELECT id, delivery, answer FROM requests WHERE session_id = ? AND state = ? AND match_key = ? AND kind = ? AND created_at <= ? ORDER BY created_at LIMIT 1', session.id, 'open', key, relatedKind, at)
      if (related) {
        if (event === 'PermissionDenied') store.run('UPDATE requests SET state = ?, expired_reason = ? WHERE id = ?', 'expired', 'interrupted', related.id)
        else store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE id = ?', 'answered', JSON.stringify(closingAnswer(related, 'allow')), at, related.id)
      }
    }
    return true
  }
  if (event === 'UserPromptSubmit') {
    let changed = false
    for (const row of store.all('SELECT id, kind, delivery, answer FROM requests WHERE session_id = ? AND state = ? AND created_at <= ?', session.id, 'open', at)) {
      // A reply the deck typed into a question is answered by its UserPromptSubmit (state-machines 2.6).
      store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE id = ?', 'answered', JSON.stringify(closingAnswer(row, row.kind === 'question' && DECK_DELIVERIES.includes(row.delivery) ? 'reply' : 'deny')), at, row.id)
      changed = true
    }
    return changed || resumed
  }
  if (event === 'Notification' && hook.notification_type === 'idle_prompt') return store.run('UPDATE requests SET state = ?, expired_reason = ? WHERE session_id = ? AND state = ? AND source <> ?', 'expired', 'interrupted', session.id, 'open', 'stop_question').changes > 0
  return resumed
}

/** Expire every open request for a session. */
export function expireRequests(store, sessionId, reason) {
  return store.run('UPDATE requests SET state = ?, expired_reason = ? WHERE session_id = ? AND state = ?', 'expired', reason, sessionId, 'open').changes > 0
}
