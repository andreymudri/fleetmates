// Ordered cheapest to most capable. The order is load-bearing: escalateTier walks it.
export const TIERS = ['cheap', 'mid', 'capable']

const FENCE = /^\s*(?:```|~~~)/m

// `tasks` is every task in the plan, needed to count dependents. Rules are ordered and the
// first match wins, so a task that both defines an interface and looks mechanical is capable.
export function inferTier(task, tasks) {
  const dependents = tasks.filter((t) => t.deps.includes(task.id)).length
  if (dependents >= 2) return 'capable'
  if (task.files.length > 4) return 'capable'
  if (FENCE.test(task.brief ?? '') && task.files.length <= 2) return 'cheap'
  return 'mid'
}

// A model that failed a problem once is unlikely to succeed at the same tier on the same
// problem. Capped rather than wrapping: there is nothing above the top tier.
export function escalateTier(tier) {
  const index = TIERS.indexOf(tier)
  if (index < 0) throw new Error(`unknown tier: ${tier}`)
  return TIERS[Math.min(index + 1, TIERS.length - 1)]
}
