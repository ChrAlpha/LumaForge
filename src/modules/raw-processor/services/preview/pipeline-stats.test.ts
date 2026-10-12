import { describe, expect, it } from 'vitest'

import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import {
  areSamePipelineFacts,
  areSamePipelineStats,
  differsOnlyInTiming,
  toPipelineFacts,
} from './pipeline-stats'

const stats: PipelineStats = {
  uploadTime: 4,
  lutUploadTime: 0,
  processTime: 18,
  totalTime: 22,
  inputSize: { width: 4000, height: 2666 },
  previewSize: { width: 1200, height: 800 },
  inputFormat: 'uint16-rgb',
  transformPath: 'no-lut',
  lutRole: null,
  lutInputTransfer: null,
  lutOutputTransfer: null,
  lutSize: null,
}

describe('pipeline stats', () => {
  it('tells a new frame timing from a new pipeline', () => {
    const retimed = { ...stats, processTime: 9, totalTime: 12 }
    const resized = { ...stats, previewSize: { width: 600, height: 400 } }

    expect(areSamePipelineStats(stats, { ...stats })).toBe(true)
    expect(areSamePipelineStats(stats, retimed)).toBe(false)
    expect(differsOnlyInTiming(stats, retimed)).toBe(true)
    expect(differsOnlyInTiming(stats, resized)).toBe(false)
  })

  it('keeps the facts without the timings, compared by value', () => {
    const facts = toPipelineFacts(stats)
    expect(facts).not.toHaveProperty('processTime')
    expect(facts).not.toHaveProperty('uploadTime')
    expect(facts.previewSize).toEqual({ width: 1200, height: 800 })

    expect(
      areSamePipelineFacts(
        facts,
        toPipelineFacts({
          ...stats,
          processTime: 3,
          inputSize: { width: 4000, height: 2666 },
        }),
      ),
    ).toBe(true)
    expect(
      areSamePipelineFacts(
        facts,
        toPipelineFacts({ ...stats, transformPath: 'display-lut' }),
      ),
    ).toBe(false)
    expect(areSamePipelineFacts(null, null)).toBe(true)
    expect(areSamePipelineFacts(facts, null)).toBe(false)
  })
})
