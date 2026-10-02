import React, { createElement, useEffect, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import { shown, titleText, translate } from '../../components/StatusPill.jsx'
import { trapTab } from '../drawer/NeedsYouDrawer.jsx'
import { fetchRunPlan, openRunPlan } from '../../state/actions.js'

/** English copy for the read-only plan drawer (team-run.md TEAM-O5 default). */
export const PLAN_COPY = Object.freeze({
  'team.plan.label': 'Plan',
  'team.plan.close': 'Close',
  'team.plan.openInEditor': 'Open in editor',
  'team.plan.loading': 'Loading the plan',
  'team.plan.truncated': 'The plan is longer than 256 KiB; the rest is not shown.',
  'team.plan.error': 'Could not read the plan: {error}',
  'team.plan.openFailed': 'Could not open the plan: {error}'
})

// Raw HTML is never parsed as HTML: with `html: false` it arrives as text tokens.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false })

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 's'])

// Only absolute http and https URLs become links; the href is the parsed URL, never the raw text.
function safeHref(href) {
  try {
    const url = new URL(String(href ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function element(token, children, key) {
  if (token.hidden) return createElement(React.Fragment, { key }, ...children)
  if (token.type === 'link_open') {
    const href = safeHref(token.attrGet('href'))
    return href
      ? createElement('a', { key, href, rel: 'noreferrer noopener', target: '_blank' }, ...children)
      : createElement(React.Fragment, { key }, ...children)
  }
  if (!TAGS.has(token.tag)) return createElement(React.Fragment, { key }, ...children)
  const props = { key }
  if (token.tag === 'ol') {
    const start = Number(token.attrGet('start'))
    if (Number.isInteger(start) && start !== 1) props.start = start
  }
  return createElement(token.tag, props, ...children)
}

// Untrusted code (commands and paths, 08-security 4.5) through `shown`, except the line feeds and tabs
// that lay out code blocks.
const plain = text => String(text ?? '').replace(/[^\n\t]+/g, part => shown(part))
// Untrusted prose through `titleText`: C0, C1 and bidi controls become tokens, emoji and RTL scripts stay.
const prose = text => String(text ?? '').replace(/[^\n\t]+/g, part => titleText(part))

// Leaf tokens: text stays text. Prose shows C0, C1 and bidi controls as visible `<U+XXXX>` tokens (`prose`);
// inline code and code blocks also show format and default-ignorable characters (`plain`). html_block,
// html_inline and image tokens (and anything unknown) are dropped.
function leaf(token, key, build) {
  switch (token.type) {
    case 'inline': return createElement(React.Fragment, { key }, ...build(token.children ?? []))
    case 'text': return prose(token.content)
    case 'code_inline': return createElement('code', { key }, plain(token.content))
    case 'softbreak': return '\n'
    case 'hardbreak': return createElement('br', { key })
    case 'code_block':
    case 'fence': return createElement('pre', { key }, createElement('code', null, plain(token.content)))
    case 'hr': return createElement('hr', { key })
    default: return null
  }
}

function build(tokens) {
  const root = { children: [] }
  const stack = [root]
  let key = 0
  for (const token of tokens) {
    if (token.nesting === 1) stack.push({ token, children: [] })
    else if (token.nesting === -1) {
      const frame = stack.length > 1 ? stack.pop() : null
      if (frame) stack.at(-1).children.push(element(frame.token, frame.children, key++))
    } else {
      const node = leaf(token, key++, build)
      if (node !== null) stack.at(-1).children.push(node)
    }
  }
  // Unclosed frames (never produced by markdown-it, kept for safety) flatten into their parent.
  while (stack.length > 1) {
    const frame = stack.pop()
    stack.at(-1).children.push(element(frame.token, frame.children, key++))
  }
  return root.children
}

/**
 * Render plan markdown as React elements by mapping markdown-it tokens (`html: false`); no HTML string
 * is ever injected. Prose passes through `titleText`, so control and bidi characters show as `<U+XXXX>`
 * tokens while emoji sequences stay whole; inline code and code blocks pass through `shown`, which also
 * shows format and default-ignorable characters. Line feeds and tabs are kept. Raw HTML in the source shows as
 * text, links render only for `http:` and `https:`, and images are not rendered.
 * @param {string} markdown
 * @returns {React.ReactNode[]}
 */
export function renderMarkdown(markdown) {
  return build(md.parse(String(markdown ?? ''), {}))
}

/**
 * The text of the plan's first level-one heading, or null.
 * @param {string} markdown
 * @returns {string | null}
 */
export function planHeading(markdown) {
  const tokens = md.parse(String(markdown ?? ''), {})
  const index = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1')
  if (index === -1) return null
  const inline = tokens[index + 1]
  const text = (inline?.children ?? []).filter(token => token.type === 'text' || token.type === 'code_inline').map(token => token.content).join('').trim()
  return text || null
}

/**
 * The read-only plan drawer: a modal dialog with the plan path, the rendered markdown, a truncation note,
 * Close and the secondary "Open in editor". Pure, so tests can render and walk it.
 * @param {{ plan: { path: string|null, markdown: string, truncated: boolean } | null, error?: string|null, openError?: string|null,
 *   opening?: boolean, t?: Function, onClose: () => void, onOpenInEditor: () => void, onKeyDown?: Function, panelRef?: object }} props
 */
export function PlanDrawerView({ plan, error = null, openError = null, opening = false, t, onClose, onOpenInEditor, onKeyDown, panelRef }) {
  const label = translate(t, PLAN_COPY, 'team.plan.label')
  return (
    <div className="plan-backdrop">
      <section ref={panelRef} className="plan-drawer" role="dialog" aria-modal="true" aria-labelledby="plan-drawer-title" onKeyDown={onKeyDown}>
        <header className="plan-header">
          <h2 className="plan-title" id="plan-drawer-title">{label}</h2>
          {plan?.path ? <code className="plan-path">{shown(plan.path)}</code> : null}
          <div className="plan-actions">
            <button type="button" className="button button--secondary button--xs" disabled={opening} onClick={onOpenInEditor}>{translate(t, PLAN_COPY, 'team.plan.openInEditor')}</button>
            <button type="button" className="button button--ghost button--xs plan-close" data-initial-focus="true" onClick={onClose}>{translate(t, PLAN_COPY, 'team.plan.close')}</button>
          </div>
        </header>
        {openError ? <p className="plan-error" role="alert">{translate(t, PLAN_COPY, 'team.plan.openFailed', { error: titleText(openError) })}</p> : null}
        {error ? <p className="plan-error" role="alert">{translate(t, PLAN_COPY, 'team.plan.error', { error: titleText(error) })}</p> : plan ? (
          <div className="plan-body">
            {renderMarkdown(plan.markdown)}
            {plan.truncated ? <p className="plan-truncated">{translate(t, PLAN_COPY, 'team.plan.truncated')}</p> : null}
          </div>
        ) : (
          <div className="plan-body" aria-busy="true">
            <span className="sr-only">{translate(t, PLAN_COPY, 'team.plan.loading')}</span>
            {[0, 1, 2, 3].map(index => <div key={index} className="plan-skeleton motion-shimmer" aria-hidden="true" />)}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The plan drawer with its data: reads the plan with `fetchRunPlan`, opens it in the desktop editor with
 * `openRunPlan`, closes on Esc, keeps Tab inside, and returns focus to the opener on close.
 * This browser wiring is not exercised by the unit tests; {@link PlanDrawerView} and {@link renderMarkdown} are.
 * @param {{ api: object, repoKey: string, repoId: string, runId: string, t?: Function, onClose: () => void }} props
 */
export function PlanDrawer({ api, repoKey, repoId, runId, t, onClose }) {
  const panel = useRef(null)
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState(null)
  useEffect(() => {
    let current = true
    fetchRunPlan(api, repoKey, runId).then(data => { if (current) setPlan(data) }).catch(failure => { if (current) setError(failure?.message ?? 'failed') })
    return () => { current = false }
  }, [api, repoKey, runId])
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    panel.current?.querySelector('[data-initial-focus="true"]')?.focus()
    return () => opener?.focus?.()
  }, [])
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else trapTab(event, panel.current)
  }
  const onOpenInEditor = () => {
    setOpening(true)
    setOpenError(null)
    openRunPlan(api, repoId, runId).catch(failure => setOpenError(failure?.message ?? 'failed')).finally(() => setOpening(false))
  }
  return <PlanDrawerView plan={plan} error={error} openError={openError} opening={opening} t={t} onClose={onClose} onOpenInEditor={onOpenInEditor} onKeyDown={onKeyDown} panelRef={panel} />
}
