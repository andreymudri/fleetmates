import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Whitespace is normalised once here, so an assertion pins words rather than the file's current
// line wrap. Reflowing a paragraph must not turn this suite red with nothing semantic changed.
const body = async () =>
  (await readFile(new URL('../skills/grilling/SKILL.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ')

test('walks the design tree, parent decisions before the children that depend on them', async () => {
  const b = await body()
  assert.match(b, /design tree/i)
  assert.match(b, /resolve a parent before the children/i)
})

test('gives an ordered per-round loop from the open bucket to the restated ledger', async () => {
  const b = await body()
  assert.match(b, /Take the top entry of the \*\*OPEN\*\* bucket/i)
  assert.match(b, /Ask exactly one question, as one `AskUserQuestion` call/i)
  assert.match(b, /Record the answer in the ledger/i)
  assert.match(b, /When a branch closes, restate the ledger/i)
})

test('asks with AskUserQuestion, one question per call, never in prose', async () => {
  const b = await body()
  assert.match(b, /Ask with `AskUserQuestion`, never in prose/i)
  assert.match(b, /One question per `AskUserQuestion` call, one call per turn/i)
  assert.match(b, /do not batch several questions into one call/i)
})

test('declares two to four real options and leaves the typed answer to the tool', async () => {
  const b = await body()
  assert.match(b, /two to four options, three by default/i)
  assert.match(b, /real, distinct position/i)
  assert.match(b, /You do not declare a "something else" option/i)
  assert.match(b, /type an answer none of yours offered/i)
  assert.match(b, /a typed answer is a new branch/i)
})

test('marks one option as the recommended answer', async () => {
  const b = await body()
  assert.match(b, /your own recommended answer/i)
  assert.match(b, /recommendation marked inside the label text/i)
  assert.match(b, /\(recommended\)/)
})

test('option descriptions say what the choice commits the user to downstream', async () => {
  assert.match(await body(), /what choosing it commits them to downstream/i)
})

test('offers the numbered-list fallback where AskUserQuestion is unavailable', async () => {
  assert.match(await body(), /no `AskUserQuestion` tool, offer the options as a numbered list/i)
})

test('requires fact-finding in the repo instead of asking what can be looked up', async () => {
  const b = await body()
  assert.match(b, /repository, the docs or the git history can answer it, go read them/i)
  assert.match(b, /Never hand the user a lookup/i)
})

test('keeps an open-questions ledger with resolved, open and deferred buckets', async () => {
  const b = await body()
  assert.match(b, /open-questions ledger/i)
  assert.match(b, /RESOLVED/)
  assert.match(b, /OPEN \(ordered/)
  assert.match(b, /DEFERRED/)
  assert.match(b, /who decided it/i)
  assert.match(b, /the trigger that reopens it/i)
  assert.match(b, /which option was chosen/i)
  assert.match(b, /move those entries back to \*\*Open\*\*/i)
  assert.match(b, /keep it in a scratch file and name the path/i)
})

test('runs a coverage sweep over the predictable holes before declaring done', async () => {
  const b = await body()
  assert.match(b, /coverage sweep/i)
  for (const topic of [
    /success criteria/i,
    /Inputs, outputs and interfaces/i,
    /who owns writes/i,
    /Failure modes and error handling/i,
    /Edge cases and limits/i,
    /Concurrency and ordering/i,
    /Migration and backwards compatibility/i,
    /Security and trust boundaries/i,
    /Observability/i,
    /Testing strategy/i,
    /non-goals/i,
  ]) assert.match(b, topic)
})

test('stops on a closed tree and user confirmation, never on a question count', async () => {
  const b = await body()
  assert.match(b, /Stop when no branch is open and the user confirms/i)
  assert.match(b, /A question count is never a valid stop condition/i)
})

test('names where the interview hands off, including back into brainstorming', async () => {
  const b = await body()
  assert.match(b, /return to its step 3 carrying the ledger/i)
  assert.match(b, /hand the ledger to `writing-plans`/i)
  assert.match(b, /Route into `brainstorming`/i)
  assert.match(b, /skip the approval gate/i)
})

test('defers high-fidelity questions to a prototype instead of extracting an answer', async () => {
  const b = await body()
  assert.match(b, /not grillable/i)
  assert.match(b, /prototype or a spike/i)
})

test('splits a subject too large to grill in one interview', async () => {
  assert.match(await body(), /split it into grillable chunks/i)
})
