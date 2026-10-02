// Shell analysis for the approvals classifier (docs/deck/07-approvals.md 3.3 and the tier review
// F6, F7, F8, F15). Structure only: segments, wrappers, redirects, payloads, write targets and
// network-to-interpreter routes. Tiers are decided by the classifier, never here.
import path from 'node:path'

const MAX_DEPTH = 8
const MAX_LENGTH = 1_000_000
const MAX_SEGMENTS = 20_000
const MAX_ROUTES = 1_000

/** Commands that fetch from the network (F7). */
export const FETCH_COMMANDS = Object.freeze(['curl', 'wget', 'aria2c', 'http', 'httpie', 'fetch', 'nc', 'socat'])
/** Interpreters a fetch must not reach (F7); `python*` covers every versioned python name. */
export const INTERPRETERS = Object.freeze(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'busybox', 'python*', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'source', '.'])

const fetchSet = new Set(FETCH_COMMANDS)
const interpreterSet = new Set(INTERPRETERS.filter(name => name !== 'python*'))
const shellSet = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh'])
const devNulls = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const metaChars = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const reservedPrefix = ['if', 'then', 'elif', 'else', 'do', 'while', 'until']
const reservedEnd = ['fi', 'done', 'esac']
const redirectOps = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>|', '>&', '<', '>']
const writeOps = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&'])
const substitutionKinds = new Set(['$(', '`', '<('])

class ShellError extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

function fail(reason) {
  throw new ShellError(reason)
}

const isDigit = char => char >= '0' && char <= '9'
const isNameStart = char => char !== undefined && /[A-Za-z_]/.test(char)
const isNameChar = char => char !== undefined && /\w/.test(char)

/**
 * Basename of a command word (`/usr/bin/rm` gives `rm`).
 * @param {string} word
 * @returns {string}
 */
export function commandBase(word) {
  const slash = word.lastIndexOf('/')
  return slash >= 0 && slash < word.length - 1 ? word.slice(slash + 1) : word
}

function resolvePath(text, dir) {
  if (text.startsWith('/')) return path.posix.resolve(text)
  if (!dir) return null
  return path.posix.resolve(dir, text)
}

function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

class Parser {
  constructor(source, depth, options) {
    this.s = source
    this.i = 0
    this.depth = depth
    this.options = options
    this.heredocs = []
  }

  enter() {
    if (this.depth + 1 > MAX_DEPTH) fail('too-deep')
    this.depth++
  }

  leave() {
    this.depth--
  }

  parseAll() {
    const list = this.parseList(null)
    if (this.i < this.s.length) fail('syntax')
    if (this.heredocs.length) fail('heredoc-delimiter')
    return list
  }

  atWord(word) {
    if (!this.s.startsWith(word, this.i)) return false
    const next = this.s[this.i + word.length]
    return next === undefined || metaChars.has(next)
  }

  skipBlanks() {
    for (;;) {
      const char = this.s[this.i]
      if (char === ' ' || char === '\t') this.i++
      else if (char === '\\' && this.s[this.i + 1] === '\n') this.i += 2
      else if (char === '#') {
        const end = this.s.indexOf('\n', this.i)
        this.i = end < 0 ? this.s.length : end
      } else return
    }
  }

  newline() {
    this.i++
    this.readHeredocs()
  }

  skipNewlines() {
    for (;;) {
      this.skipBlanks()
      if (this.s[this.i] !== '\n') return
      this.newline()
    }
  }

  readHeredocs() {
    const pending = this.heredocs
    this.heredocs = []
    for (const heredoc of pending) {
      const bodyStart = this.i
      let bodyEnd = -1
      while (this.i < this.s.length) {
        const end = this.s.indexOf('\n', this.i)
        const lineEnd = end < 0 ? this.s.length : end
        let line = this.s.slice(this.i, lineEnd)
        if (heredoc.strip) line = line.replace(/^\t+/, '')
        const lineStart = this.i
        this.i = end < 0 ? this.s.length : end + 1
        if (line === heredoc.delimiter) { bodyEnd = lineStart; break }
      }
      if (bodyEnd < 0) fail('heredoc-delimiter')
      if (!heredoc.quoted) heredoc.redirect.subs = new Parser(this.s.slice(bodyStart, bodyEnd), this.depth, this.options).heredocSubs()
    }
  }

  heredocSubs() {
    const word = { text: '', subs: [], expansion: false }
    while (this.i < this.s.length) {
      const char = this.s[this.i]
      if (char === '\\') this.i += 2
      else if (char === '$') this.readDollar(word, true)
      else if (char === '`') this.readBacktick(word, true)
      else this.i++
    }
    return word.subs
  }

  commandStartsAt() {
    const char = this.s[this.i]
    return !(char === undefined || char === ')' || char === ';' || char === '&' || char === '|' || char === '\n')
  }

  parseList(end) {
    const items = []
    for (;;) {
      this.skipNewlines()
      const char = this.s[this.i]
      if (char === undefined) {
        if (end) fail('syntax')
        return items
      }
      if (char === ')') {
        if (end === ')') return items
        fail('syntax')
      }
      if (end === '}' && this.atWord('}')) return items
      const pipeline = this.parsePipeline()
      this.skipBlanks()
      const first = this.s[this.i]
      const second = this.s[this.i + 1]
      let op = null
      if (first === '&' && second === '&') { op = '&&'; this.i += 2 }
      else if (first === '|' && second === '|') { op = '||'; this.i += 2 }
      else if (first === ';' && second === ';') fail('syntax')
      else if (first === ';') { op = ';'; this.i++ }
      else if (first === '&') { op = '&'; this.i++ }
      else if (first === '\n') { op = '\n'; this.newline() }
      items.push({ pipeline, op })
      if (op === '&&' || op === '||') {
        this.skipNewlines()
        if (!this.commandStartsAt() || (end === '}' && this.atWord('}'))) fail('syntax')
        continue
      }
      if (op === null) {
        const next = this.s[this.i]
        if (next === undefined) {
          if (end) fail('syntax')
          return items
        }
        if (next === ')' && end === ')') return items
        if (end === '}' && this.atWord('}')) return items
        fail('syntax')
      }
    }
  }

  parsePipeline() {
    const stages = []
    this.skipBlanks()
    let negated = false
    while (this.atWord('!')) {
      negated = true
      this.i++
      this.skipBlanks()
    }
    for (;;) {
      const command = this.parseCommand()
      this.skipBlanks()
      if (this.s[this.i] === '|' && this.s[this.i + 1] !== '|') {
        const pipe = this.s[this.i + 1] === '&' ? '|&' : '|'
        this.i += pipe.length
        stages.push({ command, pipe })
        this.skipNewlines()
        if (!this.commandStartsAt()) fail('syntax')
        continue
      }
      stages.push({ command, pipe: null })
      return { negated, stages }
    }
  }

  parseCommand() {
    let skipped = false
    for (;;) {
      this.skipBlanks()
      const keyword = reservedPrefix.find(word => this.atWord(word))
      if (!keyword) break
      this.i += keyword.length
      skipped = true
    }
    this.skipBlanks()
    const ending = reservedEnd.find(word => this.atWord(word))
    if (ending) {
      this.i += ending.length
      return { type: 'simple', assigns: [], words: [], redirects: this.parseTrailingRedirects(), skipped: true }
    }
    if (this.s[this.i] === '(') {
      this.i++
      this.enter()
      const body = this.parseList(')')
      if (this.s[this.i] !== ')' || !body.length) fail('syntax')
      this.i++
      this.leave()
      return { type: 'group', kind: 'subshell', body, redirects: this.parseTrailingRedirects() }
    }
    if (this.atWord('{')) {
      this.i++
      this.enter()
      const body = this.parseList('}')
      if (!this.atWord('}') || !body.length) fail('syntax')
      this.i++
      this.leave()
      return { type: 'group', kind: 'brace', body, redirects: this.parseTrailingRedirects() }
    }
    return this.parseSimple(skipped)
  }

  parseTrailingRedirects() {
    const redirects = []
    for (;;) {
      this.skipBlanks()
      if (!this.redirectAhead()) return redirects
      redirects.push(this.parseRedirect())
    }
  }

  redirectAhead() {
    let j = this.i
    while (isDigit(this.s[j])) j++
    const char = this.s[j]
    if (char === '<' || char === '>') return this.s[j + 1] !== '(' || j > this.i
    return j === this.i && char === '&' && this.s[j + 1] === '>'
  }

  parseSimple(skipped) {
    const command = { type: 'simple', assigns: [], words: [], redirects: [], skipped }
    for (;;) {
      this.skipBlanks()
      const char = this.s[this.i]
      if (char === undefined || char === '\n' || char === ';' || char === '|' || char === ')') break
      if (char === '&' && this.s[this.i + 1] !== '>') break
      if (char === '(') fail('syntax')
      if ((char === '<' || char === '>') && this.s[this.i + 1] === '(') { command.words.push(this.readProcessSubstitution()); continue }
      if (this.redirectAhead()) { command.redirects.push(this.parseRedirect()); continue }
      const word = this.readWord()
      if (!command.words.length && /^[A-Za-z_]\w*=/.test(word.raw)) { command.assigns.push(word); continue }
      command.words.push(word)
    }
    if (!command.words.length && !command.assigns.length && !command.redirects.length && !skipped) fail('syntax')
    return command
  }

  parseRedirect() {
    let fd = ''
    while (isDigit(this.s[this.i])) fd += this.s[this.i++]
    const op = redirectOps.find(candidate => this.s.startsWith(candidate, this.i))
    this.i += op.length
    this.skipBlanks()
    const char = this.s[this.i]
    let target
    if ((char === '<' || char === '>') && this.s[this.i + 1] === '(') target = this.readProcessSubstitution()
    else {
      if (char === undefined || metaChars.has(char)) fail('syntax')
      target = this.readWord()
    }
    const redirect = { fd: fd ? Number(fd) : null, op, target, subs: [] }
    if (op === '<<' || op === '<<-') {
      if (target.expansion || target.procSub) fail('heredoc-delimiter')
      redirect.heredoc = true
      redirect.quoted = target.quoted
      this.heredocs.push({ redirect, delimiter: target.text, strip: op === '<<-', quoted: target.quoted })
    }
    return redirect
  }

  readProcessSubstitution() {
    const start = this.i
    const kind = `${this.s[this.i]}(`
    this.i += 2
    this.enter()
    const list = this.parseList(')')
    if (this.s[this.i] !== ')') fail('syntax')
    this.i++
    this.leave()
    const raw = this.s.slice(start, this.i)
    return { text: raw, raw, expansion: true, glob: false, quoted: false, literal: false, subs: [{ kind, list }], procSub: kind }
  }

  readWord() {
    const s = this.s
    const start = this.i
    const word = { text: '', expansion: false, glob: false, quoted: false, subs: [] }
    let brace = -1
    let bracket = false
    if (s[this.i] === '~') {
      const next = s[this.i + 1]
      if (next === undefined || next === '/' || metaChars.has(next)) {
        if (this.options.homeDir) word.text = this.options.homeDir
        else { word.text = '~'; word.expansion = true }
        this.i++
      }
    }
    while (this.i < s.length) {
      const char = s[this.i]
      if (metaChars.has(char)) break
      if (char === "'") {
        const end = s.indexOf("'", this.i + 1)
        if (end < 0) fail('unclosed-quote')
        word.text += s.slice(this.i + 1, end)
        word.quoted = true
        this.i = end + 1
      } else if (char === '"') {
        this.i++
        this.readDouble(word)
        word.quoted = true
      } else if (char === '\\') {
        const next = s[this.i + 1]
        if (next === undefined) fail('syntax')
        if (next !== '\n') { word.text += next; word.quoted = true }
        this.i += 2
      } else if (char === '$') this.readDollar(word, false)
      else if (char === '`') this.readBacktick(word, false)
      else {
        if (char === '*' || char === '?') word.glob = true
        else if (char === '[') bracket = true
        else if (char === ']' && bracket) word.glob = true
        else if (char === '{') brace = word.text.length
        else if (char === '}' && brace >= 0) {
          const inner = word.text.slice(brace)
          if (inner.includes(',') || inner.includes('..')) word.glob = true
          brace = -1
        }
        word.text += char
        this.i++
      }
    }
    word.raw = s.slice(start, this.i)
    word.literal = !word.expansion && !word.glob
    return word
  }

  readDouble(word) {
    const s = this.s
    for (;;) {
      const char = s[this.i]
      if (char === undefined) fail('unclosed-quote')
      if (char === '"') { this.i++; return }
      if (char === '\\') {
        const next = s[this.i + 1]
        if (next === undefined) fail('unclosed-quote')
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          if (next !== '\n') word.text += next
          this.i += 2
        } else {
          word.text += char
          this.i++
        }
      } else if (char === '$') this.readDollar(word, true)
      else if (char === '`') this.readBacktick(word, true)
      else {
        word.text += char
        this.i++
      }
    }
  }

  homeExpands() {
    return Boolean(this.options.homeDir) && !this.options.homeAssigned
  }

  readDollar(word, inDouble) {
    const s = this.s
    const start = this.i
    const next = s[this.i + 1]
    if (next === '(') {
      if (s[this.i + 2] === '(') return this.readArithmetic(word)
      this.i += 2
      this.enter()
      const list = this.parseList(')')
      if (s[this.i] !== ')') fail('syntax')
      this.i++
      this.leave()
      word.subs.push({ kind: '$(', list })
      word.expansion = true
      word.text += s.slice(start, this.i)
      return
    }
    if (next === '{') {
      let j = this.i + 2
      let depth = 1
      for (; j < s.length; j++) {
        const char = s[j]
        if (char === '`' || (char === '$' && s[j + 1] === '(')) fail('unknown-expansion')
        if (char === '\\') { j++; continue }
        if (char === '{') depth++
        else if (char === '}' && --depth === 0) break
      }
      if (j >= s.length) fail('unknown-expansion')
      const inner = s.slice(this.i + 2, j)
      if (inner === 'HOME' && this.homeExpands()) word.text += this.options.homeDir
      else {
        word.expansion = true
        word.text += s.slice(start, j + 1)
      }
      this.i = j + 1
      return
    }
    if (next === "'" && !inDouble) return this.readAnsiC(word)
    if (next === '"' && !inDouble) {
      this.i += 2
      this.readDouble(word)
      word.quoted = true
      return
    }
    if (next === '[') fail('unknown-expansion')
    if (isNameStart(next)) {
      let j = this.i + 1
      while (isNameChar(s[j])) j++
      const name = s.slice(this.i + 1, j)
      if (name === 'HOME' && this.homeExpands()) word.text += this.options.homeDir
      else {
        word.expansion = true
        word.text += s.slice(start, j)
      }
      this.i = j
      return
    }
    if (next !== undefined && '0123456789@*#?$!-'.includes(next)) {
      word.expansion = true
      word.text += `$${next}`
      this.i += 2
      return
    }
    word.text += '$'
    this.i++
  }

  readArithmetic(word) {
    const s = this.s
    const start = this.i
    let depth = 0
    let j = this.i + 1
    for (; j < s.length; j++) {
      const char = s[j]
      if (char === '`' || (char === '$' && s[j + 1] === '(' && j !== start)) fail('unknown-expansion')
      if (char === '(') depth++
      else if (char === ')' && --depth === 0) break
    }
    if (j >= s.length || s[j - 1] !== ')') fail('unknown-expansion')
    word.expansion = true
    word.text += s.slice(start, j + 1)
    this.i = j + 1
  }

  readAnsiC(word) {
    const s = this.s
    const escapes = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v', '?': '?' }
    let j = this.i + 2
    for (;;) {
      const char = s[j]
      if (char === undefined) fail('unclosed-quote')
      if (char === "'") break
      if (char === '\\') {
        const next = s[j + 1]
        if (next === undefined) fail('unclosed-quote')
        if (!Object.hasOwn(escapes, next)) fail('unknown-expansion')
        word.text += escapes[next]
        j += 2
        continue
      }
      word.text += char
      j++
    }
    word.quoted = true
    this.i = j + 1
  }

  readBacktick(word, inDouble) {
    const s = this.s
    let j = this.i + 1
    let inner = ''
    for (;;) {
      const char = s[j]
      if (char === undefined) fail('unclosed-quote')
      if (char === '`') break
      if (char === '\\') {
        const next = s[j + 1]
        if (next === undefined) fail('unclosed-quote')
        if (next === '`' || next === '$' || next === '\\' || (inDouble && next === '"')) {
          inner += next
          j += 2
          continue
        }
      }
      inner += char
      j++
    }
    this.enter()
    const list = new Parser(inner, this.depth, this.options).parseAll()
    this.leave()
    word.subs.push({ kind: '`', list })
    word.expansion = true
    word.text += s.slice(this.i, j + 1)
    this.i = j + 1
  }
}

function parseString(text, depth, options) {
  if (depth > MAX_DEPTH) fail('too-deep')
  return new Parser(text, depth, options).parseAll()
}

const literalWord = text => ({ text, raw: text, expansion: false, glob: false, quoted: false, literal: true, subs: [] })

function scanOptions(words, start, spec, onValue = () => {}, onFlag = () => {}) {
  const flags = new Set(spec.flags ?? [])
  const values = new Set(spec.values ?? [])
  const other = new Set(spec.other ?? [])
  let i = start
  while (i < words.length) {
    const word = words[i]
    const text = word.text
    if (!word.literal) break
    if (text === '--') { i++; break }
    if (spec.assigns && /^[A-Za-z_]\w*=/.test(text)) { onValue('=', word); i++; continue }
    if (!text.startsWith('-') || text === '-') break
    if (text.startsWith('--')) {
      const equal = text.indexOf('=')
      const name = equal < 0 ? text : text.slice(0, equal)
      if (!flags.has(name) && !values.has(name)) onFlag(name)
      if (equal >= 0) { onValue(name, { ...literalWord(text.slice(equal + 1)), literal: word.literal }); i++ }
      else if (values.has(name) || other.has(name)) { onValue(name, words[i + 1]); i += 2 }
      else i++
      continue
    }
    let consumed = 1
    for (let k = 1; k < text.length; k++) {
      const option = `-${text[k]}`
      if (values.has(option) || other.has(option)) {
        if (!values.has(option)) onFlag(option)
        const rest = text.slice(k + 1)
        if (rest) onValue(option, literalWord(rest))
        else { onValue(option, words[i + 1]); consumed = 2 }
        break
      }
      if (!flags.has(option)) onFlag(option)
    }
    i += consumed
  }
  return Math.min(i, words.length)
}

const wrapperSpecs = {
  env: { flags: ['-i', '--ignore-environment', '-0', '--null'], values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], other: ['-a', '--argv0'], assigns: true },
  command: { flags: ['-p'] },
  builtin: {},
  time: { flags: ['-p'], other: ['-f', '--format', '-o', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  nohup: {},
  timeout: { flags: ['--preserve-status', '--foreground', '-v', '--verbose'], values: ['-s', '--signal', '-k', '--kill-after'] },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  sudo: { other: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'], assigns: true },
  doas: { other: ['-u', '-C'] },
  pkexec: { other: ['--user'] }
}

const runnerValues = {
  'uv run': ['--with', '--with-editable', '--with-requirements', '-p', '--python', '--package', '--extra', '--group', '--only-group', '--no-group', '--env-file', '--directory', '--project', '--index', '--index-url', '--default-index', '--extra-index-url', '-f', '--find-links', '--config-file', '--cache-dir', '--color', '-P', '--upgrade-package', '--reinstall-package', '--refresh-package', '-C', '--config-setting', '--python-platform', '--resolution', '--prerelease', '--exclude-newer', '--link-mode', '--keyring-provider', '--index-strategy', '--allow-insecure-host', '--no-binary-package', '--no-build-package'],
  'poetry run': ['-C', '--directory', '-P', '--project'],
  'pnpm exec': ['-C', '--dir', '-F', '--filter', '--reporter', '--workspace-concurrency'],
  'npx --no-install': ['-p', '--package', '--cache', '--registry', '--userconfig', '-c', '--call']
}

/**
 * Git global options before the subcommand, ported from the M1 classifier.
 * @param {string[]} args the words after `git`
 * @returns {string[]} the subcommand and its arguments, or `[]` when there is none
 */
export function gitSubcommandArgs(args) {
  const booleans = new Set(['--no-pager', '-P', '--paginate', '-p', '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare'])
  const values = new Set(['-C', '-c', '--git-dir', '--work-tree', '--config-env', '--namespace', '--attr-source', '--exec-path'])
  let offset = 0
  while (offset < args.length && args[offset].startsWith('-')) {
    const option = args[offset]
    if (booleans.has(option)) { offset++; continue }
    if (values.has(option) && option !== '--exec-path') {
      if (offset + 1 >= args.length) return []
      offset += 2
      continue
    }
    const equal = option.indexOf('=')
    if (option.startsWith('--') && equal >= 0 && values.has(option.slice(0, equal))) { offset++; continue }
    return []
  }
  return args.slice(offset)
}

/**
 * Normalise an option against the known long options of a command (tier review F6). An exact
 * match, or a unique prefix of at least three characters after `--`, returns that option (with its
 * `=value` kept); an ambiguous prefix returns every candidate; anything else returns `null`. A short
 * flag bundle expands (`-rf` gives `['-r', '-f']`) and a single short flag returns itself.
 * @param {string} arg
 * @param {string[]} known
 * @returns {string | string[] | null}
 */
export function normalizeLongOption(arg, known = []) {
  if (typeof arg !== 'string') return null
  if (arg.startsWith('--')) {
    if (arg === '--') return null
    const equal = arg.indexOf('=')
    const name = equal < 0 ? arg : arg.slice(0, equal)
    const suffix = equal < 0 ? '' : arg.slice(equal)
    const longs = known.filter(option => option.startsWith('--'))
    if (longs.includes(name)) return name + suffix
    if (name.length - 2 < 3) return null
    const candidates = longs.filter(option => option.startsWith(name))
    if (candidates.length === 1) return candidates[0] + suffix
    if (candidates.length > 1) return candidates.map(option => option + suffix)
    return null
  }
  if (/^-[^-]/.test(arg)) {
    if (arg.length === 2) return arg
    return [...arg.slice(1)].map(flag => `-${flag}`)
  }
  return null
}

function urlBasename(text) {
  let pathname = text
  try { pathname = new URL(text).pathname } catch { pathname = text.split(/[?#]/)[0] }
  const name = pathname.slice(pathname.lastIndexOf('/') + 1)
  return name || null
}

function isInterpreterName(name) {
  return name !== null && (interpreterSet.has(name) || /^python[0-9.]*$/.test(name))
}

/**
 * The basename of a segment's command word, or `null` when there is none or it is not literal.
 * @param {{ words: string[], literal: boolean }} segment
 * @returns {string | null}
 */
export function commandName(segment) {
  if (!segment.words.length || !segment.literal) return null
  return commandBase(segment.words[0])
}

class Walker {
  constructor(options) {
    this.options = options
    this.segments = []
    this.pipelines = []
  }

  newSegment(ctx, position) {
    if (this.segments.length >= MAX_SEGMENTS) fail('too-large')
    const segment = {
      index: this.segments.length,
      words: [],
      wordInfo: [],
      literal: true,
      assignments: [],
      redirects: [],
      wrappers: [...(ctx.wrappers ?? [])],
      wrapperOptions: false,
      payloadOf: ctx.payloadOf ?? null,
      via: ctx.via ?? null,
      depth: ctx.depth,
      cwd: ctx.dir,
      remote: Boolean(ctx.remote),
      writes: [],
      mounts: [],
      privileged: false,
      pipeline: position?.pipeline ?? null,
      stage: position?.stage ?? null,
      op: position?.op ?? null
    }
    this.segments.push(segment)
    return segment
  }

  walkList(list, ctx) {
    for (const item of list) this.walkPipeline(item.pipeline, ctx, item.op)
  }

  walkPipeline(pipeline, ctx, op) {
    const id = this.pipelines.length
    const ranges = []
    this.pipelines.push(ranges)
    const single = pipeline.stages.length === 1
    pipeline.stages.forEach((stage, index) => {
      const stageCtx = single ? ctx : { ...ctx }
      const start = this.segments.length
      this.walkCommand(stage.command, stageCtx, { pipeline: id, stage: index, op: stage.pipe ?? op, single })
      ranges.push([start, this.segments.length])
    })
  }

  walkCommand(command, ctx, position) {
    if (command.type === 'simple') return this.walkSimple(command, ctx, position, true)
    const inner = { ...ctx, depth: ctx.depth + 1 }
    const start = this.segments.length
    this.walkList(command.body, inner)
    if (command.kind === 'brace' && position.single) ctx.dir = inner.dir
    if (!command.redirects.length) return
    let holders = this.segments.slice(start).filter(segment => segment.payloadOf === (ctx.payloadOf ?? null))
    if (!holders.length) holders = [this.newSegment(inner, position)]
    for (const holder of holders) this.addRedirects(holder, command.redirects)
    for (const redirect of command.redirects) this.walkSubs([redirect.target, { subs: redirect.subs }], holders[0], ctx)
  }

  addRedirects(segment, redirects) {
    for (const redirect of redirects) {
      const record = { fd: redirect.fd, op: redirect.op, target: redirect.target.text, literal: redirect.target.literal }
      if (redirect.heredoc) { record.heredoc = true; record.quoted = redirect.quoted }
      if ((redirect.op === '>&' || redirect.op === '<&') && /^(?:\d+|-)$/.test(redirect.target.text)) record.dup = true
      segment.redirects.push(record)
      if (writeOps.has(redirect.op) && !record.dup && !redirect.target.procSub) this.addWrite(segment, redirect.target, redirect.op === '>&' ? '&>' : redirect.op)
    }
  }

  addWrite(segment, word, via) {
    if (!word) return
    if (!word.literal) {
      segment.writes.push({ path: null, raw: word.text, via, literal: false })
      return
    }
    const resolved = resolvePath(word.text, segment.cwd)
    const record = { path: resolved, via }
    if (resolved === null) record.raw = word.text
    else if (devNulls.has(resolved)) record.devNull = true
    segment.writes.push(record)
  }

  walkSubs(words, segment, ctx) {
    for (const word of words) {
      for (const sub of word?.subs ?? []) {
        if (ctx.depth + 1 > MAX_DEPTH) fail('too-deep')
        this.walkList(sub.list, { dir: ctx.dir, depth: ctx.depth + 1, payloadOf: segment.index, via: sub.kind, remote: ctx.remote })
      }
    }
  }

  walkSimple(command, ctx, position, walkSubstitutions) {
    if (command.skipped && !command.words.length && !command.assigns.length && !command.redirects.length) return
    const segment = this.newSegment(ctx, position)
    for (const word of command.assigns) segment.assignments.push(assignment(word))
    const words = command.words.slice()
    const start = this.stripWrappers(words, segment, ctx)
    const rest = words.slice(start)
    segment.words = rest.map(word => word.text)
    segment.wordInfo = rest.map(word => ({ literal: word.literal, quoted: word.quoted, glob: word.glob }))
    segment.literal = rest.length ? rest[0].literal : true
    this.addRedirects(segment, command.redirects)
    if (walkSubstitutions) {
      this.walkSubs([...command.assigns, ...command.words, ...command.redirects.map(redirect => redirect.target)], segment, ctx)
      for (const redirect of command.redirects) this.walkSubs([{ subs: redirect.subs }], segment, ctx)
    }
    if (!rest.length || !rest[0].literal) return
    const name = commandBase(rest[0].text)
    this.assignmentsOf(name, rest, segment)
    this.payloads(name, rest, segment, ctx)
    this.writeTargets(name, rest, segment)
    if ((name === 'cd' || name === 'pushd' || name === 'popd') && position?.single) ctx.dir = this.changeDirectory(name, rest, ctx.dir)
  }

  changeDirectory(name, words, dir) {
    if (name === 'popd') return null
    let i = 1
    while (i < words.length && /^-[LPe@]+$/.test(words[i].text)) i++
    if (words[i]?.text === '--') i++
    const target = words[i]
    if (!target) return this.options.homeDir ?? null
    if (!target.literal || target.text === '-' || target.text.startsWith('+')) return null
    return resolvePath(target.text, dir)
  }

  assignmentsOf(name, words, segment) {
    if (!['export', 'declare', 'typeset', 'local', 'readonly'].includes(name)) return
    for (const word of words.slice(1)) {
      if (/^[A-Za-z_]\w*=/.test(word.text)) segment.assignments.push({ ...assignment(word), exported: true })
    }
  }

  stripWrappers(words, segment, ctx) {
    let i = 0
    while (i < words.length && words[i].literal) {
      const name = commandBase(words[i].text)
      const next = words[i + 1]
      let runner = null
      if ((name === 'uv' || name === 'poetry') && next?.literal && next.text === 'run') runner = `${name} run`
      else if (name === 'pnpm' && next?.literal && next.text === 'exec') runner = 'pnpm exec'
      else if (name === 'npx') {
        let j = i + 1
        while (j < words.length && words[j].literal && words[j].text.startsWith('-') && words[j].text !== '--no-install') j++
        if (words[j]?.text === '--no-install') runner = 'npx --no-install'
      }
      if (runner) {
        segment.wrappers.push(runner)
        let j = runner === 'npx --no-install' ? i + 1 : i + 2
        const values = new Set(runnerValues[runner])
        while (j < words.length && words[j].literal && words[j].text.startsWith('-') && words[j].text !== '-') {
          const text = words[j].text
          if (text === '--') { j++; break }
          if (text === '--no-install' && runner === 'npx --no-install') { j++; continue }
          segment.wrapperOptions = true
          const option = text.startsWith('--') ? text.split('=')[0] : text.slice(0, 2)
          const attached = text.startsWith('--') ? text.includes('=') : text.length > 2
          j += values.has(option) && !attached ? 2 : 1
        }
        i = Math.min(j, words.length)
        continue
      }
      const spec = wrapperSpecs[name]
      if (!spec) break
      if (name === 'command' && words.slice(i + 1).some(word => word.literal && /^-[a-zA-Z]*[vV]/.test(word.text))) break
      segment.wrappers.push(name)
      let split = null
      const onValue = (option, value) => {
        if (option === '=') { segment.assignments.push(assignment(value)); return }
        if (name === 'env' && (option === '-C' || option === '--chdir') && value) segment.cwd = value.literal ? resolvePath(value.text, segment.cwd) : null
        if (name === 'sudo' && (option === '-D' || option === '--chdir') && value) segment.cwd = value.literal ? resolvePath(value.text, segment.cwd) : null
        if (name === 'env' && (option === '-S' || option === '--split-string')) split = value ?? null
      }
      const onFlag = () => { segment.wrapperOptions = true }
      let j = i + 1
      for (;;) {
        split = null
        j = scanOptions(words, j, spec, onValue, onFlag)
        if (!split) break
        if (!split.literal) fail('syntax')
        const parsed = parseString(split.text, ctx.depth + 1, this.options)
        const only = parsed.length === 1 && parsed[0].pipeline.stages.length === 1 ? parsed[0].pipeline.stages[0].command : null
        if (!only || only.type !== 'simple' || only.redirects.length) fail('syntax')
        words.splice(j, 0, ...only.assigns, ...only.words)
      }
      if (name === 'timeout' && j < words.length) j++
      i = j
    }
    return i
  }

  payloadString(text, segment, ctx, via, extra = {}) {
    const depth = ctx.depth + 1
    const list = parseString(text, depth, this.options)
    const remote = Boolean(ctx.remote || extra.remote)
    this.walkList(list, { dir: remote ? null : segment.cwd, depth, payloadOf: segment.index, via, remote, wrappers: extra.wrappers })
  }

  opaquePayload(words, segment, ctx, via, remote = false) {
    const payload = this.newSegment({ dir: segment.cwd, depth: ctx.depth + 1, payloadOf: segment.index, via, remote: ctx.remote || remote }, null)
    payload.words = words.map(word => word.text)
    payload.wordInfo = words.map(word => ({ literal: word.literal, quoted: word.quoted, glob: word.glob }))
    payload.literal = false
  }

  stringPayload(words, segment, ctx, via, extra = {}) {
    if (!words.length) return
    if (words.every(word => word.literal)) this.payloadString(words.map(word => word.text).join(' '), segment, ctx, via, extra)
    else this.opaquePayload(words, segment, ctx, via, extra.remote)
  }

  argvPayload(words, segment, ctx, via, remote = false) {
    if (!words.length) return
    if (ctx.depth + 1 > MAX_DEPTH) fail('too-deep')
    const isRemote = Boolean(ctx.remote || remote)
    this.walkSimple({ type: 'simple', assigns: [], words, redirects: [] }, { dir: isRemote ? null : segment.cwd, depth: ctx.depth + 1, payloadOf: segment.index, via, remote: isRemote }, null, false)
  }

  payloads(name, words, segment, ctx) {
    if (shellSet.has(name)) return this.shellPayload(name, words, segment, ctx)
    if (name === 'eval') return this.stringPayload(words.slice(1), segment, ctx, 'eval')
    if (name === 'su') return this.suPayload(words, segment, ctx)
    if (name === 'xargs') return this.argvPayload(words.slice(xargsCommandIndex(words)), segment, ctx, 'xargs')
    if (name === 'find') return this.findPayloads(words, segment, ctx)
    if (name === 'fd' || name === 'fdfind') return this.fdPayloads(words, segment, ctx)
    if (name === 'parallel') return this.parallelPayload(words, segment, ctx)
    if (name === 'ssh') return this.sshPayload(words, segment, ctx)
    if (name === 'docker' || name === 'podman') return this.containerPayload(name, words, segment, ctx)
    if (name === 'kubectl') return this.kubectlPayload(words, segment, ctx)
  }

  shellPayload(name, words, segment, ctx) {
    let i = 1
    let command = false
    while (i < words.length && words[i].literal) {
      const text = words[i].text
      if (text === '--' || text === '-') { i++; break }
      if (text === '--rcfile' || text === '--init-file') { i += 2; continue }
      if (text.startsWith('--')) { i++; continue }
      if (/^[-+][A-Za-z]+$/.test(text)) {
        if (text[0] === '-' && text.includes('c')) command = true
        i += 1 + [...text].filter(char => char === 'o' || char === 'O').length
        continue
      }
      break
    }
    if (!command || i >= words.length) return
    const script = words[i]
    if (script.literal) this.payloadString(script.text, segment, ctx, `${name} -c`)
    else this.opaquePayload([script], segment, ctx, `${name} -c`)
  }

  suPayload(words, segment, ctx) {
    let script = null
    scanOptions(words, 1, { flags: ['-', '-l', '--login', '-m', '-p', '--preserve-environment', '-P', '--pty'], values: ['-c', '--command', '-s', '--shell', '-g', '--group', '-G', '--supp-group', '-w', '--whitelist-environment'] }, (option, value) => {
      if (option === '-c' || option === '--command') script = value
    })
    if (!script) return
    if (script.literal) this.payloadString(script.text, segment, ctx, 'su -c', { wrappers: ['su'] })
    else this.opaquePayload([script], segment, ctx, 'su -c')
  }

  findPayloads(words, segment, ctx) {
    const actions = new Set(['-exec', '-execdir', '-ok', '-okdir'])
    for (let k = 1; k < words.length; k++) {
      if (!words[k].literal || !actions.has(words[k].text)) continue
      let end = k + 1
      while (end < words.length && !(words[end].text === ';' || (words[end].text === '+' && words[end - 1].text === '{}'))) end++
      if (end >= words.length || end === k + 1) fail('syntax')
      this.argvPayload(words.slice(k + 1, end), segment, ctx, `find ${words[k].text}`)
      k = end
    }
  }

  fdPayloads(words, segment, ctx) {
    const actions = new Set(['-x', '-X', '--exec', '--exec-batch'])
    for (let k = 1; k < words.length; k++) {
      if (!words[k].literal || !actions.has(words[k].text)) continue
      let end = k + 1
      while (end < words.length && words[end].text !== ';') end++
      this.argvPayload(words.slice(k + 1, end), segment, ctx, `fd ${words[k].text}`)
      k = end
    }
  }

  parallelPayload(words, segment, ctx) {
    const values = new Set(['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file', '--colsep', '-d', '--delimiter', '-I', '--results', '--joblog', '-n', '--max-args', '-N', '-L', '--delay', '--timeout', '--tag-string', '--workdir', '--wd', '--tmpdir', '-E'])
    let i = 1
    while (i < words.length && words[i].literal && words[i].text.startsWith('-') && !words[i].text.startsWith(':::')) {
      const text = words[i].text
      if (text === '--') { i++; break }
      i += values.has(text) ? 2 : 1
    }
    let end = i
    while (end < words.length && !/^::::?\+?$/.test(words[end].text)) end++
    this.stringPayload(words.slice(i, end), segment, ctx, 'parallel')
  }

  sshPayload(words, segment, ctx) {
    const valued = 'BbcDEeFIiJLlmOoPpQRSWw'
    let i = 1
    const skip = () => {
      while (i < words.length && words[i].literal) {
        const text = words[i].text
        if (text === '--') { i++; return }
        if (!text.startsWith('-') || text === '-') return
        let consumed = 1
        for (let k = 1; k < text.length; k++) {
          if (valued.includes(text[k])) {
            if (k === text.length - 1) consumed = 2
            break
          }
        }
        i += consumed
      }
    }
    skip()
    if (i >= words.length) return
    i++
    skip()
    this.stringPayload(words.slice(i), segment, ctx, 'ssh', { remote: true })
  }

  containerPayload(name, words, segment, ctx) {
    const globalValues = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '--url', '--connection', '--root', '--runroot'])
    let i = 1
    while (i < words.length && words[i].literal && words[i].text.startsWith('-')) i += globalValues.has(words[i].text) ? 2 : 1
    if (words[i]?.text === 'container') i++
    const sub = words[i]?.text
    if (sub !== 'run' && sub !== 'exec') return
    i++
    const run = sub === 'run'
    const values = run
      ? ['-a', '--attach', '-c', '--cpu-shares', '--cidfile', '--cpus', '--cpuset-cpus', '-e', '--env', '--env-file', '--entrypoint', '-h', '--hostname', '-l', '--label', '--label-file', '--log-driver', '--log-opt', '-m', '--memory', '--mount', '--name', '--network', '--net', '-p', '--publish', '--platform', '--pull', '--restart', '-u', '--user', '-v', '--volume', '--volumes-from', '-w', '--workdir', '--add-host', '--cap-add', '--cap-drop', '--device', '--dns', '--dns-search', '--gpus', '--health-cmd', '--ipc', '--isolation', '--link', '--mac-address', '--pid', '--runtime', '--security-opt', '--shm-size', '--stop-signal', '--stop-timeout', '--storage-opt', '--sysctl', '--tmpfs', '--ulimit', '--userns', '--uts', '--expose', '--group-add', '--memory-swap', '--cgroupns', '--cgroup-parent', '--ip', '--ip6', '--network-alias', '--annotation', '--pids-limit', '--arch', '--os', '--variant', '--pod', '--secret']
      : ['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys']
    let entrypoint = null
    i = scanOptions(words, i, { values }, (option, value) => {
      if (!value) return
      if (run && (option === '-v' || option === '--volume')) this.addMount(segment, value, 'volume')
      else if (run && option === '--mount') this.addMount(segment, value, 'mount')
      else if (run && option === '--entrypoint') entrypoint = value
      else if (option === '--privileged' && value.text !== 'false') segment.privileged = true
    }, option => {
      if (option === '--privileged') segment.privileged = true
    })
    if (i >= words.length) return
    const payload = words.slice(i + 1)
    if (entrypoint) payload.unshift(entrypoint)
    this.argvPayload(payload, segment, ctx, `${name} ${sub}`, true)
  }

  addMount(segment, value, kind) {
    if (!value.literal) {
      segment.mounts.push({ source: null, raw: value.text, literal: false })
      return
    }
    let source = null
    let target = null
    if (kind === 'volume') {
      const parts = value.text.split(':')
      if (parts.length < 2) return
      ;[source, target] = parts
    } else {
      for (const field of value.text.split(',')) {
        const equal = field.indexOf('=')
        const key = equal < 0 ? field : field.slice(0, equal)
        const fieldValue = equal < 0 ? '' : field.slice(equal + 1)
        if (key === 'source' || key === 'src') source = fieldValue
        if (key === 'target' || key === 'destination' || key === 'dst') target = fieldValue
      }
      if (source === null) return
    }
    if (source.startsWith('/') || source.startsWith('.')) {
      const resolved = resolvePath(source, segment.cwd)
      segment.mounts.push(resolved === null ? { source: null, raw: source, target } : { source: resolved, target })
    } else segment.mounts.push({ source, target, named: true })
  }

  kubectlPayload(words, segment, ctx) {
    const dashes = words.findIndex(word => word.literal && word.text === '--')
    if (dashes < 0 || !words.slice(1, dashes).some(word => word.literal && word.text === 'exec')) return
    this.argvPayload(words.slice(dashes + 1), segment, ctx, 'kubectl exec', true)
  }

  writeTargets(name, words, segment) {
    if (name === 'tee') {
      const operands = []
      for (let k = 1, options = true; k < words.length; k++) {
        const text = words[k].text
        if (options && text === '--') { options = false; continue }
        if (options && words[k].literal && text.startsWith('-') && text !== '-') continue
        operands.push(words[k])
      }
      for (const word of operands) this.addWrite(segment, word, 'tee')
    }
    if (name === 'dd') {
      for (const word of words.slice(1)) if (word.text.startsWith('of=')) this.addWrite(segment, { ...word, text: word.text.slice(3) }, 'dd')
    }
    if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') this.copyTargets(name, words, segment)
    if (name === 'curl') this.curlTargets(words, segment)
    if (name === 'wget') this.wgetTargets(words, segment)
    this.outputOptionTargets(name, words, segment)
  }

  copyTargets(name, words, segment) {
    const values = new Set(['-t', '--target-directory', '-S', '--suffix', ...(name === 'install' ? ['-m', '--mode', '-o', '--owner', '-g', '--group'] : [])])
    const operands = []
    let targetDir = null
    let directories = false
    for (let k = 1, options = true; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (options && text === '--') { options = false; continue }
      if (!options || !word.literal || !text.startsWith('-') || text === '-') { operands.push(word); continue }
      if (text.startsWith('--')) {
        const [option, ...valueParts] = text.split('=')
        const value = valueParts.length ? { ...word, text: valueParts.join('=') } : null
        if (values.has(option) && !value) {
          if (option === '--target-directory') targetDir = words[k + 1]
          k++
        } else if (option === '--target-directory') targetDir = value
        continue
      }
      for (let c = 1; c < text.length; c++) {
        const option = `-${text[c]}`
        if (option === '-d' && name === 'install') directories = true
        if (values.has(option)) {
          const rest = text.slice(c + 1)
          const value = rest ? { ...word, text: rest } : words[++k]
          if (option === '-t') targetDir = value
          break
        }
      }
    }
    const into = (dir, source) => ({ text: joinPath(dir.text, commandBase(source.text.replace(/\/+$/, ''))), literal: dir.literal && source.literal })
    if (targetDir) {
      this.addWrite(segment, targetDir, name)
      for (const source of operands) this.addWrite(segment, into(targetDir, source), name)
    } else if (directories) {
      for (const word of operands) this.addWrite(segment, word, name)
    } else if (operands.length >= 2) {
      const dest = operands.at(-1)
      this.addWrite(segment, dest, name)
      if (operands.length > 2 || dest.text.endsWith('/')) for (const source of operands.slice(0, -1)) this.addWrite(segment, into(dest, source), name)
    } else if (name === 'ln' && operands.length === 1) {
      this.addWrite(segment, { text: commandBase(operands[0].text), literal: operands[0].literal }, name)
    }
  }

  curlTargets(words, segment) {
    const shortValues = 'AbcCdDeEFHKmoPQrTtuUwxXyYz'
    const longValues = new Set(['--output', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--request', '--url', '--config', '--dump-header', '--max-time', '--connect-timeout', '--retry', '--proxy', '--cacert', '--cert', '--key', '--form', '--write-out', '--output-dir', '--upload-file', '--range', '--continue-at'])
    const outputs = []
    const urls = []
    let remoteNames = 0
    let outputDir = null
    const take = (option, value) => {
      if (!value) return
      if (option === '-o' || option === '--output' || option === '-D' || option === '--dump-header' || option === '-c' || option === '--cookie-jar') outputs.push(value)
      else if (option === '--url') urls.push(value)
      else if (option === '--output-dir') outputDir = value
    }
    for (let k = 1; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (!word.literal && !word.glob) { urls.push(word); continue }
      if (!text.startsWith('-') || text === '-') { urls.push(word); continue }
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        const option = equal < 0 ? text : text.slice(0, equal)
        if (option === '--remote-name' || option === '--remote-name-all') remoteNames++
        if (equal >= 0) take(option, { ...word, text: text.slice(equal + 1) })
        else if (longValues.has(option)) take(option, words[++k])
        continue
      }
      for (let c = 1; c < text.length; c++) {
        const option = `-${text[c]}`
        if (option === '-O') remoteNames++
        if (shortValues.includes(text[c])) {
          const rest = text.slice(c + 1)
          take(option, rest ? { ...word, text: rest } : words[++k])
          break
        }
      }
    }
    const base = word => (outputDir && outputDir.literal && !word.text.startsWith('/') ? { text: joinPath(outputDir.text, word.text), literal: word.literal } : word)
    for (const word of outputs) if (word.text !== '-') this.addWrite(segment, base(word), 'curl')
    if (remoteNames) {
      for (const url of urls) {
        const file = urlBasename(url.text)
        if (file) this.addWrite(segment, base({ text: file, literal: url.literal || url.glob }), 'curl')
      }
    }
  }

  wgetTargets(words, segment) {
    const shortValues = 'OoaPeiUtTwQADlBR'
    const longValues = ['--output-document', '--output-file', '--append-output', '--directory-prefix', '--execute', '--input-file', '--user-agent', '--tries', '--timeout', '--wait', '--quota', '--accept', '--reject', '--domains', '--level', '--base', '--header', '--post-data', '--post-file', '--user', '--password', '--quiet', '--verbose', '--continue', '--no-clobber', '--recursive', '--server-response', '--spider', '--no-check-certificate', '--https-only']
    const valued = new Set(longValues.slice(0, 21))
    let document = null
    const logs = []
    const urls = []
    let prefix = null
    const take = (option, value) => {
      if (!value) return
      if (option === '-O' || option === '--output-document') document = value
      else if (option === '-o' || option === '--output-file' || option === '-a' || option === '--append-output') logs.push(value)
      else if (option === '-P' || option === '--directory-prefix') prefix = value
    }
    for (let k = 1; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (!text.startsWith('-') || text === '-' || (!word.literal && !word.glob)) { urls.push(word); continue }
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        const normalized = normalizeLongOption(equal < 0 ? text : text.slice(0, equal), longValues)
        const option = typeof normalized === 'string' ? normalized : text
        if (equal >= 0) take(option, { ...word, text: text.slice(equal + 1) })
        else if (valued.has(option)) take(option, words[++k])
        continue
      }
      for (let c = 1; c < text.length; c++) {
        if (shortValues.includes(text[c])) {
          const rest = text.slice(c + 1)
          take(`-${text[c]}`, rest ? { ...word, text: rest } : words[++k])
          break
        }
      }
    }
    const under = word => (prefix && prefix.literal && !word.text.startsWith('/') ? { text: joinPath(prefix.text, word.text), literal: word.literal } : word)
    for (const word of logs) this.addWrite(segment, word, 'wget')
    if (document) {
      if (document.text !== '-') this.addWrite(segment, document, 'wget')
      return
    }
    for (const url of urls) {
      const file = urlBasename(url.text) ?? 'index.html'
      this.addWrite(segment, under({ text: file, literal: url.literal || url.glob }), 'wget')
    }
  }

  outputOptionTargets(name, words, segment) {
    const table = this.options.outputOpts
    if (!table) return
    let key = name
    let args = words.slice(1)
    if (name === 'git') {
      const rest = gitSubcommandArgs(args.map(word => word.text))
      if (!rest.length) return
      key = `git ${rest[0]}`
      args = args.slice(args.length - rest.length + 1)
    }
    let spec = Object.hasOwn(table, key) ? table[key] : null
    if (!spec && name !== 'git') {
      const sub = args.find(word => !word.text.startsWith('-'))
      if (sub && Object.hasOwn(table, `${name} ${sub.text}`)) {
        key = `${name} ${sub.text}`
        spec = table[key]
        args = args.slice(args.indexOf(sub) + 1)
      }
    }
    if (!spec) return
    if (Array.isArray(spec)) spec = { options: spec }
    const options = spec.options ?? []
    const longs = options.filter(option => option.startsWith('--'))
    const valueOptions = new Set(spec.values ?? [])
    const operandIndexes = new Set(spec.operands ?? [])
    let operand = 0
    for (let k = 0, parsing = true; k < args.length; k++) {
      const word = args[k]
      const text = word.text
      if (parsing && text === '--') { parsing = false; continue }
      if (!parsing || !word.literal || !text.startsWith('-') || text === '-') {
        if (operandIndexes.has(operand)) this.addWrite(segment, word, key)
        operand++
        continue
      }
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        const normalized = normalizeLongOption(equal < 0 ? text : text.slice(0, equal), longs)
        if (typeof normalized === 'string' && options.includes(normalized)) {
          const value = equal >= 0 ? { ...word, text: text.slice(equal + 1) } : args[++k]
          this.addWrite(segment, value, `${key} ${normalized}`)
        } else if (valueOptions.has(equal < 0 ? text : text.slice(0, equal)) && equal < 0) k++
        continue
      }
      if (options.includes(text) && text.length > 2) {
        this.addWrite(segment, args[++k], `${key} ${text}`)
        continue
      }
      if (valueOptions.has(text)) { k++; continue }
      for (let c = 1; c < text.length; c++) {
        const option = `-${text[c]}`
        if (options.includes(option) || valueOptions.has(option)) {
          const rest = text.slice(c + 1)
          const value = rest ? { ...word, text: rest } : args[++k]
          if (options.includes(option)) this.addWrite(segment, value, `${key} ${option}`)
          break
        }
      }
    }
  }

  routes() {
    const segments = this.segments
    const routes = []
    const seen = new Set()
    const add = (kind, fetch, interpreter, extra = {}) => {
      const key = `${fetch}:${interpreter}`
      if (seen.has(key) || routes.length >= MAX_ROUTES) return
      seen.add(key)
      routes.push({ kind, fetch, interpreter, ...extra })
    }
    const names = segments.map(segment => commandName(segment))
    const isFetch = index => fetchSet.has(names[index])
    const isInterpreter = index => isInterpreterName(names[index])
    const children = segments.map(() => [])
    for (const segment of segments) if (segment.payloadOf !== null) children[segment.payloadOf].push(segment.index)
    const subtree = index => {
      const found = []
      const stack = [index]
      while (stack.length) {
        const current = stack.pop()
        found.push(current)
        stack.push(...children[current])
      }
      return found
    }
    const fetched = []
    for (const ranges of this.pipelines) {
      for (let a = 0; a < ranges.length; a++) {
        const [start, end] = ranges[a]
        for (let fetch = start; fetch < end; fetch++) {
          if (!isFetch(fetch)) continue
          for (let b = a + 1; b < ranges.length; b++) {
            for (let target = ranges[b][0]; target < ranges[b][1]; target++) {
              if (isInterpreter(target)) add('pipe', fetch, target)
              for (const write of segments[target].writes) if (write.path && !write.devNull) fetched.push({ path: write.path, fetch, after: target })
            }
          }
        }
      }
    }
    for (const segment of segments) {
      const index = segment.index
      if (isInterpreter(index) || names[index] === 'eval') {
        for (const child of children[index]) {
          if (!substitutionKinds.has(segments[child].via)) continue
          for (const inner of subtree(child)) if (isFetch(inner)) add('substitution', inner, index)
        }
      }
      if (isFetch(index)) {
        for (const write of segment.writes) if (write.path && !write.devNull) fetched.push({ path: write.path, fetch: index, after: index })
        for (const child of children[index]) {
          if (segments[child].via !== '>(') continue
          for (const inner of subtree(child)) if (isInterpreter(inner)) add('substitution', index, inner)
        }
      }
    }
    if (!fetched.length) return routes
    for (const segment of segments) {
      const executed = new Set()
      if (segment.words.length && segment.literal && segment.words[0].includes('/')) executed.add(resolvePath(segment.words[0], segment.cwd))
      if (isInterpreter(segment.index)) {
        segment.words.slice(1).forEach((word, k) => {
          if (segment.wordInfo[k + 1].literal && !word.startsWith('-')) executed.add(resolvePath(word, segment.cwd))
        })
        for (const redirect of segment.redirects) if (redirect.op === '<' && redirect.literal) executed.add(resolvePath(redirect.target, segment.cwd))
      }
      executed.delete(null)
      if (!executed.size) continue
      for (const file of fetched) {
        if (segment.index > file.after && executed.has(file.path)) add('file', file.fetch, segment.index, { path: file.path })
      }
    }
    return routes
  }
}

function assignment(word) {
  const equal = word.text.indexOf('=')
  return { name: word.text.slice(0, equal), value: word.text.slice(equal + 1), literal: word.literal }
}

function xargsCommandIndex(words) {
  const values = new Set(['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a'])
  const longValues = new Set(['--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'])
  const attachedOnly = new Set(['-i', '-l', '-e'])
  let i = 1
  while (i < words.length && words[i].literal) {
    const text = words[i].text
    if (text === '--') return i + 1
    if (!text.startsWith('-') || text === '-') break
    if (text.startsWith('--')) {
      i += longValues.has(text) ? 2 : 1
      continue
    }
    let consumed = 1
    for (let k = 1; k < text.length; k++) {
      const option = `-${text[k]}`
      if (values.has(option)) {
        if (k === text.length - 1) consumed = 2
        break
      }
      if (attachedOnly.has(option)) break
    }
    i += consumed
  }
  return Math.min(i, words.length)
}

/**
 * Parse a Bash command into segments for the classifier (docs/deck/07-approvals.md 3.3). Fails
 * closed: anything the tokenizer does not understand returns `{ ok: false, reason }`.
 *
 * Each segment is `{ index, words, wordInfo, literal, assignments, redirects, wrappers,
 * wrapperOptions, payloadOf, via, depth, cwd, remote, writes, mounts, privileged, pipeline, stage,
 * op }`. `routes` lists the network-to-interpreter routes of the tier review F7 as
 * `{ kind: 'pipe' | 'substitution' | 'file', fetch, interpreter, path? }` (segment indexes).
 * @param {string} command
 * @param {{ cwd?: string, homeDir?: string, outputOpts?: Record<string, string[] | { options?: string[], operands?: number[], values?: string[] }> }} [options]
 * @returns {{ ok: true, segments: object[], routes: object[] } | { ok: false, reason: string }}
 */
export function parseCommand(command, { cwd = null, homeDir = null, outputOpts = null } = {}) {
  if (typeof command !== 'string') return { ok: false, reason: 'not-a-string' }
  if (command.includes('\u0000')) return { ok: false, reason: 'nul' }
  if (command.length > MAX_LENGTH) return { ok: false, reason: 'too-large' }
  const options = { homeDir, homeAssigned: /(?:^|[^\w$])HOME=/.test(command), outputOpts }
  try {
    const list = parseString(command, 0, options)
    const walker = new Walker(options)
    walker.walkList(list, { dir: cwd, depth: 0, payloadOf: null, via: null, remote: false })
    return { ok: true, segments: walker.segments, routes: walker.routes() }
  } catch (error) {
    if (error instanceof ShellError) return { ok: false, reason: error.reason }
    if (error instanceof RangeError) return { ok: false, reason: 'too-large' }
    throw error
  }
}
