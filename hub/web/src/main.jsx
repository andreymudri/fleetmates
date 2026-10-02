import './styles/tokens.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/observe.css'
import './styles/setup.css'
import '@xterm/xterm/css/xterm.css'
import './styles/terminal.css'
import './styles/focus.css'
import './styles/launch.css'
import './styles/compact.css'
import './styles/team.css'
import './styles/crew.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shell/App.jsx'
import { captureToken, createApiClient, createConnection, wsUrl } from './state/api.js'
import { createDeckStore } from './state/deck-store.js'
import { createSetupFeed, tapSetupChecks } from './screens/first-run/FirstRun.jsx'
import { deckScreens } from './screens/failures/Failures.jsx'
import { createTerminalClient } from './state/terminal.js'

// Components and screens never import CSS themselves (the vite runnerImport test loader cannot load it);
// every stylesheet is imported here, once.

const { token, to } = captureToken({ location: window.location, history: window.history, storage: window.sessionStorage })
if (to) window.history.replaceState(null, '', to)

const store = createDeckStore()
const feed = createSetupFeed()
const fatal = state => store.dispatch({ type: 'connection', state, attempt: 0, nextAt: null })
const api = createApiClient({ token, fetch: (url, init) => window.fetch(url, init), onFatal: fatal })
const connection = createConnection({
  token,
  url: wsUrl(window.location),
  WebSocket: window.WebSocket,
  store: tapSetupChecks(store, feed),
  storage: window.sessionStorage,
  probe: api.probe,
  reload: () => window.location.reload()
})
connection.start()

const terminals = createTerminalClient(connection)
const screens = deckScreens({ api, feed, terminals, dispatch: store.dispatch })

createRoot(document.getElementById('root')).render(<Shell store={store} connection={connection} api={api} screens={screens} />)
