import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readBody } from '../../server/http/router.mjs'

test('an oversized streamed JSON body leaves the request alive for its 413 response', async t => {
  const req = Readable.from([Buffer.alloc(256 * 1024 + 1)])
  req.headers = { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
  t.after(() => req.destroy())
  await assert.rejects(readBody(req), { status: 413, code: 'payload_too_large' })
  assert.equal(req.destroyed, false)
})
