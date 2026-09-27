#!/usr/bin/env node
// Capture hook registered by capture-cc.mjs for every Claude Code hook event. It appends
// `{ receivedAt, payload }` as one JSON line to $CAPTURE_OUT/hooks.jsonl, never writes to
// stdout (Claude Code reads a hook's stdout as a decision), and always exits 0.

import { appendFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
async function readStdin () {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

try {
  const raw = await readStdin()
  const receivedAt = Date.now()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { unparsed: raw }
  }
  const out = process.env.CAPTURE_OUT
  if (out) appendFileSync(path.join(out, 'hooks.jsonl'), JSON.stringify({ receivedAt, payload }) + '\n')
} catch {}
process.exit(0)
