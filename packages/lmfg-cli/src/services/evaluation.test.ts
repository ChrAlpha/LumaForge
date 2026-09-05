import { describe, expect, it } from 'vitest'

import type { Metrics } from '../schemas/results'
import {
  compareMetrics,
  flattenMetrics,
  rankCandidates,
  scoreCandidate,
  validateObjective,
} from './evaluation'

function metrics(
  overrides: Partial<Metrics['luma']> = {},
  chroma?: Partial<Metrics['chroma']>,
): Metrics {
  return {
    schema: 'lmfg.metrics.v1',
    width: 4,
    height: 2,
    sampled_pixels: 8,
    luma: {
      mean: 0.4,
      p1: 0.02,
      p50: 0.38,
      p99: 0.95,
      clipped_highlight_ratio: 0.01,
      clipped_shadow_ratio: 0.002,
      ...overrides,
    },
    chroma: { mean_saturation: 0.3, colorfulness: 40, ...chroma },
    histogram: { bins: 2, luma: [4, 4] },
    approximate: false,
  }
}

describe('flattenMetrics / compareMetrics', () => {
  it('flattens every scalar and reports signed deltas', () => {
    const flat = flattenMetrics(metrics())
    expect(Object.keys(flat)).toHaveLength(8)
    const comparison = compareMetrics(
      metrics(),
      metrics({ mean: 0.45 }, { colorfulness: 38 }),
    )
    expect(comparison['luma.mean']).toEqual({
      baseline: 0.4,
      value: 0.45,
      delta: 0.05,
    })
    expect(comparison['chroma.colorfulness'].delta).toBe(-2)
    expect(comparison['luma.p99'].delta).toBe(0)
  })
})

describe('validateObjective', () => {
  it('accepts target and range terms with default weights', () => {
    expect(
      validateObjective({
        'luma.mean': { target: 0.45 },
        'luma.clipped_highlight_ratio': { max: 0.01, weight: 5 },
      }),
    ).toEqual({
      'luma.mean': { target: 0.45, weight: 1 },
      'luma.clipped_highlight_ratio': { max: 0.01, weight: 5 },
    })
  })

  it('rejects unknown metrics, mixed terms, bad numbers, and empty objectives', () => {
    for (const bad of [
      {},
      [],
      null,
      { 'luma.nope': { target: 1 } },
      { 'luma.mean': { target: 1, min: 0 } },
      { 'luma.mean': {} },
      { 'luma.mean': { target: 'x' } },
      { 'luma.mean': { min: 1, max: 0 } },
      { 'luma.mean': { target: 1, weight: -1 } },
    ]) {
      expect(() => validateObjective(bad)).toThrow(
        expect.objectContaining({ code: 'args.invalid', exitCode: 2 }),
      )
    }
  })
})

describe('scoreCandidate / rankCandidates', () => {
  const objective = validateObjective({
    'luma.mean': { target: 0.45, weight: 2 },
    'luma.clipped_highlight_ratio': { max: 0.01 },
    'luma.p1': { min: 0.01 },
  })

  it('penalises distance from targets and distance outside ranges only', () => {
    const inside = scoreCandidate(metrics(), objective)
    expect(inside.score).toBe(0.1)
    expect(inside.terms.map((term) => term.penalty)).toEqual([0.1, 0, 0])
    const clipped = scoreCandidate(
      metrics({ clipped_highlight_ratio: 0.03, p1: 0.001 }),
      objective,
    )
    expect(clipped.terms.map((term) => term.penalty)).toEqual([
      0.1, 0.009, 0.02,
    ])
    expect(clipped.score).toBe(0.129)
  })

  it('ranks best-first with a stable id tie-break', () => {
    const ranked = rankCandidates(
      [
        { id: 'cand_0003', metrics: metrics({ mean: 0.5 }) },
        { id: 'cand_0002', metrics: metrics({ mean: 0.45 }) },
        { id: 'cand_0001', metrics: metrics({ mean: 0.45 }) },
      ],
      objective,
    )
    expect(ranked.map((entry) => entry.candidate_id)).toEqual([
      'cand_0001',
      'cand_0002',
      'cand_0003',
    ])
    expect(ranked[2].score).toBe(0.1)
  })
})
