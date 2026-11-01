// The watchdog's heartbeat. Everything that touches the world is injected: `tick` gathers liveness
// rows for the current phase, `emit` prints one event, `state` persists the ladder, `sleep` waits.
// So the whole sequence is testable with a fake clock and no repository.
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { printable } from './reviews.mjs'
import { nextAction } from './watch.mjs'

export const MAX_TICK_FAILURES = 3

export class LockHeldError extends Error {}

export async function acquireLock(file, pid, isAlive) {
  try {
    await writeFile(file, `${pid}\n`, { flag: 'wx' })
    return
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  const holder = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
  if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
    throw new LockHeldError(`another watch (pid ${holder}) already holds ${file}`)
  }
  await writeFile(file, `${pid}\n`)
}

export async function releaseLock(file, pid) {
  const holder = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
  if (holder === pid) await unlink(file).catch(() => {})
}

export async function runWatch({ tick, emit, state, sleep, now, config, onAction = async () => {} }) {
  const history = { ...((await state.load()) ?? {}) }
  const intervalMs = config.intervalMinutes * 60 * 1000
  let failures = 0
  for (;;) {
    let snapshot
    try {
      snapshot = await tick()
      failures = 0
    } catch (err) {
      failures++
      emit({ event: 'watch-error', message: printable(err?.message ?? err) })
      if (failures >= MAX_TICK_FAILURES) { emit({ event: 'exit', reason: 'errors' }); return 1 }
      await sleep(intervalMs)
      continue
    }
    if (!snapshot.inFlight) { emit({ event: 'exit', reason: 'phase-idle' }); return 0 }
    const at = now()
    for (const row of snapshot.rows) {
      const decision = nextAction(row, history[row.taskId], config, at)
      history[row.taskId] = decision.history
      if (decision.action === 'none') continue
      const event = { event: decision.action, task: printable(row.taskId), at: new Date(at).toISOString() }
      if (decision.attempt) event.attempt = decision.attempt
      if (decision.reason) event.reason = decision.reason
      emit(event)
      await onAction(row.taskId, decision)
    }
    await state.save(history)
    await sleep(intervalMs)
  }
}
