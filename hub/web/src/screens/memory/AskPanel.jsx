import React, { useEffect, useRef, useState } from 'react'
import { Citation } from '../../components/Citation.jsx'
import { titleText } from '../../components/StatusPill.jsx'
import { renderMarkdown } from '../team-run/PlanDrawer.jsx'

/** Transform only exact validated path:line references in markdown text nodes. */
export function citedMarkdown(text, citations, navigate) {
  const transform = node => {
    if (typeof node === 'string') {
      const matches = new Map(citations.map(citation => [`${citation.path}:${citation.line}`, citation]))
      const chunks = node.split(/([^\s()]+\.md:\d+)/g)
      return chunks.map((chunk, i) => matches.has(chunk) ? <Citation key={i} {...matches.get(chunk)} navigate={navigate} /> : chunk)
    }
    if (Array.isArray(node)) return node.map(transform)
    if (React.isValidElement(node) && node.props.children) return React.cloneElement(node, {}, transform(node.props.children))
    return node
  }
  return transform(renderMarkdown(text))
}
export function AskPanel({ thread, messages = [], threads = [], misses = [], asking = false, down = false, prefill = '', focusComposer = false, navigate = () => {}, onSend, onStop, onDelete, onThread }) {
  const [text, setText] = useState(prefill), [history, setHistory] = useState(false), [expanded, setExpanded] = useState({})
  const composer = useRef(null)
  useEffect(() => { setText(prefill) }, [prefill, thread?.id])
  useEffect(() => { if (focusComposer) composer.current?.focus() }, [focusComposer, thread?.id])
  const completed = messages.filter(message => message.status !== 'streaming')
  const streaming = messages.find(message => message.role === 'assistant' && message.status === 'streaming')
  const send = () => { if (text.trim() && !down && !asking) { onSend?.(text); setText('') } }
  return <aside aria-label="Ask your vault" className="memory-ask">
    <header><span className="eyebrow">Thread</span><h2><bdi>{titleText(thread?.title ?? 'Ask your vault')}</bdi></h2>
      <button onClick={() => setHistory(value => !value)} aria-expanded={history}>History</button><button onClick={() => onThread?.('new')}>New thread</button>
      {history ? <ul className="ask-history">{threads.map(row => <li key={row.id}><button onClick={() => onThread?.(row.id)}><bdi>{titleText(row.title)}</bdi> · {new Date(row.createdAt).toLocaleDateString()}</button><button aria-label={`Delete thread ${titleText(row.title)}`} onClick={() => onDelete?.(row.id)}>Delete thread</button></li>)}</ul> : null}
    </header>
    {!messages.length ? <p>Ask anything about your vault. Answers cite the note and line.</p> : null}
    <div role="log" aria-live="polite" aria-relevant="additions" className="ask-messages">
      {completed.map((message, index) => <article key={message.id} className={`ask-message ask-message--${message.role}`}>
        {message.role === 'user' ? <p><bdi lang="pt-BR">{titleText(message.text)}</bdi></p> : <>
          {message.status === 'error' ? <><p>The ask did not finish: <bdi>{titleText(message.error?.message ?? message.error ?? 'Unknown error')}</bdi>.</p><button onClick={() => setText(messages.slice(0, messages.indexOf(message)).findLast(row => row.role === 'user')?.text ?? '')}>Try again</button></> : <>
            <div className="ask-answer" lang="pt-BR">{citedMarkdown(message.text, message.citations ?? [], navigate)}</div>
            {message.generalKnowledge ? <section className="ask-general"><h3>General knowledge · not from your vault</h3><div lang="pt-BR">{renderMarkdown(message.generalKnowledge)}</div></section> : null}
            {message.unverified ? <p>Citations unavailable for this answer</p> : null}
            {message.isMiss ? <div className="ask-miss"><h3>Nothing in your vault on this.</h3><p>Logged as a miss. Want to chart it?</p><button onClick={() => {
              const question = completed[index - 1]?.text ?? ''
              const missId = message.missId ?? misses.find(miss => miss.threadId === message.threadId && miss.question === question)?.id
              navigate(`/research/new?topic=${encodeURIComponent(question)}${missId ? `&miss=${encodeURIComponent(missId)}` : ''}`)
            }}>Research this</button></div> : null}
            <div className="ask-sources">{(expanded[message.id] ? message.citations : message.citations?.slice(0, 6))?.map((citation, i) => <Citation key={i} {...citation} navigate={navigate} />)}{message.citations?.length > 6 && !expanded[message.id] ? <button onClick={() => setExpanded(value => ({ ...value, [message.id]: true }))}>+{message.citations.length - 6} sources</button> : null}</div>
            {message.status === 'cancelled' ? <p>Stopped</p> : null}
          </>}
        </>}
      </article>)}
    </div>
    {asking ? <div className="ask-stream" aria-live="off" aria-busy="true"><p>{streaming?.text ? titleText(streaming.text) : 'Searching your vault…'}</p><button onClick={onStop}>Stop</button></div> : null}
    {down ? <p>Memory is unavailable: vault-mcp is not answering.</p> : null}
    <form onSubmit={event => { event.preventDefault(); send() }}><label className="sr-only" htmlFor="vault-question">Ask your vault</label>
      <textarea ref={composer} id="vault-question" placeholder="Ask a follow-up" maxLength={4000} value={text} disabled={down || asking} autoFocus={focusComposer}
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} />
      <button aria-label="Send" disabled={down || asking || !text.trim()}>Send</button>
    </form>
  </aside>
}
