import type {
  ColorGraphIntent,
  ColorGraphIntentSource,
  LUTData,
  PreviewHistogramState,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import {
  colorGraphIntentSignature,
  createPreviewHistogramProcessor,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'

const ROW_BAND_ROWS = 32
/**
 * Live feedback cadence: while the look moves, a histogram run starts at
 * most this often (leading and trailing), one at a time, always on the
 * latest params.
 */
export const HISTOGRAM_THROTTLE_MS = 150
/** Quiet time after the last change before a coarse result is refined. */
export const HISTOGRAM_SETTLE_MS = 150
/**
 * During a scrub the main thread may be busy with the histogram at most one
 * part in this many: the interval stretches to this multiple of the last
 * run's busy time when a device is slow enough to need it.
 */
export const HISTOGRAM_BUSY_SHARE_DENOMINATOR = 6
const MAX_HISTOGRAM_SAMPLED_PIXELS = 500_000
/**
 * Sample budget of a run made while the look is moving. A run costs about
 * 0.5us per sampled pixel with a LUT on a desktop CPU (~240ms at the full
 * budget, ~25ms at 48k), so this budget keeps a scrub run near 21ms, under
 * 1/6 of the 150ms interval. The full budget comes back once the input
 * settles.
 */
export const SCRUB_HISTOGRAM_SAMPLED_PIXELS = 40_000
const UNSUPPORTED_PREVIEW_REASON =
  'Preview histogram requires RGB16 Linear ProPhoto preview data.'
const HISTOGRAM_OFF_REASON = 'No surface shows the preview histogram.'
const UNREPRESENTED_LOOK_REASON =
  'The histogram does not measure built-in styles.'

type PreviewHistogramInput = {
  /**
   * False while no surface shows the histogram (a phone with it turned
   * off, the CPU preview, an applied Transform): no run starts, and any run
   * in flight stops. Defaults to true.
   */
  enabled?: boolean
  imageRef: RefObject<DecodedImage | null>
  imageVersion: number
  imageIdentity?: string
  /**
   * The workflow's accepted descriptor for the frame `imageRef` holds; null
   * while no decoded frame is accepted. Jobs are keyed by `imageVersion` and
   * `imageIdentity`, not by it.
   */
  frame?: DecodedPreviewFrame | null
  params: ColorGraphIntentSource
  lutDataRef: RefObject<LUTData | null>
  lutDataVersion: number
  displaySource: DisplaySource
}

/** What a job reads: the color intent, never the view. */
type HistogramJobInput = Omit<PreviewHistogramInput, 'params' | 'frame'> & {
  intent: ColorGraphIntent
}

type ValidHistogramImage = DecodedImage & {
  data: Uint16Array
  source: 'quick' | 'bounded-hq'
}

type HistogramJob =
  | {
      kind: 'unavailable' | 'unsupported'
      key: string
      state: PreviewHistogramState
    }
  | {
      kind: 'compute'
      key: string
      handoffKey: string
      image: ValidHistogramImage
      graph: Parameters<typeof createPreviewHistogramProcessor>[0]['graph']
    }

type ComputeHistogramJob = Extract<HistogramJob, { kind: 'compute' }>

const HISTOGRAM_OFF_JOB: HistogramJob = Object.freeze({
  kind: 'unsupported',
  key: 'off',
  state: Object.freeze({ state: 'unsupported', reason: HISTOGRAM_OFF_REASON }),
})

function getPreviousReady(
  state: PreviewHistogramState,
): ReadyPreviewHistogram | null {
  if (state.state === 'ready') return state
  if (state.state === 'stale' || state.state === 'computing') {
    return state.previous
  }
  return null
}

function hasExpectedRgb16DataLength(image: DecodedImage) {
  if (!(image.data instanceof Uint16Array)) return false

  const expectedLength = image.width * image.height * 3
  return (
    Number.isSafeInteger(expectedLength) &&
    expectedLength > 0 &&
    image.data.length === expectedLength
  )
}

function createHistogramJob({
  enabled = true,
  imageRef,
  imageVersion,
  imageIdentity = 'unscoped-preview',
  intent,
  lutDataRef,
  lutDataVersion,
  displaySource,
}: HistogramJobInput): HistogramJob {
  if (!enabled) return HISTOGRAM_OFF_JOB
  const image = imageRef.current
  const imageIdentityKey = imageIdentity
  const toneKey = colorGraphIntentSignature(intent)

  if (!image) {
    const reason = displaySource === 'embedded' ? 'embedded-only' : 'no-image'
    return {
      kind: 'unavailable',
      key: ['unavailable', displaySource, imageVersion, toneKey].join('|'),
      state: { state: 'unavailable', reason },
    }
  }

  const imageKey = [
    imageVersion,
    image.width,
    image.height,
    image.layout,
    image.colorSpace,
    image.source ?? '',
    image.renderExposure.ev,
    image.renderExposure.multiplier,
  ].join(':')

  if (
    image.layout !== 'rgb-u16' ||
    image.colorSpace !== 'linear-prophoto-rgb' ||
    !hasExpectedRgb16DataLength(image) ||
    (image.source !== 'quick' && image.source !== 'bounded-hq')
  ) {
    return {
      kind: 'unsupported',
      key: ['unsupported', imageIdentityKey, imageKey, displaySource].join('|'),
      state: {
        state: 'unsupported',
        reason: UNSUPPORTED_PREVIEW_REASON,
      },
    }
  }

  // The histogram is shown only over the WebGPU preview, so it measures what
  // that preview draws: a custom LUT export would refuse is dropped and the
  // user's adjustments stay. A built-in preset WebGPU draws has no TS graph,
  // and the look-stripped graph would not measure it, so nothing is measured.
  const plan = resolvePreviewColorPlan({
    intent,
    lut: lutDataRef.current,
    rawRenderExposure: image.renderExposure,
    executor: 'webgpu',
  })
  if (plan.histogram.kind !== 'graph') {
    return {
      kind: 'unsupported',
      key: ['unrepresented', imageIdentityKey, imageKey, displaySource].join(
        '|',
      ),
      state: { state: 'unsupported', reason: UNREPRESENTED_LOOK_REASON },
    }
  }

  // Keyed on what the preview draws: a look it drops, and that look's
  // strength, start no run. The drawn LUT is keyed by its version, which
  // moves with every LUT record, so a new contract on the same bytes counts.
  const drawnKey = [
    colorGraphIntentSignature(plan.effectiveIntent),
    plan.lut ? lutDataVersion : 'no-lut',
  ].join('|')
  const key = [
    'compute',
    imageIdentityKey,
    imageKey,
    displaySource,
    drawnKey,
  ].join('|')
  const handoffKey = [imageIdentityKey, drawnKey].join('|')

  return {
    kind: 'compute',
    key,
    handoffKey,
    image: image as ValidHistogramImage,
    graph: plan.histogram.graph,
  }
}

function createInitialState(job: HistogramJob): PreviewHistogramState {
  if (job.kind !== 'compute') return job.state
  return { state: 'computing', previous: null }
}

function scheduleChunk(work: () => void) {
  return window.setTimeout(work, 0)
}

function getPreviewHistogramRowStep(
  width: number,
  height: number,
  budget = MAX_HISTOGRAM_SAMPLED_PIXELS,
) {
  const totalPixels = width * height
  if (!Number.isSafeInteger(totalPixels) || totalPixels <= budget) {
    return 1
  }

  return Math.max(1, Math.ceil(totalPixels / budget))
}

function sameHistogramImage(a: ComputeHistogramJob, b: HistogramJob) {
  return (
    b.kind === 'compute' &&
    a.image === b.image &&
    a.image.source === b.image.source
  )
}

/**
 * `full` samples up to the full budget; `scrub` is a cheap run made while
 * the look moves; `refine` brings a scrub result back to the full budget
 * once the input settles.
 */
type HistogramRunKind = 'full' | 'scrub' | 'refine'

interface HistogramRun {
  job: ComputeHistogramJob
  kind: HistogramRunKind
  cancelled: boolean
  chunkTimer: number | null
}

interface HistogramScheduler {
  running: HistogramRun | null
  /** A newer job arrived while a run that may finish was in flight. */
  pending: boolean
  startTimer: number | null
  /** The job the start timer was set for. */
  queuedJob: ComputeHistogramJob | null
  refineTimer: number | null
  lastStartAt: number | null
  intervalMs: number
}

export function usePreviewHistogram(
  input: PreviewHistogramInput,
): PreviewHistogramState {
  const {
    enabled = true,
    imageRef,
    imageVersion,
    imageIdentity,
    params,
    lutDataRef,
    lutDataVersion,
    displaySource,
  } = input
  // The histogram reads the color intent only: a view change (view mode,
  // compare split) or an equal intent rebuilt upstream keeps the same job.
  const intentSignature = colorGraphIntentSignature(params)
  const intent = useMemo(
    () => pickColorGraphIntent(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intentSignature],
  )
  const resolvedJob = useMemo(
    () =>
      createHistogramJob({
        enabled,
        imageRef,
        imageIdentity,
        imageVersion,
        intent,
        lutDataRef,
        lutDataVersion,
        displaySource,
      }),
    [
      displaySource,
      enabled,
      intent,
      imageRef,
      imageIdentity,
      imageVersion,
      lutDataRef,
      lutDataVersion,
    ],
  )
  // An equal key is the same work: a change the preview does not draw keeps
  // the job, so it neither restarts a run nor marks the bins stale.
  const job = useMemo(
    () => resolvedJob,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedJob.key],
  )
  const [state, setState] = useState<PreviewHistogramState>(() =>
    createInitialState(job),
  )
  const stateRef = useRef(state)
  const jobKeyRef = useRef(job.key)
  const latestJobRef = useRef(job)
  const schedulerRef = useRef<HistogramScheduler>({
    running: null,
    pending: false,
    startTimer: null,
    queuedJob: null,
    refineTimer: null,
    lastStartAt: null,
    intervalMs: HISTOGRAM_THROTTLE_MS,
  })
  latestJobRef.current = job

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const commitState = useCallback((nextState: PreviewHistogramState) => {
    stateRef.current = nextState
    setState(nextState)
  }, [])

  const cancelRun = useCallback((run: HistogramRun | null) => {
    if (!run) return
    run.cancelled = true
    if (run.chunkTimer !== null) window.clearTimeout(run.chunkTimer)
    const scheduler = schedulerRef.current
    if (scheduler.running === run) scheduler.running = null
  }, [])

  const clearTimers = useCallback(() => {
    const scheduler = schedulerRef.current
    if (scheduler.startTimer !== null) window.clearTimeout(scheduler.startTimer)
    if (scheduler.refineTimer !== null) {
      window.clearTimeout(scheduler.refineTimer)
    }
    scheduler.startTimer = null
    scheduler.queuedJob = null
    scheduler.refineTimer = null
  }, [])

  // Runs are chunked across macrotasks, so the scheduler, not the effect
  // that saw a job, owns them: a scrub never cancels the run that would
  // have answered it, and two runs never interleave.
  const startRunRef = useRef<
    (kind: HistogramRunKind, job: HistogramJob) => void
  >(() => {})
  const scheduleRef = useRef<
    (kind: 'full' | 'scrub', job: ComputeHistogramJob) => void
  >(() => {})

  // The first quick histogram is worth finishing while bounded-HQ takes
  // over the same look: it is the first thing the user sees.
  const isSupersededFirstQuick = (
    candidate: ComputeHistogramJob | null,
    next: HistogramJob,
  ): candidate is ComputeHistogramJob =>
    candidate !== null &&
    next.kind === 'compute' &&
    candidate !== next &&
    candidate.image.source === 'quick' &&
    getPreviousReady(stateRef.current) === null &&
    candidate.handoffKey === next.handoffKey

  startRunRef.current = (kind, job) => {
    const scheduler = schedulerRef.current
    if (job.kind !== 'compute' || scheduler.running) return

    const previous = getPreviousReady(stateRef.current)
    const run: HistogramRun = { job, kind, cancelled: false, chunkTimer: null }
    scheduler.running = run
    // A run on anything but the latest job owes the latest a run after it.
    scheduler.pending = job !== latestJobRef.current
    scheduler.lastStartAt = Date.now()
    // A full run says it is computing; a scrub or refine run lands within a
    // frame or two and keeps the bins on screen meanwhile.
    if (kind === 'full') commitState({ state: 'computing', previous })

    const { image } = job
    const processor = createPreviewHistogramProcessor({
      width: image.width,
      rowBandRows: ROW_BAND_ROWS,
      graph: job.graph,
    })
    const rowStep = getPreviewHistogramRowStep(
      image.width,
      image.height,
      kind === 'scrub'
        ? SCRUB_HISTOGRAM_SAMPLED_PIXELS
        : MAX_HISTOGRAM_SAMPLED_PIXELS,
    )
    const isFirstQuickRun = previous === null && image.source === 'quick'
    const bandsPerChunk = isFirstQuickRun ? 4 : 1
    let nextRow = 0
    let processedRows = 0
    let busyMs = 0

    const processOneBand = () => {
      if (rowStep === 1) {
        const rowCount = Math.min(ROW_BAND_ROWS, image.height - nextRow)
        const start = nextRow * image.width * 3
        const end = start + rowCount * image.width * 3
        processor.processUint16Rows(image.data.subarray(start, end), rowCount)
        nextRow += rowCount
        processedRows += rowCount
      } else {
        let rowsThisChunk = 0
        while (rowsThisChunk < ROW_BAND_ROWS && nextRow < image.height) {
          const start = nextRow * image.width * 3
          const end = start + image.width * 3
          processor.processUint16Rows(image.data.subarray(start, end), 1)
          nextRow += rowStep
          processedRows += 1
          rowsThisChunk += 1
        }
      }
    }

    const finish = () => {
      const ready = processor.finish({
        source: image.source,
        width: image.width,
        height: image.height,
        totalRows: processedRows,
        ownership: 'main-thread-chunked-no-copy',
        inputByteLength: image.data.buffer.byteLength,
      })
      scheduler.running = null
      if (kind === 'scrub') {
        scheduler.intervalMs = Math.max(
          HISTOGRAM_THROTTLE_MS,
          busyMs * HISTOGRAM_BUSY_SHARE_DENOMINATOR,
        )
      }

      const latest = latestJobRef.current
      if (latest.key === job.key) {
        scheduler.pending = false
        commitState(ready)
        // A scrub run sampled less than a settled histogram should; once
        // the input stays put, refine it at the full budget.
        if (kind === 'scrub' && rowStep > 1) {
          scheduler.refineTimer = window.setTimeout(() => {
            scheduler.refineTimer = null
            if (latestJobRef.current.key === job.key) {
              startRunRef.current('refine', job)
            }
          }, HISTOGRAM_SETTLE_MS)
        }
        return
      }
      if (latest.kind !== 'compute') return
      // The first quick histogram stands on its own while bounded-HQ takes
      // over the same look; any other result that lags the latest params
      // shows, marked stale, until the run for them lands.
      commitState(
        isFirstQuickRun && latest.handoffKey === job.handoffKey
          ? ready
          : { state: 'stale', previous: ready },
      )
      if (scheduler.pending) {
        scheduleRef.current(
          latest.image.source === image.source ? 'scrub' : 'full',
          latest,
        )
      }
    }

    const processNextBand = () => {
      run.chunkTimer = null
      if (run.cancelled) return
      const startedAt = performance.now()
      for (
        let band = 0;
        band < bandsPerChunk && nextRow < image.height;
        band += 1
      ) {
        processOneBand()
      }
      busyMs += performance.now() - startedAt
      if (nextRow >= image.height) {
        finish()
      } else {
        run.chunkTimer = scheduleChunk(processNextBand)
      }
    }

    processNextBand()
  }

  scheduleRef.current = (kind, job) => {
    const scheduler = schedulerRef.current
    if (scheduler.startTimer !== null || scheduler.running) return
    scheduler.queuedJob = job
    // Leading edge when the last run started an interval ago or more,
    // trailing edge otherwise; a first look or a new source never waits.
    const delay =
      kind === 'scrub' && scheduler.lastStartAt !== null
        ? Math.max(0, scheduler.lastStartAt + scheduler.intervalMs - Date.now())
        : 0
    scheduler.startTimer = window.setTimeout(() => {
      const queued = scheduler.queuedJob
      scheduler.startTimer = null
      scheduler.queuedJob = null
      // Skip to the latest params, unless the queued job is the first
      // quick histogram the latest one only takes over from.
      const latest = latestJobRef.current
      if (isSupersededFirstQuick(queued, latest)) {
        startRunRef.current('full', queued)
        return
      }
      startRunRef.current(kind, latest)
    }, delay)
  }

  useEffect(() => {
    jobKeyRef.current = job.key
    const scheduler = schedulerRef.current
    // Any change outdates a settled-input refinement.
    if (scheduler.refineTimer !== null) {
      window.clearTimeout(scheduler.refineTimer)
      scheduler.refineTimer = null
    }

    if (job.kind !== 'compute') {
      cancelRun(scheduler.running)
      clearTimers()
      scheduler.pending = false
      commitState(job.state)
      return
    }

    const previous = getPreviousReady(stateRef.current)
    commitState(
      previous
        ? { state: 'stale', previous }
        : { state: 'computing', previous: null },
    )
    const kind: 'full' | 'scrub' =
      previous && previous.source === job.image.source ? 'scrub' : 'full'

    const running = scheduler.running
    if (running) {
      // Let a run finish when its answer is still worth showing: any run
      // on the same image but a settled-input refinement (the next run
      // starts after it, on the latest params), or the first quick
      // histogram bounded-HQ is taking over.
      const worthFinishing =
        (running.kind !== 'refine' && sameHistogramImage(running.job, job)) ||
        isSupersededFirstQuick(running.job, job)
      if (worthFinishing) {
        scheduler.pending = true
        return
      }
      cancelRun(running)
    }
    if (scheduler.startTimer !== null) {
      // The queued first quick run goes ahead; the latest follows it.
      if (isSupersededFirstQuick(scheduler.queuedJob, job)) return
      // A first look or a new source does not wait out a scrub's interval.
      if (kind === 'full') {
        window.clearTimeout(scheduler.startTimer)
        scheduler.startTimer = null
        scheduler.queuedJob = null
      }
    }
    scheduleRef.current(kind, job)
  }, [cancelRun, clearTimers, commitState, job])

  useEffect(
    () => () => {
      cancelRun(schedulerRef.current.running)
      clearTimers()
    },
    [cancelRun, clearTimers],
  )

  if (jobKeyRef.current !== job.key) {
    if (job.kind !== 'compute') return job.state
    const previous = getPreviousReady(state)
    return previous
      ? { state: 'stale', previous }
      : { state: 'computing', previous: null }
  }

  return state
}
