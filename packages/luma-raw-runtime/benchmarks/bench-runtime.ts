import { createLumaRawRuntime } from '../src/runtime'
import type {
  LumaEmbeddedPreview,
  LumaRawFrame,
  LumaRawProbe,
  LumaRawRuntime,
} from '../src/types'
import type { BenchProvenance } from './bench-provenance'
import { loadBenchmarkProvenance } from './bench-provenance'

const QUICK_PREVIEW_MAX_PIXELS = 2_500_000
const BOUNDED_HQ_MAX_PIXELS = 12_000_000
const HQ_TARGET_MAX_MEGAPIXELS = 30

type BenchStage =
  | 'luma-open-session'
  | 'luma-embedded'
  | 'luma-quick'
  | 'luma-hq'

type BenchTargetStatus = 'within-target' | 'over-target' | 'baseline'
type BenchRuntime = 'luma'
type BenchTimings = Record<string, number | undefined>
type BenchHeap = Record<string, number | undefined>
type BenchMetric = number | null

type BenchRecord = {
  runtime: BenchRuntime
  stage: BenchStage
  file: string
  fileName: string
  size: number
  fileSize: number
  width: BenchMetric
  height: BenchMetric
  megapixels: BenchMetric
  total: BenchMetric
  totalMs: BenchMetric
  read: BenchMetric
  copyToWasm: BenchMetric
  librawOpen: BenchMetric
  openBuffer: BenchMetric
  unpack: BenchMetric
  heapBytes: BenchMetric
  heapBefore: BenchMetric
  heapAfter: BenchMetric
  heapPeak: BenchMetric
  targetStatus: BenchTargetStatus
  provenanceSourceLockSha256: string | null
  error: string | null
  timings?: BenchTimings
  heap?: BenchHeap
}

type BenchRecordInput = {
  runtime: BenchRuntime
  stage: BenchStage
  file: string
  fileName: string
  size: number
  fileSize: number
  width?: number
  height?: number
  megapixels?: number
  total: number
  targetStatus?: BenchTargetStatus
  provenanceSourceLockSha256: string | null
  timings?: BenchTimings
  heap?: BenchHeap
}

type BenchErrorRecord = BenchRecord & { error: string }

type LumaSessionStageResult = (LumaEmbeddedPreview | LumaRawFrame) & {
  timings: BenchTimings & { total: number }
  heap?: BenchHeap
}

type LumaRawSession = {
  probe: LumaRawProbe
  timings: BenchTimings & { total: number }
  heap?: BenchHeap
  extractEmbeddedPreview: () => Promise<LumaSessionStageResult | null>
  decodeQuick: () => Promise<LumaSessionStageResult>
  decodeBoundedHq: (options: {
    maxOutputPixels: number
  }) => Promise<LumaSessionStageResult>
  dispose: () => void
}

type LumaRawRuntimeWithAnticipatedSession = LumaRawRuntime & {
  openSession?: (
    file: File,
    options?: { maxOutputPixels?: number },
  ) => Promise<LumaRawSession>
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing benchmark control: ${selector}`)
  return element
}

const input = required<HTMLInputElement>('#fixture')
const runButton = required<HTMLButtonElement>('#run')
const copyButton = required<HTMLButtonElement>('#copy')
const copyStatus = required<HTMLSpanElement>('#copy-status')
const output = required<HTMLPreElement>('#output')

function targetStatus(
  stage: BenchStage,
  total: number,
  megapixels?: number,
): BenchTargetStatus {
  if (stage === 'luma-embedded') {
    return total < 1000 ? 'within-target' : 'over-target'
  }
  if (stage === 'luma-quick') {
    return total <= 4000 ? 'within-target' : 'over-target'
  }
  if (stage === 'luma-hq') {
    if ((megapixels ?? 0) > HQ_TARGET_MAX_MEGAPIXELS) return 'baseline'
    return total <= 8000 ? 'within-target' : 'over-target'
  }
  return 'baseline'
}

function print(record: BenchRecord | BenchErrorRecord) {
  output.textContent += `${JSON.stringify(record)}\n`
}

function printError(
  stage: BenchStage,
  file: File,
  provenance: BenchProvenance,
  error: unknown,
) {
  const record = makeRecord({
    runtime: 'luma',
    stage,
    file: file.name,
    fileName: file.name,
    size: file.size,
    fileSize: file.size,
    total: 0,
    targetStatus: 'baseline',
    provenanceSourceLockSha256: provenance.sourceLockSha256,
  })

  print({
    ...record,
    total: null,
    totalMs: null,
    error: errorMessage(error),
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function outputMegapixels(width?: number, height?: number) {
  return width && height
    ? Number(((width * height) / 1_000_000).toFixed(2))
    : undefined
}

function firstTiming(timings: BenchTimings | undefined, keys: string[]) {
  for (const key of keys) {
    const value = timings?.[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

function metric(value: number | undefined): BenchMetric {
  return value ?? null
}

function heapBytes(heap: BenchHeap | undefined): BenchMetric {
  return (
    firstTiming(heap, [
      'peak',
      'after',
      'before',
      'heapBytes',
      'wasmHeapBytes',
      'usedBytes',
      'usedHeapBytes',
    ]) ?? null
  )
}

function heapStatsFields(heap: BenchHeap | undefined) {
  return {
    heapBefore: metric(firstTiming(heap, ['before'])),
    heapAfter: metric(firstTiming(heap, ['after'])),
    heapPeak: metric(firstTiming(heap, ['peak'])),
  }
}

function recordTimingFields(timings: BenchTimings | undefined) {
  return {
    read: metric(firstTiming(timings, ['read', 'readFile'])),
    copyToWasm: metric(firstTiming(timings, ['copyToWasm'])),
    librawOpen: metric(firstTiming(timings, ['librawOpen'])),
    openBuffer: metric(firstTiming(timings, ['openBuffer'])),
    unpack: metric(firstTiming(timings, ['unpack'])),
  }
}

function makeRecord(base: BenchRecordInput): BenchRecord {
  const megapixels =
    base.megapixels ?? outputMegapixels(base.width, base.height) ?? null

  return {
    ...base,
    width: base.width ?? null,
    height: base.height ?? null,
    megapixels,
    totalMs: base.total,
    ...recordTimingFields(base.timings),
    heapBytes: heapBytes(base.heap),
    ...heapStatsFields(base.heap),
    targetStatus:
      base.targetStatus ??
      targetStatus(base.stage, base.total, megapixels ?? undefined),
    error: null,
  }
}

function assertOpenSession(
  runtime: LumaRawRuntime,
): asserts runtime is LumaRawRuntimeWithAnticipatedSession & {
  openSession: NonNullable<LumaRawRuntimeWithAnticipatedSession['openSession']>
} {
  const candidate = runtime as LumaRawRuntimeWithAnticipatedSession
  if (typeof candidate.openSession !== 'function') {
    throw new TypeError('Luma runtime openSession API is not available yet.')
  }
}

function printLumaStage(
  file: File,
  provenance: BenchProvenance,
  stage: BenchStage,
  result: {
    width?: number
    height?: number
    timings: BenchTimings & { total: number }
    heap?: BenchHeap
  },
  targetOverride?: BenchTargetStatus,
) {
  print(
    makeRecord({
      runtime: 'luma',
      stage,
      file: file.name,
      fileName: file.name,
      size: file.size,
      fileSize: file.size,
      width: result.width,
      height: result.height,
      megapixels: outputMegapixels(result.width, result.height),
      total: result.timings.total,
      targetStatus: targetOverride,
      provenanceSourceLockSha256: provenance.sourceLockSha256,
      timings: result.timings,
      heap: result.heap,
    }),
  )
}

async function benchLuma(file: File, provenance: BenchProvenance) {
  const runtime = createLumaRawRuntime({ requireCrossOriginIsolation: false })
  let session: LumaRawSession | undefined

  try {
    await runtime.init()
    assertOpenSession(runtime)

    session = await runtime.openSession(file, {
      maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
    })
  } catch (error) {
    printError('luma-open-session', file, provenance, error)
    runtime.dispose()
    return
  }

  try {
    printLumaStage(
      file,
      provenance,
      'luma-open-session',
      {
        width: session.probe.width,
        height: session.probe.height,
        timings: session.timings,
        heap: session.heap,
      },
      'baseline',
    )

    const runLumaStage = async (
      stage: Exclude<BenchStage, 'luma-open-session'>,
      action: () => Promise<void>,
    ) => {
      try {
        await action()
      } catch (error) {
        printError(stage, file, provenance, error)
      }
    }

    await runLumaStage('luma-embedded', async () => {
      const embedded = await session.extractEmbeddedPreview()
      if (!embedded) {
        throw new Error('No embedded preview available.')
      }
      printLumaStage(file, provenance, 'luma-embedded', {
        width: embedded.width,
        height: embedded.height,
        timings: embedded.timings,
        heap: embedded.heap,
      })
    })

    await runLumaStage('luma-quick', async () => {
      const quick = await session.decodeQuick()
      printLumaStage(file, provenance, 'luma-quick', {
        width: quick.width,
        height: quick.height,
        timings: quick.timings,
        heap: quick.heap,
      })
    })

    await runLumaStage('luma-hq', async () => {
      const hq = await session.decodeBoundedHq({
        maxOutputPixels: BOUNDED_HQ_MAX_PIXELS,
      })
      printLumaStage(file, provenance, 'luma-hq', {
        width: hq.width,
        height: hq.height,
        timings: hq.timings,
        heap: hq.heap,
      })
    })
  } finally {
    session.dispose()
    runtime.dispose()
  }
}

async function run() {
  output.textContent = ''
  copyStatus.textContent = ''
  const files = [...(input.files ?? [])]
  if (files.length === 0) {
    output.textContent = 'Choose at least one RAW fixture.\n'
    return
  }

  runButton.disabled = true
  try {
    const provenance = await loadBenchmarkProvenance()
    for (const file of files) {
      await benchLuma(file, provenance)
    }
  } finally {
    runButton.disabled = false
  }
}

runButton.addEventListener('click', () => {
  run().catch((error) => {
    output.textContent += `${errorMessage(error)}\n`
    console.error(error)
  })
})

copyButton.addEventListener('click', async () => {
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    copyStatus.textContent = 'Clipboard unavailable'
    copyButton.title = 'Clipboard unavailable in this browser context'
    return
  }

  try {
    await clipboard.writeText(output.textContent || '')
    copyStatus.textContent = 'Copied'
    copyButton.title = 'Copied JSONL output'
  } catch (error) {
    copyStatus.textContent = 'Copy failed'
    copyButton.title = errorMessage(error)
  }
})
