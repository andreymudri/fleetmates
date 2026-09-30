/**
 * English chrome catalog. Keys and values follow the copy decks in
 * docs/deck/screens/rail-and-shell.md section 9 and failures-and-loading.md section 9.
 * @type {Record<string, string>}
 */
export const messages = {
  'shell.skip': 'Skip to main content',
  'shell.rail.label': 'Deck sections',
  'shell.rail.logo': 'fleetmates deck',
  'shell.rail.sessions': 'Sessions',
  'shell.rail.sessions.needs': 'Sessions, {n, plural, one {# needs you} other {# need you}}',
  'shell.rail.memory': 'Memory',
  'shell.rail.meetings': 'Meetings',
  'shell.rail.meetings.recording': 'Meetings, recording',
  'shell.rail.settings': 'Settings',
  'shell.rail.tooltip': '{section} · {keys}',
  'shell.rail.badgeMax': '99+',
  'shell.title': '{page} · fleetmates deck',
  'shell.title.needs': '({n}) {page} · fleetmates deck',
  'shell.notFound': 'This page is not on the deck.',
  'shell.notFound.home': 'All ships',
  'shell.fatal.heading': 'Fleetmates Deck',
  'shell.fatal.token': 'This tab\'s key no longer matches the deck. Open the deck again with fleetmates-deck open.',
  'shell.fatal.origin': 'The deck only answers pages it served itself. Open it from fleetmates-deck open.',
  'shell.fatal.outdated': 'The deck was updated. Reload',
  'shell.fatal.reload': 'Reload',
  'shell.toast.needs.title': '{repo} needs approval',
  'shell.toast.question.title': '{repo} asked you',
  'shell.toast.crash.title': '{repo} crashed, exit {code}',
  'shell.toast.open': 'Open',
  'shell.toast.dismiss': 'Dismiss',
  'shell.toast.more': '+{n} more',
  'shell.announce.request': '{repo} needs approval: {summary}',
  'shell.announce.question': '{repo} asked you: {summary}',
  'shell.announce.crash': '{repo} crashed, exit {code}',
  'shell.announce.burst': '{n} new requests',
  'shell.announce.recStart': 'Recording started',
  'shell.announce.recStop': 'Recording stopped',
  'shell.lang.fallback': 'DECK_LANG is set to Portuguese, but the Portuguese catalog is not approved yet. The deck is shown in English.',
  'shell.page.home': 'Sessions',
  'shell.page.new': 'New session',
  'shell.page.focus': 'Session',
  'shell.page.team': 'Team run',
  'shell.page.memory': 'Memory',
  'shell.page.research': 'Research',
  'shell.page.meetings': 'Meetings',
  'shell.page.settings': 'Settings',
  'shell.page.crew': 'Crew',
  'shell.page.welcome': 'First run',
  'shell.page.notFound': 'Not found',
  'shell.page.pending': 'This screen arrives in a later milestone.',
  'fail.server.banner': 'Lost the deck server. Your ships are unaffected, reconnecting… (attempt {attempt}, next in {seconds}s)',
  'fail.server.asOf': 'as of {time}',
  'fail.deckd.banner': 'Radio silence from deckd. Ships still sailing, re-establishing contact… (attempt {attempt}, next in {seconds}s)',
  'fail.retryNow': 'Retry now',
  'fail.reconnected': 'Reconnected',
  'fail.loading': 'Loading {thing}',
  'fail.loading.sessions': 'sessions'
}

/**
 * Format a catalog message with `{name}` placeholders and ICU `plural` blocks (`one`, `other`, `=N`, `#`).
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 * @param {string} [locale]
 * @returns {string}
 */
export function format(template, params = {}, locale = 'en') {
  let out = ''
  let index = 0
  while (index < template.length) {
    const open = template.indexOf('{', index)
    if (open === -1) { out += template.slice(index)
      break }
    out += template.slice(index, open)
    const close = matching(template, open)
    const body = template.slice(open + 1, close)
    const plural = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(body)
    if (plural) {
      const value = Number(params[plural[1]])
      const options = parseOptions(plural[2])
      const category = new Intl.PluralRules(locale).select(value)
      const chosen = options[`=${value}`] ?? options[category] ?? options.other ?? ''
      out += format(chosen, params, locale).replace(/#/g, new Intl.NumberFormat(locale).format(value))
    } else {
      const name = body.trim()
      out += Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`
    }
    index = close + 1
  }
  return out
}

function matching(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  throw Error('unbalanced message')
}

function parseOptions(text) {
  const options = {}
  let index = 0
  while (index < text.length) {
    const found = /\s*(=?\w+)\s*\{/y
    found.lastIndex = index
    const match = found.exec(text)
    if (!match) break
    const open = found.lastIndex - 1
    const close = matching(text, open)
    options[match[1]] = text.slice(open + 1, close)
    index = close + 1
  }
  return options
}
