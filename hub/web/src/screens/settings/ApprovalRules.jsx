import React, { useCallback, useEffect, useState } from 'react'
import { shown, titleText, translate } from '../../components/StatusPill.jsx'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx'
import { tildePath } from '../new-session/NewSession.jsx'
import { addRule, fetchRules, revokeRule } from '../../state/actions.js'

/**
 * English copy for the Approval rules section (docs/deck/screens/settings.md sections 4.2, 5 and 9, 07-approvals
 * 7.2 to 7.4) plus the strings the M3 plan adds (tiers.json error, tracked note, revoke follow-up line).
 */
export const RULES_COPY = Object.freeze({
  'settings.nav.rules.sub': '{n, plural, one {# rule} other {# rules}} in {m, plural, one {# repo} other {# repos}}',
  'settings.rules.title': 'Approval rules',
  'settings.rules.intro': 'Rules live in each repo\'s .claude/settings.local.json, so they also apply when you run claude in a plain terminal. Destructive commands can never become rules.',
  'settings.rules.threshold': 'Suggest a rule after approving the same Safe command',
  'settings.rules.threshold.label': 'Approvals before suggesting',
  'settings.rules.threshold.5': '5 times',
  'settings.rules.threshold.3': '3 times',
  'settings.rules.threshold.never': 'Never suggest',
  'settings.rules.count': '{n, plural, one {# rule} other {# rules}}',
  'settings.rules.fromApprovals': 'from {n} approvals · {date}',
  'settings.rules.byHand': 'added by hand',
  'settings.rules.byHandDate': 'added by hand · {date}',
  'settings.rules.revoke': 'Revoke…',
  'settings.rules.revoke.title': 'Revoke {pattern} in {repo}?',
  'settings.rules.revoke.body': 'Removes the rule from {path}. Claude Code will ask again for this command, also in a plain terminal.',
  'settings.rules.revoke.confirm': 'Revoke rule',
  'settings.rules.revoked': 'Rule revoked in {repo}',
  'settings.rules.revoked.restart': 'Running sessions may keep the old rule until they restart.',
  'settings.rules.add': 'Add a rule…',
  'settings.rules.add.title': 'Add a rule in {repo}',
  'settings.rules.add.pattern': 'Pattern',
  'settings.rules.add.save': 'Add rule',
  'settings.rules.add.destructive': 'Destructive commands can never become rules.',
  'settings.rules.toolWide': 'Allows every {tool} call in {repo}',
  'settings.rules.destructiveRule': 'This rule lets Claude run a Destructive command without asking.',
  'settings.rules.tracked': 'This file is tracked by git in {repo}; the rule will be committed with it.',
  'settings.rules.empty': 'No approval rules yet. Rules you accept from suggestions, or add by hand, show up here.',
  'settings.rules.readError': 'Could not read {path}: {error}.',
  'settings.rules.writeError': 'Could not write {path}: {error}. Nothing changed.',
  'settings.rules.loadError': 'Could not load the approval rules: {error}',
  'settings.rules.retry': 'Retry',
  'settings.rules.tiersError': 'tiers.json has an error on line {line}: {message} Using the previous tiers.',
  'settings.tiers.label': 'Risk tiers',
  'settings.tiers.title': 'How the deck sorts requests',
  'settings.tiers.safe': 'Reads, tests, builds, linters. Can be batched, approved from a popup and turned into a rule.',
  'settings.tiers.caution': 'Network, installs, writes outside the repo. One at a time; a rule is possible only if you add it by hand.',
  'settings.tiers.destructive': 'rm, git push --force, git reset --hard, deploys, database writes. Never batched, never a rule, never from a popup, and always behind a confirm checkbox.',
  'settings.tiers.footer': 'Tiers come from pattern lists in ~/.config/fleetmates/deck/tiers.json. Unknown commands default to Caution.',
  'confirm.cancel': 'Cancel'
})

/** Threshold choices in Select order, as stored in `prefs.ruleSuggestAfter` (null is "Never suggest"). */
export const THRESHOLDS = Object.freeze([5, 3, null])
const TIERS = ['safe', 'caution', 'destructive']
// Tool-wide rules the server refuses outright (07-approvals 7.3); every other bare tool name is accepted with a warning.
const REFUSED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WRITE_ERRORS = new Set(['settings_io_failed', 'settings_changed'])

const repoName = repo => String(repo?.repoKey ?? String(repo?.repoId ?? '').split('/').filter(Boolean).at(-1) ?? '')

/**
 * Nav counts for "{n} rules in {m} repos": every rule, and the repos holding at least one.
 * @param {{ repos?: { rules?: object[] }[] } | null | undefined} data the `GET /api/rules` body
 * @returns {{ n: number, m: number } | null} null before the rules have loaded
 */
export function rulesSummary(data) {
  if (!data || !Array.isArray(data.repos)) return null
  const counts = data.repos.map(repo => (Array.isArray(repo.rules) ? repo.rules.length : 0))
  return { n: counts.reduce((sum, n) => sum + n, 0), m: counts.filter(n => n > 0).length }
}

/**
 * Nav subtitle for the rules row, or '' before the rules have loaded.
 * @param {Parameters<typeof rulesSummary>[0]} data
 * @param {Function} [t]
 * @returns {string}
 */
export function rulesNavSub(data, t) {
  const summary = rulesSummary(data)
  return summary ? translate(t, RULES_COPY, 'settings.nav.rules.sub', summary) : ''
}

/**
 * A rule's date as "26 Sep" (English) or the Brazilian short form.
 * @param {number} ms
 * @param {string} [lang]
 * @returns {string}
 */
export function ruleDate(ms, lang = 'en') {
  const date = new Date(ms)
  if (lang === 'pt') return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' }).format(date)
  return `${date.getDate()} ${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date)}`
}

/**
 * The source line under a rule (settings.md 4.2, SET-O5): "from {n} approvals · {date}" for a suggestion the
 * deck wrote, "added by hand · {date}" for one added in Settings, "added by hand" when the date is unknown.
 * @param {{ source?: string, approvalsBefore?: number | null, createdAt?: number | null }} rule
 * @param {Function} [t]
 * @param {string} [lang]
 * @returns {string}
 */
export function ruleMeta(rule, t, lang) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  if (!Number.isFinite(rule?.createdAt)) return tr('settings.rules.byHand')
  const date = ruleDate(rule.createdAt, lang)
  if (rule.source === 'suggested' && Number.isInteger(rule.approvalsBefore)) return tr('settings.rules.fromApprovals', { n: rule.approvalsBefore, date })
  return tr('settings.rules.byHandDate', { date })
}

/**
 * The tool a pattern allows wholesale, or null: a bare tool name such as `WebFetch` (07-approvals 7.3). Bash and
 * the file tools are refused by the server, and `mcp__server__tool` names one tool, so neither gets the warning.
 * @param {string} pattern
 * @returns {string | null}
 */
export function toolWideOf(pattern) {
  const text = String(pattern ?? '').trim()
  return /^[A-Za-z]+$/.test(text) && !REFUSED_TOOLS.has(text) ? text : null
}

/**
 * The line a failed rule write shows (settings.md 5): the Decided refusal for `destructive_rule`, "Could not write
 * {path}: {error}. Nothing changed." for an I/O failure, otherwise the server's message. Server text goes
 * through `shown`.
 * @param {{ code?: string, message?: string, details?: { path?: string, errno?: string } } | null} error
 * @param {{ settingsPath?: string }} repo
 * @param {Function} [t]
 * @returns {string}
 */
export function ruleErrorText(error, repo, t) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  if (error?.code === 'destructive_rule') return tr('settings.rules.add.destructive')
  const message = shown(error?.details?.errno ?? error?.message ?? error?.code ?? 'failed')
  if (WRITE_ERRORS.has(error?.code)) return tr('settings.rules.writeError', { path: shown(tildePath(error?.details?.path ?? repo?.settingsPath ?? '')), error: message })
  return shown(error?.message ?? error?.code ?? 'failed')
}

function TierBadge({ tier, t }) {
  if (!TIERS.includes(tier)) return null
  return <span className={`tier-badge tier-badge--${tier}`}>{translate(t, CARD_COPY, `tier.${tier}`)}</span>
}

function RuleRow({ repo, rule, t, lang, busy, onRevoke }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  const destructive = rule.destructive === true || rule.tier === 'destructive'
  return (
    <li className={`rule-row${destructive ? ' rule-row--destructive' : ''}`} aria-busy={busy ? 'true' : undefined}>
      <div className="rule-main">
        <TierBadge tier={destructive ? 'destructive' : rule.tier} t={t} />
        <code className="rule-pattern">{shown(rule.pattern)}</code>
        <span className="rule-meta">{ruleMeta(rule, t, lang)}</span>
        <button type="button" className="button button--secondary button--xs" disabled={busy} onClick={() => onRevoke(repo, rule)}>{tr('settings.rules.revoke')}</button>
      </div>
      {destructive ? <p className="rule-warning">{tr('settings.rules.destructiveRule')}</p> : null}
      {rule.tracked === true ? <p className="setting-hint rule-tracked"><bdi>{tr('settings.rules.tracked', { repo: titleText(repoName(repo)) })}</bdi></p> : null}
    </li>
  )
}

function Banner({ text, retry, onRetry }) {
  return (
    <div className="rules-banner" role="alert">
      <p className="rules-banner-text"><bdi>{text}</bdi></p>
      {onRetry ? <button type="button" className="button button--secondary button--xs" onClick={onRetry}>{retry}</button> : null}
    </div>
  )
}

function RepoRules({ repo, t, lang, busy, writeError, onRevoke, onAdd, onRetry }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  const rules = Array.isArray(repo.rules) ? repo.rules : []
  const name = repoName(repo)
  const headingId = `rules-repo-${encodeURIComponent(String(repo.repoId ?? name)).replace(/%/g, '_')}`
  return (
    <section className="rules-repo" aria-labelledby={headingId}>
      <header className="rules-repo-head">
        <h3 className="rules-repo-name" id={headingId}><bdi>{titleText(name)}</bdi></h3>
        <span className="rules-repo-path"><bdi>{shown(tildePath(repo.repoId))}</bdi></span>
        <span className="rules-repo-count">{tr('settings.rules.count', { n: rules.length })}</span>
      </header>
      {repo.readError
        ? <Banner text={tr('settings.rules.readError', { path: shown(tildePath(repo.readError.file ?? repo.settingsPath ?? '')), error: shown(repo.readError.message ?? 'failed') })} retry={tr('settings.rules.retry')} onRetry={onRetry} />
        : null}
      {writeError ? <Banner text={writeError} /> : null}
      {rules.length
        ? <ul className="rules-list">{rules.map(rule => <RuleRow key={rule.pattern} repo={repo} rule={rule} t={t} lang={lang} busy={busy === rule.pattern} onRevoke={onRevoke} />)}</ul>
        : repo.readError ? null : <p className="setting-hint rules-empty">{tr('settings.rules.empty')}</p>}
      <button type="button" className="button button--ghost button--sm rules-add" onClick={() => onAdd(repo)}>{tr('settings.rules.add')}</button>
    </section>
  )
}

/**
 * The tier aside (settings.md 4.2): the three badges with what each tier allows, and where tiers come from.
 * @param {{ t?: Function }} props
 */
export function TiersAside({ t }) {
  const tr = key => translate(t, RULES_COPY, key)
  return (
    <aside className="rules-tiers" aria-label={tr('settings.tiers.label')}>
      <h3 className="settings-subheading">{tr('settings.tiers.title')}</h3>
      <ul className="rules-tiers-list">
        {TIERS.map(tier => <li key={tier} className="rules-tier"><TierBadge tier={tier} t={t} /><span>{tr(`settings.tiers.${tier}`)}</span></li>)}
      </ul>
      <p className="setting-hint">{tr('settings.tiers.footer')}</p>
    </aside>
  )
}

/**
 * The Approval rules section, pure (settings.md 4.2 and 5): intro, threshold Select, one section per repo with
 * its rules, read and write error banners, the empty text, the tiers.json error banner and the tier aside.
 * Every pattern, path and server message renders as text through `shown` or `titleText`.
 * @param {{
 *   data: { threshold?: number | null, tiersError?: { line?: number, message?: string } | null, repos?: object[] } | null,
 *   loadError?: string | null, threshold?: number | null, thresholdError?: string, t?: Function, lang?: string,
 *   busy?: { repoId: string, pattern: string } | null, writeErrors?: Record<string, string>,
 *   onThreshold: (value: number | null) => void, onRevoke: (repo: object, rule: object) => void,
 *   notice?: { title: string, body?: string } | null, onAdd: (repo: object) => void, onRetry: () => void
 * }} props
 */
export function ApprovalRulesView({ data, loadError = null, threshold, thresholdError, t, lang, busy = null, writeErrors = {}, notice = null, onThreshold, onRevoke, onAdd, onRetry }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  const current = threshold === undefined ? (data?.threshold === undefined ? 5 : data.threshold) : threshold
  const value = current === null ? 'never' : String(THRESHOLDS.includes(current) ? current : 5)
  const tiersError = data?.tiersError
  let body
  if (loadError) body = <Banner text={tr('settings.rules.loadError', { error: shown(loadError) })} retry={tr('settings.rules.retry')} onRetry={onRetry} />
  else if (!data) body = <>{[0, 1].map(index => <div key={index} className="skeleton-panel motion-shimmer" aria-hidden="true" />)}</>
  else if (!data.repos?.length) body = <p className="setting-hint rules-empty">{tr('settings.rules.empty')}</p>
  else {
    body = data.repos.map(repo => <RepoRules key={repo.repoId ?? repoName(repo)} repo={repo} t={t} lang={lang} busy={busy && busy.repoId === repo.repoId ? busy.pattern : null}
      writeError={writeErrors[repo.repoId] ?? null} onRevoke={onRevoke} onAdd={onAdd} onRetry={onRetry} />)
  }
  return (
    <section className="settings-section settings-rules" aria-labelledby="settings-rules-title">
      <div className="rules-main">
        <h2 className="settings-heading" id="settings-rules-title">{tr('settings.rules.title')}</h2>
        <p className="rules-intro">{tr('settings.rules.intro')}</p>
        {notice ? <p className="setting-hint setting-saved rules-notice" role="status">{[notice.title, notice.body].filter(Boolean).join(' ')}</p> : null}
        {tiersError ? <Banner text={tr('settings.rules.tiersError', { line: shown(tiersError.line ?? '?'), message: shown(tiersError.message ?? '') })} /> : null}
        <div className="setting-row">
          <label className="setting-select" htmlFor="pref-ruleSuggestAfter">{tr('settings.rules.threshold')}
            <select id="pref-ruleSuggestAfter" aria-label={tr('settings.rules.threshold.label')} value={value}
              onChange={event => onThreshold(event.target.value === 'never' ? null : Number(event.target.value))}>
              {THRESHOLDS.map(n => <option key={String(n)} value={n === null ? 'never' : String(n)}>{tr(`settings.rules.threshold.${n === null ? 'never' : n}`)}</option>)}
            </select>
          </label>
          {thresholdError ? <p className="setting-error" role="status"><bdi>{thresholdError}</bdi></p> : null}
        </div>
        {body}
      </div>
      <TiersAside t={t} />
    </section>
  )
}

/**
 * The revoke confirm (settings.md 4.2 and 8): a ConfirmDialog with Cancel first and focused, and "Revoke rule"
 * as the only red control.
 * @param {{ repo: object, rule: object, t?: Function, onConfirm: () => void, onCancel: () => void }} props
 */
export function RevokeDialog({ repo, rule, t, onConfirm, onCancel }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  return (
    <ConfirmDialog tone="danger" t={t} cancelLabel={tr('confirm.cancel')}
      title={tr('settings.rules.revoke.title', { pattern: shown(rule.pattern), repo: repoName(repo) })}
      body={tr('settings.rules.revoke.body', { path: shown(tildePath(repo.settingsPath ?? `${repo.repoId}/.claude/settings.local.json`)) })}
      confirmLabel={tr('settings.rules.revoke.confirm')} onConfirm={onConfirm} onCancel={onCancel} />
  )
}

/**
 * "Add a rule…" dialog, pure: a pattern field, the tool-wide warning shown before saving, and the server's
 * refusal or write error.
 * @param {{ repo: object, pattern: string, error?: string | null, sending?: boolean, t?: Function, onPattern: (text: string) => void, onSubmit: () => void, onCancel: () => void }} props
 */
export function AddRuleDialog({ repo, pattern, error = null, sending = false, t, onPattern, onSubmit, onCancel }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  const tool = toolWideOf(pattern)
  const submit = event => {
    event.preventDefault()
    if (!sending && String(pattern ?? '').trim()) onSubmit()
  }
  const onKeyDown = event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }
  return (
    <div className="confirm-backdrop">
      <form className="confirm-dialog rules-add-dialog" role="dialog" aria-modal="true" aria-labelledby="rules-add-title" onSubmit={submit} onKeyDown={onKeyDown}>
        <h2 id="rules-add-title" className="confirm-title"><bdi>{tr('settings.rules.add.title', { repo: titleText(repoName(repo)) })}</bdi></h2>
        <label className="setting-label" htmlFor="rules-add-pattern">{tr('settings.rules.add.pattern')}</label>
        <input id="rules-add-pattern" className="text-input" type="text" value={pattern} spellCheck={false} autoComplete="off" onChange={event => onPattern(event.target.value)} />
        {tool ? <p className="rule-warning" role="status"><bdi>{tr('settings.rules.toolWide', { tool: shown(tool), repo: titleText(repoName(repo)) })}</bdi></p> : null}
        {error ? <p className="setting-error" role="alert"><bdi>{error}</bdi></p> : null}
        <div className="confirm-actions">
          <button type="button" className="button" onClick={onCancel}>{tr('confirm.cancel')}</button>
          <button type="submit" className="button button--primary" aria-busy={sending ? 'true' : undefined}>{tr('settings.rules.add.save')}</button>
        </div>
      </form>
    </div>
  )
}

/**
 * Fetch the rules on mount and whenever `rev` (the store's `data.rulesRev`) changes.
 * @param {{ get: Function }} api
 * @param {number} rev
 * @returns {{ data: object | null, error: string | null, reload: () => void }}
 */
export function useRules(api, rev) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let current = true
    fetchRules(api).then(body => { if (current) { setData(body ?? { repos: [] })
      setError(null) } }, failure => { if (current) setError(String(failure?.message ?? failure?.code ?? 'failed')) })
    return () => { current = false }
  }, [api, rev, tick])
  const reload = useCallback(() => setTick(n => n + 1), [])
  return { data, error, reload }
}

/**
 * The Approval rules section with its actions: revoke through the confirm dialog (`DELETE /api/rules/...`),
 * add by hand (`POST /api/rules`, source `manual`), threshold through `onThreshold`. Success of a revoke goes
 * to `toast` as "Rule revoked in {repo}" with the restart line; without `toast` the same two lines show inline
 * under the section heading.
 * @param {{ api: object, rules: ReturnType<typeof useRules>, threshold?: number | null, thresholdError?: string, t?: Function, lang?: string, toast?: (item: object) => void, onThreshold: (value: number | null) => void }} props
 */
export function ApprovalRules({ api, rules, threshold, thresholdError, t, lang, toast, onThreshold }) {
  const tr = (key, params) => translate(t, RULES_COPY, key, params)
  const [revoking, setRevoking] = useState(null)
  const [busy, setBusy] = useState(null)
  const [writeErrors, setWriteErrors] = useState({})
  const [adding, setAdding] = useState(null)
  const [notice, setNotice] = useState(null)
  const announce = item => { if (toast) toast(item)
    else setNotice(item) }
  const setWriteError = (repoId, text) => setWriteErrors(map => ({ ...map, [repoId]: text }))
  const confirmRevoke = () => {
    const { repo, rule } = revoking
    setRevoking(null)
    setNotice(null)
    setBusy({ repoId: repo.repoId, pattern: rule.pattern })
    setWriteError(repo.repoId, null)
    revokeRule(api, repoName(repo), rule.pattern)
      .then(() => announce({ tone: 'success', title: tr('settings.rules.revoked', { repo: repoName(repo) }), body: tr('settings.rules.revoked.restart') }),
        error => setWriteError(repo.repoId, ruleErrorText(error, repo, t)))
      .finally(() => { setBusy(null)
        rules.reload() })
  }
  const submitAdd = () => {
    const { repo, pattern } = adding
    setAdding(state => ({ ...state, sending: true, error: null }))
    addRule(api, { repoKey: repoName(repo), pattern: pattern.trim(), source: 'manual' })
      .then(() => { setAdding(null)
        rules.reload() }, error => setAdding(state => state && { ...state, sending: false, error: ruleErrorText(error, repo, t) }))
  }
  return (
    <>
      <ApprovalRulesView data={rules.data} loadError={rules.error} threshold={threshold} thresholdError={thresholdError} t={t} lang={lang} busy={busy} writeErrors={writeErrors}
        notice={notice} onThreshold={onThreshold} onRevoke={(repo, rule) => setRevoking({ repo, rule })} onAdd={repo => setAdding({ repo, pattern: '', error: null, sending: false })} onRetry={rules.reload} />
      {revoking ? <RevokeDialog repo={revoking.repo} rule={revoking.rule} t={t} onConfirm={confirmRevoke} onCancel={() => setRevoking(null)} /> : null}
      {adding ? <AddRuleDialog repo={adding.repo} pattern={adding.pattern} error={adding.error} sending={adding.sending} t={t}
        onPattern={text => setAdding(state => ({ ...state, pattern: text, error: null }))} onSubmit={submitAdd} onCancel={() => setAdding(null)} /> : null}
    </>
  )
}
