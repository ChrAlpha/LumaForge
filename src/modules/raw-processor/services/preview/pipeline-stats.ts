import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

type PipelineSize = PipelineStats['inputSize']

function isSamePipelineSize(a: PipelineSize, b: PipelineSize) {
  return a.width === b.width && a.height === b.height
}

// Every stats field must be listed, so a new field cannot be silently ignored.
const PIPELINE_STATS_FIELD_EQUALITY: {
  [Key in keyof PipelineStats]: (
    a: PipelineStats[Key],
    b: PipelineStats[Key],
  ) => boolean
} = {
  uploadTime: Object.is,
  lutUploadTime: Object.is,
  processTime: Object.is,
  totalTime: Object.is,
  inputSize: isSamePipelineSize,
  previewSize: isSamePipelineSize,
  inputFormat: Object.is,
  transformPath: Object.is,
  lutRole: Object.is,
  lutInputTransfer: Object.is,
  lutOutputTransfer: Object.is,
  lutSize: Object.is,
}

const PIPELINE_STATS_FIELDS = Object.keys(
  PIPELINE_STATS_FIELD_EQUALITY,
) as Array<keyof PipelineStats>

/** How a frame's render took, not what the pipeline is. */
type PipelineTimingField =
  | 'uploadTime'
  | 'lutUploadTime'
  | 'processTime'
  | 'totalTime'

const PIPELINE_TIMING_FIELDS: ReadonlySet<keyof PipelineStats> =
  new Set<PipelineTimingField>([
    'uploadTime',
    'lutUploadTime',
    'processTime',
    'totalTime',
  ])

/**
 * What the preview pipeline is, without how long its last frame took: the
 * input and preview sizes, the input format and the LUT path.
 */
export type PipelineFacts = Omit<PipelineStats, PipelineTimingField>

const PIPELINE_FACT_FIELDS = PIPELINE_STATS_FIELDS.filter(
  (key) => !PIPELINE_TIMING_FIELDS.has(key),
) as Array<keyof PipelineFacts>

function isSameField<Key extends keyof PipelineStats>(
  key: Key,
  a: Pick<PipelineStats, Key>,
  b: Pick<PipelineStats, Key>,
) {
  return PIPELINE_STATS_FIELD_EQUALITY[key](a[key], b[key])
}

export function areSamePipelineStats(a: PipelineStats, b: PipelineStats) {
  return PIPELINE_STATS_FIELDS.every((key) => isSameField(key, a, b))
}

/** The same pipeline, rendering a frame in a different time. */
export function differsOnlyInTiming(a: PipelineStats, b: PipelineStats) {
  return areSamePipelineFacts(a, b)
}

export function toPipelineFacts(stats: PipelineStats): PipelineFacts {
  const {
    uploadTime: _uploadTime,
    lutUploadTime: _lutUploadTime,
    processTime: _processTime,
    totalTime: _totalTime,
    ...facts
  } = stats
  return facts
}

export function areSamePipelineFacts(
  a: PipelineFacts | null,
  b: PipelineFacts | null,
) {
  if (a === null || b === null) return a === b
  return PIPELINE_FACT_FIELDS.every((key) => isSameField(key, a, b))
}
