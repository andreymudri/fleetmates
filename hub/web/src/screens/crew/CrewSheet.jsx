import React, { useEffect, useState } from 'react'
import { CrewAvatar, SLOT_COLORS } from '../../components/CrewAvatar.jsx'
import { shown, translate } from '../../components/StatusPill.jsx'
import { patchCrew } from '../../state/actions.js'
import { deckApi } from '../drawer/NeedsYouDrawer.jsx'
import { radioKeys, SettingsView, sharedRepos } from '../settings/Settings.jsx'

/** English copy for the Crew sheet (docs/deck/screens/crew-sheet.md section 9). */
export const CREW_COPY = Object.freeze({
  'crew.title': 'One crew member per repo',
  'crew.intro': 'The shape comes from the repo name. The color is the first free slot when the deck first sees the repo, saved so it never changes and never repeats. Needs you raises an arm and adds an amber signal; idle closes the eyes.',
  'crew.grid.repo': 'Repo',
  'crew.pose.running': 'running',
  'crew.pose.needs': 'needs you',
  'crew.pose.idle': 'idle',
  'crew.pose.done': 'done',
  'crew.pose.crashed': 'crashed',
  'crew.avatar.a11y': '{repo} crew member, {pose}',
  'crew.team.title': 'A fleetmates team shares a hat',
  'crew.team.lead': 'lead',
  'crew.customize.title': 'Customize {repo}\'s crew member',
  'crew.customize.repo': 'Repo',
  'crew.customize.current': 'Current look',
  'crew.customize.reroll': 'Reroll',
  'crew.customize.resetShape': 'Use the original shape',
  'crew.customize.color': 'Color',
  'crew.customize.color.current': 'Current color',
  'crew.customize.color.free': 'Free color slot {n}',
  'crew.customize.color.none': 'All 9 colors are taken. Archive a repo to free one.',
  'crew.customize.hat': 'Hat',
  'crew.customize.hat.none': 'No hat',
  'crew.customize.hat.cap': 'Cap',
  'crew.customize.hat.bandana': 'Bandana',
  'crew.small.title': 'At card size (27px), poses still read',
  'crew.note': 'The pose is a backup signal, never the only one: every card also carries a state pill with an icon and a label.',
  'crew.shared': '{n} repos share colors because there are more than 9. Pick which ones share below.',
  'crew.empty': 'No repos yet. Crew members appear the first time the deck sees a repo.',
  'crew.saved': '{repo}\'s crew member updated',
  'crew.saveError': 'Could not save the crew change: {error}',
  'crew.undo': 'Undo',
  'crew.dismiss': 'Dismiss'
})

/** Poses in grid order (crew-sheet.md section 3). */
export const CREW_POSES = Object.freeze(['running', 'needs', 'idle', 'done', 'crashed'])
/** Hats a repo's crew member can wear (crew.md 7); teal is the team cap, never a personal hat. */
export const CREW_HATS = Object.freeze(['none', 'cap', 'bandana'])
/** How long the saved toast offers Undo, in ms (crew-sheet.md section 5). */
export const UNDO_MS = 6000

const TEAM = ['T1', 'T2', 'T3']

/**
 * The crew fields of a repo row, with the seed defaulting to the repo name.
 * @param {{ name: string, crew?: { seed?: string | null, slot?: number | null, hat?: string } }} repo
 * @returns {{ seed: string, slot: number | null, hat: string }}
 */
export function crewOf(repo) {
  const crew = repo?.crew ?? {}
  return { seed: crew.seed || repo?.name || '', slot: Number.isInteger(crew.slot) ? crew.slot : null, hat: CREW_HATS.includes(crew.hat) ? crew.hat : 'none' }
}

/**
 * The seed "Reroll" writes: `name#2`, then `name#3`, ... (crew.md 1).
 * @param {{ name: string, crew?: { seed?: string | null } }} repo
 * @returns {string}
 */
export function nextSeed(repo) {
  const { seed } = crewOf(repo)
  const n = seed.startsWith(`${repo.name}#`) ? Number(seed.slice(repo.name.length + 1)) : 1
  return `${repo.name}#${Number.isInteger(n) && n >= 1 ? n + 1 : 2}`
}

/**
 * Color choices for a repo: its current slot first, then every slot no other known repo holds on its own
 * (crew.md 4.1 and 4.2). Shared and archived repos hold no slot.
 * @param {object[]} repos snapshot `repos` rows
 * @param {object} repo the customize target
 * @returns {{ slot: number, current: boolean }[]}
 */
export function colorChoices(repos, repo) {
  const own = crewOf(repo).slot
  const taken = new Set(repos.filter(row => row.id !== repo.id && !row.archivedAt && !row.crew?.slotShared && Number.isInteger(row.crew?.slot)).map(row => row.crew.slot))
  const free = SLOT_COLORS.map((_, slot) => slot).filter(slot => slot !== own && !taken.has(slot))
  return [...(own === null ? [] : [{ slot: own, current: true }]), ...free.map(slot => ({ slot, current: false }))]
}

function failure(error) {
  return String(error?.code ?? error?.message ?? 'failed')
}

/**
 * Apply one crew change: the preview updates at once, `PATCH /api/repos/:repoKey/crew` saves it, a failure
 * reverts the preview and toasts "Could not save the crew change: {error}", a success toasts with an Undo
 * patch holding the previous seed and hat, and the previous slot when the change moved it.
 * @param {{ api: { patch: Function }, repo: object, patch: { seed?: string, slot?: number, hat?: string }, setPreview: (crew: object) => void, toast: (toast: { tone: 'success'|'error', text: string, undo?: object }) => void, t?: Function }} options
 * @returns {Promise<void>}
 */
export function changeCrew({ api, repo, patch, setPreview, toast, t }) {
  const tr = (key, params) => translate(t, CREW_COPY, key, params)
  const before = crewOf(repo)
  setPreview({ ...before, ...patch })
  const undo = { seed: before.seed, ...(patch.slot !== undefined && before.slot !== null ? { slot: before.slot } : {}), hat: before.hat }
  return patchCrew(api, repo.repoKey ?? repo.name, patch).then(
    () => toast({ tone: 'success', text: tr('crew.saved', { repo: shown(repo.name) }), undo }),
    error => {
      setPreview(before)
      toast({ tone: 'error', text: tr('crew.saveError', { error: shown(failure(error)) }) })
    })
}

function Swatches({ choices, t, onChange }) {
  const tr = (key, params) => translate(t, CREW_COPY, key, params)
  const slots = choices.map(choice => choice.slot)
  return (
    <div className="crew-swatches" role="radiogroup" aria-label={tr('crew.customize.color')}>
      {choices.map((choice, index) => (
        <button key={choice.slot} type="button" role="radio" className="crew-swatch" style={{ background: SLOT_COLORS[choice.slot] }}
          aria-checked={choice.current ? 'true' : 'false'} tabIndex={choice.current ? 0 : -1}
          aria-label={choice.current ? tr('crew.customize.color.current') : tr('crew.customize.color.free', { n: choice.slot })}
          onClick={() => { if (!choice.current) onChange({ slot: choice.slot }) }} onKeyDown={radioKeys(slots, index, slot => onChange({ slot }))} />
      ))}
    </div>
  )
}

function Customize({ repos, repo, t, busy, onSelect, onChange }) {
  const tr = (key, params) => translate(t, CREW_COPY, key, params)
  const crew = crewOf(repo)
  const name = shown(repo.name)
  const choices = colorChoices(repos, repo)
  return (
    <div className="crew-customize-column">
      <label className="setting-select crew-repo-select" htmlFor="crew-repo">{tr('crew.customize.repo')}
        {/* Options carry the row index, so a repo key with hidden characters never reaches the DOM raw. */}
        <select id="crew-repo" value={String(repos.indexOf(repo))} onChange={event => { const row = repos[Number(event.target.value)]
          if (row) onSelect(row.repoKey ?? row.name) }}>
          {repos.map((row, index) => <option key={row.id} value={String(index)}>{shown(row.name)}</option>)}
        </select>
      </label>
      <section className="crew-card" aria-labelledby="crew-customize-title" aria-busy={busy ? 'true' : undefined}>
        <h2 className="settings-heading" id="crew-customize-title"><bdi>{tr('crew.customize.title', { repo: name })}</bdi></h2>
        <div className="crew-preview">
          <CrewAvatar seed={crew.seed} slot={crew.slot ?? undefined} hat={crew.hat} pose="done" size="xl" label={tr('crew.avatar.a11y', { repo: name, pose: tr('crew.pose.done') })} />
          <span className="setting-hint">{tr('crew.customize.current')}</span>
        </div>
        <div className="crew-actions">
          <button type="button" className="button button--secondary" onClick={() => onChange({ seed: nextSeed(repo) })}>{tr('crew.customize.reroll')}</button>
          {crew.seed !== repo.name ? <button type="button" className="button button--ghost button--sm" onClick={() => onChange({ seed: repo.name })}>{tr('crew.customize.resetShape')}</button> : null}
        </div>
        <h3 className="settings-subheading">{tr('crew.customize.color')}</h3>
        <Swatches choices={choices} t={t} onChange={onChange} />
        {choices.some(choice => !choice.current) ? null : <p className="setting-hint">{tr('crew.customize.color.none')}</p>}
        <h3 className="settings-subheading">{tr('crew.customize.hat')}</h3>
        <div className="segmented" role="radiogroup" aria-label={tr('crew.customize.hat')}>
          {CREW_HATS.map((hat, index) => (
            <button key={hat} type="button" role="radio" className="segmented-option" aria-checked={hat === crew.hat ? 'true' : 'false'} tabIndex={hat === crew.hat ? 0 : -1}
              onClick={() => { if (hat !== crew.hat) onChange({ hat }) }} onKeyDown={radioKeys(CREW_HATS, index, value => onChange({ hat: value }))}>{tr(`crew.customize.hat.${hat}`)}</button>
          ))}
        </div>
      </section>
      <section className="crew-small" aria-labelledby="crew-small-title">
        <h2 className="settings-heading" id="crew-small-title">{tr('crew.small.title')}</h2>
        <ul className="crew-tiles">
          {CREW_POSES.map(pose => (
            <li key={pose} className="crew-tile">
              <CrewAvatar seed={crew.seed} slot={crew.slot ?? undefined} hat={crew.hat} pose={pose} size="sm" />
              <span className={`crew-pose crew-pose--${pose}`}>{tr(`crew.pose.${pose}`)}</span>
            </li>
          ))}
        </ul>
        <p className="setting-hint">{tr('crew.note')}</p>
      </section>
    </div>
  )
}

function CrewToast({ toast, t, onUndo, onDismiss }) {
  const tr = key => translate(t, CREW_COPY, key)
  return (
    <div className={`crew-toast crew-toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <p className="crew-toast-text"><bdi>{toast.text}</bdi></p>
      {toast.undo ? <button type="button" className="button button--xs" onClick={() => onUndo(toast.undo)}>{tr('crew.undo')}</button> : null}
      <button type="button" className="button button--ghost button--xs" onClick={onDismiss}>{tr('crew.dismiss')}</button>
    </div>
  )
}

/**
 * Crew sheet content, pure (crew-sheet.md): heading and intro, the pose grid as a table (pose column headers,
 * repo row headers, one named `xl` avatar per pose), the team section from the first repo, the repo select and
 * the Customize card. Repo names pass through `shown`. Nothing animates.
 * @param {{ repos: object[], selected?: string, loading?: boolean, busy?: boolean, toast?: { tone: string, text: string, undo?: object } | null, t?: Function, onSelect: (repoKey: string) => void, onChange: (patch: object) => void, onUndo?: (patch: object) => void, onDismiss?: () => void }} props
 */
export function CrewSheetView({ repos, selected, loading = false, busy = false, toast = null, t, onSelect, onChange, onUndo = () => {}, onDismiss = () => {} }) {
  const tr = (key, params) => translate(t, CREW_COPY, key, params)
  const known = repos.filter(repo => !repo.archivedAt)
  const target = known.find(repo => (repo.repoKey ?? repo.name) === selected) ?? known[0]
  const shared = sharedRepos(known)
  const first = known[0]
  return (
    <section className="settings-section crew-sheet" aria-labelledby="crew-title">
      <h2 className="settings-heading" id="crew-title">{tr('crew.title')}</h2>
      <p className="crew-intro">{tr('crew.intro')}</p>
      {shared ? <p className="crew-shared" role="note">{tr('crew.shared', { n: shared })}</p> : null}
      {toast ? <CrewToast toast={toast} t={t} onUndo={onUndo} onDismiss={onDismiss} /> : null}
      {!loading && !known.length ? <p className="setting-hint crew-empty">{tr('crew.empty')}</p> : (
        <div className="crew-layout">
          <div className="crew-grid-scroll">
            <table className="crew-grid">
              <thead>
                <tr>
                  <th scope="col" className="sr-only">{tr('crew.grid.repo')}</th>
                  {CREW_POSES.map(pose => <th scope="col" key={pose} className={`crew-pose crew-pose--${pose}`}>{tr(`crew.pose.${pose}`)}</th>)}
                </tr>
              </thead>
              <tbody aria-busy={loading ? 'true' : undefined}>
                {loading
                  ? [0, 1, 2].map(row => (
                    <tr key={row} aria-hidden="true"><th scope="row" className="crew-repo"><span className="skeleton-line" /></th>
                      {CREW_POSES.map(pose => <td key={pose}><span className="crew-cell crew-cell--skeleton" /></td>)}</tr>
                  ))
                  : known.map(repo => {
                    const crew = crewOf(repo)
                    const name = shown(repo.name)
                    return (
                      <tr key={repo.id}>
                        <th scope="row" className="crew-repo" title={name}><bdi>{name}</bdi></th>
                        {CREW_POSES.map(pose => (
                          <td key={pose}><span className="crew-cell">
                            <CrewAvatar seed={crew.seed} slot={crew.slot ?? undefined} hat={crew.hat} pose={pose} size="xl" label={tr('crew.avatar.a11y', { repo: name, pose: tr(`crew.pose.${pose}`) })} />
                          </span></td>
                        ))}
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
          {loading || !target ? null : (
            <div className="crew-side">
              <section className="crew-team-section" aria-labelledby="crew-team-title">
                <h2 className="settings-heading" id="crew-team-title">{tr('crew.team.title')}</h2>
                <ul className="crew-team">
                  {[['lead', crewOf(first).seed], ...TEAM.map(id => [id, `${first.name}#${id}`])].map(([id, seed]) => (
                    <li key={id} className="crew-tile">
                      <CrewAvatar seed={seed} slot={crewOf(first).slot ?? undefined} pose="running" team size="md" />
                      <span className="crew-tile-label">{id === 'lead' ? tr('crew.team.lead') : id}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <Customize repos={known} repo={target} t={t} busy={busy} onSelect={onSelect} onChange={onChange} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The `/settings/crew` route screen: the Crew sheet inside the Settings shell. `?repo=` preselects the
 * customize target; each change goes through {@link changeCrew}, and the saved toast offers Undo for
 * {@link UNDO_MS}. Browser wiring; the pure view and `changeCrew` carry the tested behaviour.
 * @param {{ route: object, search?: string, state: object, t?: Function, navigate: (to: string) => void, api?: object }} props
 */
export function CrewSheet({ search = globalThis.location?.search ?? '', state, t, navigate, api }) {
  const client = api ?? deckApi()
  const repos = state.data?.repos ?? []
  const [previews, setPreviews] = useState({})
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(false)
  let selected = null
  try { selected = new URLSearchParams(String(search ?? '')).get('repo') } catch {}
  useEffect(() => {
    if (toast?.tone !== 'success') return undefined
    const timer = setTimeout(() => setToast(current => current === toast ? null : current), UNDO_MS)
    return () => clearTimeout(timer)
  }, [toast])
  // A preview is dropped once the store's `repo.upserted` row carries the same look, so later changes show.
  useEffect(() => {
    setPreviews(map => {
      const left = Object.entries(map).filter(([id, crew]) => {
        const stored = crewOf(repos.find(repo => repo.id === id))
        return stored.seed !== crew.seed || stored.slot !== crew.slot || stored.hat !== crew.hat
      })
      return left.length === Object.keys(map).length ? map : Object.fromEntries(left)
    })
  }, [repos])
  const shownRepos = repos.map(repo => previews[repo.id] ? { ...repo, crew: { ...repo.crew, ...previews[repo.id] } } : repo)
  const known = shownRepos.filter(repo => !repo.archivedAt)
  const target = known.find(repo => (repo.repoKey ?? repo.name) === selected) ?? known[0]
  const apply = patch => {
    if (!target) return
    const id = target.id
    setBusy(true)
    changeCrew({ api: client, repo: target, patch, t, toast: setToast, setPreview: crew => setPreviews(map => ({ ...map, [id]: crew })) })
      .finally(() => setBusy(false))
  }
  const onSelect = key => navigate(`/settings/crew?${new URLSearchParams({ repo: key })}`)
  return (
    <SettingsView section="crew" prefs={state.data?.prefs ?? {}} t={t} navigate={navigate}>
      <CrewSheetView repos={shownRepos} selected={target ? target.repoKey ?? target.name : null} loading={!state.loaded} busy={busy} toast={toast} t={t}
        onSelect={onSelect} onChange={apply} onUndo={undo => { setToast(null)
          apply(undo) }} onDismiss={() => setToast(null)} />
    </SettingsView>
  )
}
