import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

/**
 * What the preview pipeline is, without how long its last frame took: the
 * input and preview sizes.
 */
export type PipelineFacts = Omit<PipelineStats, 'processTime'>

type PipelineSize = PipelineStats['inputSize']

function isSameSize(a: PipelineSize, b: PipelineSize) {
  return a.width === b.width && a.height === b.height
}

export function toPipelineFacts({
  inputSize,
  previewSize,
}: PipelineStats): PipelineFacts {
  return { inputSize, previewSize }
}

export function areSamePipelineFacts(
  a: PipelineFacts | null,
  b: PipelineFacts | null,
) {
  if (a === null || b === null) return a === b
  return (
    isSameSize(a.inputSize, b.inputSize) &&
    isSameSize(a.previewSize, b.previewSize)
  )
}

export function areSamePipelineStats(a: PipelineStats, b: PipelineStats) {
  return Object.is(a.processTime, b.processTime) && areSamePipelineFacts(a, b)
}

/** The same pipeline, rendering a frame in a different time. */
export function differsOnlyInTiming(a: PipelineStats, b: PipelineStats) {
  return areSamePipelineFacts(a, b)
}
