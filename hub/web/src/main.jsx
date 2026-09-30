import './styles/tokens.css'
import './styles/shell.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shell/App.jsx'
import { captureToken, createApiClient, createConnection, wsUrl } from './state/api.js'
import { createDeckStore } from './state/deck-store.js'

const { token, to } = captureToken({ location: window.location, history: window.history, storage: window.sessionStorage })
if (to) window.history.replaceState(null, '', to)

const store = createDeckStore()
const fatal = state => store.dispatch({ type: 'connection', state, attempt: 0, nextAt: null })
const api = createApiClient({ token, fetch: (url, init) => window.fetch(url, init), onFatal: fatal })
const connection = createConnection({
  token,
  url: wsUrl(window.location),
  WebSocket: window.WebSocket,
  store,
  storage: window.sessionStorage,
  probe: api.probe,
  reload: () => window.location.reload()
})
connection.start()

createRoot(document.getElementById('root')).render(<Shell store={store} connection={connection} api={api} />)
