// Spike only; deleted at M1.
// Plain browser script, no bundler: index.html loads xterm.js and the fit
// addon as UMD globals. The page query (?pty=<id> or ?spawn=1&cwd=<dir>) is
// passed through to the /ws WebSocket, with the per-launch token from
// #token=<t> offered as the WebSocket subprotocol. The token moves to
// sessionStorage and leaves the address bar. With ?spawn=1 nothing connects
// until the Start button is clicked, so loading the URL alone spawns nothing.
/* global Terminal, FitAddon */
(function () {
  const hash = new URLSearchParams(location.hash.slice(1))
  if (hash.get('token')) {
    sessionStorage.setItem('spikeToken', hash.get('token'))
    history.replaceState(null, '', location.pathname + location.search)
  }
  const token = sessionStorage.getItem('spikeToken')

  const term = new Terminal({ scrollback: 5000 })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('term'))
  fit.fit()

  const status = document.getElementById('status')
  const start = document.getElementById('start')
  const params = new URLSearchParams(location.search)

  /** @param {{ kind: string, name?: string } | null} from */
  const showFrom = (from) => {
    status.textContent = `lastInputFrom: ${from ? from.kind + (from.name ? ' (' + from.name + ')' : '') : 'none'}`
  }

  /** @param {string} b64 */
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  const connect = () => {
    const spawning = params.get('spawn') === '1'
    if (spawning) {
      params.set('cols', String(term.cols))
      params.set('rows', String(term.rows))
    }
    const ws = new WebSocket(`ws://${location.host}/ws?${params}`, [token])
    const send = (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const sendSize = () => send({ t: 'resize', cols: term.cols, rows: term.rows })

    ws.addEventListener('open', sendSize)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.t === 'pty') {
        showFrom(msg.lastInputFrom)
        if (spawning) history.replaceState(null, '', `/?pty=${encodeURIComponent(msg.ptyId)}`)
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
  }

  if (!token) {
    status.textContent = 'no token: open the URL the spike server printed (http://127.0.0.1:<port>/#token=...)'
  } else if (params.get('spawn') === '1') {
    start.textContent = `Start claude in ${params.get('cwd') || '(no cwd)'}`
    start.hidden = false
    start.addEventListener('click', () => {
      start.hidden = true
      connect()
    }, { once: true })
  } else {
    connect()
  }
})()
