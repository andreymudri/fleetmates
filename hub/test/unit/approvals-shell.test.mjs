import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeLongOption, parseCommand } from '../../server/approvals/shell.mjs'

const cwd = '/home/you/repo'
const homeDir = '/home/you'

function parse(command, options = {}) {
  const result = parseCommand(command, { cwd, homeDir, ...options })
  assert.equal(result.ok, true, `${JSON.stringify(command)} did not parse: ${result.reason}`)
  return result
}

const lines = result => result.segments.map(segment => segment.words.join(' '))

test('every construct of the 3.3 table splits into the expected segments', () => {
  const cases = [
    ['a && b', ['a', 'b']],
    ['a || b', ['a', 'b']],
    ['a ; b', ['a', 'b']],
    ['a & b', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['a | b', ['a', 'b']],
    ['a |& b', ['a', 'b']],
    ['( a ; b )', ['a', 'b']],
    ['{ a; b; }', ['a', 'b']],
    ['echo $(a x)', ['echo $(a x)', 'a x']],
    ['echo `a x`', ['echo `a x`', 'a x']],
    ['diff <(a) >(b)', ['diff <(a) >(b)', 'a', 'b']],
    ["bash -c 'a && b'", ['bash -c a && b', 'a', 'b']],
    ['sh -c "a | b"', ['sh -c a | b', 'a', 'b']],
    ["zsh -c 'a'", ['zsh -c a', 'a']],
    ["dash -c 'a'", ['dash -c a', 'a']],
    ["eval 'a; b'", ['eval a; b', 'a', 'b']],
    ['xargs -0 -n 1 rm -f', ['xargs -0 -n 1 rm -f', 'rm -f']],
    ['find . -name x -exec rm {} \\;', ['find . -name x -exec rm {} ;', 'rm {}']],
    ['find . -execdir rm {} +', ['find . -execdir rm {} +', 'rm {}']],
    ['find . -okdir cat {} \\;', ['find . -okdir cat {} ;', 'cat {}']],
    ['find . -name x -delete', ['find . -name x -delete']],
    ['fd -e orig -x rm', ['fd -e orig -x rm', 'rm']],
    ["parallel 'rm {}' ::: a b", ['parallel rm {} ::: a b', 'rm {}']],
    ['FOO=1 BAR=2 cargo test', ['cargo test']],
    ['env -i A=1 nice -n 5 nohup timeout -s KILL 5 stdbuf -oL time command builtin rm x', ['rm x']],
    ['/usr/bin/env rm x', ['rm x']],
    ['uv run pytest', ['pytest']],
    ['poetry run pytest', ['pytest']],
    ['pnpm exec vitest', ['vitest']],
    ['npx --no-install vitest', ['vitest']],
    ['sudo rm x', ['rm x']],
    ['doas rm x', ['rm x']],
    ['cd sub && echo hi > out.txt', ['cd sub', 'echo hi']],
    ['python - <<EOF\nprint(1)\nEOF', ['python -']],
    ['cat <<< hi', ['cat']],
    ['./run.sh', ['./run.sh']],
    ['if true; then rm x; fi', ['true', 'rm x']]
  ]
  for (const [command, expected] of cases) assert.deepEqual(lines(parse(command)), expected, command)

  const pipeAll = parse('a |& b')
  assert.equal(pipeAll.segments[0].op, '|&', '|& is recorded as its own operator')
  assert.equal(pipeAll.segments[0].pipeline, pipeAll.segments[1].pipeline)
  assert.deepEqual([pipeAll.segments[0].stage, pipeAll.segments[1].stage], [0, 1])
  assert.equal(parse('a | b').segments[0].op, '|')
  assert.equal(parse('a && b').segments[0].op, '&&')
  assert.equal(parse('a & b').segments[0].op, '&')

  const grouped = parse('( a ; b )')
  assert.deepEqual(grouped.segments.map(segment => segment.depth), [1, 1])

  const substituted = parse('echo $(a x)')
  assert.equal(substituted.segments[1].payloadOf, 0)
  assert.equal(substituted.segments[1].via, '$(')
  assert.equal(parse('echo `a x`').segments[1].via, '`')
  assert.deepEqual(parse('diff <(a) >(b)').segments.slice(1).map(segment => segment.via), ['<(', '>('])

  const payload = parse("bash -c 'a && b'")
  assert.deepEqual(payload.segments.slice(1).map(segment => [segment.payloadOf, segment.via]), [[0, 'bash -c'], [0, 'bash -c']])
  assert.equal(parse('xargs -0 -n 1 rm -f').segments[1].via, 'xargs')
  assert.equal(parse('find . -name x -exec rm {} \\;').segments[1].via, 'find -exec')
  assert.equal(parse('fd -e orig -x rm').segments[1].via, 'fd -x')

  const assigned = parse('FOO=1 BAR=2 cargo test').segments[0]
  assert.deepEqual(assigned.assignments.map(item => [item.name, item.value]), [['FOO', '1'], ['BAR', '2']])
  const exported = parse('export PATH=/tmp/bin; cargo test').segments[0]
  assert.deepEqual(exported.assignments.map(item => item.name), ['PATH'])

  const wrapped = parse('env -i A=1 nice -n 5 nohup timeout -s KILL 5 stdbuf -oL time command builtin rm x').segments[0]
  assert.deepEqual(wrapped.wrappers, ['env', 'nice', 'nohup', 'timeout', 'stdbuf', 'time', 'command', 'builtin'])
  assert.equal(wrapped.wrapperOptions, false)
  assert.deepEqual(wrapped.assignments.map(item => item.name), ['A'])
  assert.deepEqual(parse('uv run pytest').segments[0].wrappers, ['uv run'])
  assert.deepEqual(parse('npx --no-install vitest').segments[0].wrappers, ['npx --no-install'])
  assert.deepEqual(parse('sudo rm x').segments[0].wrappers, ['sudo'])
  assert.equal(parse('env --unset=X rm x').segments[0].wrapperOptions, false)
  assert.equal(parse('env -v rm x').segments[0].wrapperOptions, true, 'an option env is not named with is flagged')
  assert.equal(parse('sudo -u root rm x').segments[0].wrapperOptions, true)
  assert.deepEqual(lines(parse('command -v rm')), ['command -v rm'], 'command -v looks up a name and runs nothing')
  assert.deepEqual(lines(parse('su -c "rm -rf x" root')), ['su -c rm -rf x root', 'rm -rf x'])
  assert.deepEqual(parse('su -c "rm -rf x" root').segments[1].wrappers, ['su'])

  const moved = parse('cd sub && echo hi > out.txt')
  assert.equal(moved.segments[1].cwd, '/home/you/repo/sub')
  assert.deepEqual(moved.segments[1].writes, [{ path: '/home/you/repo/sub/out.txt', via: '>' }])
  assert.equal(parse('(cd /tmp) && echo hi > out.txt').segments[1].writes[0].path, '/home/you/repo/out.txt', 'a cd in a subshell does not leak')
  assert.equal(parse('cd - && echo hi > out.txt').segments[1].writes[0].path, null, 'an unknown directory leaves relative targets unresolved')

  const heredoc = parse('python - <<EOF\nprint(1)\nEOF').segments[0]
  assert.equal(heredoc.redirects[0].op, '<<')
  assert.equal(heredoc.redirects[0].heredoc, true)
  assert.equal(parse('cat <<< hi').segments[0].redirects[0].op, '<<<')
  const bodySub = parse('cat <<EOF\n$(rm -rf x)\nEOF')
  assert.deepEqual(lines(bodySub), ['cat', 'rm -rf x'], 'an unquoted heredoc body runs its substitutions')
  assert.deepEqual(lines(parse("cat <<'EOF'\n$(rm -rf x)\nEOF")), ['cat'], 'a quoted heredoc body is data')

  assert.equal(parse('./run.sh').segments[0].literal, true)
  assert.deepEqual(lines(parse('if true; then rm x; fi')), ['true', 'rm x'])
})

test('redirections and write targets resolve against the segment directory', () => {
  const writes = command => parse(command).segments.flatMap(segment => segment.writes)
  assert.deepEqual(writes('a > f'), [{ path: '/home/you/repo/f', via: '>' }])
  assert.deepEqual(writes('a >> /tmp/f'), [{ path: '/tmp/f', via: '>>' }])
  assert.deepEqual(writes('a &> f'), [{ path: '/home/you/repo/f', via: '&>' }])
  assert.deepEqual(writes('a 2> f'), [{ path: '/home/you/repo/f', via: '>' }])
  assert.deepEqual(writes('a >| f'), [{ path: '/home/you/repo/f', via: '>|' }])
  assert.deepEqual(writes('a < f'), [])
  assert.deepEqual(writes('a 2>&1'), [])
  assert.deepEqual(writes('a > /dev/null 2> /dev/stderr'), [{ path: '/dev/null', via: '>', devNull: true }, { path: '/dev/stderr', via: '>', devNull: true }])
  assert.deepEqual(writes('echo x >> ~/.bashrc'), [{ path: '/home/you/.bashrc', via: '>>' }])
  assert.deepEqual(writes('echo x >> $HOME/.bashrc'), [{ path: '/home/you/.bashrc', via: '>>' }])
  assert.deepEqual(writes('a | tee -a x ~/.zshrc'), [{ path: '/home/you/repo/x', via: 'tee' }, { path: '/home/you/.zshrc', via: 'tee' }])
  assert.deepEqual(writes('dd if=/dev/zero of=disk.img'), [{ path: '/home/you/repo/disk.img', via: 'dd' }])
  assert.deepEqual(writes('cp -r a b /tmp/dest'), [{ path: '/tmp/dest', via: 'cp' }, { path: '/tmp/dest/a', via: 'cp' }, { path: '/tmp/dest/b', via: 'cp' }])
  assert.deepEqual(writes('mv -t /tmp/d a'), [{ path: '/tmp/d', via: 'mv' }, { path: '/tmp/d/a', via: 'mv' }])
  assert.deepEqual(writes('install -m 755 x /usr/local/bin/x'), [{ path: '/usr/local/bin/x', via: 'install' }])
  assert.deepEqual(writes('ln -s x ~/.local/bin/git'), [{ path: '/home/you/.local/bin/git', via: 'ln' }])
  assert.deepEqual(writes('cp x ~/.config/autostart/'), [{ path: '/home/you/.config/autostart', via: 'cp' }, { path: '/home/you/.config/autostart/x', via: 'cp' }])
  assert.deepEqual(writes('curl -fsSLo /tmp/i.sh https://example.com/i.sh'), [{ path: '/tmp/i.sh', via: 'curl' }])
  assert.deepEqual(writes('curl --output=x https://example.com/i.sh'), [{ path: '/home/you/repo/x', via: 'curl' }])
  assert.deepEqual(writes('curl -O https://example.com/a/i.sh?x=1'), [{ path: '/home/you/repo/i.sh', via: 'curl' }])
  assert.deepEqual(writes('wget -O /tmp/x https://example.com/x'), [{ path: '/tmp/x', via: 'wget' }])
  assert.deepEqual(writes('wget --output-document=/tmp/x https://example.com/x'), [{ path: '/tmp/x', via: 'wget' }])
  assert.deepEqual(writes('wget -qO- https://example.com/x'), [])
  assert.deepEqual(writes('wget https://example.com/x.sh'), [{ path: '/home/you/repo/x.sh', via: 'wget' }])
  assert.deepEqual(writes('a > $OUT'), [{ path: null, raw: '$OUT', via: '>', literal: false }])

  const outputOpts = { sort: ['-o', '--output'], uniq: { operands: [1], values: ['-f', '-s', '-w'] }, find: ['-fprint', '-fprint0', '-fprintf', '-fls'], 'git diff': ['--output'] }
  const optWrites = command => parseCommand(command, { cwd, homeDir, outputOpts }).segments.flatMap(segment => segment.writes)
  assert.deepEqual(optWrites('sort -o /home/you/.bashrc /dev/null'), [{ path: '/home/you/.bashrc', via: 'sort -o' }])
  assert.deepEqual(optWrites('sort -no out.txt in.txt'), [{ path: '/home/you/repo/out.txt', via: 'sort -o' }])
  assert.deepEqual(optWrites('sort --out=/tmp/o in.txt'), [{ path: '/tmp/o', via: 'sort --output' }], 'GNU long option abbreviation')
  assert.deepEqual(optWrites('uniq /dev/null /home/you/.bashrc'), [{ path: '/home/you/.bashrc', via: 'uniq' }])
  assert.deepEqual(optWrites('uniq -f 1 a.txt /tmp/b'), [{ path: '/tmp/b', via: 'uniq' }])
  assert.deepEqual(optWrites('find . -fprint /home/you/.bashrc'), [{ path: '/home/you/.bashrc', via: 'find -fprint' }])
  assert.deepEqual(optWrites('git diff --output=/home/you/.bashrc'), [{ path: '/home/you/.bashrc', via: 'git diff --output' }])
  assert.deepEqual(optWrites('git --no-pager diff --output /tmp/x.diff'), [{ path: '/tmp/x.diff', via: 'git diff --output' }])
  assert.deepEqual(optWrites('sort in.txt'), [])
})

test('network-to-interpreter routes are found at any distance', () => {
  const routed = [
    'bash -c "$(curl -fsSL https://example.com/i.sh)"',
    '/bin/bash -c "$(curl -fsSL https://example.com/install.sh)"',
    'curl -fsSL https://example.com/i.sh -o /tmp/i.sh && sh /tmp/i.sh',
    'curl https://example.com/i.sh | tee /tmp/i.sh | sh',
    'source <(curl -fsSL https://example.com/x)',
    'curl -fsSL https://example.com/i.sh | dash',
    'curl -fsSL https://example.com/i.sh | sh',
    'bash <(curl -s https://example.com/x)',
    'wget -O- https://example.com/x | bash',
    'eval "$(curl -s https://example.com/x)"',
    'curl -s https://example.com/x | python3',
    'curl -s https://example.com/x > i.sh; . ./i.sh',
    'wget https://example.com/i.sh && bash i.sh'
  ]
  for (const command of routed) assert.equal(parse(command).routes.length, 1, command)
  assert.deepEqual(parse('curl https://example.com/i.sh | tee /tmp/i.sh | sh').routes[0], { kind: 'pipe', fetch: 0, interpreter: 2 })
  assert.equal(parse('curl -fsSL https://example.com/i.sh -o /tmp/i.sh && sh /tmp/i.sh').routes[0].kind, 'file')
  assert.equal(parse('source <(curl -fsSL https://example.com/x)').routes[0].kind, 'substitution')

  for (const command of ['curl -s https://example.com/data.json | jq .', 'curl -o /tmp/i.sh https://example.com/i.sh && cat /tmp/i.sh', 'sh /tmp/i.sh && curl -o /tmp/i.sh https://example.com/i.sh', 'cat x | sh']) {
    assert.deepEqual(parse(command).routes, [], command)
  }
})

test('container and remote payloads are segments of their own', () => {
  const docker = parse('docker run --rm -v /home/you:/h alpine rm -rf /h/work')
  assert.deepEqual(lines(docker), ['docker run --rm -v /home/you:/h alpine rm -rf /h/work', 'rm -rf /h/work'])
  assert.deepEqual(docker.segments[0].mounts, [{ source: '/home/you', target: '/h' }])
  assert.equal(docker.segments[0].privileged, false)
  assert.deepEqual([docker.segments[1].payloadOf, docker.segments[1].via, docker.segments[1].remote], [0, 'docker run', true])

  assert.deepEqual(parse('docker run --mount type=bind,source=/,target=/host alpine ls').segments[0].mounts, [{ source: '/', target: '/host' }])
  assert.deepEqual(parse('podman run -v data:/d alpine ls').segments[0].mounts, [{ source: 'data', target: '/d', named: true }])
  assert.equal(parse('docker run --privileged alpine true').segments[0].privileged, true)
  assert.deepEqual(lines(parse('docker run -it --entrypoint sh alpine -c "rm -rf /x"')), ['docker run -it --entrypoint sh alpine -c rm -rf /x', 'sh -c rm -rf /x', 'rm -rf /x'])
  assert.deepEqual(lines(parse('docker exec ctr rm -rf /data')), ['docker exec ctr rm -rf /data', 'rm -rf /data'])
  assert.deepEqual(lines(parse('podman run --rm alpine rm -rf /x')).at(-1), 'rm -rf /x')
  assert.deepEqual(lines(parse('docker run --rm alpine')), ['docker run --rm alpine'])

  const ssh = parse("ssh prod 'rm -rf /srv/data'")
  assert.deepEqual(lines(ssh), ['ssh prod rm -rf /srv/data', 'rm -rf /srv/data'])
  assert.deepEqual([ssh.segments[1].via, ssh.segments[1].remote], ['ssh', true])
  assert.deepEqual(lines(parse('ssh -p 2222 -t prod sudo rm -rf /x')).at(-1), 'rm -rf /x')
  assert.deepEqual(lines(parse('ssh prod')), ['ssh prod'])

  assert.deepEqual(lines(parse('kubectl exec mypod -- rm -rf /data')), ['kubectl exec mypod -- rm -rf /data', 'rm -rf /data'])
})

test('options between a runner wrapper and its command set wrapperOptions', () => {
  const withOption = parse('uv run --with requests pytest').segments[0]
  assert.deepEqual(withOption.words, ['pytest'])
  assert.equal(withOption.wrapperOptions, true)
  assert.equal(parse('uv run pytest').segments[0].wrapperOptions, false)
  assert.deepEqual(parse('uv run python x.py').segments[0].words, ['python', 'x.py'])
  assert.equal(parse('npx --no-install --yes vitest').segments[0].wrapperOptions, true)
  assert.deepEqual(parse('npx cowsay hi').segments[0].words, ['npx', 'cowsay', 'hi'], 'npx without --no-install is not a wrapper')
})

test('a command word that is not literal gives literal: false', () => {
  const substituted = parse('$(echo rm) -rf x')
  assert.equal(substituted.segments[0].literal, false)
  assert.deepEqual(lines(substituted), ['$(echo rm) -rf x', 'echo rm'])
  const variable = parse('X=rm; $X -rf x')
  assert.deepEqual(variable.segments.map(segment => segment.literal), [true, false])
  assert.equal(parse('${X} -rf x').segments[0].literal, false)
  assert.equal(parse('r* -rf x').segments[0].literal, false)
  assert.equal(parse('rm -rf *').segments[0].literal, true)
  assert.equal(parse('[ -f x ]').segments[0].literal, true, '[ is a literal command word')
  const opaque = parse('bash -c "$X"')
  assert.deepEqual([opaque.segments[1].via, opaque.segments[1].literal], ['bash -c', false])
})

test('anything the tokenizer does not understand fails closed', () => {
  const failures = [
    ["echo 'abc", 'unclosed-quote'],
    ['echo "abc', 'unclosed-quote'],
    ['echo `abc', 'unclosed-quote'],
    ['cat <<EOF\nhello', 'heredoc-delimiter'],
    ['cat <<EOF', 'heredoc-delimiter'],
    ['echo a\u0000b', 'nul'],
    ['echo $[1+2]', 'unknown-expansion'],
    ['echo ${X', 'unknown-expansion'],
    ['echo $((1+2', 'unknown-expansion'],
    ['echo $(a', 'syntax'],
    ['a &&', 'syntax'],
    ['case x in a) b;; esac', 'syntax'],
    ['f() { a; }', 'syntax'],
    ['find . -exec rm {}', 'syntax'],
    ['echo ' + '$('.repeat(9) + 'a' + ')'.repeat(9), 'too-deep'],
    [`bash -c "${'bash -c \\"'.repeat(4)}a${'\\"'.repeat(4)}"`, null]
  ]
  for (const [command, reason] of failures) {
    const result = parseCommand(command, { cwd, homeDir })
    if (reason === null) { assert.equal(result.ok, true, command); continue }
    assert.deepEqual(result, { ok: false, reason }, command)
  }
  assert.equal(parseCommand('echo ' + '$('.repeat(8) + 'a' + ')'.repeat(8), { cwd }).ok, true, 'eight levels are allowed')
  assert.equal(parseCommand(42).ok, false)
})

test('normalizeLongOption matches exact options and unique prefixes', () => {
  const push = ['--force', '--force-with-lease', '--force-if-includes', '--prune', '--delete']
  assert.equal(normalizeLongOption('--har', ['--hard', '--soft']), '--hard')
  assert.equal(normalizeLongOption('--hard', ['--hard', '--soft']), '--hard')
  assert.deepEqual(normalizeLongOption('--forc', push), ['--force', '--force-with-lease', '--force-if-includes'])
  assert.equal(normalizeLongOption('--force', push), '--force', 'an exact match wins over longer candidates')
  assert.equal(normalizeLongOption('--force-w', push), '--force-with-lease')
  assert.equal(normalizeLongOption('--force-w=origin/main', push), '--force-with-lease=origin/main')
  assert.equal(normalizeLongOption('--fo', push), null, 'a prefix needs three characters')
  assert.equal(normalizeLongOption('--frobnicate', push), null)
  assert.equal(normalizeLongOption('main', push), null)
  assert.deepEqual(normalizeLongOption('-rf', []), ['-r', '-f'])
  assert.deepEqual(normalizeLongOption('-fu', []), ['-f', '-u'])
  assert.equal(normalizeLongOption('-f', []), '-f')
})

test('a 100 KB command of nested quotes parses in linear time', () => {
  const unit = `"a'b'c" 'd"e"f' $'g\\'h' "i\\"j" `
  const command = 'echo ' + unit.repeat(Math.ceil(100 * 1024 / unit.length))
  assert.ok(command.length >= 100 * 1024)
  const doubleQuote = text => `"${text.replace(/[\\"$`]/g, '\\$&')}"`
  let nested = 'echo ' + `'a b' "c d" `.repeat(2500)
  for (let level = 0; level < 4; level++) nested = `bash -c ${doubleQuote(nested)}`
  assert.ok(nested.length >= 100 * 1024)
  const nestedResult = parseCommand(nested, { cwd })
  assert.equal(nestedResult.segments.length, 5, 'four nested bash -c payloads and the innermost echo')
  assert.equal(nestedResult.segments[4].words.length, 5001)
  for (const input of [command, nested]) {
    let best = Infinity
    for (let run = 0; run < 5; run++) {
      const started = performance.now()
      const result = parseCommand(input, { cwd })
      best = Math.min(best, performance.now() - started)
      assert.equal(result.ok, true)
    }
    assert.ok(best < 50, `parsed ${input.length} characters in ${best.toFixed(1)} ms`)
  }
})
