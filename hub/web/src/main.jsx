import './styles/research.css'
import './styles/tokens.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/observe.css'
import './styles/answers.css'
import './styles/setup.css'
import '@xterm/xterm/css/xterm.css'
import './styles/terminal.css'
import './styles/focus.css'
import './styles/launch.css'
import './styles/compact.css'
import './styles/team.css'
import './styles/crew.css'
import './styles/meetings.css'
import './styles/meeting-live.css'
import './styles/memory.css'
import './styles/memory-graph.css'
import './styles/memory-ask.css'
import './styles/memory-lists.css'
import './styles/unlock.css'
import './styles/mobile.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shell/App.jsx'
import { captureToken, createApiClient, createConnection, wsUrl } from './state/api.js'
import { createDeckStore } from './state/deck-store.js'
import { createSetupFeed, tapSetupChecks } from './screens/first-run/FirstRun.jsx'
import { deckScreens } from './screens/failures/Failures.jsx'
import { createTerminalClient } from './state/terminal.js'
import { Unlock } from './screens/unlock/Unlock.jsx'
import { TOKEN_KEY } from './state/api.js'
import { forgetRejectedToken, pairable } from './state/unlock.js'

// Components and screens never import CSS themselves (the vite runnerImport test loader cannot load it);
// each deck stylesheet is imported here, once. xterm's stylesheet is the exception: it is imported here and also
// `@import`ed by terminal.css, and the production build carries its rules once.

// Remote access is the only reason this device keeps a token past the tab: on a local deck the token stays in
// sessionStorage, as it always has, so a loopback tab does not turn a tab-lifetime secret into a stored one.
const remote = pairable(window.location)
const durable = remote || window.matchMedia?.('(display-mode: standalone)')?.matches ? window.localStorage : null
const { token, to } = captureToken({ location: window.location, history: window.history, storage: window.sessionStorage, durable })
if (to) window.history.replaceState(null, '', to)
// The installed PWA shell: a service worker at the root, with scope '/', that caches the static shell only. It is
// registered after load so it never competes with the first paint, and only over HTTPS: `isSecureContext` is true
// on loopback too, and a local deck has no use for a worker.
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}) })
}

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
// A rotated token sends a paired phone back to Unlock rather than to a fatal screen it cannot act on.
const stopForgetting = store.subscribe(() => {
  if (forgetRejectedToken({ remote, state: store.getState().connection.state, storages: [window.sessionStorage, window.localStorage],
    key: TOKEN_KEY, reload: () => window.location.replace('/') })) stopForgetting()
})

const terminals = createTerminalClient(connection)
const screens = deckScreens({ api, feed, terminals, dispatch: store.dispatch })

// A device with no token (an installed PWA opens at its start_url, with no `#token=` fragment) unlocks first:
// the passphrase is traded for the deck token, which is stored durably, and the app then starts normally. The
// reload replaces the entry, so the browser back button never lands on an Unlock screen that is now pointless.
const unlocked = nextToken => {
  window.sessionStorage.setItem(TOKEN_KEY, nextToken)
  window.localStorage.setItem(TOKEN_KEY, nextToken)
  window.location.replace('/')
}
createRoot(document.getElementById('root')).render(token || !remote
  ? <Shell store={store} connection={connection} api={api} screens={screens} />
  : <Unlock onUnlocked={unlocked} />)
