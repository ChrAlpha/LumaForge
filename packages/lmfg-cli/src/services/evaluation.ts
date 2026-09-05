import { LmfgError } from '../protocol/errors'
import type { Metrics } from '../schemas/results'

/** Scalar metric keys an objective or comparison can address. */
export const METRIC_KEYS = [
  'luma.mean',
  'luma.p1',
  'luma.p50',
  'luma.p99',
  'luma.clipped_highlight_ratio',
  'luma.clipped_shadow_ratio',
  'chroma.mean_saturation',
  'chroma.colorfulness',
] as const

export type MetricKey = (typeof METRIC_KEYS)[number]
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
  for (const key of METRIC_KEYS) {
    comparison[key] = {
      baseline: base[key],
      value: flat[key],
      delta: round(flat[key] - base[key]),
    }
  }
  return comparison
}

/**
 * One objective term: aim for `target`, or stay inside `[min, max]`. The
 * penalty is `weight` times the distance from the target or the distance
 * outside the range; lower total scores rank first.
 */
export type ObjectiveTerm = {
  target?: number
  min?: number
  max?: number
  weight?: number
}

export type Objective = Partial<Record<MetricKey, ObjectiveTerm>>

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

export function validateObjective(input: unknown): Objective {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LmfgError('args.invalid', {
      message: 'An objective must be a JSON object keyed by metric name.',
      suggestedNextActions: ['lmfg schema show lmfg.objective.v1'],
    })
  }
  const objective: Objective = {}
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) {
    throw new LmfgError('args.invalid', {
      message: 'An objective needs at least one metric term.',
      suggestedNextActions: ['lmfg schema show lmfg.objective.v1'],
    })
  }
  for (const [key, raw] of entries) {
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      throw new LmfgError('args.invalid', {
        message: `Unknown objective metric "${key}". Known metrics: ${METRIC_KEYS.join(', ')}.`,
      })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new LmfgError('args.invalid', {
        message: `Objective term "${key}" must be an object with target, min, max, or weight.`,
      })
    }
    const term = raw as Record<string, unknown>
    for (const field of ['target', 'min', 'max', 'weight']) {
      const value = term[field]
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw new LmfgError('args.invalid', {
          message: `Objective term "${key}.${field}" must be a finite number.`,
        })
      }
    }
    const weight = (term.weight as number | undefined) ?? 1
    if (weight < 0) {
      throw new LmfgError('args.invalid', {
        message: `Objective term "${key}.weight" must not be negative.`,
      })
    }
    const hasTarget = term.target !== undefined
    const hasRange = term.min !== undefined || term.max !== undefined
    if (hasTarget === hasRange) {
      throw new LmfgError('args.invalid', {
        message: `Objective term "${key}" needs either a target or a min/max range.`,
      })
    }
    if (
      term.min !== undefined &&
      term.max !== undefined &&
      (term.min as number) > (term.max as number)
    ) {
      throw new LmfgError('args.invalid', {
        message: `Objective term "${key}" has min greater than max.`,
      })
    }
    objective[key as MetricKey] = {
      ...(hasTarget ? { target: term.target as number } : {}),
      ...(term.min !== undefined ? { min: term.min as number } : {}),
      ...(term.max !== undefined ? { max: term.max as number } : {}),
      weight,
    }
  }
  return objective
}

export function scoreCandidate(
  metrics: Metrics,
  objective: Objective,
): { score: number; terms: TermScore[] } {
  const flat = flattenMetrics(metrics)
  const terms: TermScore[] = []
  let score = 0
  for (const key of METRIC_KEYS) {
    const term = objective[key]
    if (!term) continue
    const value = flat[key]
    const weight = term.weight ?? 1
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
