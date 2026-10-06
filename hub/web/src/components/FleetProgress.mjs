import React from 'react'
import { validateDiagram } from '../../../../scripts/diagram.mjs'
const h = React.createElement
const NEXT = {
  running: ['Continue the current task', 'Continue a tarefa atual'], starting: ['Wait for the session to start', 'Aguarde a sessão iniciar'],
  needs_approval: ['Review the request', 'Revise a solicitação'], asked_you: ['Answer the question', 'Responda à pergunta'],
  done: ['Review the changes', 'Revise as alterações'], reviewed: ['Choose the next task', 'Escolha a próxima tarefa'],
  crashed: ['Inspect the crash', 'Investigue a falha'], stale: ['Inspect the stalled session', 'Inspecione a sessão parada'],
  idle: ['Start the next task', 'Inicie a próxima tarefa'], ended: ['Review the session history', 'Revise o histórico da sessão'],
}
export function reportShape(session, steps = [], lang = 'en') {
  const pt = lang === 'pt', next = (NEXT[session.state] ?? ['Inspect the session', 'Inspecione a sessão'])[pt ? 1 : 0]
  const count = Array.isArray(steps) ? steps.length : 0
  const done = Array.isArray(steps) ? steps.filter(step => step.status === 'done' || step.status === 'completed').length : 0
  const state = Object.hasOwn(NEXT, session.state) ? session.state : 'unknown'
  return pt ? `Próximo: ${next}. Etapa ${count ? done : '?'} de ${count || '?'} concluída: ${done} etapas registradas. Estado: ${state}.`
    : `Next: ${next}. Step ${count ? done : '?'} of ${count || '?'} done: ${done} recorded steps. Current: ${state}.`
}
export function FleetReport({ session, steps, lang }) {
  return h('p', { className: 'fleet-report' }, reportShape(session, steps, lang))
}

export function ExtensionScanNotice({ request, lang = 'en' }) {
  const report = request.reasons?.find(reason => reason.entryId === 'extension.scan')
  if (!report) return null
  const count = (report.scans ?? []).reduce((n, scan) => n + (scan.findings?.length ?? 0), 0)
  const checked = (report.scans ?? []).every(scan => scan.state === 'scanned') && !!report.scans?.length
  return h('p', { className: 'extension-scan-notice', role: 'status' }, lang === 'pt'
    ? `Próximo: revise a extensão. Scan ${checked ? 'concluído' : 'não verificado'}: ${count} alertas. Código executável precisa de revisão.`
    : `Next: review the extension. Scan ${checked ? 'completed' : 'unverified'}: ${count} findings. Executable code needs review.`)
}

export function NativeDiagram({ diagram, lang = 'en' }) {
  let data
  try { data = validateDiagram(diagram) } catch { return h('p', null, lang === 'pt' ? 'Diagrama indisponível.' : 'Diagram unavailable.') }
  const lanes = [...new Set(data.nodes.map(node => node.lane))].sort((a, b) => a - b)
  const positions = new Map()
  const counts = new Map()
  for (const node of data.nodes) {
    const row = counts.get(node.lane) ?? 0; counts.set(node.lane, row + 1)
    positions.set(node.id, { x: 30 + lanes.indexOf(node.lane) * 180, y: 30 + row * 70 })
  }
  const width = Math.max(200, lanes.length * 180), height = Math.max(100, Math.max(0, ...counts.values()) * 70 + 40)
  return h('div', { className: 'fleet-diagram' }, h('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': lang === 'pt' ? 'Etapas e dependências' : 'Phases and dependencies' },
    h('g', { className: 'fleet-diagram-edges' }, ...data.edges.map((edge, i) => {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      return h('line', { key: i, x1: from.x + 130, y1: from.y + 20, x2: to.x, y2: to.y + 20, stroke: 'currentColor' })
    })),
    ...data.nodes.map(node => {
      const at = positions.get(node.id)
      return h('g', { key: node.id, transform: `translate(${at.x} ${at.y})`, className: `fleet-node fleet-node--${node.state}` },
        h('title', null, `${node.label}: ${node.state}`), h('rect', { width: 130, height: 44, rx: 6, fill: 'var(--bg-raised)', stroke: 'currentColor' }),
        h('text', { x: 8, y: 17, fill: 'currentColor' }, node.label), h('text', { x: 8, y: 34, fill: 'currentColor', fontSize: 11 }, node.state))
    })))
}

const EVENTS = {
  'task-started': ['Task started', 'Tarefa iniciada'], 'command-run': ['Command ran', 'Comando executado'],
  'gate-result': ['Gate result', 'Resultado do gate'], handoff: ['Handoff', 'Entrega'], 'stop-requested': ['Stop requested', 'Parada solicitada'], 'stall-block': ['Stall detected', 'Travamento detectado'], 'hook-fired': ['Hook observed', 'Hook observado'],
}
export function LedgerTimeline({ timeline, lang = 'en' }) {
  if (!timeline) return null
  const pt = lang === 'pt'
  const phase = Number.isInteger(timeline.phase) ? `${timeline.phase}/${timeline.totalPhases ?? '?'}` : '?'
  return h('section', { className: 'fleet-ledger-timeline', 'aria-label': pt ? 'Linha do tempo da sessão' : 'Session timeline' },
    h('h2', null, pt ? 'Linha do tempo' : 'Timeline'),
    h('p', null, `${pt ? 'Etapa atual' : 'Current phase'}: ${phase}${timeline.phaseVerified ? '' : pt ? ' (não verificada)' : ' (unverified)'}. ${pt ? 'Eventos observados; o gate decide a conclusão.' : 'Observed events; the gate decides completion.'}`),
    timeline.unavailable?.length || timeline.truncated ? h('p', { role: 'status' }, pt ? 'Histórico parcial ou indisponível.' : 'History is partial or unavailable.') : null,
    h('ol', null, ...(timeline.events ?? []).slice(-200).map(event => {
      const date = new Date(event.at), valid = Number.isFinite(date.getTime())
      return h('li', { key: event.id }, h('time', { dateTime: valid ? date.toISOString() : undefined }, valid ? date.toLocaleTimeString(pt ? 'pt' : 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '?'),
        ` ${event.task}: ${(EVENTS[event.kind] ?? ['Unknown event', 'Evento desconhecido'])[pt ? 1 : 0]}${event.result ? ` (${event.result})` : ''}`)
    })),
    !timeline.events?.length ? h('p', null, pt ? 'Nenhum evento registrado.' : 'No recorded events.') : null)
}
