#!/usr/bin/env node
// Builds the commit the Claude plugin directory tracks: the `directory` branch.
//
//   node tools/directory-branch.mjs [--ref <rev>] [--parent <rev>]
//
// The directory's validator times out on this repository's full root (hub/, docs/ and tests/ are
// most of its size), so the directory follows a branch that holds only what npm ships: the
// entries of package.json `files`, plus package.json itself, read from <ref> (default HEAD).
//
// The commit is built with git plumbing and a throwaway index, so the working tree, the index and
// HEAD are never touched. It takes the author of <ref>, so the branch carries no bot identity.
// Prints the new commit sha, or `unchanged` when the tree equals <parent>'s. Pushing is left to
// the caller (the release workflow).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The tracked paths npm would ship for these `files` entries. Only plain files and directories
// (with or without a trailing slash) are supported; a glob is refused so it cannot quietly match
// the wrong set.
export function shippedPaths(tracked, files) {
  const entries = files.map((entry) => {
    if (/[*?[\]{}!]/.test(entry)) throw new Error(`package.json files entry "${entry}" is a glob, which this tool does not resolve`)
    return entry.replace(/^\.\//, '').replace(/\/+$/, '')
  })
  return tracked.filter((p) => p === 'package.json' || entries.some((e) => p === e || p.startsWith(`${e}/`))).sort()
}

export function buildDirectoryCommit({ cwd, ref = 'HEAD', parent = null }) {
  const run = (args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim()
  const commit = run(['rev-parse', '--verify', `${ref}^{commit}`])
  const pkg = JSON.parse(run(['show', `${commit}:package.json`]))
  const listing = run(['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean)
  const byPath = new Map(listing.map((line) => [line.slice(line.indexOf('\t') + 1), line]))
  const keep = shippedPaths([...byPath.keys()], pkg.files ?? [])

  const scratch = mkdtempSync(path.join(tmpdir(), 'fm-directory-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
    run(['read-tree', '--empty'], { env })
    run(['update-index', '-z', '--index-info'], { env, input: keep.map((p) => `${byPath.get(p)}\0`).join('') })
    const tree = run(['write-tree'], { env })
    if (parent && run(['rev-parse', `${parent}^{tree}`]) === tree) return null

    const [name, email] = run(['log', '-1', '--format=%an%x00%ae', commit]).split('\0')
    const identity = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
    const label = run(['describe', '--tags', '--match', 'v*', '--always', commit])
    const args = ['commit-tree', tree, '-m', `chore(directory): sync shipped plugin files from ${label}`]
    if (parent) args.push('-p', run(['rev-parse', '--verify', `${parent}^{commit}`]))
    return run(args, { env: { ...process.env, ...identity } })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i === -1 ? undefined : args[i + 1]
  }
  const sha = buildDirectoryCommit({ cwd: process.cwd(), ref: opt('--ref') ?? 'HEAD', parent: opt('--parent') || null })
  process.stdout.write(`${sha ?? 'unchanged'}\n`)
}
