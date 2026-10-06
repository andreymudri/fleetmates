import path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { authorize, securityHeaders } from './auth.mjs'
/** Construct a stable API failure without including request content. */
export function apiError(status, code, details = {}) {
  return Object.assign(new Error(code), { status, code, details })
}
/** Serialize a REST response, preserving HEAD semantics. */
export function json(req, res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data))
}
/**
 * Read an optional JSON object body with a 256 KiB byte cap (08-security 4.1); a declared or streamed body
 * over it is 413 payload_too_large. Terminal input and pastes travel over the WebSocket, not this path.
 */
export async function readBody(req) {
  const max = 256 * 1024
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  if (!hasBody) return {}
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw apiError(415, 'unsupported_media_type')
  if (Number(req.headers['content-length'] ?? 0) > max) throw apiError(413, 'payload_too_large')
  let size = 0
  const chunks = []
  // Keep the socket alive when rejecting an oversized stream so the client receives the 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > max) throw apiError(413, 'payload_too_large')
    chunks.push(chunk)
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw apiError(422, 'validation_failed') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(422, 'validation_failed')
  return body
}
/** Route authenticated API requests and confined built SPA assets. */
export function createRouter({ api, staticDir, getToken, getPort }) {
  return async (req, res) => {
    const port = getPort()
    const isApi = /^\/api(?:\/|\?|$)/.test(req.url)
    for (const [key, value] of Object.entries(securityHeaders(port, isApi))) res.setHeader(key, value)
    try {
      const auth = authorize(req, { port, token: getToken(), api: isApi })
      if (auth) {
        if (auth.status === 421) res.setHeader('Location', `http://127.0.0.1:${port}/`)
        throw apiError(auth.status, auth.code)
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (isApi) {
        const segments = url.pathname.split('/').filter(Boolean).map(value => decodeURIComponent(value))
        const body = await readBody(req)
        const result = await api({ method: req.method === 'HEAD' ? 'GET' : req.method, segments, query: url.searchParams, body })
        json(req, res, result.status ?? 200, result.data)
        return
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw apiError(404, 'not_found')
      if (url.pathname === '/.well-known/fleetmates-deck/identity') {
        const nonce = url.searchParams.get('nonce')
        if (!/^[A-Za-z0-9_-]{32}$/.test(nonce ?? '')) throw apiError(422, 'validation_failed')
        res.setHeader('Cache-Control', 'no-store')
        json(req, res, 200, { nonce, mac: createHmac('sha256', getToken()).update(`fleetmates-deck-open:${port}:${nonce}`).digest('hex') })
        return
      }
      const root = await realpath(staticDir)
      const requested = decodeURIComponent(url.pathname)
      let file = path.resolve(root, '.' + requested)
      if (!file.startsWith(root + path.sep) && file !== root) throw apiError(404, 'not_found')
      try {
        file = await realpath(file)
        if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) file = path.join(root, 'index.html')
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
        file = path.join(root, 'index.html')
      }
      file = await realpath(file)
      if (!file.startsWith(root + path.sep)) throw apiError(404, 'not_found')
      let content = await readFile(file)
      if (path.basename(file) === 'index.html') content = Buffer.from(content.toString('utf8').replace(/(src|href)="\.\//g, '$1="/'))
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch (error) {
      // Drain rejected uploads without buffering them. Closing during the upload can reset the
      // connection before the client receives the error response.
      if (!res.headersSent) json(req, res, error.status ?? (error instanceof URIError ? 422 : error.code === 'ENOENT' ? 404 : 500), { error: { code: error.code && error.status ? error.code : error instanceof URIError ? 'validation_failed' : error.code === 'ENOENT' ? 'not_found' : 'internal', message: error.status ? error.code : 'Request failed', retryable: false, ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}) } })
      else res.end()
      req.resume()
    }
  }
}
