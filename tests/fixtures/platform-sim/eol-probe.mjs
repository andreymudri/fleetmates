// Reintroduces the failure class behind the rescue CRLF bug: code that assumes a file
// committed as "a\n" is checked out byte-for-byte. Commits through whatever global git config
// the environment names, checks the commit out into a second worktree, and exits 1 when the
// checked-out bytes differ.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(os.tmpdir(), 'eol-probe-'))
const repo = path.join(root, 'repo')
const wt = path.join(root, 'wt')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

let code = 0
try {
  execFileSync('git', ['init', '-q', repo], { stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(path.join(repo, 'file.txt'), 'a\n')
  git(repo, 'add', 'file.txt')
  git(repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'probe')
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
  const bytes = readFileSync(path.join(wt, 'file.txt'))
  if (!bytes.equals(Buffer.from('a\n'))) {
    process.stderr.write(`eol-probe: checked-out bytes are ${JSON.stringify(bytes.toString('latin1'))}, expected "a\\n"\n`)
    code = 1
  } else {
    process.stdout.write('eol-probe: checked-out bytes match\n')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(code)
