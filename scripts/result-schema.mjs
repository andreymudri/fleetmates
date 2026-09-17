// The teammate result contract. One definition so the Workflow template and the headless
// driver validate identical shapes; the driver's adapter also hands this to codex via
// --output-schema, which refuses a schema object that does not set additionalProperties.
export const RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'branch', 'filesChanged', 'summary', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    branch: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
}

// A hand-rolled check of RESULT_SCHEMA for harnesses with no schema-enforced output (Cursor).
// Kept next to the schema so the two cannot drift; covers exactly the keywords RESULT_SCHEMA uses.
export function validateResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const props = RESULT_SCHEMA.properties
  for (const key of Object.keys(value)) if (!Object.hasOwn(props, key)) return false
  for (const key of RESULT_SCHEMA.required) if (!Object.hasOwn(value, key)) return false
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(value, key)) continue
    const v = value[key]
    if (spec.type === 'string') {
      if (typeof v !== 'string') return false
      if (spec.enum && !spec.enum.includes(v)) return false
    } else if (spec.type === 'array') {
      if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) return false
    }
  }
  return true
}
