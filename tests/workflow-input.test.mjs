import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readWorkflowInput } from '../scripts/workflow-input.mjs'
test('workflow JSON reader handles regular input and refuses valid JSON beyond the actual byte budget', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'input.json')
  await writeFile(file, '{"task":"T1"}')
  assert.deepEqual(await readWorkflowInput(file), { task: 'T1' })
  await writeFile(file, '{}'.padEnd(1024 * 1024 + 1))
  await assert.rejects(readWorkflowInput(file), /exceeds 1 MiB/)
})
test('workflow JSON reader refuses symlinks and nonregular FIFOs without draining or blocking', { skip: process.platform === 'win32' }, async t => {
  const { execFileSync } = await import('node:child_process')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = path.join(root, 'target.json'), link = path.join(root, 'link.json'), fifo = path.join(root, 'fifo')
  await writeFile(target, '{}'); await symlink(target, link)
  await assert.rejects(readWorkflowInput(link))
  execFileSync('mkfifo', [fifo])
  await assert.rejects(readWorkflowInput(fifo), /regular file/)
})
