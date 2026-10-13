import type { MetricKey, Metrics, Objective } from '../schemas/results'
import { METRIC_KEY_VALUES } from '../schemas/results'

export type FlatMetrics = Record<MetricKey, number>

export function flattenMetrics(metrics: Metrics): FlatMetrics {
  return {
    'luma.mean': metrics.luma.mean,
    'luma.p1': metrics.luma.p1,
    'luma.p50': metrics.luma.p50,
    'luma.p99': metrics.luma.p99,
    'luma.clipped_highlight_ratio': metrics.luma.clipped_highlight_ratio,
    'luma.clipped_shadow_ratio': metrics.luma.clipped_shadow_ratio,
    'chroma.mean_saturation': metrics.chroma.mean_saturation,
    'chroma.colorfulness': metrics.chroma.colorfulness,
  }
}

export type MetricDelta = { baseline: number; value: number; delta: number }
export type MetricComparison = Record<MetricKey, MetricDelta>

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function compareMetrics(
  baseline: Metrics,
  candidate: Metrics,
): MetricComparison {
  const base = flattenMetrics(baseline)
  const flat = flattenMetrics(candidate)
  const comparison = {} as MetricComparison
  for (const key of METRIC_KEY_VALUES) {
    comparison[key] = {
      baseline: base[key],
      value: flat[key],
      delta: round(flat[key] - base[key]),
    }
  }
  return comparison
}

export type TermScore = {
  key: MetricKey
  value: number
  penalty: number
  weight: number
}

export type CandidateScore = {
  candidate_id: string
  score: number
  terms: TermScore[]
}

export function scoreCandidate(
  metrics: Metrics,
  objective: Objective,
): { score: number; terms: TermScore[] } {
  const flat = flattenMetrics(metrics)
  const terms: TermScore[] = []
  let score = 0
  for (const key of METRIC_KEY_VALUES) {
    const term = objective[key]
    if (!term) continue
    const value = flat[key]
    const { weight } = term
    let distance = 0
    if (term.target !== undefined) {
      distance = Math.abs(value - term.target)
    } else {
      if (term.min !== undefined && value < term.min)
        distance = term.min - value
      if (term.max !== undefined && value > term.max)
        distance = value - term.max
    }
    const penalty = round(weight * distance)
    score += penalty
    terms.push({ key, value, penalty, weight })
  }
  return { score: round(score), terms }
}

/** Locale-independent ordering so ranks are identical on every machine. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Sorted best-first; ties break on candidate id so the order is reproducible. */
export function rankCandidates(
  candidates: ReadonlyArray<{ id: string; metrics: Metrics }>,
  objective: Objective,
): CandidateScore[] {
  return candidates
    .map((candidate) => ({
      candidate_id: candidate.id,
      ...scoreCandidate(candidate.metrics, objective),
    }))
    .sort(
      (a, b) => a.score - b.score || compareIds(a.candidate_id, b.candidate_id),
    )
}
