import React, { useState } from 'react'
import { exchangePassphrase, pairingMessage } from '../../state/pairing.js'

/**
 * The screen a device without a token sees (remote access). It takes the passphrase the owner set with
 * `fleetmates-deck remote-pass`, trades it for the deck token and hands it to `onPaired`. The visual design is
 * still to come; this is the working form.
 * @param {{ fetch?: typeof fetch, onPaired: (token: string) => void }} props
 */
export function Pairing({ fetch: fetcher = globalThis.fetch.bind(globalThis), onPaired }) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function submit(event) {
    event.preventDefault()
    if (busy || !passphrase) return
    setBusy(true)
    setError(null)
    const result = await exchangePassphrase({ fetch: fetcher, passphrase })
    setBusy(false)
    if (result.ok) { setPassphrase('')
      onPaired(result.token)
      return }
    setError(pairingMessage(result.code, result.retryAfterMs))
  }
  return (
    <main className="pairing" aria-labelledby="pairing-title">
      <form className="pairing-card" onSubmit={submit}>
        <h1 id="pairing-title">Pair this device</h1>
        <p>Type the remote access passphrase of your deck. This device then keeps its own copy of the deck key.</p>
        <label htmlFor="pairing-pass">Passphrase</label>
        <input id="pairing-pass" type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off"
          spellCheck="false" value={passphrase} disabled={busy} onChange={event => setPassphrase(event.target.value)} />
        {error ? <p className="pairing-error" role="alert">{error}</p> : null}
        <button type="submit" disabled={busy || !passphrase}>{busy ? 'Pairing...' : 'Pair'}</button>
      </form>
    </main>
  )
}
