// Reintroduces the failure class behind the ledger bug: code that assumes os.tmpdir() is
// already a canonical path. Exits 1 when the temp dir is reached through a symlink.
import { realpathSync } from 'node:fs'
import os from 'node:os'

const tmp = os.tmpdir()
const real = realpathSync(tmp)
if (real !== tmp) {
  process.stderr.write(`realpath-probe: os.tmpdir() is not canonical (${JSON.stringify(tmp)} -> ${JSON.stringify(real)})\n`)
  process.exit(1)
}
process.stdout.write('realpath-probe: os.tmpdir() is canonical\n')
