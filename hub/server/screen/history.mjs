// The rendered history of an ended session (docs/deck/06-storage.md `session_scrollback`): stored text
// written into a headless terminal and serialized, so it replays as rows at any browser size.
import { ScreenModel } from '../../deckd/screen-model.mjs'

/**
 * Write `text` into a headless terminal of `cols` x `rows` (scrollback 1000) and return its serialized
 * scrollback and screen, with colours and attributes, no terminal modes and no alternate-buffer switch
 * (deckd's `ScreenModel.history()`). Serialized history replays to the same screen; legacy raw PTY bytes,
 * whose original size is unknown, come out as rows rendered at this size.
 * @param {string} text
 * @param {{ cols?: number, rows?: number }} [size]
 * @returns {Promise<string>}
 */
export async function renderHistory(text, { cols = 120, rows = 40 } = {}) {
  const model = new ScreenModel({ cols, rows })
  try {
    model.write(text)
    await model.flush()
    return model.history().data
  } finally {
    model.dispose()
  }
}
