import React, { memo, useMemo } from 'react'

/**
 * Body colors for crew slots 0 to 8 (docs/deck/design/crew.md section 4.1, tokens `crew.slot.*`).
 * @type {readonly string[]}
 */
export const SLOT_COLORS = Object.freeze(['#ff9e64', '#f7768e', '#7aa2f7', '#73daca', '#bb9af7', '#7dcfff', '#c3e88d', '#e0c98a', '#f5a3d7'])

/** Research runs and scouts (token `crew.research`); never part of the slot pool. */
export const RESEARCH_COLOR = '#c0caf5'

const INK = '#15161e'
const TEAM_HAT = '#3cc8c8'
const SIGNAL = Object.freeze({ A: '#e0af68', G: '#8f96b8', R: '#f7768e' })

/** Pixel size per token (crew.md section 8): cell 3, 4, 5 and 8 on a 9 x 9 grid. */
export const CREW_SIZES = Object.freeze({ sm: 27, md: 36, lg: 45, xl: 72 })

const POSES = {
  starting: 'running', running: 'running', needs_approval: 'needs', asked_you: 'needs', stale: 'idle', idle: 'idle',
  done: 'done', reviewed: 'done', crashed: 'crashed', ended: 'none'
}

/**
 * Crew pose for a session state (crew.md section 6, 02-domain.md section 3). Unknown states are neutral.
 * @param {string} state
 * @returns {'running'|'needs'|'idle'|'done'|'crashed'|'none'}
 */
export function poseFor(state) {
  return POSES[state] ?? 'none'
}

/**
 * 32-bit FNV-1a over UTF-16 code units (crew.md section 2).
 * @param {string} seed
 * @returns {number} uint32
 */
export function fnv1a(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * Shape bits with unsigned shifts (crew.md section 3; the canvas used a signed shift for ears).
 * @param {number} h
 * @returns {{ wide: boolean, ears: 0|1|2, belly: boolean }}
 */
export function shapeBits(h) {
  return { wide: ((h >>> 4) & 1) === 1, ears: /** @type {0|1|2} */ ((h >>> 6) % 3), belly: ((h >>> 9) & 1) === 1 }
}

/**
 * Interpolate two `#rrggbb` colors per 8-bit channel (crew.md section 4.4).
 * @param {string} hex
 * @param {string} to
 * @param {number} t
 * @returns {string} lowercase `#rrggbb`
 */
export function mix(hex, to, t) {
  const a = parseInt(hex.slice(1), 16)
  const b = parseInt(to.slice(1), 16)
  const channel = shift => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return '#' + ((1 << 24) + (channel(16) << 16) + (channel(8) << 8) + channel(0)).toString(16).slice(1)
}

const shade = body => Object.freeze({ light: mix(body, '#ffffff', 0.35), dark: mix(body, '#000000', 0.35) })

/**
 * Light and dark shades for every slot and the research color, computed once at module load.
 * @type {Readonly<Record<string, Readonly<{ light: string, dark: string }>>>}
 */
export const SHADES = Object.freeze(Object.fromEntries([...SLOT_COLORS, RESEARCH_COLOR].map(body => [body, shade(body)])))

const extraShades = new Map()
function shadesOf(body) {
  if (SHADES[body]) return SHADES[body]
  if (!extraShades.has(body)) extraShades.set(body, shade(body))
  return extraShades.get(body)
}

const TEAMMATE_STEPS = [['#ffffff', 0.25], ['#000000', 0.12], ['#ffffff', 0.45], ['#000000', 0.24]]

/**
 * Body color for teammate number k (1-based, task order) of a run led by `body` (crew.md section 5).
 * @param {string} body
 * @param {number} k
 * @returns {string}
 */
export function teammateColor(body, k) {
  const [to, t] = TEAMMATE_STEPS[(k - 1) % TEAMMATE_STEPS.length]
  return mix(body, to, t)
}

/**
 * Paint the 9 x 9 letter grid for a seed, pose and hat (crew.md section 6.1).
 * Letters: B body, L light, D dark, I ink, H hat, A amber, G grey, R red, `.` empty.
 * @param {string} seed
 * @param {string} pose
 * @param {'none'|'cap'|'bandana'} [hat]
 * @returns {string[][]}
 */
export function paint(seed, pose, hat = 'none') {
  const { wide, ears, belly } = shapeBits(fnv1a(seed))
  const grid = Array.from({ length: 9 }, () => Array(9).fill('.'))
  const set = (x, y, c) => { grid[y][x] = c }
  for (let x = 2; x <= 6; x++) set(x, 1, 'B')
  for (let y = 2; y <= 3; y++) for (let x = wide ? 1 : 2; x <= (wide ? 7 : 6); x++) set(x, y, 'B')
  for (let x = 2; x <= 6; x++) { set(x, 4, 'B')
    set(x, 5, 'B') }
  for (let x = 3; x <= 5; x++) set(x, 6, 'B')
  set(3, 7, 'D')
  set(5, 7, 'D')
  if (belly) { set(4, 4, 'L')
    set(4, 5, 'L') }
  if (hat === 'cap') {
    for (let x = 2; x <= 6; x++) set(x, 0, 'H')
    set(wide ? 1 : 2, 1, 'H')
    set(wide ? 7 : 6, 1, 'H')
  } else {
    if (ears === 1) set(4, 0, 'L')
    else if (ears === 2) { set(2, 0, 'B')
      set(6, 0, 'B') }
    if (hat === 'bandana') {
      for (let x = 2; x <= 6; x++) set(x, 1, 'H')
      set(7, 1, 'H')
      set(8, 2, 'H')
    }
  }
  const eye = pose === 'idle' ? 'D' : pose === 'crashed' ? 'R' : 'I'
  set(3, 2, eye)
  set(5, 2, eye)
  if (pose === 'idle') { set(8, 0, 'G')
    set(7, 1, 'G') }
  if (pose === 'done') for (let x = 3; x <= 5; x++) set(x, 3, 'I')
  else set(4, 3, 'D')
  const paintAll = cells => { for (const [x, y, c] of cells) set(x, y, c) }
  if (pose === 'running') paintAll([[1, 5, 'B'], [0, 5, 'D'], [7, 5, 'B'], [8, 5, 'D']])
  else if (pose === 'needs') paintAll([[1, 5, 'B'], [7, 4, 'B'], [8, 3, 'B'], [8, 2, 'L'], [8, 1, 'L'], [0, 0, 'A'], [0, 1, 'A']])
  else if (pose === 'done') paintAll([[1, 4, 'B'], [0, 3, 'B'], [0, 2, 'L'], [7, 4, 'B'], [8, 3, 'B'], [8, 2, 'L']])
  else if (pose === 'crashed') paintAll([[1, 6, 'D'], [7, 6, 'D']])
  else paintAll([[1, 5, 'B'], [7, 5, 'B']])
  return grid
}

/**
 * Merge each row's horizontal runs of one letter into rects (crew.md section 9).
 * @param {string[][]} grid
 * @returns {{ x: number, y: number, w: number, c: string }[]}
 */
export function runs(grid) {
  const out = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]
      let w = 1
      while (x + w < row.length && row[x + w] === c) w++
      if (c !== '.') out.push({ x, y, w, c })
      x += w
    }
  })
  return out
}

/**
 * Resolve the body color: explicit color, else the slot, else the shared-slot rule `h % 9` (crew.md 4.3).
 * @param {{ seed: string, slot?: number | null, color?: string | null }} crew
 * @returns {string}
 */
export function crewColor({ seed, slot, color }) {
  if (color) return color
  if (Number.isInteger(slot) && SLOT_COLORS[slot]) return SLOT_COLORS[slot]
  return SLOT_COLORS[fnv1a(String(seed ?? '')) % SLOT_COLORS.length]
}

/**
 * The pixel crew member as one inline SVG. Decorative (`aria-hidden`) unless `label` is set, and never animated.
 * @param {{ seed: string, slot?: number, color?: string, pose?: string, hat?: 'none'|'cap'|'bandana', team?: boolean, hatColor?: string, size?: 'sm'|'md'|'lg'|'xl', label?: string }} props
 */
export const CrewAvatar = memo(function CrewAvatar({ seed, slot, color, pose = 'none', hat = 'none', team = false, hatColor, size = 'sm', label }) {
  const body = crewColor({ seed, slot, color })
  const wornHat = team ? 'cap' : hat
  const rects = useMemo(() => {
    const { light, dark } = shadesOf(body)
    const fills = { B: body, L: light, D: dark, I: INK, H: hatColor ?? (team ? TEAM_HAT : dark), ...SIGNAL }
    return runs(paint(String(seed ?? ''), pose, wornHat)).map(run => ({ ...run, fill: fills[run.c] }))
  }, [seed, body, pose, wornHat, team, hatColor])
  const px = CREW_SIZES[size] ?? CREW_SIZES.sm
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }
  return (
    <svg className={`crew-avatar crew-avatar--${size}`} width={px} height={px} viewBox="0 0 9 9" shapeRendering="crispEdges" {...a11y} focusable="false">
      {rects.map(run => <rect key={`${run.x},${run.y}`} x={run.x} y={run.y} width={run.w} height={1} fill={run.fill} />)}
    </svg>
  )
})
