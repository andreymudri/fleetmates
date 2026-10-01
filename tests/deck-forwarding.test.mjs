import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'

// `cli.mjs ui` and `cli.mjs deck <cmd>` forward to the hub's own CLI (hub/bin/fleetmates-deck.mjs).
// Every call here passes `--root` at a FAKE checkout whose hub bin only records the argv it
// received, so nothing here starts systemd units, a browser, a server or Claude Code. The fake bin
// is a `.mjs` run by process.execPath, so it also runs on win32.

const FAKE_BIN = `import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
writeFileSync(path.join(here, 'argv.json'), JSON.stringify(argv))
process.exitCode = argv[0] === 'status' ? 7 : 0
`

// A checkout whose NAME carries a space and shell metacharacters. Forwarded as an argv array, the
// bin path reaches node intact; joined into a shell string, the shell splits it at the space and
// runs the `;` as a second command, which writes to $DECK_FWD_SIDE (inside the temp dir, never the
// cwd), and the fake bin never writes argv.json. Windows forbids `>` and `"` in file names, so
// there the name keeps only the space.
const UNSAFE_NAME = process.platform === 'win32' ? 'root dir' : 'root dir; echo pwned > "$DECK_FWD_SIDE" #'

async function fakeCheckout({ bin = true, modules = true } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-fwd-'))
  process.env.DECK_FWD_SIDE = path.join(base, 'side effect')
  const root = path.join(base, UNSAFE_NAME)
  const hub = path.join(root, 'hub')
  await mkdir(path.join(hub, 'bin'), { recursive: true })
  if (bin) await writeFile(path.join(hub, 'bin', 'fleetmates-deck.mjs'), FAKE_BIN)
  if (modules) await mkdir(path.join(hub, 'node_modules'))
  return { base, root, argvFile: path.join(hub, 'bin', 'argv.json') }
}

function capture() {
  const lines = []
  const io = { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)) }
  return { io, text: () => lines.join('\n') }
}

test('deck forwards the subcommand and its allowed flags as an argv array, and returns the child exit code', async () => {
  const { base, root, argvFile } = await fakeCheckout()
  try {
    const { io, text } = capture()
    assert.equal(await runCli(['deck', 'init', '--dry-run', '--rotate-token', '--root', root], io), 0, text())
    assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), ['init', '--dry-run', '--rotate-token'])
    assert.equal(existsSync(path.join(base, 'side effect')), false, 'no shell may interpret the hub path')

    assert.equal(await runCli(['deck', 'status', '--root', root], io), 7, 'the child exit code is the CLI exit code')
    assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), ['status'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('ui forwards to the hub open command', async () => {
  const { base, root, argvFile } = await fakeCheckout()
  try {
    const { io, text } = capture()
    assert.equal(await runCli(['ui', '--root', root], io), 0, text())
    assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), ['open'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('ui and deck refuse unknown subcommands, flags, flag values and positionals before starting anything', async () => {
  const { base, root, argvFile } = await fakeCheckout()
  try {
    const refused = [
      ['deck'],
      ['deck', 'bogus'],
      ['deck', '--help'],
      ['deck', 'init', '--force'],
      ['deck', 'init', '--dry-run=1'],
      ['deck', 'init', '--dry-run', 'extra'],
      ['deck', 'init', 'extra'],
      ['deck', 'doctor', '--dry-run'],
      ['deck', 'open', '--port', '1'],
      ['deck', 'uninstall-hooks', '-y'],
      ['deck', 'status', '$(touch pwned)'],
      ['ui', '--port', '1'],
      ['ui', 'extra'],
      ['ui', '--rotate-token'],
    ]
    for (const argv of refused) {
      const { io, text } = capture()
      assert.equal(await runCli([...argv, '--root', root], io), 2, `${argv.join(' ')} must be refused`)
      assert.match(text(), /usage: cli\.mjs/, `${argv.join(' ')} must print the usage`)
      assert.equal(existsSync(argvFile), false, `${argv.join(' ')} must not start the hub CLI`)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('deck refuses cleanly and names the install command when the hub or its dependencies are missing', async () => {
  for (const shape of [{ bin: false }, { modules: false }, { bin: false, modules: false }]) {
    const { base, root, argvFile } = await fakeCheckout(shape)
    try {
      for (const argv of [['deck', 'doctor'], ['ui']]) {
        const { io, text } = capture()
        assert.equal(await runCli([...argv, '--root', root], io), 1, `${JSON.stringify(shape)} ${argv.join(' ')}`)
        assert.match(text(), /npm ci --prefix /, 'the refusal names the install command')
        assert.equal(existsSync(argvFile), false)
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }
  // A checkout with no hub/ at all, as in the published plugin package, whose name carries a
  // terminal escape: the refusal prints the path quoted, never the raw escape byte.
  const { io, text } = capture()
  const missing = path.join(tmpdir(), 'deck-fwd-no-such-\u001b[2K-dir')
  assert.equal(await runCli(['deck', 'status', '--root', missing], io), 1)
  assert.match(text(), /npm ci --prefix /)
  assert.equal(text().includes('\u001b'), false, 'a control character in --root must not reach the terminal')
})

test('the usage line lists ui and deck', async () => {
  const lines = []
  assert.equal(await runCli([], { out: (s) => lines.push(s) }), 2)
  const usage = /usage: cli\.mjs <([a-z|-]+)>/.exec(lines.join('\n'))
  assert.ok(usage)
  const names = usage[1].split('|')
  assert.ok(names.includes('ui') && names.includes('deck'))
})
