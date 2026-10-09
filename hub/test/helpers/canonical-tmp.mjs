import fs from 'node:fs'
import os from 'node:os'

// Loaded with --import by `npm test`, before any test file. On Windows os.tmpdir() can name the temp directory by
// its 8.3 short name (C:\Users\RUNNER~1\AppData\Local\Temp on the GitHub runner). The deck canonicalizes every
// directory to its long name, so a path a test built from os.tmpdir() never equalled the one the deck reported.
// The temp variables are pointed at the canonical directory, for this process and the test processes it starts.
// run-join.test and machines.test pin how the deck itself treats a short name.
const canonical = fs.realpathSync.native(os.tmpdir())
for (const key of process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']) process.env[key] = canonical
