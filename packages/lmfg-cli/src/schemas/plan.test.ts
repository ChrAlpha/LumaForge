// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  expandSweepPlan,
  MAX_CANDIDATES_PER_SWEEP,
  normalizeCandidatePlan,
} from './plan'

describe('normalizeCandidatePlan', () => {
  it('assigns sequential ids and merges base params', () => {
    const plan = normalizeCandidatePlan({
      base: { contrast: 20 },
      candidates: [
        { params: { exposure_ev: -1 } },
        { id: 'warm', tag: 'warm', params: { temperature: 30 } },
      ],
    })
    expect(plan.candidates.map((c) => c.id)).toEqual(['cand_0001', 'warm'])
    expect(plan.candidates[0].params).toMatchObject({
      exposure_ev: -1,
      contrast: 20,
    })
    expect(plan.candidates[1].params).toMatchObject({
      temperature: 30,
      contrast: 20,
    })
    expect(plan.candidates[1].tag).toBe('warm')
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      normalizeCandidatePlan({
        candidates: [
          { id: 'a', params: {} },
          { id: 'a', params: {} },
        ],
      }),
    ).toThrow(/duplicate/i)
  })
})

describe('expandSweepPlan', () => {
  it('expands axes as a cartesian product in declaration order', () => {
    const plan = expandSweepPlan({
      base: { contrast: 5 },
      axes: { exposure_ev: [-1, 1], temperature: [0, 20, 40] },
    })
    expect(plan.candidates).toHaveLength(6)
    expect(plan.candidates[0]).toMatchObject({
      id: 'cand_0001',
      tag: 'exposure_ev=-1,temperature=0',
    })
    expect(plan.candidates[1].params).toMatchObject({
      exposure_ev: -1,
      temperature: 20,
      contrast: 5,
    })
    expect(plan.candidates[5].params).toMatchObject({
      exposure_ev: 1,
      temperature: 40,
    })
  })

  it('caps the sweep size', () => {
    const values = Array.from({ length: 9 }, (_, i) => i)
    expect(() =>
      expandSweepPlan({ axes: { exposure_ev: values, contrast: values } }),
    ).toThrow(new RegExp(String(MAX_CANDIDATES_PER_SWEEP)))
  })
})
