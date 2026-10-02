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
// Reserved words that only end a compound command; one at command start anywhere else is a syntax
// error, as in Bash.
const listEnds = ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']
// Two levels of guarantee (D-87, tightened 2026-10-02). `plain: true` means the allowlist in
// `plainText` accepted the whole source text (simple commands joined by `|`, `&&`, `||`, `;`,
// every character from a small literal set, and no command word that is a builtin other than
// echo, printf without -v, true, false, test, `[` and pwd, a wrapper or payload runner, a shell
// or interpreter, no git config option, and no option that changes the directory or repository),
// the parser returned ok, and the walker found no wrapper, no payload segment, no git config
// option and no route; only a plain command may
// be Safe. Outside plain
// the parser is best effort, for raising tiers: it refuses the constructs listed in the
// parseCommand JSDoc with `unsupported` or `unknown-expansion`, and otherwise reports the segments,
// writes and routes it finds. It does not promise to see everything bash runs in a command that
// is not plain. The plan rates a command that does not parse as Caution (D-81).
//
// Reserved words that start a construct this parser does not model (a function body, a
// coprocess, a select menu); `((` (an arithmetic command) is refused next to them.
const unsupportedWords = ['function', 'coproc', 'select']
// Commands refused by name. Arithmetic evaluation runs the `$(...)` inside an array subscript (the
// review reproduced it in bash 5.3 for let, printf -v, test -v, read and declare), and a variable
// NAME operand may carry a subscript, so builtins that do arithmetic or assign to a NAME are
// refused, as are builtins that change how later commands parse or run, and commands that run a
// string or argv this parser does not model. The reasons come from bash(1) and the tools' man
// pages; bash could not be run in this worktree to check them.
const REFUSED_COMMANDS = Object.freeze({
  let: 'evaluates every argument as arithmetic',
  read: 'assigns to NAME operands, which may carry an array subscript',
  mapfile: 'assigns to an array NAME and runs a -C callback',
  readarray: 'assigns to an array NAME and runs a -C callback',
  unset: 'takes NAME operands, which may carry an array subscript',
  getopts: 'assigns to a NAME operand',
  shopt: 'changes how later commands parse and run (lastpipe, extglob, expand_aliases)',
  enable: 'loads or disables builtins, so a later command word may run something else',
  alias: 'changes what a later command word runs',
  hash: '-p binds a command name to any file',
  compgen: 'expands a word list and runs -C and -F commands',
  complete: 'registers -C and -F commands',
  bind: '-x binds a shell command',
  fc: 'runs commands again from the history',
  jobs: '-x runs a command',
  flock: 'runs a command or a -c string; not modelled',
  script: 'runs a -c string or a shell and writes a typescript file; not modelled',
  runuser: 'runs a command or a -c string as another user; not modelled',
  chroot: 'runs a command under another root, where paths mean something else; not modelled',
  watch: 'runs its arguments as an sh -c string, repeatedly; not modelled'
})
// Variables whose assignment may run code, refused wherever they are assigned: bash(1) expands PS4
// like PS1 before each command it traces under xtrace, so a `$(...)` in it may run, and the dynamic
// variables may hold the integer attribute, which makes an assignment an arithmetic evaluation.
// Neither was run against bash here; the list errs on the side of refusing.
const REFUSED_ASSIGNMENTS = Object.freeze(['PS4', 'SECONDS', 'RANDOM', 'SRANDOM', 'LINENO', 'HISTCMD', 'OPTIND', 'BASHPID', 'BASH_SUBSHELL', 'EPOCHSECONDS', 'EPOCHREALTIME', 'PPID', 'UID', 'EUID'])
// `[[` evaluates the operands of these operators as arithmetic.
const COND_ARITHMETIC = Object.freeze(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
// `-v NAME` evaluates a subscript in NAME; `-R NAME` looks a NAME up too. Refused in `[[`,
// `test` and `[`.
const NAME_TESTS = Object.freeze(['-v', '-R'])
// The only `set -o` (and `bash -o`) option names accepted; any other option is refused.
const SET_OPTION_NAMES = Object.freeze(['errexit', 'nounset', 'pipefail', 'xtrace'])
// The only single-letter options accepted after `set` and on a shell's command line (`-c` is the
// shell's own; `-l`, `-i` and `-s` change where it reads input and startup files, not the parse).
const SET_LETTERS = 'eux'
const SHELL_LETTERS = 'euxclis'
const SHELL_LONG_OPTIONS = Object.freeze(['--norc', '--noprofile', '--login', '--noediting', '--rcfile', '--init-file'])
const testUnary = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-o'])
const testBinary = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef', '-a', '-o'])
const declareCommands = new Set(['declare', 'typeset', 'local', 'readonly', 'export'])
const declareLetters = 'gprxfFlut'
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

// True when a `..` component follows a component that is not `..` (`.` counts as one). The kernel
// resolves such a `..` after it follows any symlink before it, so collapsing it lexically may name
// a file in another directory; such a path is reported as unknown.
function dotDotAfterComponent(text) {
  let seen = false
  for (const part of text.split('/')) {
    if (part === '..') {
      if (seen) return true
    } else if (part !== '') seen = true
  }
  return false
}

// D-87 plain text. Every character outside a quote pair is from PLAIN_CHAR or a space; a quote
// pair holds only those characters and spaces. The only operators are `|`, `&&`, `||` and `;`,
// and the only redirects PLAIN_REDIRECTS, each a whole token. The word lists below are written
// out rather than derived from the walker's tables, so the text check does not depend on the
// walker; a test checks that every name in those tables is also excluded here.
const PLAIN_CHAR = /^[A-Za-z0-9_\-./:=@%+,]$/
const PLAIN_QUOTED = /^[A-Za-z0-9_\-./:=@%+, ]*$/
const PLAIN_REDIRECTS = ['2>&1', '2>/dev/null', '>/dev/null']
// Every builtin and reserved word of bash(1) (GNU Bash 5.3, SHELL BUILTIN COMMANDS and RESERVED
// WORDS) except echo, printf (without -v), true, false, test, `[` and pwd.
const PLAIN_EXCLUDED_BUILTINS = Object.freeze(['.', ':', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'enable', 'eval', 'exec', 'exit', 'export', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'pushd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'times', 'trap', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait', '!', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then', 'until', 'while', '{', '}', 'time', '[[', ']]'])
// Wrappers and payload runners, excluded whatever their arguments: the wrapper table of the walker
// (`wrapperSpecs`), npx (the walker's `npx --no-install` runner; npx runs a package in any form)
// and the commands whose payload the walker parses from their own words.
const PLAIN_EXCLUDED_WRAPPERS = Object.freeze(['builtin', 'bunx', 'command', 'doas', 'env', 'eval', 'exec', 'ionice', 'nice', 'nohup', 'npx', 'parallel', 'pkexec', 'setsid', 'ssh', 'stdbuf', 'su', 'sudo', 'time', 'timeout', 'trap', 'xargs'])
// Runners excluded when a subcommand that runs a package or payload is one of their words: the
// walker's runner table (`uv run`, `poetry run`, `pnpm exec`) and the package runners `npm exec`,
// `npm x`, `pnpm dlx`, `yarn dlx`, `yarn exec`, `bun x` and `deno run`.
const PLAIN_EXCLUDED_RUNNERS = Object.freeze({ uv: Object.freeze(['run']), poetry: Object.freeze(['run']), pnpm: Object.freeze(['exec', 'dlx']), npm: Object.freeze(['exec', 'x']), yarn: Object.freeze(['dlx', 'exec']), bun: Object.freeze(['x']), deno: Object.freeze(['run']) })
// Commands excluded only with an option or subcommand that runs a payload or writes a file.
const PLAIN_CONDITIONAL = Object.freeze({
  find: word => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls'].includes(word) || word.startsWith('-fprint'),
  fd: word => /^-[A-Za-z]*[xX]/.test(word) || word.startsWith('--exec'),
  fdfind: word => /^-[A-Za-z]*[xX]/.test(word) || word.startsWith('--exec'),
  docker: word => word === 'run' || word === 'exec',
  podman: word => word === 'run' || word === 'exec',
  kubectl: word => word === 'exec'
})
// The shells and interpreters of F7 (`shellSet` and INTERPRETERS); a name starting `python` is
// matched as a prefix.
const PLAIN_EXCLUDED_INTERPRETERS = Object.freeze(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'mksh', 'fish', 'busybox', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'source', '.'])
// Options that change the directory or repository a command acts on, matched exactly, as
// `--opt=value`, or as a getopt_long prefix (`--dir`); `-C` also attached (`-Cdir`) or in a
// bundle (`-xzC`).
const PLAIN_DIRECTORY_OPTIONS = Object.freeze(['--git-dir', '--work-tree', '--directory', '--chdir', '--prefix', '--project', '--cwd', '--dir', '--manifest-path'])

// True when a git command line sets configuration before its subcommand (`-c`, `-cname=value`,
// `--config-env`): any config key may run code (core.pager, core.fsmonitor, alias.*). Used by
// both halves of plain.
function gitConfigOption(words) {
  if (!words.length || commandBase(words[0]) !== 'git') return false
  for (const word of words.slice(1)) {
    if (!word.startsWith('-')) return false
    if (word.startsWith('-c') || /^--config-env(?:=|$)/.test(word)) return true
  }
  return false
}

function plainDirectoryOption(word) {
  if (/^-[A-Za-z]*C/.test(word)) return true
  if (!word.startsWith('--') || word.length < 3) return false
  const name = word.split('=')[0]
  return PLAIN_DIRECTORY_OPTIONS.some(option => option.startsWith(name))
}

function plainCommandWords(words) {
  const [first, ...args] = words
  if (first.includes('=') || first.startsWith('%')) return false
  const name = commandBase(first)
  if (PLAIN_EXCLUDED_BUILTINS.includes(name) || PLAIN_EXCLUDED_WRAPPERS.includes(name)) return false
  if (PLAIN_EXCLUDED_INTERPRETERS.includes(name) || name.startsWith('python')) return false
  if (name === 'printf' && /^-[A-Za-z]*v/.test(args[0] ?? '')) return false
  if (Object.hasOwn(PLAIN_EXCLUDED_RUNNERS, name) && args.some(arg => PLAIN_EXCLUDED_RUNNERS[name].includes(arg))) return false
  if (gitConfigOption(words)) return false
  if (Object.hasOwn(PLAIN_CONDITIONAL, name) && args.some(PLAIN_CONDITIONAL[name])) return false
  return !args.some(plainDirectoryOption)
}

/**
 * The lists behind the D-87 raw text check, for tests: `builtins`, `wrappers`, `interpreters`
 * (a name starting `python` is also excluded), `runners` (name to the subcommands that run a
 * package or payload), `conditional` (name to a predicate over its words) and `directoryOptions`.
 */
export const PLAIN_EXCLUSIONS = Object.freeze({ builtins: PLAIN_EXCLUDED_BUILTINS, wrappers: PLAIN_EXCLUDED_WRAPPERS, interpreters: PLAIN_EXCLUDED_INTERPRETERS, runners: PLAIN_EXCLUDED_RUNNERS, conditional: PLAIN_CONDITIONAL, directoryOptions: PLAIN_DIRECTORY_OPTIONS })

/**
 * The D-87 check on the source text alone, apart from the walker (see `isPlain` for the rule).
 * `isPlain` also needs the parse to succeed and `segmentsArePlain` to hold.
 * @param {string} source
 * @returns {boolean}
 */
export function isPlainText(source) {
  return typeof source === 'string' && plainText(source)
}

function plainText(source) {
  const commands = [[]]
  let word = null
  const endWord = () => {
    if (word !== null) commands.at(-1).push(word)
    word = null
  }
  const operator = length => {
    endWord()
    if (!commands.at(-1).length && !commands.at(-1).redirected) return false
    commands.push([])
    return length
  }
  for (let i = 0; i < source.length;) {
    const char = source[i]
    if (char === ' ') { endWord(); i++; continue }
    if (word === null) {
      const redirect = PLAIN_REDIRECTS.find(token => source.startsWith(token, i) && [undefined, ' ', '|', ';', '&'].includes(source[i + token.length]))
      if (redirect) { commands.at(-1).redirected = true; i += redirect.length; continue }
    }
    if (char === '|' || char === ';' || char === '&') {
      const pair = source.slice(i, i + 2)
      const length = pair === '&&' || pair === '||' ? 2 : char === '&' ? 0 : 1
      if (!length || !operator(length)) return false
      i += length
      continue
    }
    if (char === "'" || char === '"') {
      const end = source.indexOf(char, i + 1)
      if (end < 0) return false
      const inner = source.slice(i + 1, end)
      if (!PLAIN_QUOTED.test(inner)) return false
      word = (word ?? '') + inner
      i = end + 1
      continue
    }
    if (!PLAIN_CHAR.test(char)) return false
    word = (word ?? '') + char
    i++
  }
  endWord()
  for (const command of commands) {
    if (!command.length) return false
    if (!plainCommandWords(command)) return false
    if (command.some(dotDotAfterComponent)) return false
  }
  return true
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
      else if (char === '\\' && this.s[this.i + 1] === '\n') fail('unsupported')
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
        // In an unquoted body bash joins a backslash-newline before it compares a line with the
        // delimiter (the review saw `EO\` + `F` end the body in bash 5.3). Not modelled: any body
        // line ending in a backslash is refused.
        if (!heredoc.quoted && line.endsWith('\\')) fail('unsupported')
      }
      if (bodyEnd < 0) fail('heredoc-delimiter')
      const body = this.s.slice(bodyStart, bodyEnd)
      heredoc.redirect.body = heredoc.strip ? body.replace(/^\t+/gm, '') : body
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

  // `end` is null (the whole input), ')' or a list of reserved words that close the list.
  atEnd(end) {
    return Array.isArray(end) && end.some(word => this.atWord(word))
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
      if (this.atEnd(end)) return items
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
        if (!this.commandStartsAt() || this.atEnd(end)) fail('syntax')
        continue
      }
      if (op === null) {
        const next = this.s[this.i]
        if (next === undefined) {
          if (end) fail('syntax')
          return items
        }
        if (next === ')' && end === ')') return items
        if (this.atEnd(end)) return items
        fail('syntax')
      }
    }
  }

  // `!` and the `time` keyword (with `-p` and `--`) may precede a pipeline in any order; what
  // follows them is checked exactly as at command start. A timed simple command gets a keyword
  // `time` word back in front, which the walker strips as the `time` wrapper with no options.
  parsePipeline() {
    const stages = []
    this.skipBlanks()
    let negated = false
    let timed = false
    for (;;) {
      if (this.atWord('!')) {
        negated = true
        this.i++
      } else if (this.atWord('time')) {
        timed = true
        this.i += 4
        this.skipBlanks()
        while (this.atWord('-p')) { this.i += 2; this.skipBlanks() }
        if (this.atWord('--')) this.i += 2
      } else break
      this.skipBlanks()
    }
    if (timed && !this.commandStartsAt()) return { negated, stages: [{ command: { type: 'simple', assigns: [], words: [keywordTime()], redirects: [] }, pipe: null }] }
    for (;;) {
      const command = this.parseCommand()
      if (timed && !stages.length && command.type === 'simple') command.words.unshift(keywordTime())
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
    this.skipBlanks()
    if (unsupportedWords.some(word => this.atWord(word)) || this.s.startsWith('((', this.i)) fail('unsupported')
    if (this.atWord('case')) fail('syntax')
    if (listEnds.some(word => this.atWord(word))) fail('syntax')
    if (this.atWord('if')) return this.parseIf()
    if (this.atWord('while') || this.atWord('until')) return this.parseLoop()
    if (this.atWord('for')) return this.parseFor()
    if (this.atWord('[[')) return this.parseCond()
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
      const body = this.parseList(['}'])
      if (!this.atWord('}') || !body.length) fail('syntax')
      this.i++
      this.leave()
      return { type: 'group', kind: 'brace', body, redirects: this.parseTrailingRedirects() }
    }
    return this.parseSimple()
  }

  // A non-empty list closed by one of `ends`; the caller consumes the closing word.
  clause(ends) {
    const list = this.parseList(ends)
    if (!list.length) fail('syntax')
    return list
  }

  parseIf() {
    this.enter()
    this.i += 2
    const body = []
    for (;;) {
      body.push(...this.clause(['then']))
      this.i += 4
      body.push(...this.clause(['elif', 'else', 'fi']))
      if (this.atWord('elif')) { this.i += 4; continue }
      if (this.atWord('else')) {
        this.i += 4
        body.push(...this.clause(['fi']))
      }
      break
    }
    this.i += 2
    this.leave()
    return { type: 'group', kind: 'if', body, redirects: this.parseTrailingRedirects() }
  }

  parseLoop() {
    const kind = this.atWord('while') ? 'while' : 'until'
    this.enter()
    this.i += kind.length
    const body = this.clause(['do'])
    this.i += 2
    body.push(...this.clause(['done']))
    this.i += 4
    this.leave()
    return { type: 'group', kind, body, redirects: this.parseTrailingRedirects() }
  }

  parseFor() {
    this.enter()
    this.i += 3
    this.skipBlanks()
    if (this.s.startsWith('((', this.i)) fail('unsupported')
    let j = this.i
    while (isNameChar(this.s[j])) j++
    const after = this.s[j]
    if (!isNameStart(this.s[this.i]) || !(after === undefined || metaChars.has(after))) fail('syntax')
    if (REFUSED_ASSIGNMENTS.includes(this.s.slice(this.i, j))) fail('unsupported')
    this.i = j
    const items = []
    this.skipNewlines()
    if (this.atWord('in')) {
      this.i += 2
      for (;;) {
        this.skipBlanks()
        const char = this.s[this.i]
        if (char === undefined || char === ';' || char === '\n') break
        if (metaChars.has(char)) fail('syntax')
        items.push(this.readWord())
      }
      if (this.s[this.i] === ';') this.i++
      else if (this.s[this.i] === '\n') this.newline()
      else fail('syntax')
    } else if (this.s[this.i] === ';') this.i++
    this.skipNewlines()
    if (!this.atWord('do')) fail('syntax')
    this.i += 2
    const body = this.clause(['done'])
    this.i += 4
    this.leave()
    return { type: 'group', kind: 'for', body, items, redirects: this.parseTrailingRedirects() }
  }

  // `[[ ... ]]` is one command whose operators (`&&`, `||`, `!`, `(`, `)`, `<`, `>`) are words, not
  // list or redirect syntax; it becomes a simple command `[[ ... ]]` the walker checks. `=~` (its
  // right side has its own lexing) and any other operator are refused.
  parseCond() {
    const words = [literalWord('[[')]
    this.i += 2
    for (;;) {
      this.skipNewlines()
      const char = this.s[this.i]
      if (char === undefined) fail('syntax')
      if (this.atWord(']]')) {
        this.i += 2
        words.push(literalWord(']]'))
        break
      }
      const pair = this.s.slice(this.i, this.i + 2)
      if (pair === '&&' || pair === '||') { words.push(literalWord(pair)); this.i += 2; continue }
      if (char === '(' || char === ')' || char === '<' || char === '>') { words.push(literalWord(char)); this.i++; continue }
      if (metaChars.has(char)) fail('unsupported')
      const word = this.readWord()
      if (word.text === '=~' && word.literal) fail('unsupported')
      words.push(word)
    }
    return { type: 'simple', assigns: [], words, redirects: this.parseTrailingRedirects() }
  }

  parseTrailingRedirects() {
    const redirects = []
    for (;;) {
      this.skipBlanks()
      if (!this.redirectAhead()) return redirects
      redirects.push(this.parseRedirect())
    }
  }

  // `{name}>file` (a named file descriptor) is a redirect wherever it stands in a simple command.
  namedFdEnd() {
    if (this.s[this.i] !== '{' || !isNameStart(this.s[this.i + 1])) return -1
    let j = this.i + 2
    while (isNameChar(this.s[j])) j++
    return this.s[j] === '}' && (this.s[j + 1] === '<' || this.s[j + 1] === '>') ? j + 1 : -1
  }

  redirectAhead() {
    if (this.namedFdEnd() >= 0) return true
    let j = this.i
    while (isDigit(this.s[j])) j++
    const char = this.s[j]
    if (char === '<' || char === '>') return this.s[j + 1] !== '(' || j > this.i
    return j === this.i && char === '&' && this.s[j + 1] === '>'
  }

  parseSimple() {
    const command = { type: 'simple', assigns: [], words: [], redirects: [] }
    for (;;) {
      this.skipBlanks()
      const char = this.s[this.i]
      if (char === undefined || char === '\n' || char === ';' || char === '|' || char === ')') break
      if (char === '&' && this.s[this.i + 1] !== '>') break
      if (char === '(') fail('syntax')
      if ((char === '<' || char === '>') && this.s[this.i + 1] === '(') { command.words.push(this.readProcessSubstitution()); continue }
      if (this.redirectAhead()) { command.redirects.push(this.parseRedirect()); continue }
      const word = this.readWord()
      if (!command.words.length && /^[A-Za-z_]\w*\+?=/.test(word.raw)) { command.assigns.push(word); continue }
      // `NAME[subscript]=value` evaluates the subscript as arithmetic.
      if (!command.words.length && /^[A-Za-z_]\w*\[/.test(word.raw)) fail('unsupported')
      command.words.push(word)
    }
    if (!command.words.length && !command.assigns.length && !command.redirects.length) fail('syntax')
    return command
  }

  parseRedirect() {
    let fd = ''
    let varFd = null
    const named = this.namedFdEnd()
    if (named >= 0) {
      varFd = this.s.slice(this.i + 1, named - 1)
      this.i = named
    }
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
    if (varFd) redirect.varFd = varFd
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
    // Any unquoted `{` followed later in the word by an unquoted `,` or `..` may be a brace
    // expansion at some nesting depth, so the word is marked glob (not literal).
    let brace = false
    let bracket = false
    if (s[this.i] === '~') this.readTilde(word, false)
    while (this.i < s.length) {
      const char = s[this.i]
      if (metaChars.has(char)) break
      // Bash expands `~` after the `=` of any NAME= word (so `dd of=~/x` writes the home file), and
      // after a `:` in its value.
      if (char === '~' && /^[A-Za-z_]\w*=(?:[^'"\\]*:)?$/.test(s.slice(start, this.i))) { this.readTilde(word, true); continue }
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
        // Bash joins a backslash-newline before it tokenizes: the round 2 review saw bash 5.3 run
        // `$\<newline>(cmd)` as a substitution (bash could not be run here). The tokens here are
        // already read, so every continuation outside single quotes is refused.
        if (next === '\n') fail('unsupported')
        word.text += next
        word.quoted = true
        this.i += 2
      } else if (char === '$') this.readDollar(word, false)
      else if (char === '`') this.readBacktick(word, false)
      else {
        if (char === '*' || char === '?') word.glob = true
        else if (char === '[') bracket = true
        else if (char === ']' && bracket) word.glob = true
        else if (char === '{') brace = true
        else if (brace && (char === ',' || (char === '.' && s[this.i + 1] === '.'))) word.glob = true
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
        if (next === '\n') fail('unsupported')
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          word.text += next
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

  // A bare `~` is the home directory unless HOME may have been reassigned; `~user`, `~+` and `~-`
  // name a directory this parser does not know, so the word stops being literal.
  readTilde(word, assignment) {
    const next = this.s[this.i + 1]
    const bare = next === undefined || next === '/' || metaChars.has(next) || (assignment && next === ':')
    if (bare && this.homeExpands()) word.text += this.options.homeDir
    else {
      word.text += '~'
      word.expansion = true
    }
    this.i++
  }

  // `split` marks an expansion outside double quotes, whose result may split into several words.
  readDollar(word, inDouble) {
    const s = this.s
    const start = this.i
    const next = s[this.i + 1]
    const unquoted = () => { if (!inDouble) word.split = true }
    if (next === '(') {
      // Arithmetic expansion evaluates array subscripts held in variable values, which run their
      // `$(...)`, so every `$((` is refused (as is `$[`).
      if (s[this.i + 2] === '(') fail('unknown-expansion')
      unquoted()
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
      // Only `${NAME}` and `${N}`. Every operator form is refused: bash scans quotes inside the
      // braces by rules this parser does not model, `${v:off}` and `${a[i]}` evaluate arithmetic,
      // `${v@P}` runs the `$(...)` in a value, `${!v}` is indirection and `${ cmd; }` runs cmd.
      const match = /^\{([A-Za-z_]\w*|\d+)\}/.exec(s.slice(this.i + 1, this.i + 260))
      if (!match) fail('unknown-expansion')
      if (match[1] === 'HOME' && this.homeExpands()) word.text += this.options.homeDir
      else {
        word.expansion = true
        unquoted()
        word.text += s.slice(start, this.i + 1 + match[0].length)
      }
      this.i += 1 + match[0].length
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
        unquoted()
        word.text += s.slice(start, j)
      }
      this.i = j
      return
    }
    if (next !== undefined && '0123456789@*#?$!-'.includes(next)) {
      word.expansion = true
      unquoted()
      word.text += `$${next}`
      this.i += 2
      return
    }
    word.text += '$'
    this.i++
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
    if (!inDouble) word.split = true
    word.text += s.slice(this.i, j + 1)
    this.i = j + 1
  }
}

function parseString(text, depth, options) {
  if (depth > MAX_DEPTH) fail('too-deep')
  return new Parser(text, depth, options).parseAll()
}

const literalWord = text => ({ text, raw: text, expansion: false, glob: false, quoted: false, literal: true, subs: [] })
const keywordTime = () => ({ ...literalWord('time'), keyword: true })

// getopt_long matching: an exact long option, or a unique prefix of one (`--targ` is
// `--target-directory`). With `prefixes: false` (a tool that does not use getopt_long) only an
// exact match counts. An ambiguous or unknown option is refused.
function matchLong(name, known, prefixes = true) {
  if (known.includes(name)) return name
  const candidates = prefixes ? known.filter(option => option.startsWith(name)) : []
  if (candidates.length === 1) return candidates[0]
  fail('unsupported')
}

// Scan the options of a wrapper or a payload command. `flags` and `values` are the options the
// plan names; `other` (with a value) and `extra` (without one) are known options that set
// wrapperOptions; `optional` are long options whose value is only given as `--opt=value`, and
// `attached` short options whose value is only the rest of their word (`-i{}`); `refuse` are long
// options that are refused but listed, so a prefix is judged against the tool's whole list. With
// `strict`, an option the spec does not know is refused, since the word after it may be its value
// and reading that value as the command would hide the command.
function scanOptions(words, start, spec, onValue = () => {}, onFlag = () => {}) {
  const flags = new Set(spec.flags ?? [])
  const values = new Set(spec.values ?? [])
  const other = new Set(spec.other ?? [])
  const extra = new Set(spec.extra ?? [])
  const optional = new Set(spec.optional ?? [])
  const attached = new Set(spec.attached ?? [])
  const refuse = new Set(spec.refuse ?? [])
  const longs = [...flags, ...values, ...other, ...extra, ...optional, ...refuse].filter(option => option.startsWith('--'))
  let i = start
  while (i < words.length) {
    const word = words[i]
    const text = word.text
    if (!word.literal) break
    // GNU env (and sudo) take any operand holding `=` before the command as an assignment, also
    // after `--` (the review ran `env -- PATH=. ls` in bash and it ran ./ls), so one whose name is
    // not a NAME (`a.b=1`, `BASH_FUNC_f%%=...`, which defines a function) is refused rather than
    // read as the command word.
    const assign = operand => {
      if (!/^[A-Za-z_]\w*=/.test(operand.text)) fail('unsupported')
      onValue('=', operand)
    }
    if (text === '--') {
      i++
      for (; spec.assigns && i < words.length && words[i].literal && words[i].text.includes('='); i++) assign(words[i])
      break
    }
    if (spec.assigns && !text.startsWith('-') && text.includes('=')) {
      assign(word)
      i++
      continue
    }
    if (text === '-' && spec.dashIsFlag) { onValue('-', null); i++; continue }
    if (!text.startsWith('-') || text === '-') break
    if (spec.numeric && /^-\d+$/.test(text)) { i++; continue }
    if (text.startsWith('--')) {
      const equal = text.indexOf('=')
      let name = equal < 0 ? text : text.slice(0, equal)
      if (spec.strict) {
        name = matchLong(name, longs, Boolean(spec.long))
        if (refuse.has(name)) fail('unsupported')
        if (equal >= 0 && (flags.has(name) || extra.has(name))) fail('unsupported')
      }
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
      if (attached.has(option)) {
        onFlag(option)
        break
      }
      if (spec.strict && !flags.has(option) && !extra.has(option)) fail('unsupported')
      if (!flags.has(option)) onFlag(option)
    }
    i += consumed
  }
  return Math.min(i, words.length)
}

// Option lists come from `--help` (nice, nohup, timeout, stdbuf, setsid, ionice) and the man pages
// (env, sudo, pkexec) on the development machine; GNU time and doas are not installed there, so
// their lists come from their documentation unchecked. `long` marks getopt_long (prefix) matching.
// The `time` entry is GNU time (/usr/bin/time); the Bash keyword `time` takes no options here and
// is handled by the parser.
const wrapperSpecs = {
  env: { strict: true, long: true, assigns: true, dashIsFlag: true, flags: ['-i', '--ignore-environment', '-0', '--null'], values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], other: ['-a', '--argv0'], extra: ['-v', '--debug', '--list-signal-handling'], optional: ['--block-signal', '--default-signal', '--ignore-signal'], refuse: ['--help', '--version'] },
  command: { strict: true, flags: ['-p'] },
  builtin: { strict: true },
  exec: { strict: true, flags: ['-c', '-l'], other: ['-a'] },
  time: { strict: true, long: true, flags: ['-p', '--portability'], other: ['-f', '--format', '-o', '--output'], extra: ['-a', '--append', '-v', '--verbose', '-q', '--quiet'], refuse: ['--help', '--version'] },
  nice: { strict: true, long: true, numeric: true, values: ['-n', '--adjustment'], refuse: ['--help', '--version'] },
  nohup: { strict: true, long: true, refuse: ['--help', '--version'] },
  timeout: { strict: true, long: true, flags: ['--preserve-status', '-p', '--foreground', '-f', '-v', '--verbose'], values: ['-s', '--signal', '-k', '--kill-after'], refuse: ['--help', '--version'] },
  stdbuf: { strict: true, long: true, values: ['-i', '-o', '-e', '--input', '--output', '--error'], refuse: ['--help', '--version'] },
  sudo: { strict: true, long: true, assigns: true, other: ['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout', '-a', '--auth-type', '-c', '--login-class'], extra: ['-A', '--askpass', '-B', '--bell', '-b', '--background', '-E', '-H', '--set-home', '-i', '--login', '-k', '--reset-timestamp', '-N', '--no-update', '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell'], optional: ['--preserve-env'], refuse: ['--help', '--version', '--edit', '--list', '--validate', '--remove-timestamp', '--chroot', '--host'] },
  doas: { strict: true, other: ['-u', '-C', '-a'], extra: ['-L', '-n', '-s'] },
  pkexec: { strict: true, other: ['--user'], extra: ['--disable-internal-agent', '--keep-cwd'] },
  setsid: { strict: true, long: true, extra: ['-c', '--ctty', '-f', '--fork', '-w', '--wait'], refuse: ['--help', '--version'] },
  ionice: { strict: true, long: true, other: ['-c', '--class', '-n', '--classdata'], extra: ['-t', '--ignore'], refuse: ['--pid', '--pgid', '--uid', '--help', '--version'] }
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
    // Directories reached by a cd, `env -C` or `sudo -D` through a component that may be a
    // symlink. A leading `..` from one of them is resolved by the kernel from the symlink target,
    // so it is reported as unknown. The starting `cwd` is taken as a physical path.
    this.logicalDirs = new Set()
  }

  resolve(text, dir) {
    if (dotDotAfterComponent(text)) return null
    if (text.startsWith('/')) return path.posix.resolve(text)
    if (!dir) return null
    if ((text === '..' || text.startsWith('../')) && this.logicalDirs.has(dir)) return null
    return path.posix.resolve(dir, text)
  }

  // From a logical directory `resolve` already gives null for any `..`, so only a target naming a
  // component other than `.` and `..` can make the result logical.
  chdir(text, dir) {
    const result = this.resolve(text, dir)
    if (result !== null && text.split('/').some(part => part !== '' && part !== '.' && part !== '..')) this.logicalDirs.add(result)
    return result
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
      stdinShell: false,
      pipeline: position?.pipeline ?? null,
      stage: position?.stage ?? null,
      op: position?.op ?? null
    }
    this.segments.push(segment)
    return segment
  }

  // A list is a run of and-or lists (items joined by `&&` and `||`). One that ends in `&` runs in a
  // background subshell, so its directory changes stay inside it. A directory change reaches the
  // next item only through `&&` with no `||` before it in the same and-or list: on any other path
  // the `cd` may have failed or been skipped, so the directory becomes unknown (null).
  walkList(list, ctx) {
    for (let first = 0; first < list.length;) {
      let last = first
      while (last < list.length - 1 && (list[last].op === '&&' || list[last].op === '||')) last++
      const chainCtx = list[last].op === '&' ? { ...ctx } : ctx
      const start = chainCtx.dir
      let sawOr = false
      for (let k = first; k <= last; k++) {
        const before = chainCtx.dir
        const op = list[k].op
        this.walkPipeline(list[k].pipeline, chainCtx, op)
        if (chainCtx.dir !== before && (op !== '&&' || sawOr)) chainCtx.dir = null
        if (op === '||') {
          sawOr = true
          if (chainCtx.dir !== start) chainCtx.dir = null
        }
      }
      if (chainCtx.dir !== start) chainCtx.dir = null
      first = last + 1
    }
  }

  walkPipeline(pipeline, ctx, op) {
    const id = this.pipelines.length
    const ranges = []
    this.pipelines.push(ranges)
    const single = pipeline.stages.length === 1
    // Every stage of a multi-stage pipeline gets its own copy of the context, so a `cd` in any
    // stage leaves the shell directory alone. Bash runs the last stage in the current shell only
    // under `shopt -s lastpipe`, and `shopt` (and `bash -O`) is refused.
    pipeline.stages.forEach((stage, index) => {
      const stageCtx = single ? ctx : { ...ctx }
      const start = this.segments.length
      this.walkCommand(stage.command, stageCtx, { pipeline: id, stage: index, op: stage.pipe ?? op, single })
      ranges.push([start, this.segments.length])
    })
  }

  walkCommand(command, ctx, position) {
    if (command.type === 'simple') return this.walkSimple(command, ctx, position, true)
    const dir = ctx.dir
    const inner = { ...ctx, depth: ctx.depth + 1 }
    const start = this.segments.length
    if (command.items?.some(word => word.subs.length)) this.walkSubs(command.items, this.newSegment(ctx, position), ctx)
    const bodyStart = this.segments.length
    const pipelinesStart = this.pipelines.length
    this.walkList(command.body, inner)
    // A later iteration of a loop starts where the previous one left the shell, so when the body
    // or condition moves the directory anywhere, the body is walked again with it unknown.
    if ((command.kind === 'for' || command.kind === 'while' || command.kind === 'until') && dir !== null && inner.dir !== dir) {
      this.segments.length = bodyStart
      this.pipelines.length = pipelinesStart
      inner.dir = null
      this.walkList(command.body, inner)
    }
    // A brace group runs in this shell. The body of if, while, until and for may run zero times or
    // only in part, so a directory it changes is unknown afterwards. A subshell never leaks.
    if (position.single && command.kind === 'brace') ctx.dir = inner.dir
    else if (position.single && command.kind !== 'subshell' && inner.dir !== dir) ctx.dir = null
    if (!command.redirects.length) return
    let holders = this.segments.slice(start).filter(segment => segment.payloadOf === (ctx.payloadOf ?? null))
    if (!holders.length) holders = [this.newSegment(inner, position)]
    // The shell opens a compound's redirects before its body runs, so they resolve in `dir`.
    for (const holder of holders) this.addRedirects(holder, command.redirects, dir)
    for (const redirect of command.redirects) this.walkSubs([redirect.target, { subs: redirect.subs }], holders[0], ctx)
  }

  // Redirects are opened by the shell, so they resolve against the shell directory `dir`, never the
  // directory a wrapper such as `env -C` gives the command.
  addRedirects(segment, redirects, dir) {
    for (const redirect of redirects) {
      const record = { fd: redirect.fd, op: redirect.op, target: redirect.target.text, literal: redirect.target.literal }
      if (redirect.varFd) record.varFd = redirect.varFd
      if (redirect.heredoc) { record.heredoc = true; record.quoted = redirect.quoted }
      if ((redirect.op === '>&' || redirect.op === '<&') && /^(?:\d+|-)$/.test(redirect.target.text)) record.dup = true
      if (!redirect.heredoc && redirect.op !== '<<<' && !record.dup && !redirect.target.procSub) record.path = redirect.target.literal ? this.resolve(redirect.target.text, dir) : null
      segment.redirects.push(record)
      if (writeOps.has(redirect.op) && !record.dup && !redirect.target.procSub) this.addWrite(segment, redirect.target, redirect.op === '>&' ? '&>' : redirect.op, dir)
    }
  }

  addWrite(segment, word, via, dir = segment.cwd) {
    if (!word) return
    if (!word.literal) {
      segment.writes.push({ path: null, raw: word.text, via, literal: false })
      return
    }
    const resolved = this.resolve(word.text, dir)
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
    const segment = this.newSegment(ctx, position)
    for (const word of command.assigns) segment.assignments.push(assignment(word))
    const words = command.words.slice()
    const start = this.stripWrappers(words, segment, ctx)
    const rest = words.slice(start)
    segment.words = rest.map(word => word.text)
    segment.wordInfo = rest.map(word => ({ literal: word.literal, quoted: word.quoted, glob: word.glob }))
    segment.literal = rest.length ? rest[0].literal : true
    this.addRedirects(segment, command.redirects, ctx.dir)
    if (walkSubstitutions) {
      this.walkSubs([...command.assigns, ...command.words, ...command.redirects.map(redirect => redirect.target)], segment, ctx)
      for (const redirect of command.redirects) this.walkSubs([{ subs: redirect.subs }], segment, ctx)
    }
    // `exec` with only redirects keeps them open for every later command, so a process
    // substitution, here-string or heredoc there feeds commands this parser cannot link to it.
    if (!rest.length && segment.wrappers.includes('exec') && command.redirects.some(redirect => redirect.target.procSub || redirect.heredoc || redirect.op === '<<<')) fail('unsupported')
    if (!rest.length || !rest[0].literal) return
    const name = commandBase(rest[0].text)
    refuseUnmodelled(name, rest)
    this.assignmentsOf(name, rest, segment)
    this.payloads(name, rest, segment, ctx, command.redirects)
    this.writeTargets(name, rest, segment)
    if (ctx.runtimeArgs) this.runtimeWrite(name, segment, ctx.via)
    // These run code in the current shell. A trap action or a sourced file may change the
    // directory in ways the parser cannot see; an eval payload is checked for a directory change.
    if (name === 'trap' || name === '.' || name === 'source') ctx.dir = null
    else if (name === 'eval' && this.segments.slice(segment.index + 1).some(payload => !payload.literal || ['cd', 'pushd', 'popd', 'trap', '.', 'source'].includes(commandName(payload)))) ctx.dir = null
    if ((name === 'cd' || name === 'pushd' || name === 'popd') && position?.single) {
      // Behind an external wrapper (`env cd`, `sudo cd`) cd is a separate process and the shell
      // stays put; `time` is a Bash keyword that runs the builtin, but /usr/bin/time does not.
      const own = segment.wrappers.slice(ctx.wrappers?.length ?? 0).filter(wrapper => wrapper !== 'command' && wrapper !== 'builtin')
      if (!own.length) ctx.dir = this.changeDirectory(name, rest, ctx.dir)
      else if (own.includes('time')) ctx.dir = null
    }
  }

  // `popd`, `pushd` (stack rotation, and CDPATH as for cd), `cd -` (OLDPWD) and a non-literal
  // target give an unknown directory. A cd target whose first component is not `/`, `.` or `..` is
  // looked up in CDPATH first (POSIX cd; the review saw bash 5.3 follow CDPATH for `.ssh`), and
  // CDPATH may be assigned in the command or inherited, so such a target gives an unknown
  // directory too.
  changeDirectory(name, words, dir) {
    if (name !== 'cd') return null
    let i = 1
    while (i < words.length && /^-[LPe@]+$/.test(words[i].text)) i++
    if (words[i]?.text === '--') i++
    const target = words[i]
    if (!target) return this.options.homeDir && !this.options.homeAssigned ? this.options.homeDir : null
    if (!target.literal) return null
    const text = target.text
    if (!(text.startsWith('/') || text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../'))) return null
    return this.chdir(text, dir)
  }

  assignmentsOf(name, words, segment) {
    if (!declareCommands.has(name)) return
    for (const word of words.slice(1)) {
      if (/^[A-Za-z_]\w*\+?=/.test(word.text)) segment.assignments.push({ ...assignment(word), exported: true })
    }
  }

  stripWrappers(words, segment, ctx) {
    let i = 0
    let shell = false
    while (i < words.length && words[i].literal) {
      if (words[i].keyword) {
        segment.wrappers.push('time')
        i++
        continue
      }
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
        if (name === 'env' && (option === '-C' || option === '--chdir') && value) segment.cwd = value.literal ? this.chdir(value.text, segment.cwd) : null
        if (name === 'sudo' && (option === '-D' || option === '--chdir') && value) segment.cwd = value.literal ? this.chdir(value.text, segment.cwd) : null
        if (name === 'env' && (option === '-S' || option === '--split-string')) split = value ?? null
        // GNU time writes its report to the -o file (its documentation; GNU time is not installed
        // here, so this was not run).
        if (name === 'time' && (option === '-o' || option === '--output')) this.addWrite(segment, value, 'time -o')
      }
      const onFlag = option => {
        segment.wrapperOptions = true
        if ((name === 'sudo' && ['-s', '--shell', '-i', '--login'].includes(option)) || (name === 'doas' && option === '-s')) shell = true
      }
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
    // `sudo -s`, `sudo -i` and `doas -s` with no command run a shell that reads its stdin
    // (sudo(8), doas(1); not run here, since they ask for a password).
    if (shell && i >= words.length) segment.stdinShell = true
    return i
  }

  payloadString(text, segment, ctx, via, extra = {}) {
    const depth = ctx.depth + 1
    const list = parseString(text, depth, this.options)
    const remote = Boolean(ctx.remote || extra.remote)
    this.walkList(list, { dir: remote || extra.unknownDir ? null : segment.cwd, depth, payloadOf: segment.index, via, remote, wrappers: extra.wrappers, runtimeArgs: extra.runtimeArgs })
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

  // `runtimeArgs` marks a payload that gets more arguments when it runs (xargs, fd -x, parallel):
  // a write command in it also writes to an unknown path.
  argvPayload(words, segment, ctx, via, remote = false, runtimeArgs = false) {
    if (!words.length) return
    if (ctx.depth + 1 > MAX_DEPTH) fail('too-deep')
    const isRemote = Boolean(ctx.remote || remote)
    this.walkSimple({ type: 'simple', assigns: [], words, redirects: [] }, { dir: isRemote ? null : segment.cwd, depth: ctx.depth + 1, payloadOf: segment.index, via, remote: isRemote, runtimeArgs }, null, false)
  }

  // A write command whose arguments are added at run time may write anywhere, so it gets a write
  // to an unknown path: the commands writeTargets knows, and any command the outputOpts table
  // names (its output option may come at run time too).
  runtimeWrite(name, segment, via) {
    const table = this.options.outputOpts
    const outputs = table ? Object.keys(table).some(key => key.split(' ')[0] === name) : false
    if (RUNTIME_WRITE_COMMANDS.includes(name) || outputs) segment.writes.push({ path: null, raw: '', via, literal: false, runtime: true })
  }

  payloads(name, words, segment, ctx, redirects = []) {
    if (shellSet.has(name)) return this.shellPayload(name, words, segment, ctx, redirects)
    if (Object.hasOwn(payloadHandlers, name)) payloadHandlers[name](this, name, words, segment, ctx)
  }

  // xargs adds the arguments it reads from stdin or an -a file, or puts them where its -I, -i or
  // --replace string stands, so every word holding that string is not literal.
  xargsPayload(words, segment, ctx) {
    const start = xargsCommandIndex(words)
    let replace = null
    const longs = [...xargsSpec.extra, ...xargsSpec.other, ...xargsSpec.optional, ...xargsSpec.refuse].filter(option => option.startsWith('--'))
    for (let k = 1; k < start; k++) {
      const word = words[k]
      const text = word.text
      if (text === '--') break
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        if (matchLong(equal < 0 ? text : text.slice(0, equal), longs) === '--replace') replace = equal < 0 ? literalWord('{}') : { ...word, text: text.slice(equal + 1) }
        continue
      }
      for (let c = 1; c < text.length; c++) {
        if (text[c] === 'i') { replace = text.length > c + 1 ? { ...word, text: text.slice(c + 1) } : literalWord('{}'); break }
        if (text[c] === 'I') { replace = text.length > c + 1 ? { ...word, text: text.slice(c + 1) } : words[++k]; break }
        if (xargsSpec.other.includes(`-${text[c]}`) || xargsSpec.attached.includes(`-${text[c]}`)) { if (c === text.length - 1 && xargsSpec.other.includes(`-${text[c]}`)) k++; break }
      }
    }
    const payload = words.slice(start)
    const runtime = !replace ? payload : !replace.literal ? payload.map(word => ({ ...word, literal: false })) : runtimeWords(payload, word => word.text.includes(replace.text))
    this.argvPayload(runtime, segment, ctx, 'xargs', false, true)
  }

  // Shell options are limited to SHELL_LETTERS, `-o` with SET_OPTION_NAMES and SHELL_LONG_OPTIONS;
  // anything else (`-O lastpipe`, `-k`, `--posix`) changes how the payload runs and is refused. A
  // non-literal word that stands where an option may and could split, or has words after it (so
  // it could be `-c` and the next word the script), gives an opaque payload.
  shellPayload(name, words, segment, ctx, redirects = []) {
    let i = 1
    let command = false
    let stdin = false
    while (i < words.length && words[i].literal) {
      const text = words[i].text
      if (text === '--' || text === '-') { i++; break }
      if (text === '--rcfile' || text === '--init-file') { i += 2; continue }
      if (text.startsWith('--')) {
        if (!SHELL_LONG_OPTIONS.includes(text)) fail('unsupported')
        i++
        continue
      }
      if (/^[-+][A-Za-z]+$/.test(text)) {
        let consumed = 1
        for (const letter of text.slice(1)) {
          if (letter === 'o') {
            const option = words[i + consumed]
            if (option && (!option.literal || !SET_OPTION_NAMES.includes(option.text))) fail('unsupported')
            consumed++
          } else if (!SHELL_LETTERS.includes(letter)) fail('unsupported')
        }
        if (text[0] === '-' && text.includes('c')) command = true
        if (text[0] === '-' && text.includes('s')) stdin = true
        i += consumed
        continue
      }
      break
    }
    const open = words[i]
    if (open && !open.literal && (open.split || open.glob || i + 1 < words.length)) {
      this.opaquePayload(words.slice(i), segment, ctx, command ? `${name} -c` : name)
      return
    }
    // With no -c and no script operand (or -s) the shell runs its stdin, so a here-string or
    // heredoc on fd 0 is its script.
    if (!command && (i >= words.length || stdin)) {
      const input = redirects.filter(redirect => (redirect.fd === null || redirect.fd === 0) && (redirect.op === '<<<' || redirect.heredoc)).at(-1)
      if (!input) return
      const text = input.op === '<<<' ? input.target.text : input.body
      const literal = input.op === '<<<' ? input.target.literal : input.quoted || !/[$`\\]/.test(input.body)
      if (literal) this.payloadString(text, segment, ctx, `${name} stdin`)
      else this.opaquePayload([{ text, literal: false, quoted: false, glob: false }], segment, ctx, `${name} stdin`)
      return
    }
    if (!command || i >= words.length) return
    const script = words[i]
    if (script.literal) this.payloadString(script.text, segment, ctx, `${name} -c`)
    else this.opaquePayload([script], segment, ctx, `${name} -c`)
  }

  // `su [options] [-] [user [args]]`: `-c`, `--command` and `--session-command` give a string
  // payload, and the args after the user are handed to the user's shell (`su root -c cmd`).
  suPayload(words, segment, ctx) {
    let script = null
    const spec = { strict: true, long: true, dashIsFlag: true, flags: ['-f', '--fast', '-l', '--login', '-m', '-p', '--preserve-environment', '-P', '--pty', '-T', '--no-pty'], values: ['-c', '--command', '--session-command', '-s', '--shell', '-g', '--group', '-G', '--supp-group', '-w', '--whitelist-environment'], refuse: ['--help', '--version'] }
    let i = scanOptions(words, 1, spec, (option, value) => {
      if (option === '-c' || option === '--command' || option === '--session-command') script = value ?? null
    })
    if (script) {
      if (script.literal) this.payloadString(script.text, segment, ctx, 'su -c', { wrappers: ['su'] })
      else this.opaquePayload([script], segment, ctx, 'su -c')
    }
    if (words[i]?.literal && words[i].text === '-') i++
    i++
    if (i < words.length) this.shellPayload('su', [literalWord('sh'), ...words.slice(i)], segment, ctx)
    // With no command su runs the user's shell, which reads its stdin (su(1); not run here).
    else if (!script) segment.stdinShell = true
  }

  // `trap [-lpP] [--] ACTION SIGNAL...`: ACTION is a string payload. It runs when the signal
  // arrives, after later commands may have changed the directory, so its directory is unknown.
  trapPayload(words, segment, ctx) {
    let i = 1
    while (i < words.length && words[i].literal && words[i].text.startsWith('-') && words[i].text !== '-') {
      const text = words[i].text
      if (text === '--') { i++; break }
      if (/^-[lpP]+$/.test(text)) return
      fail('unsupported')
    }
    const operands = words.slice(i)
    if (operands.length < 2 || (operands[0].literal && operands[0].text === '-')) return
    this.stringPayload([operands[0]], segment, ctx, 'trap', { unknownDir: true })
  }

  findPayloads(words, segment, ctx) {
    const actions = new Set(['-exec', '-execdir', '-ok', '-okdir'])
    for (let k = 1; k < words.length; k++) {
      if (!words[k].literal || !actions.has(words[k].text)) continue
      let end = k + 1
      while (end < words.length && !(words[end].text === ';' || (words[end].text === '+' && words[end - 1].text === '{}'))) end++
      if (end >= words.length || end === k + 1) fail('syntax')
      // find puts each path it finds where `{}` stands (find(1)), so a word holding it is not
      // literal.
      this.argvPayload(runtimeWords(words.slice(k + 1, end), word => word.text.includes('{}')), segment, ctx, `find ${words[k].text}`)
      k = end
    }
  }

  // fd adds each path it finds, or puts it where a `{}`, `{/}`, `{//}`, `{.}` or `{/.}`
  // placeholder stands (fd(1)), so a word holding `{` is not literal.
  fdPayloads(words, segment, ctx) {
    const actions = new Set(['-x', '-X', '--exec', '--exec-batch'])
    for (let k = 1; k < words.length; k++) {
      if (!words[k].literal || !actions.has(words[k].text)) continue
      let end = k + 1
      while (end < words.length && words[end].text !== ';') end++
      this.argvPayload(runtimeWords(words.slice(k + 1, end), word => word.text.includes('{')), segment, ctx, `fd ${words[k].text}`, false, true)
      k = end
    }
  }

  // GNU parallel: only the options listed here are accepted, each exactly (`--jobs=4` and `-j4`
  // too); any other option is refused. With no command, every `:::` argument becomes a payload
  // and input from stdin or a `::::` file gives an opaque payload, since parallel(1) runs its input
  // as commands then (parallel is not installed here, so this was not run).
  parallelPayload(words, segment, ctx) {
    const values = new Set(['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file', '--colsep', '-d', '--delimiter', '-I', '--results', '--joblog', '-n', '--max-args', '-N', '-L', '--delay', '--timeout', '--tag-string', '--workdir', '--wd', '--tmpdir', '-E'])
    const flags = new Set(['-k', '--keep-order', '--will-cite', '--bar', '--eta', '--progress', '--line-buffer', '-u', '--ungroup', '--group', '-v', '--verbose', '--tag'])
    const separator = /^::::?\+?$/
    let i = 1
    while (i < words.length && words[i].literal && words[i].text.startsWith('-') && !separator.test(words[i].text)) {
      const text = words[i].text
      if (text === '--') { i++; break }
      const name = text.startsWith('--') ? text.split('=')[0] : text.slice(0, 2)
      const attachedValue = text.startsWith('--') ? text.includes('=') : text.length > 2
      if (values.has(name)) i += attachedValue ? 1 : 2
      else if (flags.has(text)) i++
      else fail('unsupported')
    }
    let end = i
    while (end < words.length && !separator.test(words[end].text)) end++
    if (end > i) {
      // parallel adds each input, or puts it where a replacement string (`{}`, `{.}`, `{1}`, a
      // `{= =}` expression) stands; with one, the command is opaque.
      const command = words.slice(i, end)
      if (command.some(word => word.text.includes('{'))) this.opaquePayload(command, segment, ctx, 'parallel')
      else this.stringPayload(command, segment, ctx, 'parallel', { runtimeArgs: true })
      return
    }
    const sources = words.slice(end)
    if (!sources.length || sources.some(word => word.text !== ':::' && separator.test(word.text))) {
      this.opaquePayload(sources, segment, ctx, 'parallel')
      return
    }
    for (const word of sources) if (word.text !== ':::') this.stringPayload([word], segment, ctx, 'parallel')
  }

  // ssh runs a ProxyCommand, LocalCommand or KnownHostsCommand locally through the user's shell,
  // and a `-F` file may set them, so `-F`, those `-o` keys (any case, `Key=value` or `Key value`)
  // and a non-literal `-o` value are refused.
  sshPayload(words, segment, ctx) {
    const valued = 'BbcDEeFIiJLlmOoPpQRSWw'
    const localKeys = ['proxycommand', 'localcommand', 'permitlocalcommand', 'knownhostscommand', 'match', 'include']
    let i = 1
    const skip = () => {
      while (i < words.length && words[i].literal) {
        const text = words[i].text
        if (text === '--') { i++; return }
        if (!text.startsWith('-') || text === '-') return
        let consumed = 1
        for (let k = 1; k < text.length; k++) {
          if (text[k] === 'F') fail('unsupported')
          if (valued.includes(text[k])) {
            const last = k === text.length - 1
            if (last) consumed = 2
            if (text[k] === 'o') {
              const value = last ? words[i + 1] : literalWord(text.slice(k + 1))
              if (value && (!value.literal || localKeys.includes(value.text.trim().split(/[\s=]/)[0].toLowerCase()))) fail('unsupported')
            }
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
      const resolved = this.resolve(source, segment.cwd)
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
    if (name === 'history') this.historyTargets(words, segment)
    if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') this.copyTargets(name, words, segment)
    if (name === 'curl') this.curlTargets(words, segment)
    if (name === 'wget') this.wgetTargets(words, segment)
    if (name === 'aria2c') this.aria2cTargets(words, segment)
    if (name === 'http' || name === 'httpie') this.httpieTargets(name, words, segment)
    this.outputOptionTargets(name, words, segment)
  }

  // aria2c writes `-o`/`--out` (or the URL basename) under `-d`/`--dir`, from aria2c(1); aria2c
  // is not installed here, so this was not run. An unknown option's value is read as a URL, which
  // over-reports a write.
  aria2cTargets(words, segment) {
    let out = null
    let dir = null
    const urls = []
    for (let k = 1; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (!word.literal || !text.startsWith('-') || text === '-') { urls.push(word); continue }
      const long = text.startsWith('--')
      const equal = text.indexOf('=')
      const option = long ? (equal < 0 ? text : text.slice(0, equal)) : text.slice(0, 2)
      if (option !== '--out' && option !== '--dir' && option !== '-o' && option !== '-d') continue
      const attached = long ? (equal < 0 ? null : text.slice(equal + 1)) : (text.length > 2 ? text.slice(2) : null)
      const value = attached === null ? words[++k] : { ...word, text: attached }
      if (option === '--out' || option === '-o') out = value ?? null
      else dir = value ?? null
    }
    const under = word => (dir && !word.text.startsWith('/') ? { text: joinPath(dir.text, word.text), literal: dir.literal && word.literal } : word)
    if (out) {
      this.addWrite(segment, under(out), 'aria2c')
      return
    }
    for (const url of urls) {
      const file = urlBasename(url.text)
      if (file) this.addWrite(segment, under({ text: file, literal: url.literal || url.glob }), 'aria2c')
    }
  }

  // HTTPie writes `-o`/`--output`, and with `-d`/`--download` and no output the URL basename,
  // from its documentation; HTTPie is not installed here, so this was not run.
  httpieTargets(name, words, segment) {
    let output = null
    let download = false
    const operands = []
    for (let k = 1; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (!word.literal || !text.startsWith('-') || text === '-') { operands.push(word); continue }
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        const option = equal < 0 ? text : text.slice(0, equal)
        if (option === '--download') download = true
        if (option === '--output') output = equal < 0 ? words[++k] ?? null : { ...word, text: text.slice(equal + 1) }
        continue
      }
      for (let c = 1; c < text.length; c++) {
        if (text[c] === 'd') download = true
        if (text[c] === 'o') {
          const rest = text.slice(c + 1)
          output = rest ? { ...word, text: rest } : words[++k] ?? null
          break
        }
      }
    }
    if (output) {
      this.addWrite(segment, output, name)
      return
    }
    if (!download) return
    const url = operands.find(word => !/^[A-Z]+$/.test(word.text))
    const file = url ? urlBasename(url.text) : null
    if (file) this.addWrite(segment, { text: file, literal: url.literal || url.glob }, name)
  }

  // `history -w`, `-a` and `-n` take a FILE operand, or use HISTFILE without one (bash(1));
  // -w and -a write it, and -n is recorded as a write too, which over-reports.
  historyTargets(words, segment) {
    let file = false
    let operand = null
    for (const word of words.slice(1)) {
      if (word.literal && /^-[a-z]+$/.test(word.text)) {
        if (/[awn]/.test(word.text)) file = true
      } else if (operand === null) operand = word
    }
    if (!file) return
    if (operand) this.addWrite(segment, operand, 'history')
    else segment.writes.push({ path: null, raw: 'HISTFILE', via: 'history', literal: false })
  }

  copyTargets(name, words, segment) {
    const values = new Set(['-t', '--target-directory', '-S', '--suffix', ...(name === 'install' ? ['-m', '--mode', '-o', '--owner', '-g', '--group'] : [])])
    const operands = []
    let targetDir = null
    let directories = false
    let noTarget = false
    for (let k = 1, options = true; k < words.length; k++) {
      const word = words[k]
      const text = word.text
      if (options && text === '--') { options = false; continue }
      if (!options || !word.literal || !text.startsWith('-') || text === '-') { operands.push(word); continue }
      if (text.startsWith('--')) {
        const [typed, ...valueParts] = text.split('=')
        const value = valueParts.length ? { ...word, text: valueParts.join('=') } : null
        const longs = copyLongOptions[name]
        const option = matchLong(typed, [...longs.required, ...longs.optional, ...longs.none])
        if (value && longs.none.includes(option)) fail('unsupported')
        if (longs.required.includes(option) && !value) {
          if (option === '--target-directory') targetDir = words[k + 1]
          k++
        } else if (option === '--target-directory') targetDir = value
        if (option === '--directory' && name === 'install') directories = true
        if (option === '--no-target-directory') noTarget = true
        continue
      }
      for (let c = 1; c < text.length; c++) {
        const option = `-${text[c]}`
        if (option === '-d' && name === 'install') directories = true
        if (option === '-T') noTarget = true
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
      // Without -T an existing directory DEST receives DEST/basename(SOURCE), which the parser
      // cannot tell apart from a file DEST, so both are recorded.
      if (!noTarget) for (const source of operands.slice(0, -1)) this.addWrite(segment, into(dest, source), name)
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
    let dir = segment.cwd
    if (name === 'git') {
      const rest = gitSubcommandArgs(args.map(word => word.text))
      if (!rest.length) return
      key = `git ${rest[0]}`
      // git changes to each `-C` directory, in order, before it reads the subcommand's options
      // (the review ran `git -C ../danger diff --output=f` and f landed in ../danger). With
      // --git-dir or --work-tree the base of a relative output path is not modelled here, so it is
      // unknown.
      const globals = args.slice(0, args.length - rest.length)
      for (let k = 0; k < globals.length; k++) {
        const text = globals[k].text
        if (text === '-C') {
          const value = globals[++k]
          dir = value.literal ? this.chdir(value.text, dir) : null
        } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(text)) dir = null
      }
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
        if (operandIndexes.has(operand)) this.addWrite(segment, word, key, dir)
        operand++
        continue
      }
      if (text.startsWith('--')) {
        const equal = text.indexOf('=')
        const normalized = normalizeLongOption(equal < 0 ? text : text.slice(0, equal), longs)
        if (typeof normalized === 'string' && options.includes(normalized)) {
          const value = equal >= 0 ? { ...word, text: text.slice(equal + 1) } : args[++k]
          this.addWrite(segment, value, `${key} ${normalized}`, dir)
        } else if (valueOptions.has(equal < 0 ? text : text.slice(0, equal)) && equal < 0) k++
        continue
      }
      if (options.includes(text) && text.length > 2) {
        this.addWrite(segment, args[++k], `${key} ${text}`, dir)
        continue
      }
      if (valueOptions.has(text)) { k++; continue }
      for (let c = 1; c < text.length; c++) {
        const option = `-${text[c]}`
        if (options.includes(option) || valueOptions.has(option)) {
          const rest = text.slice(c + 1)
          const value = rest ? { ...word, text: rest } : args[++k]
          if (options.includes(option)) this.addWrite(segment, value, `${key} ${option}`, dir)
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
    const isInterpreter = index => isInterpreterName(names[index]) || segments[index].stdinShell
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
    // A file a fetch wrote. When its directory is unknown (or its name is not literal) the file is
    // compared by its last path component, so an unresolved path still finds its route.
    const fetched = []
    const fetchedFile = (write, fetch, after) => {
      if (write.devNull) return
      fetched.push({ path: write.path, raw: write.path ? null : write.raw, name: path.posix.basename(write.path ?? write.raw), fetch, after })
    }
    for (const ranges of this.pipelines) {
      for (let a = 0; a < ranges.length; a++) {
        const [start, end] = ranges[a]
        for (let fetch = start; fetch < end; fetch++) {
          if (!isFetch(fetch)) continue
          for (let b = a + 1; b < ranges.length; b++) {
            for (let target = ranges[b][0]; target < ranges[b][1]; target++) {
              if (isInterpreter(target)) add('pipe', fetch, target)
              for (const write of segments[target].writes) fetchedFile(write, fetch, target)
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
        for (const write of segment.writes) fetchedFile(write, index, index)
        for (const child of children[index]) {
          if (segments[child].via !== '>(') continue
          for (const inner of subtree(child)) if (isInterpreter(inner)) add('substitution', index, inner)
        }
      }
    }
    // A variable assigned from a substitution that fetches may be expanded into a later
    // interpreter or eval; every later one is linked to the fetch (conservative: the expansion
    // itself is not traced).
    for (const segment of segments) {
      if (!segment.assignments.length) continue
      for (const child of children[segment.index]) {
        if (!substitutionKinds.has(segments[child].via)) continue
        for (const fetch of subtree(child)) {
          if (!isFetch(fetch)) continue
          for (const later of segments) {
            if (later.index > segment.index && later.payloadOf !== segment.index && (isInterpreter(later.index) || names[later.index] === 'eval')) add('substitution', fetch, later.index, { variable: true })
          }
        }
      }
    }
    if (!fetched.length) return routes
    // A fetched file that a later cp, mv, ln or install names as an operand marks what that
    // command writes as fetched too, in order, so a chain of copies keeps the mark. Every word
    // that is not an option counts as a source, which over-reports.
    for (const segment of segments) {
      if (!['cp', 'mv', 'ln', 'install'].includes(names[segment.index])) continue
      const sources = segment.words.slice(1).map((word, k) => ({ word, literal: segment.wordInfo[k + 1].literal })).filter(({ word, literal }) => !literal || !word.startsWith('-'))
      for (const file of [...fetched]) {
        if (file.after >= segment.index) continue
        const copied = sources.some(({ word, literal }) => {
          const resolved = literal ? this.resolve(word, segment.cwd) : null
          return file.path && resolved ? resolved === file.path : path.posix.basename(word) === file.name
        })
        if (copied) for (const write of segment.writes) fetchedFile(write, file.fetch, segment.index)
      }
    }
    // A segment piped (at any distance) into a later interpreter stage of its pipeline feeds it
    // whatever file it reads, so its operands and `<` files count as run by that interpreter.
    const pipedInto = segment => {
      if (segment.pipeline === null || segment.stage === null || isInterpreter(segment.index)) return null
      const ranges = this.pipelines[segment.pipeline]
      for (let b = segment.stage + 1; b < ranges.length; b++) {
        for (let target = ranges[b][0]; target < ranges[b][1]; target++) if (isInterpreter(target)) return target
      }
      return null
    }
    for (const segment of segments) {
      const paths = new Set()
      const resolvedNames = new Set()
      const unresolvedNames = new Set()
      const execute = (text, resolved) => {
        if (resolved) {
          paths.add(resolved)
          resolvedNames.add(path.posix.basename(resolved))
        } else unresolvedNames.add(path.posix.basename(text))
      }
      const word0 = segment.words[0]
      if (word0 !== undefined && (!segment.literal || word0.includes('/'))) execute(word0, segment.literal ? this.resolve(word0, segment.cwd) : null)
      if (isInterpreter(segment.index)) {
        segment.words.slice(1).forEach((word, k) => {
          const literal = segment.wordInfo[k + 1].literal
          if (!literal || !word.startsWith('-')) execute(word, literal ? this.resolve(word, segment.cwd) : null)
        })
        for (const redirect of segment.redirects) if (redirect.op === '<') execute(redirect.target, redirect.path)
      }
      // BASH_ENV and ENV name a file a non-interactive bash or sh runs first; any command may
      // start one, so the assignment counts wherever it is.
      for (const variable of segment.assignments) {
        if (variable.name === 'BASH_ENV' || variable.name === 'ENV') execute(variable.value, variable.literal ? this.resolve(variable.value, segment.cwd) : null)
      }
      const reader = pipedInto(segment)
      if (reader !== null) {
        segment.words.slice(1).forEach((word, k) => {
          const literal = segment.wordInfo[k + 1].literal
          if (!literal || !word.startsWith('-')) execute(word, literal ? this.resolve(word, segment.cwd) : null)
        })
        for (const redirect of segment.redirects) if (redirect.op === '<') execute(redirect.target, redirect.path)
      }
      if (!paths.size && !unresolvedNames.size) continue
      for (const file of fetched) {
        if (segment.index <= file.after) continue
        const match = file.path
          ? paths.has(file.path) || unresolvedNames.has(file.name)
          : resolvedNames.has(file.name) || unresolvedNames.has(file.name)
        if (match) add('file', file.fetch, reader ?? segment.index, file.path ? { path: file.path } : { path: null, raw: file.raw })
      }
    }
    return routes
  }
}

// Commands whose payload the walker parses from their own words; the shells of `shellSet` are
// handled apart, since they also read a here-string or heredoc.
const payloadHandlers = {
  eval: (walker, name, words, segment, ctx) => walker.stringPayload(words.slice(1), segment, ctx, 'eval'),
  trap: (walker, name, words, segment, ctx) => walker.trapPayload(words, segment, ctx),
  su: (walker, name, words, segment, ctx) => walker.suPayload(words, segment, ctx),
  xargs: (walker, name, words, segment, ctx) => walker.xargsPayload(words, segment, ctx),
  find: (walker, name, words, segment, ctx) => walker.findPayloads(words, segment, ctx),
  fd: (walker, name, words, segment, ctx) => walker.fdPayloads(words, segment, ctx),
  fdfind: (walker, name, words, segment, ctx) => walker.fdPayloads(words, segment, ctx),
  parallel: (walker, name, words, segment, ctx) => walker.parallelPayload(words, segment, ctx),
  ssh: (walker, name, words, segment, ctx) => walker.sshPayload(words, segment, ctx),
  docker: (walker, name, words, segment, ctx) => walker.containerPayload(name, words, segment, ctx),
  podman: (walker, name, words, segment, ctx) => walker.containerPayload(name, words, segment, ctx),
  kubectl: (walker, name, words, segment, ctx) => walker.kubectlPayload(words, segment, ctx)
}

/**
 * The names the walker treats as wrappers (`wrappers`), runner wrappers (`runners`, two words),
 * payload commands (`payloads`) and F7 interpreters (`interpreters`), for the test that checks
 * the D-87 plain lists cover them.
 */
export const SHELL_RUNNERS = Object.freeze({
  wrappers: Object.freeze(Object.keys(wrapperSpecs)),
  runners: Object.freeze(Object.keys(runnerValues)),
  payloads: Object.freeze([...shellSet, ...Object.keys(payloadHandlers)]),
  interpreters: Object.freeze([...INTERPRETERS, ...shellSet])
})

// The commands writeTargets records a write for.
const RUNTIME_WRITE_COMMANDS = Object.freeze(['tee', 'dd', 'cp', 'mv', 'install', 'ln', 'curl', 'wget', 'aria2c', 'http', 'httpie', 'history'])

// Copies of `words` where each word `replaced` matches is not literal, since its text is
// replaced at run time.
function runtimeWords(words, replaced) {
  return words.map(word => (word.literal && replaced(word) ? { ...word, literal: false } : word))
}

/**
 * The walker half of D-87 plain: no segment has a wrapper, is a payload or is a git command with
 * a config option before its subcommand, and there is no route. `isPlain` needs this and
 * `isPlainText` both.
 * @param {object[]} segments
 * @param {object[]} routes
 * @returns {boolean}
 */
export function segmentsArePlain(segments, routes) {
  return !routes.length && segments.every(segment => !segment.wrappers.length && segment.payloadOf === null && !gitConfigOption(segment.words))
}

function assignment(word) {
  const equal = word.text.indexOf('=')
  const name = word.text.slice(0, equal).replace(/\+$/, '')
  if (REFUSED_ASSIGNMENTS.includes(name)) fail('unsupported')
  return { name, value: word.text.slice(equal + 1), literal: word.literal }
}

// Refuse a command REFUSED_COMMANDS names, and the forms of `[[`, `test`/`[`, the declare family,
// `printf`, `wait` and `set` that do arithmetic, assign to a NAME or change how bash runs.
function refuseUnmodelled(name, words) {
  if (Object.hasOwn(REFUSED_COMMANDS, name)) fail('unsupported')
  const args = words.slice(1)
  if (name === '[[') {
    if (args.some(word => COND_ARITHMETIC.includes(word.text) || NAME_TESTS.includes(word.text) || /^[A-Za-z_]\w*\[/.test(word.text))) fail('unsupported')
  } else if (name === 'test' || name === '[') {
    const last = args.at(-1)
    refuseTest(name === '[' && last?.literal && last.text === ']' ? args.slice(0, -1) : args)
  } else if (declareCommands.has(name)) refuseDeclare(args)
  else if (name === 'printf') {
    if (args[0] && (!args[0].literal || args[0].text.startsWith('-v'))) fail('unsupported')
  } else if (name === 'wait') {
    for (const word of args) {
      if (word.literal ? /^-\w*p/.test(word.text) : !/^"?\$[!$?#]"?$/.test(word.raw)) fail('unsupported')
    }
  } else if (name === 'set') refuseSet(args)
}

// `test` and `[` do no arithmetic (bash(1)), but `-v NAME` evaluates a subscript in NAME (the
// review reproduced it in bash 5.3) and `-R NAME` looks a NAME up too. A non-literal operand
// could expand to `-v`, so one is accepted only where the argument count and the literal
// operators fix it as an operand by the POSIX test rules: one argument, `OP x`, `! x`, `x OP y`,
// `! OP x`, `( x )` and `! x OP y`, and never when it may split into several words.
function refuseTest(args) {
  if (args.some(word => NAME_TESTS.includes(word.text))) fail('unsupported')
  if (args.every(word => word.literal)) return
  if (args.some(word => !word.literal && (word.split || word.glob))) fail('unsupported')
  const is = (k, set) => Boolean(args[k]?.literal && (typeof set === 'string' ? args[k].text === set : set.has(args[k].text)))
  const n = args.length
  if (n === 1) return
  if (n === 2 && (is(0, testUnary) || is(0, '!'))) return
  if (n === 3 && (is(1, testBinary) || (is(0, '!') && is(1, testUnary)) || (is(0, '(') && is(2, ')')))) return
  if (n === 4 && is(0, '!') && is(2, testBinary)) return
  fail('unsupported')
}

// declare, typeset, local, readonly and export: options only from declareLetters (so no -i, -a,
// -A or -n), and every other argument a literal NAME or NAME=value with no subscript.
function refuseDeclare(args) {
  let options = true
  for (const word of args) {
    if (options && word.literal && word.text === '--') { options = false; continue }
    if (options && word.literal && /^[-+]./.test(word.text)) {
      if ([...word.text.slice(1)].some(letter => !declareLetters.includes(letter))) fail('unsupported')
      continue
    }
    if (!/^[A-Za-z_]\w*(?:\+?=|$)/.test(word.raw)) fail('unsupported')
  }
}

// set: only SET_LETTERS and `-o` with SET_OPTION_NAMES (either sign); the words after `--`, `-`
// or the first positional parameter are positional parameters.
function refuseSet(args) {
  const pattern = new RegExp(`^[-+]([${SET_LETTERS}]*)(o?)$`)
  for (let k = 0; k < args.length; k++) {
    const word = args[k]
    if (!word.literal) fail('unsupported')
    if (word.text === '--' || word.text === '-' || !/^[-+]/.test(word.text)) return
    const match = pattern.exec(word.text)
    if (!match) fail('unsupported')
    if (!match[2] || k + 1 >= args.length) continue
    const option = args[++k]
    if (!option.literal || !SET_OPTION_NAMES.includes(option.text)) fail('unsupported')
  }
}

// The long options of GNU cp, mv, ln and install, from `<tool> --help` (GNU coreutils 9.11): those that
// need a value, those that take one only as `--opt=value`, and those that take none. They are
// matched as getopt_long does (any unique prefix); an unknown or ambiguous one is refused.
const copyLongOptions = {
  cp: {
    required: ['--no-preserve', '--sparse', '--suffix', '--target-directory'],
    optional: ['--backup', '--context', '--preserve', '--reflink', '--update'],
    none: ['--archive', '--attributes-only', '--copy-contents', '--debug', '--dereference', '--force', '--help', '--interactive', '--keep-directory-symlink', '--link', '--no-clobber', '--no-dereference', '--no-target-directory', '--one-file-system', '--parents', '--recursive', '--remove-destination', '--strip-trailing-slashes', '--symbolic-link', '--verbose', '--version']
  },
  mv: {
    required: ['--suffix', '--target-directory'],
    optional: ['--backup', '--update'],
    none: ['--context', '--debug', '--exchange', '--force', '--help', '--interactive', '--no-clobber', '--no-copy', '--no-target-directory', '--strip-trailing-slashes', '--verbose', '--version']
  },
  ln: {
    required: ['--suffix', '--target-directory'],
    optional: ['--backup'],
    none: ['--directory', '--force', '--help', '--interactive', '--logical', '--no-dereference', '--no-target-directory', '--physical', '--relative', '--symbolic', '--verbose', '--version']
  },
  install: {
    required: ['--group', '--mode', '--owner', '--strip-program', '--suffix', '--target-directory'],
    optional: ['--backup', '--context'],
    none: ['--compare', '--debug', '--directory', '--help', '--no-target-directory', '--preserve-context', '--preserve-timestamps', '--strip', '--verbose', '--version']
  }
}

// GNU findutils xargs options (xargs(1)); an unknown or ambiguous option is refused.
const xargsSpec = { strict: true, long: true, extra: ['-0', '--null', '-o', '--open-tty', '-p', '--interactive', '-r', '--no-run-if-empty', '-t', '--verbose', '--show-limits', '-x', '--exit'], other: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var'], optional: ['--eof', '--replace', '--max-lines'], attached: ['-e', '-i', '-l'], refuse: ['--help', '--version'] }

function xargsCommandIndex(words) {
  return scanOptions(words, 1, xargsSpec)
}

// HOME can be reassigned by `HOME=`, `for HOME in`, `read HOME`, `{HOME}>f` and more, so any bare
// HOME name other than a `$HOME` or `${HOME...}` expansion stops `~` and `$HOME` expanding.
function mayAssignHome(command) {
  const text = command.replace(/[\\'"]/g, '').replace(/\$\{?[#!]?HOME(?!\w)/g, '')
  return /(?<!\w)HOME(?!\w)/.test(text)
}

/**
 * Parse a Bash command into segments for the classifier (docs/deck/07-approvals.md 3.3). A
 * successful parse carries `plain` (D-87, see `isPlain`): true only when `isPlainText` accepts
 * the source text, which is checked on the text alone, apart from the walker, and
 * `segmentsArePlain` holds for the walked segments and routes. Outside plain the
 * parser is best effort, for raising tiers; it does not promise to report everything bash runs.
 * It refuses the following with `{ ok: false, reason }` (a refusal has no `plain`):
 * `unclosed-quote`, `heredoc-delimiter`, `syntax`, `too-deep`, `too-large`, `nul` and
 * `not-a-string` for input it cannot tokenize; `unknown-expansion` for `$((`, `$[`, every `${...}`
 * other than `${NAME}` and `${N}`, and an unknown `$'\x'` escape; and `unsupported` for `function`,
 * `coproc`, `select`, `((`, `for ((`, an assignment with a subscript or to REFUSED_ASSIGNMENTS, a
 * command in REFUSED_COMMANDS, the arithmetic and NAME forms of `[[`, `test`, `[`, the declare
 * family, `printf -v`, `wait -p`, `set` and shell options outside the accepted ones, `[[ =~`, an
 * unquoted heredoc body line ending in a backslash, a backslash-newline outside single quotes and
 * quoted heredoc bodies, an `env` or `sudo` operand holding `=` whose name is not a NAME, `exec`
 * with only redirects when one is a process substitution, here-string or heredoc, `ssh -F` and an
 * `ssh -o` that sets ProxyCommand, LocalCommand, PermitLocalCommand, KnownHostsCommand, Match or
 * Include (or is not literal), and an unknown or ambiguous option of a wrapper, of `xargs`, `su`,
 * `trap`, `parallel`, or a long option of `cp`, `mv`, `ln`, `install`.
 *
 * Each segment is `{ index, words, wordInfo, literal, assignments, redirects, wrappers,
 * wrapperOptions, payloadOf, via, depth, cwd, remote, writes, mounts, privileged, stdinShell,
 * pipeline, stage, op }`. `cwd` is the directory the command runs in (`env -C` and `sudo -D` change
 * it); redirects resolve against the shell directory instead, and each file redirect record
 * carries that resolved `path`. A path is null (unknown) when the directory is unknown, when a
 * `..` follows another component, or when a leading `..` starts from a directory a cd reached
 * through a possible symlink. `stdinShell` marks `sudo -s`, `sudo -i`, `doas -s` and `su` with
 * no command, which run a shell on their stdin. A write command in a payload that gets more
 * arguments at run time (`xargs`, `fd -x`/`-X`, `parallel`) also has a write `{ path: null,
 * runtime: true }`, and a payload word holding the replacement string of xargs, find or fd is not
 * literal. A git output option resolves against `git -C` (unknown after `--git-dir` or
 * `--work-tree`). `routes` lists the network-to-interpreter routes of
 * the tier review F7 as `{ kind: 'pipe' | 'substitution' | 'file', fetch, interpreter, path?, raw?,
 * variable? }` (segment indexes); a file route whose path is unknown has `path: null` and the
 * written `raw` text, and `variable: true` marks a fetch assigned to a variable before a later
 * interpreter or eval.
 * @param {string} command
 * @param {{ cwd?: string, homeDir?: string, outputOpts?: Record<string, string[] | { options?: string[], operands?: number[], values?: string[] }> }} [options]
 * @returns {{ ok: true, plain: boolean, segments: object[], routes: object[] } | { ok: false, reason: string }}
 */
export function parseCommand(command, { cwd = null, homeDir = null, outputOpts = null } = {}) {
  if (typeof command !== 'string') return { ok: false, reason: 'not-a-string' }
  if (command.includes('\u0000')) return { ok: false, reason: 'nul' }
  if (command.length > MAX_LENGTH) return { ok: false, reason: 'too-large' }
  const options = { homeDir, homeAssigned: mayAssignHome(command), outputOpts }
  try {
    const list = parseString(command, 0, options)
    const walker = new Walker(options)
    walker.walkList(list, { dir: cwd, depth: 0, payloadOf: null, via: null, remote: false })
    const routes = walker.routes()
    return { ok: true, plain: plainText(command) && segmentsArePlain(walker.segments, routes), segments: walker.segments, routes }
  } catch (error) {
    if (error instanceof ShellError) return { ok: false, reason: error.reason }
    if (error instanceof RangeError) return { ok: false, reason: 'too-large' }
    throw error
  }
}

/**
 * Whether a Bash command is plain (D-87 as tightened on 2026-10-02): the parser accepts it, and
 * the source text is simple commands joined only by `|`, `&&`, `||` or `;`, each word plain
 * literal text (letters, digits, `_ - . / : = @ % +` and `,`, or a quote pair of those and
 * spaces), no `..` after another path component, and no redirect but `2>&1`, `>/dev/null` and
 * `2>/dev/null`. No command word (judged by its basename) is an assignment, a job spec, a bash
 * builtin or reserved word other than echo, printf without -v, true, false, test, `[` and pwd,
 * a wrapper or payload runner (`builtin`, `command`, `env`, `sudo`, `xargs`, `parallel`, the
 * rest of PLAIN_EXCLUSIONS.wrappers, `uv run`, `poetry run`, `pnpm exec` and `dlx`, `npm exec`
 * and `x`, `yarn dlx` and `exec`, `bun x`, `deno run`), git with `-c` or `--config-env` before
 * its subcommand, `find` with
 * `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*` or `-fls`, `fd` with `-x`, `-X`,
 * `--exec` or `--exec-batch`, `docker` or `podman` with `run` or `exec`, `kubectl exec`, or a
 * shell or interpreter (a `python` prefix included). No word is `-C` (attached or in a bundle)
 * or `--git-dir`, `--work-tree`, `--directory`, `--chdir`, `--prefix`, `--project`, `--cwd`,
 * `--dir` or `--manifest-path` (or a prefix of one). And the walker found no segment with a
 * wrapper, no payload segment, no git config option and no route (a fetched file run by its path,
 * `curl -o ./i.sh URL && ./i.sh`, passes the text check and is caught only here). Only a plain
 * command may be Safe.
 * @param {string} command
 * @returns {boolean}
 */
export function isPlain(command) {
  if (typeof command !== 'string') return false
  const result = parseCommand(command)
  return result.ok && result.plain
}
