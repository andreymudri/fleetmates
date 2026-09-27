// Spike only; deleted at M1.
// Plain browser script, no bundler: index.html loads xterm.js and the fit
// addon as UMD globals. The page query (?pty=<id> or ?spawn=1&cwd=<path>)
// is passed through to the /ws WebSocket.
/* global Terminal, FitAddon */
(function () {
  const term = new Terminal({ scrollback: 5000 })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('term'))
  fit.fit()

  const status = document.getElementById('status')
  const params = new URLSearchParams(location.search)
  if (params.get('spawn') === '1') {
    params.set('cols', String(term.cols))
    params.set('rows', String(term.rows))
  }
  const ws = new WebSocket(`ws://${location.host}/ws?${params}`)

  const send = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }
  const sendSize = () => send({ t: 'resize', cols: term.cols, rows: term.rows })

  /** @param {string} b64 */
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  /** @param {{ kind: string, name?: string } | null} from */
  const showFrom = (from) => {
    status.textContent = `lastInputFrom: ${from ? from.kind + (from.name ? ' (' + from.name + ')' : '') : 'none'}`
  }

  ws.addEventListener('open', sendSize)
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.t === 'pty') {
      showFrom(msg.lastInputFrom)
      if (params.get('spawn') === '1') history.replaceState(null, '', `/?pty=${encodeURIComponent(msg.ptyId)}`)
    } else if (msg.t === 'replay') {
      term.reset()
      term.write(bytes(msg.data))
    } else if (msg.t === 'out') {
      term.write(bytes(msg.data))
    } else if (msg.t === 'status') {
      showFrom(msg.lastInputFrom)
    } else if (msg.t === 'exit') {
      status.textContent += ` | exited ${msg.code}${msg.signal ? ' ' + msg.signal : ''}`
    } else if (msg.t === 'error') {
      status.textContent = `error: ${msg.message}`
    }
  })
  ws.addEventListener('close', () => { status.textContent += ' | disconnected' })

  term.onData((data) => send({ t: 'in', data }))
  window.addEventListener('resize', () => {
    fit.fit()
    sendSize()
  })
})()
