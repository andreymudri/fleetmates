import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/brainstorming/SKILL.md', import.meta.url), 'utf8')

test('states a hard gate against implementing before approval', async () => {
  assert.match(await body(), /do not|never/i)
  assert.match(await body(), /approv/i)
})

test('rejects the "too simple to need a design" rationalization', async () => {
  assert.match(await body(), /too simple/i)
})

test('requires questions one at a time', async () => {
  assert.match(await body(), /one at a time/i)
})

test('terminates by handing off to writing-plans', async () => {
  assert.match(await body(), /writing-plans/)
})

test('hands the question phase to grilling', async () => {
  assert.match(await body(), /`grilling`/)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
