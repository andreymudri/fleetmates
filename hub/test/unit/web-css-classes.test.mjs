// xterm.js puts its own classes on the elements it creates (the `.xterm` root gains `focus` while
// the terminal has focus). A deck stylesheet that styles one of those names as a bare class also
// styles the terminal: a `.focus` screen grid once squeezed the focused terminal into one column.
// So no selector in hub/web/src/styles may use such a class unless it sits under `.xterm` or
// `.terminal-view`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const styles = path.join(hub, 'web/src/styles')

// The classes @xterm/xterm 6.0.0 sets at runtime (classList.add/toggle, className and setClassName
// in hub/node_modules/@xterm/xterm/lib/xterm.mjs). Every `xterm` and `xterm-*` class counts too.
const XTERM_CLASSES = new Set([
  'focus', 'terminal', 'xterm', 'composition-view', 'scrollbar', 'slider', 'shadow', 'visible', 'invisible', 'fade',
  'active', 'column-select', 'debug', 'enable-mouse-events', 'live-region', 'arrow-background', 'mac',
  'horizontal', 'vertical', 'left', 'top', 'top-left-corner'
])
const isXtermClass = name => XTERM_CLASSES.has(name) || name.startsWith('xterm-')
const SCOPES = /\.(xterm|terminal-view)(?![\w-])/

/** Blank out comments, keeping every newline so line numbers stay true. */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))

/**
 * Every selector of a stylesheet with the 1-based line it starts on (at-rule preludes skipped).
 * @param {string} css comment-free CSS
 * @returns {{ selector: string, line: number }[]}
 */
function selectors(css) {
  const found = []
  let start = 0
  for (let at = 0; at < css.length; at++) {
    const char = css[at]
    if (char === ';' || char === '}') start = at + 1
    else if (char === '{') {
      const prelude = css.slice(start, at)
      const lead = prelude.length - prelude.trimStart().length
      if (prelude.trim() && !prelude.trim().startsWith('@')) {
        let offset = start + lead
        for (const part of prelude.trim().split(',')) {
          const skip = part.length - part.trimStart().length
          found.push({ selector: part.trim(), line: css.slice(0, offset + skip).split('\n').length })
          offset += part.length + 1
        }
      }
      start = at + 1
    }
  }
  return found
}

/**
 * The xterm classes a selector uses without `.xterm` or `.terminal-view` before them.
 * @param {string} selector
 * @returns {string[]}
 */
function bareXtermClasses(selector) {
  const bare = []
  for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (isXtermClass(match[1]) && !SCOPES.test(selector.slice(0, match.index))) bare.push(match[1])
  }
  return bare
}

test('no stylesheet uses a class xterm.js sets at runtime as a bare class', async () => {
  const files = (await readdir(styles)).filter(name => name.endsWith('.css')).sort()
  assert.ok(files.length > 0, 'hub/web/src/styles holds the stylesheets')
  const offenders = []
  for (const name of files) {
    const css = stripComments(await readFile(path.join(styles, name), 'utf8'))
    for (const { selector, line } of selectors(css)) {
      const bare = bareXtermClasses(selector)
      if (bare.length) offenders.push(`hub/web/src/styles/${name}:${line}: ${selector} (${bare.map(c => `.${c}`).join(', ')})`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the selector check flags bare xterm classes and accepts scoped ones', () => {
  assert.deepEqual(selectors('.a { x: 1 }\n@media (max-width: 1px) {\n  .focus,\n  .b { y: 2 }\n}'), [
    { selector: '.a', line: 1 }, { selector: '.focus', line: 3 }, { selector: '.b', line: 4 }
  ])
  assert.deepEqual(bareXtermClasses('.focus'), ['focus'])
  assert.deepEqual(bareXtermClasses('.home .xterm-viewport'), ['xterm-viewport'])
  assert.deepEqual(bareXtermClasses('.xterm'), ['xterm'])
  assert.deepEqual(bareXtermClasses('.focus-screen, .focus--missing'), [])
  assert.deepEqual(bareXtermClasses('.terminal-view .xterm .xterm-viewport'), [])
  assert.deepEqual(bareXtermClasses('.terminal-view .xterm.focus'), [])
  assert.deepEqual(bareXtermClasses('.xterm.focus'), ['xterm'])
  assert.deepEqual(stripComments('/* .focus {\n} */.a {'), '           \n    .a {')
})
