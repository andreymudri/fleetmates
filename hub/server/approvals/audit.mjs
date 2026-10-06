// The approvals audit trail (docs/deck/07-approvals.md section 11): append-only `approval_audit` rows
// for request decisions and tiers loads. Rule events go to `rule_audit` (approvals/rules.mjs).
// `summary` is stored redacted with the log redaction rules of docs/deck/08-security.md 4.10.
import { activeTiers, tiersSha256 } from './tiers.mjs'

/** Kinds `record` writes. Rule kinds live in `rule_audit`. */
export const AUDIT_KINDS = Object.freeze(['answered', 'refused', 'did_not_land', 'expired', 'tiers_loaded', 'tiers_rejected'])
/** Kinds about one request: retention drops them after 30 days (07-approvals 11, APR-O8 default). */
export const REQUEST_AUDIT_KINDS = Object.freeze(['answered', 'refused', 'did_not_land', 'expired'])

const VIAS = ['browser', 'terminal', 'popup', 'batch', 'settings']
const TIERS = ['safe', 'caution', 'destructive']
const MASK = '***'

/**
 * Whether a run of base64 or hex characters looks like a secret: over 40 characters, with a letter
 * and a digit, and (when it holds `/`) a slash-free stretch of at least 20 characters, so an
 * ordinary long path such as `/home/you/project/src/components/index.js` is kept.
 * @param {string} run
 */
function secretRun (run) {
  if (run.length <= 40 || !/[A-Za-z]/.test(run) || !/\d/.test(run)) return false
  return !run.includes('/') || run.split('/').some((part) => part.length >= 20)
}

/**
 * Redact text with the 08-security 4.10 rules: URL userinfo, `Bearer` credentials, the credentials of
 * any other `Authorization:` scheme (`Basic …`),
 * `password|passwd|pwd|secret|token|api_key|access_key` followed by `=` or `:` and a value, the known
 * token shapes (`ghp_`, `github_pat_`, `sk-`, `sk-ant-`, `xoxb-`, `xoxp-`, `AKIA`, `hf_`, JWTs) and
 * long base64 or hex runs. Each secret becomes `***`.
 * @param {unknown} text
 * @returns {string | null} null for null or undefined
 */
export function redact (text) {
  if (text === null || text === undefined) return null
  return String(text)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/\b(Authorization\s*:\s*)(?!Bearer\b)([A-Za-z]+)\s+[A-Za-z0-9._~+/=-]+/gi, `$1$2 ${MASK}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)/gi, `$1$2${MASK}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK)
    .replace(/\b(?:ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|xox[bp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{16,})/g, MASK)
    .replace(/[A-Za-z0-9+/=_-]{41,}/g, (run) => secretRun(run) ? MASK : run)
}

/** @param {unknown} reasons */
function reasonIds (reasons) {
  let list = reasons
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { list = [] }
  }
  if (!Array.isArray(list)) return []
  return list.map((item) => typeof item === 'string' ? item : item?.entryId).filter((id) => typeof id === 'string')
}

/**
 * @typedef {{ kind: string, at?: number, requestId?: string | null, sessionId?: string | null, repoId?: string | null,
 *   tier?: string | null, reasons?: unknown, via?: string | null, choice?: string | null, code?: string | null,
 *   optionLabel?: string | null, confirmLabel?: string | null, summary?: string | null, tiersSha256?: string | null }} AuditEvent
 */

/**
 * Append one `approval_audit` row. `summary` is redacted before it is stored. `reasons` may be the
 * classifier's reason objects or entry ids; only the ids are stored. For `refused`, the table has no
 * error column, so the error code (`code`) is stored in `choice`. `tiersSha256` defaults to the
 * active tiers set. An unknown kind, via or tier throws.
 * @param {{ run: Function }} store
 * @param {AuditEvent} event
 * @returns {number} the row id
 */
export function record (store, event) {
  const { kind, at = Date.now() } = event
  if (!AUDIT_KINDS.includes(kind)) throw new TypeError(`unknown audit kind ${kind}`)
  const via = event.via ?? null
  if (via !== null && !VIAS.includes(via)) throw new TypeError(`unknown audit via ${via}`)
  const tier = event.tier ?? null
  if (tier !== null && !TIERS.includes(tier)) throw new TypeError(`unknown audit tier ${tier}`)
  const choice = kind === 'refused' ? event.code ?? event.choice ?? null : event.choice ?? null
  const sha = event.tiersSha256 === undefined ? tiersSha256(activeTiers()) : event.tiersSha256
  const result = store.run('INSERT INTO approval_audit(at, kind, request_id, session_id, repo_id, tier, reasons, via, choice, option_label, confirm_label, summary, tiers_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    at, kind, event.requestId ?? null, event.sessionId ?? null, event.repoId ?? null, tier, JSON.stringify(reasonIds(event.reasons)), via, choice,
    event.optionLabel ?? null, event.confirmLabel ?? null, redact(event.summary), sha)
  return Number(result.lastInsertRowid)
}
