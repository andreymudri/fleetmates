import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { MetaLine, StatusPill, compactDuration, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { needsFilterParam } from '../../state/deck-store.js'
import { fetchRunPlan, stopSession } from '../../state/actions.js'
import { ObserveOverlays, useMinuteNow } from '../home/Home.jsx'
import { deckApi, openOverlay, repoFor, tierOf } from '../drawer/NeedsYouDrawer.jsx'
import { PlanDrawer, planHeading } from './PlanDrawer.jsx'

/** English copy for the read-only Team run page (docs/deck/screens/team-run.md section 9). */
export const TEAM_COPY = Object.freeze({
  'team.back': 'All ships',
  'team.pill': '{needs} of {total} need you',
  'team.elapsed': 'running {duration}',
  'team.review': '{n, plural, one {Review # request} other {Review # requests}}',
  'team.openPlan': 'Open plan',
  'team.stopRun': 'Stop run…',
  'team.stop.title': 'Stop the fleetmates run {runId}?',
  'team.stop.body': 'Stops the lead session. Teammates stop with it. Worktrees and branches stay; fleetmates never deletes runs.',
  'team.stop.confirm': 'Stop run',
  'team.stop.deckdDown': 'deckd is reconnecting',
  'team.stop.failed': 'Could not stop the run: {message}',
  'team.subtitle.plan': 'plan {path}',
  'team.phases.label': 'Phases',
  'team.phase.name': 'Phase {n}',
  'team.phase.short': 'P{n}',
  'team.phase.sub.range': 'tasks {from} to {to}',
  'team.phase.sub.single': 'task {id}',
  'team.phase.sub.done': 'done',
  'team.phase.sub.mix': '{done} done, {needs} need you, {running} running',
  'team.phase.status.done': 'done',
  'team.phase.status.active': 'active',
  'team.phase.status.pending': 'pending',
  'team.phase.sr': '{name}, {status}: {detail}',
  'team.gate.name': 'Gate {n}',
  'team.gate.passed': 'Gate {n} passed',
  'team.gate.failed': 'Gate {n} failed',
  'team.gate.checking': 'Gate {n} · checking',
  'team.gate.tooltip': 'Recorded by fleetmates gate at {time}. The deck does not re-run gates.',
  'team.gate.sr': '{label}, recorded {time}',
  'team.tasks.label': 'Current phase tasks',
  'team.tasks.heading': 'Phase {n} · tasks {from} to {to}',
  'team.tasks.later': 'Later phases',
  'team.tasks.laterAfter': 'after Gate {n}',
  'team.task.sub.waitingApproval': 'waiting on your approval ({summary}, {tier})',
  'team.task.sub.waitingAnswer': 'waiting on your answer',
  'team.task.sub.merged': 'merged · {n, plural, one {# file} other {# files}}',
  'team.task.sub.blockedBy': 'blocked by {id}',
  'team.task.sub.running': 'running {duration}',
  'team.task.sub.waitingFor': 'waiting for {ids}',
  'team.task.sub.ready': 'ready',
  'team.task.sub.notStarted': 'not started',
  'team.task.sub.other': '{state} · see fleetmates doctor',
  'team.task.state.pending': 'Pending',
  'team.task.state.blocked': 'Blocked',
  'team.task.state.failed': 'Failed',
  'team.task.state.orphaned': 'Orphaned',
  'team.task.state.unknown': 'Unknown',
  'team.task.verified': 'Claimed by the teammate; verified by Gate {n}',
  'team.gateBanner.passed': 'Gate {n} passed at {time}.',
  'team.gateBanner.failed': 'Gate {n} failed at {time}: failed: {checks}.',
  'team.gateBanner.next': 'Gate {n} runs when tasks {from} to {to} are merged.',
  'team.crew.label': 'Crew activity',
  'team.crew.lead': 'lead',
  'team.crew.noProse': 'Tool steps only. Teammate messages are not visible to the deck.',
  'team.crew.empty': 'No activity recorded yet.',
  'team.crew.loading': 'Loading activity',
  'team.empty.phase': 'No tasks in this phase.',
  'team.integrated': 'Run integrated. Every phase is merged.',
  'team.loading': 'Loading the run',
  'team.asOf': 'as of {time}',
  'team.error.status': 'status.json could not be read: {error}. Retrying.',
  'team.error.plan': 'plan.json could not be read: {error}. Retrying.',
  'team.error.noStatus': 'This run has no status.json yet. fleetmates init-run writes it.',
  'team.error.derive': 'Phase unknown: {error}',
  'team.error.deriveDefault': 'the run branch could not be compared with the task branches',
  'team.notFound': 'This run is not on the deck.'
})

const NEEDS = new Set(['needs_approval', 'asked_you'])
const SESSION_LABELS = new Set(['needs_approval', 'asked_you', 'running', 'done'])
const LINES = 12
const SHORT = 48
// Task state to the pill tone of team-run.md 4.3.2.
const TONES = { needs_approval: 'needs_approval', asked_you: 'asked_you', running: 'running', stale: 'stale', done: 'done', pending: 'idle', blocked: 'stale', failed: 'crashed', orphaned: 'crashed', unknown: 'ended' }

const enc = value => encodeURIComponent(String(value))
const isOpen = request => (request.state ?? 'open') === 'open'
const taskNumber = id => /^T(\d+)$/.exec(String(id))?.[1] ?? String(id)

function clock(at, lang) {
  return Number.isFinite(at) ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

const short = text => {
  const value = shown(text)
  return value.length > SHORT ? `${value.slice(0, SHORT - 1)}…` : value
}

/**
 * The SPA route an unknown `repoKey` redirects to when `?repoId=` names a repo the deck knows under
 * another name (API-O2 default), or null.
 * @param {object[]} repos
 * @param {string} repoKey
 * @param {string} runId
 * @param {string} search
 * @returns {string | null}
 */
export function teamRedirect(repos, repoKey, runId, search) {
  if ((repos ?? []).some(repo => repo.name === repoKey)) return null
  let repoId = null
  try { repoId = new URLSearchParams(String(search ?? '')).get('repoId') } catch {}
  const repo = repoId ? (repos ?? []).find(row => row.id === repoId) : null
  return repo && repo.name !== repoKey ? `/runs/${enc(repo.name)}/${enc(runId)}` : null
}

/**
 * The lead session of a run: `run.leadSessionId`, else a `lead` session whose `runRef` names the run.
 * @param {object} run
 * @param {object[]} sessions
 * @returns {object | null}
 */
export function runLead(run, sessions = []) {
  if (!run) return null
  return sessions.find(row => row.id === run.leadSessionId)
    ?? sessions.find(row => row.role === 'lead' && row.runRef?.runId === run.runId && row.runRef?.repoId === run.repoId) ?? null
}

function rangeText(tasks, t) {
  if (tasks.length === 1) return translate(t, TEAM_COPY, 'team.phase.sub.single', { id: shown(tasks[0].id) })
  return translate(t, TEAM_COPY, 'team.phase.sub.range', { from: shown(taskNumber(tasks[0].id)), to: shown(taskNumber(tasks.at(-1).id)) })
}

// The phase state of the run from `derivedPhase` only; `status.phase` is never read (fleetmates contract 3).
function phaseState(run) {
  const derived = Number.isFinite(run.derivedPhase) ? run.derivedPhase : null
  const integrated = derived === null && run.phaseDerivation === 'verified'
  return { derived, integrated, failed: derived === null && !integrated }
}

function phaseStatus(n, { derived, integrated, failed }) {
  if (integrated) return 'done'
  if (failed) return 'unknown'
  return n < derived ? 'done' : n === derived ? 'active' : 'pending'
}

/**
 * The display state, label, tone and sub line of one task (team-run.md 4.3.1 and 4.3.2).
 * @param {object} task a `Run.tasks[]` row
 * @param {{ run: object, requests: object[], now: number, t?: Function, merged: boolean }} context
 * @returns {{ state: string, tone: string, label: string, sub: string | null, request: object | null }}
 */
export function taskView(task, { run, requests, now, t, merged }) {
  const request = requests.find(row => row.taskId === task.id) ?? null
  const liveness = (run.teammates ?? []).find(row => row.taskId === task.id)?.liveness ?? null
  let state
  if (request) state = request.kind === 'question' ? 'asked_you' : 'needs_approval'
  else if (task.state === 'running') state = liveness === 'stalled' ? 'stale' : 'running'
  else if (['done', 'pending', 'blocked', 'failed', 'orphaned'].includes(task.state)) state = task.state
  else state = 'unknown'
  const tone = TONES[state]
  // Session states keep the StatePill copy; the task-only states use the team.task.state keys.
  const label = state === 'stale' ? stateLabel('stale', { n: Math.max(0, Math.floor((now - (task.startedAt ?? now)) / 60_000)) }, t)
    : SESSION_LABELS.has(state) ? stateLabel(state, {}, t) : translate(t, TEAM_COPY, `team.task.state.${state}`)
  const deps = task.deps ?? []
  const doneIds = new Set((run.tasks ?? []).filter(row => row.state === 'done').map(row => row.id))
  let sub = null
  if (request) {
    sub = request.kind === 'question'
      ? translate(t, TEAM_COPY, 'team.task.sub.waitingAnswer')
      : translate(t, TEAM_COPY, 'team.task.sub.waitingApproval', { summary: short(request.summary), tier: translate(t, CARD_COPY, `tier.${tierOf(request)}`) })
  } else if (task.state === 'done' || merged) sub = translate(t, TEAM_COPY, 'team.task.sub.merged', { n: (task.files ?? []).length })
  else if (task.state === 'blocked' && task.blockedBy) sub = translate(t, TEAM_COPY, 'team.task.sub.blockedBy', { id: shown(task.blockedBy) })
  else if (task.state === 'running') sub = Number.isFinite(task.startedAt) ? translate(t, TEAM_COPY, 'team.task.sub.running', { duration: compactDuration(now - task.startedAt) }) : null
  else if (task.state === 'pending' && deps.length) {
    sub = deps.every(id => doneIds.has(id))
      ? translate(t, TEAM_COPY, 'team.task.sub.ready')
      : translate(t, TEAM_COPY, 'team.task.sub.waitingFor', { ids: deps.map(shown).join(', ') })
  } else if (task.state === 'pending') sub = translate(t, TEAM_COPY, 'team.task.sub.notStarted')
  else sub = translate(t, TEAM_COPY, 'team.task.sub.other', { state: shown(task.state) })
  return { state, tone, label, sub, request }
}

function gateLabel(n, gate, t) {
  if (gate?.verdict === 'PASS') return translate(t, TEAM_COPY, 'team.gate.passed', { n })
  if (gate?.verdict === 'FAIL') return translate(t, TEAM_COPY, 'team.gate.failed', { n })
  return translate(t, TEAM_COPY, 'team.gate.name', { n })
}

function Phases({ run, views, phase, t, lang }) {
  const total = Math.max(0, Math.floor(run.totalPhases ?? 0))
  const crowded = total >= 6
  const items = []
  for (let n = 1; n <= total; n++) {
    const tasks = (run.tasks ?? []).filter(task => task.phase === n)
    const status = phaseStatus(n, phase)
    const name = translate(t, TEAM_COPY, 'team.phase.name', { n })
    const range = tasks.length ? rangeText(tasks, t) : ''
    let tail = null
    if (status === 'done' && tasks.length) tail = translate(t, TEAM_COPY, 'team.phase.sub.done')
    if (status === 'active') {
      const states = tasks.map(task => views.get(task.id)?.state)
      tail = translate(t, TEAM_COPY, 'team.phase.sub.mix', { done: states.filter(s => s === 'done').length, needs: states.filter(s => NEEDS.has(s)).length, running: states.filter(s => s === 'running' || s === 'stale').length })
    }
    const sub = [range, tail].filter(Boolean).join(' · ')
    const statusText = status === 'unknown' ? '' : translate(t, TEAM_COPY, `team.phase.status.${status}`)
    const sr = statusText ? translate(t, TEAM_COPY, 'team.phase.sr', { name, status: statusText, detail: [range, tail].filter(Boolean).join(', ') }) : name
    items.push(
      <li key={`p${n}`} className={`team-phase team-phase--${status}`} aria-label={sr} title={crowded ? sr : undefined}>
        <span className="team-phase-name" aria-hidden="true">{crowded ? translate(t, TEAM_COPY, 'team.phase.short', { n }) : name}</span>
        <span className="team-phase-bar" aria-hidden="true" />
        {sub ? <span className="team-phase-sub" aria-hidden="true">{sub}</span> : null}
      </li>
    )
    if (n < total) {
      const gate = run.gates?.[String(n)] ?? null
      const label = gateLabel(n, gate, t)
      const recorded = gate && Number.isFinite(gate.recordedAt)
      const kind = gate?.verdict === 'PASS' ? 'passed' : gate?.verdict === 'FAIL' ? 'failed' : 'pending'
      items.push(
        <li key={`g${n}`} className={`team-gate team-gate--${kind}`} tabIndex={recorded ? 0 : undefined}
          aria-label={recorded ? translate(t, TEAM_COPY, 'team.gate.sr', { label, time: clock(gate.recordedAt, lang) }) : label}
          title={recorded ? translate(t, TEAM_COPY, 'team.gate.tooltip', { time: clock(gate.recordedAt, lang) }) : undefined}>
          <span className="team-gate-mark" aria-hidden="true" />
          <span className="team-gate-name" aria-hidden="true">{label}</span>
        </li>
      )
    }
  }
  return (
    <section className="team-phases" aria-label={translate(t, TEAM_COPY, 'team.phases.label')}>
      {phase.failed ? <p className="team-banner team-banner--hint">{translate(t, TEAM_COPY, 'team.error.derive', { error: run.phaseError ? titleText(run.phaseError) : translate(t, TEAM_COPY, 'team.error.deriveDefault') })}</p> : null}
      <ol className="team-timeline">{items}</ol>
    </section>
  )
}

function crewDomId(taskId) {
  return `team-crew-${String(taskId).replace(/[^\w-]/g, '_')}`
}

function focusPanel(taskId) {
  const panel = globalThis.document?.getElementById(crewDomId(taskId))
  panel?.scrollIntoView?.({ block: 'nearest' })
  panel?.focus?.()
}

function TaskRow({ task, view, repo, run, t, onReview, onScrollTo }) {
  const title = titleText(task.title || task.id)
  const verifiedBy = task.state === 'done'
    ? Object.values(run.gates ?? {}).filter(gate => gate.verdict === 'PASS' && Number.isFinite(gate.phase) && gate.phase >= (task.phase ?? Infinity)).map(gate => gate.phase).sort((a, b) => a - b)[0]
    : undefined
  const onClick = event => {
    event?.preventDefault?.()
    if (view.request) onReview({ kind: 'task', runId: run.runId, taskId: task.id })
    else onScrollTo(task.id)
  }
  return (
    <li className={`team-task team-task--${view.tone.replace(/_/g, '-')}`} data-task={task.id}>
      <button type="button" className="team-task-button" data-task={task.id} aria-label={`${shown(task.id)} ${title}, ${view.label}`} onClick={onClick}>
        <span className="team-task-id">{shown(task.id)}</span>
        <span className="team-task-text">
          <span className="team-task-title"><bdi>{title}</bdi></span>
          {view.sub ? <span className="team-task-sub">{view.sub}</span> : null}
        </span>
        {view.state !== 'pending' ? <CrewAvatar seed={`${repo.crewSeed}#${task.id}`} slot={repo.crewSlot} pose={poseFor(view.tone)} team size="sm" /> : null}
        <span className="team-task-state" title={verifiedBy !== undefined ? translate(t, TEAM_COPY, 'team.task.verified', { n: verifiedBy }) : undefined}>
          <StatusPill state={view.tone} label={view.label} variant="text" t={t} />
        </span>
      </button>
    </li>
  )
}

function Tasks({ run, views, phase, repo, t, lang, onReview, onScrollTo }) {
  const tasks = run.tasks ?? []
  const row = task => <TaskRow key={task.id} task={task} view={views.get(task.id)} repo={repo} run={run} t={t} onReview={onReview} onScrollTo={onScrollTo} />
  let body
  if (phase.integrated) body = <p className="team-empty">{translate(t, TEAM_COPY, 'team.integrated')}</p>
  else if (phase.failed) body = tasks.length ? <ul className="team-task-list">{tasks.map(row)}</ul> : <p className="team-empty">{translate(t, TEAM_COPY, 'team.empty.phase')}</p>
  else {
    const current = tasks.filter(task => task.phase === phase.derived)
    const later = [...new Set(tasks.filter(task => task.phase > phase.derived).map(task => task.phase))].sort((a, b) => a - b)
    const name = translate(t, TEAM_COPY, 'team.phase.name', { n: phase.derived })
    const heading = current.length > 1
      ? translate(t, TEAM_COPY, 'team.tasks.heading', { n: phase.derived, from: shown(taskNumber(current[0].id)), to: shown(taskNumber(current.at(-1).id)) })
      : current.length ? `${name} · ${rangeText(current, t)}` : name
    body = (
      <>
        <h2 className="team-eyebrow">{heading}</h2>
        {current.length ? <ul className="team-task-list">{current.map(row)}</ul> : <p className="team-empty">{translate(t, TEAM_COPY, 'team.empty.phase')}</p>}
        {later.length ? (
          <div className="team-later">
            <h3 className="team-eyebrow">{translate(t, TEAM_COPY, 'team.tasks.later')}</h3>
            {later.map(n => {
              const rows = tasks.filter(task => task.phase === n)
              return (
                <details key={n} className="team-later-phase">
                  <summary>{`${translate(t, TEAM_COPY, 'team.phase.name', { n })} · ${rangeText(rows, t)}`}</summary>
                  <ul className="team-later-list">
                    {rows.map(task => (
                      <li key={task.id} className="team-later-row" data-later={task.id}>
                        <span className="team-later-title"><bdi>{`${shown(task.id)} · ${titleText(task.title || task.id)}`}</bdi></span>
                        <span className="team-later-sub">{translate(t, TEAM_COPY, 'team.tasks.laterAfter', { n: n - 1 })}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })}
          </div>
        ) : null}
      </>
    )
  }
  const latest = Object.entries(run.gates ?? {}).map(([key, gate]) => ({ n: Number.isFinite(gate.phase) ? gate.phase : Number(key), ...gate }))
    .filter(gate => Number.isFinite(gate.recordedAt)).sort((a, b) => b.recordedAt - a.recordedAt)[0] ?? null
  const current = phase.derived === null ? [] : tasks.filter(task => task.phase === phase.derived)
  const banner = [
    latest ? translate(t, TEAM_COPY, latest.verdict === 'PASS' ? 'team.gateBanner.passed' : 'team.gateBanner.failed', { n: latest.n, time: clock(latest.recordedAt, lang), checks: (latest.failed ?? []).map(shown).join(', ') }) : null,
    current.length && phase.derived < (run.totalPhases ?? 0)
      ? translate(t, TEAM_COPY, 'team.gateBanner.next', { n: phase.derived, from: shown(taskNumber(current[0].id)), to: shown(taskNumber(current.at(-1).id)) })
      : null
  ].filter(Boolean)
  return (
    <section className="team-tasks" aria-label={translate(t, TEAM_COPY, 'team.tasks.label')}>
      {body}
      {banner.length ? <p className="team-banner team-banner--gate">{banner.join(' ')}</p> : null}
    </section>
  )
}

function CrewLines({ steps, t, lang }) {
  if (!steps) {
    return (
      <div className="team-crew-lines" aria-busy="true">
        <span className="sr-only">{translate(t, TEAM_COPY, 'team.crew.loading')}</span>
        {[0, 1, 2].map(index => <div key={index} className="team-crew-skeleton motion-shimmer" aria-hidden="true" />)}
      </div>
    )
  }
  const lines = [...steps].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(-LINES)
  return (
    <div className="team-crew-lines" role="log" aria-live="off">
      {lines.length ? (
        <ol className="team-crew-steps">
          {lines.map(step => (
            <li key={step.seq} className={`team-crew-line team-crew-line--${step.status === 'failed' ? 'error' : step.status === 'running' ? 'waiting' : 'tool'}`}>
              <span className="team-crew-time">{clock(step.at, lang)}</span>
              <span className="team-crew-text">{shown(step.line)}</span>
            </li>
          ))}
        </ol>
      ) : <p className="team-crew-empty">{translate(t, TEAM_COPY, 'team.crew.empty')}</p>}
    </div>
  )
}

function CrewPanel({ id, href, who, state, label, steps, note, repo, seed, t, lang, navigate }) {
  const head = (
    <>
      <CrewAvatar seed={seed} slot={repo.crewSlot} pose={poseFor(state)} hat={repo.hat} team size="sm" />
      <MetaLine className="team-crew-who" items={who} />
      <StatusPill state={state} label={label} variant="text" t={t} />
    </>
  )
  return (
    <article className="team-crew" id={id} tabIndex={-1} aria-labelledby={`${id}-head`}>
      <header className="team-crew-head" id={`${id}-head`}>
        {href ? <a className="team-crew-link" href={href} onClick={linkHandler(navigate, href)}>{head}</a> : head}
      </header>
      {note ? <p className="team-crew-note">{translate(t, TEAM_COPY, 'team.crew.noProse')}</p> : null}
      <CrewLines steps={steps} t={t} lang={lang} />
    </article>
  )
}

function Crew({ run, lead, views, workers, repo, crew, t, lang, now, navigate }) {
  const panels = []
  if (lead) {
    const leadSteps = crew?.lead ? crew.lead.filter(step => !step.taskId) : null
    const claim = lead.runRef?.taskId ?? null
    const view = claim ? views.get(claim) : null
    panels.push(
      <CrewPanel key="lead" id={crewDomId('lead')} href={`/s/${enc(lead.id)}`} repo={repo} seed={repo.crewSeed} t={t} lang={lang} navigate={navigate}
        who={[translate(t, TEAM_COPY, 'team.crew.lead'), claim ? shown(claim) : null]} state={view?.tone ?? lead.state} label={view?.label}
        steps={leadSteps} note={false} />
    )
  }
  for (const task of workers) {
    const view = views.get(task.id)
    const steps = crew?.tasks?.[task.id] ?? (crew ? [] : null)
    const href = lead ? `/s/${enc(lead.id)}?${needsFilterParam({ kind: 'task', runId: run.runId, taskId: task.id })}` : null
    panels.push(
      <CrewPanel key={task.id} id={crewDomId(task.id)} href={href} repo={repo} seed={`${repo.crewSeed}#${task.id}`} t={t} lang={lang} navigate={navigate}
        who={[shown(task.id)]} state={view.tone} label={view.label} steps={steps} note />
    )
  }
  return <section className="team-crew-grid" aria-label={translate(t, TEAM_COPY, 'team.crew.label')}>{panels}</section>
}

/**
 * The read-only Team run page (team-run.md, M2): header, phases timeline with gates, the current
 * phase's tasks with later phases collapsed, the gate banner and the crew activity panels. Every state
 * of section 5 renders from props. Pure apart from the ConfirmDialog it shows while `confirming`.
 * @param {{
 *   state: object, run: object | null, repoKey: string, t?: Function, now?: number, lang?: string,
 *   navigate: (to: string) => void, crew?: { lead: object[] | null, tasks: Record<string, object[]> } | null,
 *   planTitle?: string | null, notFound?: boolean, loadError?: string | null, asOf?: number | null,
 *   confirming?: boolean, stopError?: string | null, onReview?: (filter: object) => void, onOpenPlan?: () => void,
 *   onStop?: () => void, onConfirmStop?: () => void, onCancelStop?: () => void, onScrollTo?: (taskId: string) => void
 * }} props
 */
export function TeamRunView({
  state, run, repoKey, t, now = Date.now(), lang = 'en', navigate, crew = null, planTitle = null, notFound = false, loadError = null,
  asOf = null, confirming = false, stopError = null, onReview = () => {}, onOpenPlan = () => {}, onStop = () => {},
  onConfirmStop = () => {}, onCancelStop = () => {}, onScrollTo = focusPanel
}) {
  const back = <a className="team-back" href="/" onClick={linkHandler(navigate, '/')}>{translate(t, TEAM_COPY, 'team.back')} <kbd className="kbd" aria-hidden="true">Alt Esc</kbd></a>
  if (!run) {
    if (notFound) {
      return (
        <section className="team team--missing">
          {back}
          <h1 className="page-title">{translate(t, TEAM_COPY, 'team.notFound')}</h1>
        </section>
      )
    }
    return (
      <section className="team team--loading" aria-busy="true">
        {back}
        <span className="sr-only">{translate(t, TEAM_COPY, 'team.loading')}</span>
        {loadError ? <p className="team-banner team-banner--error" role="alert">{translate(t, TEAM_COPY, 'team.error.status', { error: titleText(loadError) })}</p> : null}
        <div className="team-skeleton-bar motion-shimmer" aria-hidden="true" />
        {[0, 1, 2, 3, 4].map(index => <div key={index} className="team-skeleton-row motion-shimmer" aria-hidden="true" />)}
      </section>
    )
  }
  const sessions = state.data.sessions ?? []
  const repo = repoFor(state.data.repos, run.repoId)
  const lead = runLead(run, sessions)
  const members = new Set(sessions.filter(row => row.id === lead?.id || row.runRef?.runId === run.runId && row.runRef?.repoId === run.repoId).map(row => row.id))
  const requests = (state.data.requests ?? []).filter(row => isOpen(row) && members.has(row.sessionId))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const phase = phaseState(run)
  const tasks = run.tasks ?? []
  const views = new Map(tasks.map(task => [task.id, taskView(task, { run, requests, now, t, merged: phase.integrated || phase.derived !== null && task.phase < phase.derived })]))
  // Workers: the tasks under way in the current phase (every task when the phase is unknown), plus the lead when it claims no task.
  const scope = phase.derived !== null ? tasks.filter(task => task.phase === phase.derived) : phase.failed ? tasks : []
  const working = scope.filter(task => views.get(task.id).state !== 'pending')
  const claim = lead?.runRef?.taskId ?? null
  const leadOwn = lead ? requests.filter(row => row.sessionId === lead.id && !row.taskId) : []
  const leadNeeds = !!lead && (leadOwn.length > 0 || NEEDS.has(lead.state) && !requests.some(row => row.sessionId === lead.id))
  const needs = working.filter(task => NEEDS.has(views.get(task.id).state)).length + (leadNeeds && !claim ? 1 : 0)
  const total = Math.max(working.length + (lead && !claim ? 1 : 0), 1)
  const states = [...working.map(task => views.get(task.id).state), ...(lead ? [lead.state] : [])]
  const aggregate = needs ? (requests.length && requests.every(row => row.kind === 'question') ? 'asked_you' : 'needs_approval')
    : states.some(s => s === 'running' || s === 'stale') ? 'running' : tasks.length && tasks.every(task => task.state === 'done') ? 'done' : 'idle'
  const pillLabel = needs ? translate(t, TEAM_COPY, 'team.pill', { needs, total })
    : aggregate === 'idle' ? translate(t, TEAM_COPY, 'team.task.state.pending') : undefined
  const starts = tasks.map(task => task.startedAt).filter(Number.isFinite)
  const start = Number.isFinite(lead?.startedAt) ? lead.startedAt : starts.length ? Math.min(...starts) : null
  const title = titleText(lead?.task || planTitle || run.runId)
  const stoppable = !!lead && lead.alive !== false && lead.origin !== 'observed' && !['ended', 'crashed'].includes(lead.state)
  const deckdDown = !!state.deckdOutage
  const crewWorkers = scope.filter(task => task.id !== claim && (crew?.tasks?.[task.id]?.length || requests.some(row => row.taskId === task.id)))
  const readError = run.readError
  return (
    <div className="team">
      <header className="team-header">
        {back}
        <div className="team-heading">
          <h1 className="team-title" title={title}><bdi>{title}</bdi></h1>
          <MetaLine className="team-subtitle" items={[shown(repo.name || repoKey), run.runBranch ? shown(run.runBranch) : null, run.planPath ? translate(t, TEAM_COPY, 'team.subtitle.plan', { path: shown(run.planPath) }) : null]} />
        </div>
        <StatusPill state={aggregate} label={pillLabel} t={t} />
        {start !== null ? <span className="team-elapsed">{translate(t, TEAM_COPY, 'team.elapsed', { duration: compactDuration(now - start) })}</span> : null}
        <div className="team-actions">
          {requests.length ? <button type="button" className="button button--amber button--xs" onClick={() => onReview({ kind: 'run', runId: run.runId })}>{translate(t, TEAM_COPY, 'team.review', { n: requests.length })}</button> : null}
          <button type="button" className="button button--secondary button--xs" onClick={onOpenPlan}>{translate(t, TEAM_COPY, 'team.openPlan')}</button>
          {stoppable ? <button type="button" className="button button--danger button--xs" disabled={deckdDown} aria-describedby={deckdDown ? 'team-stop-reason' : undefined} onClick={onStop}>{translate(t, TEAM_COPY, 'team.stopRun')}</button> : null}
          {stoppable && deckdDown ? <span className="team-stop-reason" id="team-stop-reason">{translate(t, TEAM_COPY, 'team.stop.deckdDown')}</span> : null}
        </div>
      </header>
      {stopError ? <p className="team-banner team-banner--error" role="alert">{translate(t, TEAM_COPY, 'team.stop.failed', { message: titleText(stopError) })}</p> : null}
      {readError ? (
        <p className="team-banner team-banner--error" role="alert">
          {translate(t, TEAM_COPY, readError.file === 'plan.json' ? 'team.error.plan' : 'team.error.status', { error: titleText(readError.message) })}
          {Number.isFinite(asOf) ? <span className="team-asof">{` ${translate(t, TEAM_COPY, 'team.asOf', { time: clock(asOf, lang) })}`}</span> : null}
        </p>
      ) : null}
      {run.statusMissing === true ? <p className="team-banner team-banner--hint">{translate(t, TEAM_COPY, 'team.error.noStatus')}</p> : null}
      <div className={`team-body${readError ? ' team-body--dim' : ''}`}>
        <Phases run={run} views={views} phase={phase} t={t} lang={lang} />
        <div className="team-columns">
          <Tasks run={run} views={views} phase={phase} repo={repo} t={t} lang={lang} onReview={onReview} onScrollTo={onScrollTo} />
          <Crew run={run} lead={lead} views={views} workers={crewWorkers} repo={repo} crew={crew} t={t} lang={lang} now={now} navigate={navigate} />
        </div>
      </div>
      {confirming ? (
        <ConfirmDialog tone="danger" t={t} title={translate(t, TEAM_COPY, 'team.stop.title', { runId: shown(run.runId) })} body={translate(t, TEAM_COPY, 'team.stop.body')}
          confirmLabel={translate(t, TEAM_COPY, 'team.stop.confirm')} onConfirm={onConfirmStop} onCancel={onCancelStop} />
      ) : null}
    </div>
  )
}

/**
 * The Team run route screen for the shell's `screens` map: reads `GET /api/runs/:repoKey/:runId` (the run id
 * one encoded segment) and then follows `run.updated` through the store, loads the lead's steps and each
 * worker's `?taskId=` steps again whenever the lead's activity moves, falls back to the plan's heading for
 * the title, redirects an unknown `repoKey` with `?repoId=` (API-O2), and runs Stop run and the plan drawer.
 * This browser wiring is not exercised by the unit tests; {@link TeamRunView} and {@link teamRedirect} are.
 * @param {{ route: { params: { repoKey: string, runId: string } }, state: object, t?: Function, navigate: Function, api?: object, search?: string }} props
 */
export function TeamRun({ route, state, t, navigate, api, search = globalThis.location?.search ?? '' }) {
  const { repoKey, runId } = route.params
  const client = api ?? deckApi()
  const now = useMinuteNow()
  const repos = state.data.repos ?? []
  const repo = repos.find(row => row.name === repoKey) ?? null
  const redirect = teamRedirect(repos, repoKey, runId, search)
  const [fetched, setFetched] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [crew, setCrew] = useState(null)
  const [planTitle, setPlanTitle] = useState(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [stopError, setStopError] = useState(null)
  const goodAt = useRef(null)
  useEffect(() => { if (redirect) navigate(redirect, { replace: true }) }, [redirect, navigate])
  useEffect(() => {
    if (redirect) return undefined
    let current = true
    setFetched(null)
    setNotFound(false)
    setLoadError(null)
    client.get(`/api/runs/${enc(repoKey)}/${enc(runId)}`).then(data => { if (current) setFetched(data?.run ?? null) }).catch(error => {
      if (!current) return
      if (error?.status === 404) setNotFound(true)
      else setLoadError(error?.message ?? 'failed')
    })
    return () => { current = false }
  }, [client, repoKey, runId, redirect])
  const live = (state.data.runs ?? []).find(row => row.runId === runId && (repo ? row.repoId === repo.id : row.repoId === fetched?.repoId)) ?? null
  const run = live ?? fetched
  if (run && !run.readError) goodAt.current = Date.now()
  const lead = runLead(run, state.data.sessions ?? [])
  const leadId = lead?.id ?? null
  const activity = lead?.lastActivityAt ?? null
  const workerIds = run && Number.isFinite(run.derivedPhase)
    ? (run.tasks ?? []).filter(task => task.phase === run.derivedPhase && task.state !== 'pending' && task.id !== lead?.runRef?.taskId).map(task => task.id).join('\n')
    : ''
  useEffect(() => {
    if (!leadId) { setCrew(null); return undefined }
    let current = true
    const steps = query => client.get(`/api/sessions/${enc(leadId)}/steps${query}`).then(data => data?.steps ?? []).catch(() => [])
    const ids = workerIds ? workerIds.split('\n') : []
    Promise.all([steps(''), ...ids.map(id => steps(`?taskId=${enc(id)}`))]).then(([leadSteps, ...rest]) => {
      if (current) setCrew({ lead: leadSteps, tasks: Object.fromEntries(ids.map((id, index) => [id, rest[index]])) })
    })
    return () => { current = false }
  }, [client, leadId, activity, workerIds])
  const needsHeading = !!run && !lead?.task
  useEffect(() => {
    if (!needsHeading) return undefined
    let current = true
    fetchRunPlan(client, repoKey, runId).then(data => { if (current) setPlanTitle(planHeading(data?.markdown)) }).catch(() => {})
    return () => { current = false }
  }, [client, repoKey, runId, needsHeading])
  const onConfirmStop = () => {
    setConfirming(false)
    setStopError(null)
    if (lead) stopSession(client, lead.id).catch(error => setStopError(error?.message ?? 'failed'))
  }
  return (
    <>
      <TeamRunView state={state} run={run} repoKey={repoKey} t={t} now={now} navigate={navigate} crew={crew} planTitle={planTitle}
        notFound={notFound && !run} loadError={loadError} asOf={goodAt.current} confirming={confirming} stopError={stopError}
        onReview={filter => openOverlay('drawer', globalThis.window, { filter })} onOpenPlan={() => setPlanOpen(true)}
        onStop={() => setConfirming(true)} onConfirmStop={onConfirmStop} onCancelStop={() => setConfirming(false)} />
      {planOpen && run ? <PlanDrawer api={client} repoKey={repoKey} repoId={run.repoId} runId={run.runId} t={t} onClose={() => setPlanOpen(false)} /> : null}
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} />
    </>
  )
}
