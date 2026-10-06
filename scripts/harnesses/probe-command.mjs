import { defaultExec } from '../gate-runner.mjs'

// Read-only authentication checks share the gate runner's process-group cleanup.
// No shell, model turn, or unbounded diagnostic output.
export async function probeCommand(command, argv, env, { timeoutMs = 5000, maxOutputBytes = 65536 } = {}) {
  try {
    const result = await defaultExec(command, process.cwd(), {
      argv, env, timeoutMs, maxOutputBytes, graceMs: 250,
    })
    return { ...result, text: result.output }
  } catch (error) {
    return { code: -1, text: '', errorCode: error.code }
  }
}
