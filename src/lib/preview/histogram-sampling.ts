import type {
  createPreviewHistogramProcessor,
  PreviewHistogramSource,
} from '@lumaforge/luma-color-runtime'

/** Rows the color graph processes per band. */
export const HISTOGRAM_ROW_BAND_ROWS = 32
/** The most pixels a settled histogram samples. */
export const HISTOGRAM_FULL_SAMPLE_PIXELS = 500_000

/** The decoded preview frame a histogram run samples. */
export interface HistogramFrame {
  source: PreviewHistogramSource
  width: number
  height: number
  /** RGB16 linear ProPhoto, three channels per pixel. */
  data: Uint16Array
}

/**
 * How far apart the rows a run samples are, so that it reads at most
 * `budget` pixels of a `width` x `height` frame.
 */
export function histogramRowStep(
  width: number,
  height: number,
  budget: number,
) {
  const totalPixels = width * height
  if (!Number.isSafeInteger(totalPixels) || totalPixels <= budget) return 1
  return Math.max(1, Math.ceil(totalPixels / budget))
}

type HistogramProcessor = ReturnType<typeof createPreviewHistogramProcessor>

export interface HistogramRowSampler {
  readonly done: boolean
  /** Rows fed to the processor so far. */
  readonly sampledRows: number
  /**
   * Feeds up to `limit` sampled rows (at most a band) to the processor and
   * returns how many it fed.
   */
  feed: (limit: number) => number
}

/**
 * Walks `rows` rows of `width` pixels in `data`, `rowStep` apart: every row
 * in bands when the step is one, one row at a time otherwise.
 */
export function createHistogramRowSampler(
  processor: Pick<HistogramProcessor, 'processUint16Rows'>,
  { width, rows, data }: { width: number; rows: number; data: Uint16Array },
  rowStep: number,
): HistogramRowSampler {
  const rowLength = width * 3
  let nextRow = 0
  let sampledRows = 0
  return {
    get done() {
      return nextRow >= rows
    },
    get sampledRows() {
      return sampledRows
    },
    feed(limit) {
      if (rowStep === 1) {
        const rowCount = Math.min(limit, rows - nextRow)
        if (rowCount <= 0) return 0
        const start = nextRow * rowLength
        processor.processUint16Rows(
          data.subarray(start, start + rowCount * rowLength),
          rowCount,
        )
        nextRow += rowCount
        sampledRows += rowCount
        return rowCount
      }
      let rowCount = 0
      while (rowCount < limit && nextRow < rows) {
        const start = nextRow * rowLength
        processor.processUint16Rows(data.subarray(start, start + rowLength), 1)
        nextRow += rowStep
        sampledRows += 1
        rowCount += 1
      }
      return rowCount
    },
  }
}

/**
 * The rows of `frame` a settled histogram samples, `rowStep` apart from the
 * first, packed into a new array. Every run reads from these rows only, so
 * this is all of the frame a histogram needs.
 */
export function packHistogramRows(frame: HistogramFrame, rowStep: number) {
  const rowLength = frame.width * 3
  const rows = Math.ceil(frame.height / rowStep)
  const packed = new Uint16Array(rows * rowLength)
  for (let row = 0; row < rows; row += 1) {
    const start = row * rowStep * rowLength
    packed.set(frame.data.subarray(start, start + rowLength), row * rowLength)
  }
  return packed
}
