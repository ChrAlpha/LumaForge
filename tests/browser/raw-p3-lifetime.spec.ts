import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Download, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'
import { QUICK_PREVIEW_MAX_PIXELS } from '../../packages/render-engine/src/preview/preview-plan'
import {
  gateRawFixture,
  REQUIRE_PUBLIC_FIXTURE_ENV,
  resolvePublicRawFixture,
} from '../../scripts/ci/raw-fixtures.mjs'
import { BACKING_STORE_SETTLE_MS } from '../../src/modules/raw-processor/hooks/preview/backing-store-resize'
import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  projectHasWebGPU,
  rawPreviewUrl,
} from './raw-preview-backend'

// How long a source's work may live, observed only through what a user can
// do and what the page then holds: leaving the route ends the session and
// the work it started, a replacement with the same frame size gets frames of
// its own, a Transform answered on the quick frame is asked again on the HQ
// frame before export uses it, and a delivery reads the result it was asked
// for or refuses. The Chromium project runs the GPU preview on a software
// adapter, the WebKit project (no WebGPU adapter) the CPU preview.

// The assertions name the public DNG's own facts, so a missing copy fails
// instead of skipping.
const PUBLIC_DNG = resolvePublicRawFixture({
  env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
})
/** The public DNG's sensor size, as the decoder reports it. */
const PUBLIC_DNG_SIZE = { width: 4032, height: 3024 }
const MOBILE_VIEWPORT = { width: 393, height: 852 }
/** A phone short enough that each deck takes its height from the photo. */
const SHORT_MOBILE_VIEWPORT = { width: 393, height: 600 }
const DESKTOP_VIEWPORT = { width: 1440, height: 1000 }
/** The RAW worker bridge ends an unleased runtime after this long. */
const RAW_RUNTIME_IDLE_MS = 10_000
const STALE_DELIVERY_COPY =
  'This export no longer matches the photo. Export again to deliver it.'
/** What the export surface says while Transform waits on its worker. */
const TRANSFORM_PENDING_COPY = 'Preparing the current photo…'
const COPY_FULL_LABEL = 'Copy full-resolution image'

type WorkerKind = 'raw' | 'transform' | 'cpu-preview' | 'export' | 'other'

type TracedWorker = {
  index: number
  kind: WorkerKind
  createdAt: number
  terminatedAt: number | null
  /** Every message the page posted, `held` when the trace kept it back. */
  requests: Array<{ type: string; at: number; held: boolean }>
  lastReplyAt: number | null
}

type CpuSource = {
  worker: number
  sourceId: string
  width: number
  height: number
  at: number
}

type PageTrace = {
  workers: TracedWorker[]
  /** Sources the page handed the CPU preview worker. */
  cpuSources: CpuSource[]
  /** Sources the page told the CPU preview worker to drop. */
  cpuDisposed: Array<{ worker: number; sourceId: string; at: number }>
  /** Renders posted to the CPU preview worker. */
  cpuRenders: Array<{
    worker: number
    sourceId: string
    requestId: number
    variant: string
    at: number
  }>
  /** Frames the CPU preview worker answered, once the page received them. */
  cpuFrames: Array<{ worker: number; sourceId: string; requestId: number }>
  /** Whether CPU preview frames are kept from the page for now. */
  holdCpuFrames: boolean
  /** Frames kept back so far, with when each arrived. */
  heldCpuFrames: Array<{ worker: number; sourceId: string; at: number }>
  pendingCpuFrames: number
  /** A RAW request type the trace keeps from the worker until released. */
  holdRawRequest: string | null
  heldRawRequests: number
  /** Whether Transform renders are kept from the worker for now. */
  holdTransformRenders: boolean
  heldTransformRenders: number
  /** Whether idle-window timers are kept from running for now. */
  holdIdleTimers: boolean
  heldIdleTimers: number
  /** Whether GPU backing-store settle timers are kept from running for now. */
  holdSettleTimers: boolean
  heldSettleTimers: number
  /** Image rows written to GPU textures: RGB16 bands of a decoded frame. */
  gpuUploads: Array<{ width: number; y: number; rows: number; at: number }>
  /** When the page submitted GPU work. */
  gpuSubmits: number[]
  /** Whether GPU completions are kept from the page for now. */
  holdGpuCompletions: boolean
  /** When each completion held so far was asked for, and how many still wait. */
  heldGpuCompletions: number[]
  pendingGpuCompletions: number
  /** Every toast the page showed, once each, in order. */
  toasts: Array<{ text: string; at: number }>
  exportEvents: Array<{ type: string; payload: Record<string, unknown> }>
  /** While armed, every materialized JPEG read is held until released. */
  delivery: { armed: boolean; held: number }
  /** What reached the system share sheet. */
  shared: Array<{ name: string; size: number; type: string }>
  /** What reached the clipboard. */
  copied: Array<{ type: string; size: number }>
}

type ExportManifest = {
  kind: string
  manifest_sha256: string
  source_raw: {
    filename: string
    decoded_dimensions: { width: number; height: number }
  }
  output: {
    sha256: string
    filename: string
    dimensions: { width: number; height: number }
  }
  render_params: {
    geometry?: {
      matrix: number[]
      constrain_crop: boolean
      output: { width: number; height: number }
    }
  }
}

type JpegFile = {
  name: string
  bytes: Buffer
  sha256: string
  width: number
  height: number
}

/**
 * Records the page's workers (RAW runtime, Transform, CPU preview, export),
 * every message posted to them, when each last answered and when the page
 * ended it, and the sources and frames the CPU preview worker handled. It
 * can keep one RAW request type or the Transform renders from their worker
 * until released, hold the worker bridges' idle timers and the GPU canvases'
 * backing-store settle timers, hold answers to submitted GPU work, and hold
 * JPEG reads from export storage. The system share sheet and the clipboard are stand-ins
 * that record what reached them. Toasts and export debug events are recorded
 * too.
 */
function installPageTrace({
  idleMs,
  settleMs,
}: {
  idleMs: number
  settleMs: number
}) {
  // Playwright compiles this function before it reaches the page, so it
  // keeps to syntax that needs no helpers: no class fields.
  const NativeWorker = window.Worker
  const heldRaw: Array<{ worker: Worker; send: () => void }> = []
  const heldTransform: Array<() => void> = []
  const heldDeliveries: Array<() => void> = []
  const heldGpuCompletions: Array<() => void> = []
  const heldCpuFrames: Array<{ at: number; deliver: () => void }> = []
  const trace: PageTrace = {
    workers: [],
    cpuSources: [],
    cpuDisposed: [],
    cpuRenders: [],
    cpuFrames: [],
    holdCpuFrames: false,
    heldCpuFrames: [],
    pendingCpuFrames: 0,
    holdRawRequest: null,
    heldRawRequests: 0,
    holdTransformRenders: false,
    heldTransformRenders: 0,
    holdIdleTimers: false,
    heldIdleTimers: 0,
    holdSettleTimers: false,
    heldSettleTimers: 0,
    gpuUploads: [],
    gpuSubmits: [],
    holdGpuCompletions: false,
    heldGpuCompletions: [],
    pendingGpuCompletions: 0,
    toasts: [],
    exportEvents: [],
    delivery: { armed: false, held: 0 },
    shared: [],
    copied: [],
  }
  // A held timer is not scheduled at all; clearing it forgets it. Releasing
  // schedules an idle timer again with its whole window, and runs a settle
  // timer at once.
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const heldTimers = new Map<
    number,
    { kind: 'idle' | 'settle'; run: () => void }
  >()
  const countHeldTimers = () => {
    const kinds = Array.from(heldTimers.values(), (timer) => timer.kind)
    trace.heldIdleTimers = kinds.filter((kind) => kind === 'idle').length
    trace.heldSettleTimers = kinds.filter((kind) => kind === 'settle').length
  }
  const releaseTimers = (kind: 'idle' | 'settle', delay: number) => {
    for (const [id, timer] of [...heldTimers]) {
      if (timer.kind !== kind) continue
      heldTimers.delete(id)
      nativeSetTimeout(timer.run, delay)
    }
    countHeldTimers()
  }
  let nextHeldTimer = 2 ** 30
  window.setTimeout = function (
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) {
    const kind =
      typeof handler !== 'function'
        ? null
        : trace.holdIdleTimers && delay === idleMs
          ? 'idle'
          : trace.holdSettleTimers && delay === settleMs
            ? 'settle'
            : null
    if (kind && typeof handler === 'function') {
      const id = nextHeldTimer++
      heldTimers.set(id, { kind, run: () => handler(...args) })
      countHeldTimers()
      return id
    }
    return nativeSetTimeout(handler, delay, ...args)
  } as typeof window.setTimeout
  window.clearTimeout = function (id?: number) {
    if (id !== undefined && heldTimers.delete(id)) {
      countHeldTimers()
      return
    }
    nativeClearTimeout(id)
  } as typeof window.clearTimeout

  const terminated = new WeakSet<Worker>()
  Object.assign(window, {
    __p3Trace: trace,
    __p3ReleaseIdleTimers() {
      trace.holdIdleTimers = false
      releaseTimers('idle', idleMs)
    },
    __p3ReleaseSettleTimers() {
      trace.holdSettleTimers = false
      releaseTimers('settle', 0)
    },
    __p3ReleaseRawRequests() {
      trace.holdRawRequest = null
      for (const held of heldRaw.splice(0)) {
        if (!terminated.has(held.worker)) held.send()
      }
    },
    __p3ReleaseTransformRenders() {
      trace.holdTransformRenders = false
      for (const send of heldTransform.splice(0)) send()
    },
    /**
     * Hands the page the CPU frames that arrived before `before`, or all of
     * them and stops holding. A frame is handed over even when its worker
     * has ended since: it arrives late, as a reply already sent would.
     */
    __p3ReleaseCpuFrames(before?: number) {
      if (before === undefined) trace.holdCpuFrames = false
      const due = heldCpuFrames.filter(
        (frame) => before === undefined || frame.at < before,
      )
      for (const frame of due)
        heldCpuFrames.splice(heldCpuFrames.indexOf(frame), 1)
      trace.pendingCpuFrames = heldCpuFrames.length
      for (const frame of due) frame.deliver()
    },
    __p3ReleaseDeliveries() {
      trace.delivery.armed = false
      for (const release of heldDeliveries.splice(0)) release()
    },
    /**
     * Answers the oldest `count` held completions and keeps holding later
     * ones; with no count, answers all of them and stops holding.
     */
    __p3ReleaseGpuCompletions(count?: number) {
      if (count === undefined) trace.holdGpuCompletions = false
      const released = heldGpuCompletions.splice(
        0,
        count ?? heldGpuCompletions.length,
      )
      trace.pendingGpuCompletions = heldGpuCompletions.length
      for (const release of released) release()
    },
  })

  // The GPU queue: which decoded rows reach a texture, when work is
  // submitted, and, while held, when the page learns that submitted work
  // completed. A held completion still completes on the GPU; only its
  // answer waits.
  const queue = typeof GPUQueue === 'undefined' ? null : GPUQueue.prototype
  if (queue) {
    const writeTexture = queue.writeTexture
    queue.writeTexture = function (
      this: GPUQueue,
      ...args: Parameters<GPUQueue['writeTexture']>
    ) {
      const [destination, , layout, size] = args
      const extent = Array.isArray(size) ? (size as number[]) : null
      const origin = Array.isArray(destination.origin)
        ? (destination.origin as number[])
        : null
      // A decoded frame goes up as RGBA16 bands, eight bytes a pixel.
      if (extent && extent[0]! > 1 && layout.bytesPerRow === extent[0]! * 8) {
        trace.gpuUploads.push({
          width: extent[0]!,
          y: origin?.[1] ?? 0,
          rows: extent[1] ?? 1,
          at: performance.now(),
        })
      }
      return Reflect.apply(writeTexture, this, args)
    } as GPUQueue['writeTexture']
    const submit = queue.submit
    queue.submit = function (
      this: GPUQueue,
      ...args: Parameters<GPUQueue['submit']>
    ) {
      trace.gpuSubmits.push(performance.now())
      return Reflect.apply(submit, this, args)
    }
    const onSubmittedWorkDone = queue.onSubmittedWorkDone
    queue.onSubmittedWorkDone = function (this: GPUQueue) {
      const done = Reflect.apply(
        onSubmittedWorkDone,
        this,
        [],
      ) as Promise<undefined>
      if (!trace.holdGpuCompletions) return done
      trace.heldGpuCompletions.push(performance.now())
      const released = new Promise<void>((resolve) => {
        heldGpuCompletions.push(resolve)
      })
      trace.pendingGpuCompletions = heldGpuCompletions.length
      return Promise.all([done, released]).then(() => undefined)
    }
  }

  const rawRequests = new Set([
    'openSession',
    'extractEmbeddedPreviewFromSession',
    'decodeQuickFromSession',
    'decodeBoundedHqFromSession',
    'probeExportCapabilityFromSession',
    'closeSession',
    'probe',
  ])
  const records = new WeakMap<Worker, TracedWorker>()
  class TracedPageWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      const href = String(url)
      const record: TracedWorker = {
        index: trace.workers.length + 1,
        kind: href.includes('transform.worker')
          ? 'transform'
          : href.includes('full-res-export')
            ? 'export'
            : href.includes('browser-worker')
              ? 'cpu-preview'
              : 'other',
        createdAt: performance.now(),
        terminatedAt: null,
        requests: [],
        lastReplyAt: null,
      }
      trace.workers.push(record)
      records.set(this, record)
      this.addEventListener('message', () => {
        record.lastReplyAt = performance.now()
      })
    }

    get onmessage() {
      return super.onmessage
    }

    // The CPU preview client takes its frames through `onmessage`: a frame
    // is recorded when the page receives it, and kept back while held.
    set onmessage(handler: Worker['onmessage']) {
      const record = records.get(this)!
      if (!handler) {
        super.onmessage = handler
        return
      }
      super.onmessage = (event: MessageEvent) => {
        const data = event.data as {
          type?: string
          sourceId?: string
          requestId?: number
        }
        if (record.kind !== 'cpu-preview' || data?.type !== 'rendered') {
          handler.call(this, event)
          return
        }
        const deliver = () => {
          trace.cpuFrames.push({
            worker: record.index,
            sourceId: String(data.sourceId),
            requestId: Number(data.requestId),
          })
          handler.call(this, event)
        }
        if (!trace.holdCpuFrames) {
          deliver()
          return
        }
        const at = performance.now()
        trace.heldCpuFrames.push({
          worker: record.index,
          sourceId: String(data.sourceId),
          at,
        })
        heldCpuFrames.push({ at, deliver })
        trace.pendingCpuFrames = heldCpuFrames.length
      }
    }

    postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const record = records.get(this)!
      const request = message as {
        type?: unknown
        payload?: unknown
        sourceId?: unknown
        requestId?: unknown
        variant?: unknown
        width?: unknown
        height?: unknown
      }
      const type = typeof request?.type === 'string' ? request.type : ''
      const payload = request?.payload
      if (
        record.kind === 'other' &&
        (rawRequests.has(type) ||
          (type === 'init' &&
            typeof payload === 'object' &&
            payload !== null &&
            'requireCrossOriginIsolation' in payload))
      ) {
        record.kind = 'raw'
      }
      const send = () => {
        if (options === undefined) super.postMessage(message)
        else super.postMessage(message, options as StructuredSerializeOptions)
      }
      const at = performance.now()
      let held = false
      if (record.kind === 'raw' && trace.holdRawRequest === type) {
        held = true
        trace.heldRawRequests += 1
        heldRaw.push({ worker: this, send })
      }
      if (
        record.kind === 'transform' &&
        type === 'render' &&
        trace.holdTransformRenders
      ) {
        held = true
        trace.heldTransformRenders += 1
        heldTransform.push(send)
      }
      record.requests.push({ type, at, held })
      if (record.kind === 'cpu-preview') {
        const sourceId = String(request.sourceId)
        if (type === 'loadSource') {
          trace.cpuSources.push({
            worker: record.index,
            sourceId,
            width: Number(request.width),
            height: Number(request.height),
            at,
          })
        } else if (type === 'disposeSource') {
          trace.cpuDisposed.push({ worker: record.index, sourceId, at })
        } else if (type === 'render') {
          trace.cpuRenders.push({
            worker: record.index,
            sourceId,
            requestId: Number(request.requestId),
            variant: String(request.variant),
            at,
          })
        }
      }
      if (!held) send()
    }

    terminate() {
      const record = records.get(this)!
      if (record.terminatedAt === null) record.terminatedAt = performance.now()
      terminated.add(this)
      super.terminate()
    }
  }
  window.Worker = TracedPageWorker

  const seenToasts = new WeakSet<Element>()
  new MutationObserver(() => {
    for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
      if (seenToasts.has(toast)) continue
      const text = toast.textContent?.trim()
      if (!text) continue
      seenToasts.add(toast)
      trace.toasts.push({ text, at: performance.now() })
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })

  window.addEventListener('lumaforge-export-debug', (event) => {
    trace.exportEvents.push(
      (event as CustomEvent).detail as PageTrace['exportEvents'][number],
    )
  })

  // Stand-ins for the share sheet and the clipboard: each records what the
  // page handed it, so a refused delivery shows up as nothing recorded.
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (data?: ShareData) => Boolean(data?.files?.length),
  })
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data: ShareData) => {
      for (const file of data.files ?? []) {
        trace.shared.push({ name: file.name, size: file.size, type: file.type })
      }
    },
  })
  class RecordedClipboardItem {
    items: Record<string, Blob | Promise<Blob>>
    constructor(items: Record<string, Blob | Promise<Blob>>) {
      this.items = items
    }

    get types() {
      return Object.keys(this.items)
    }

    static supports(type: string) {
      return type === 'image/jpeg' || type === 'image/png'
    }
  }
  Object.defineProperty(window, 'ClipboardItem', {
    configurable: true,
    writable: true,
    value: RecordedClipboardItem,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async write(items: RecordedClipboardItem[]) {
        for (const item of items) {
          for (const type of item.types) {
            const blob = await item.items[type]!
            trace.copied.push({ type, size: blob.size })
          }
        }
      },
    },
  })

  // Export output lives in origin-private storage where the browser has it.
  // While armed, each JPEG read is read in full and then kept from its
  // delivery until released, so the delivery's own checks run afterwards.
  const handles = (
    window as unknown as {
      FileSystemFileHandle?: { prototype: FileSystemFileHandle }
    }
  ).FileSystemFileHandle
  if (handles?.prototype.getFile) {
    const getFile = handles.prototype.getFile
    handles.prototype.getFile = async function (this: FileSystemFileHandle) {
      const file = await getFile.call(this)
      if (!trace.delivery.armed || !/\.jpe?g$/i.test(this.name)) return file
      const bytes = await file.arrayBuffer()
      trace.delivery.held += 1
      await new Promise<void>((resolve) => {
        heldDeliveries.push(resolve)
      })
      return new File([bytes], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      })
    }
  }
}

async function readTrace(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __p3Trace: PageTrace }).__p3Trace,
  )
}

async function setTrace(
  page: Page,
  patch: Partial<
    Pick<
      PageTrace,
      | 'holdRawRequest'
      | 'holdTransformRenders'
      | 'holdIdleTimers'
      | 'holdSettleTimers'
      | 'holdGpuCompletions'
      | 'holdCpuFrames'
      | 'delivery'
    >
  >,
) {
  await page.evaluate((next) => {
    Object.assign(
      (window as unknown as { __p3Trace: PageTrace }).__p3Trace,
      next,
    )
  }, patch)
}

async function release(
  page: Page,
  what:
    | '__p3ReleaseIdleTimers'
    | '__p3ReleaseSettleTimers'
    | '__p3ReleaseRawRequests'
    | '__p3ReleaseTransformRenders'
    | '__p3ReleaseDeliveries'
    | '__p3ReleaseGpuCompletions'
    | '__p3ReleaseCpuFrames',
) {
  await page.evaluate((name) => {
    ;(window as unknown as Record<string, () => void>)[name]!()
  }, what)
}

/** Hands over the CPU frames that arrived before `before`; the rest stay held. */
async function releaseCpuFramesBefore(page: Page, before: number) {
  await page.evaluate((at) => {
    ;(
      window as unknown as { __p3ReleaseCpuFrames: (before?: number) => void }
    ).__p3ReleaseCpuFrames(at)
  }, before)
}

/** Answers the oldest `count` held GPU completions and keeps the rest held. */
async function releaseGpuCompletions(page: Page, count: number) {
  await page.evaluate((oldest) => {
    ;(
      window as unknown as {
        __p3ReleaseGpuCompletions: (count?: number) => void
      }
    ).__p3ReleaseGpuCompletions(oldest)
  }, count)
}

async function now(page: Page) {
  return page.evaluate(() => performance.now())
}

function rawWorkers(trace: PageTrace) {
  return trace.workers.filter((worker) => worker.kind === 'raw')
}

type UploadedFrame = { width: number; height: number; uploadedAt: number }

/**
 * The decoded frames written to GPU textures after `since`, in order. A
 * frame goes up in one task as bands from row 0 down, so every frame read
 * between tasks is whole.
 */
function uploadedFrames(trace: PageTrace, since: number) {
  const frames: UploadedFrame[] = []
  for (const band of trace.gpuUploads.filter((upload) => upload.at > since)) {
    const last = frames.at(-1)
    if (band.y === 0 || !last || last.width !== band.width) {
      frames.push({
        width: band.width,
        height: band.y + band.rows,
        uploadedAt: band.at,
      })
    } else {
      last.height = band.y + band.rows
      last.uploadedAt = band.at
    }
  }
  return frames
}

function requested(worker: TracedWorker, type: string) {
  return worker.requests.some((request) => request.type === type)
}

/** The RAW runtime worker the page opened its newest source session on. */
function sessionWorker(trace: PageTrace) {
  return rawWorkers(trace).findLast((worker) =>
    requested(worker, 'openSession'),
  )
}

function workerByIndex(trace: PageTrace, index: number) {
  return trace.workers.find((worker) => worker.index === index)!
}

function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 1280) <= 640
}

async function openLab(
  page: Page,
  testInfo: TestInfo,
  {
    surface,
    path = '/raw',
  }: { surface: 'mobile' | 'desktop' | 'project'; path?: string },
) {
  await page.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
    // The first-run lens hint is not what these tests are about.
    localStorage.setItem('lumaforge.raw.mobile.lensHintSeen.v1', '1')
  })
  await page.addInitScript(installPageTrace, {
    idleMs: RAW_RUNTIME_IDLE_MS,
    settleMs: BACKING_STORE_SETTLE_MS,
  })
  if (isDesktopChromiumProject(testInfo)) {
    await page.setViewportSize(
      surface === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    )
  }
  await page.goto(rawPreviewUrl(testInfo, path))
  if (surface === 'mobile') expect(isMobile(page)).toBe(true)
  if (surface === 'desktop') expect(isMobile(page)).toBe(false)
}

function uploadDock(page: Page) {
  return page.getByRole('button', { name: /finish a raw with a lut/i })
}

async function chooseRaw(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Browse RAW files' }).click()
  } else {
    await uploadDock(page).click({ position: { x: 24, y: 24 } })
  }
  await (await choosing).setFiles(file)
}

async function chooseReplacement(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Replace RAW' }).click()
  } else {
    await page.locator('[data-raw-header-action="replace"]').click()
  }
  await (await choosing).setFiles(file)
}

function loadedLab(page: Page) {
  return page.locator('.raw-lab[data-raw-lab-state="loaded"]')
}

function emptyLab(page: Page) {
  return page.locator('.raw-lab[data-raw-lab-state="empty"]')
}

async function moveAwayFromToasts(page: Page) {
  // The toast sits over the top of the photo, where the lens is. A pointer
  // left over it holds it open, so it moves away first.
  const viewport = page.viewportSize()!
  await page.mouse.move(viewport.width / 2, viewport.height - 4)
}

async function waitForLoaded(page: Page, name: string) {
  await expect(loadedLab(page)).toBeVisible({ timeout: 120_000 })
  // Ingest reports success only after the bounded HQ decode.
  const loaded = page.getByText(`Loaded ${name}`, { exact: true })
  await expect(loaded).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  await moveAwayFromToasts(page)
  await expect(loaded).toBeHidden({ timeout: 30_000 })
}

/**
 * The public DNG under another name: a distinct source of the same size.
 * With an `orientation`, its first IFD's Orientation tag says so instead.
 */
async function dngFile(
  testInfo: TestInfo,
  name: string,
  { orientation }: { orientation?: number } = {},
) {
  const buffer = await readFile(gateRawFixture(testInfo, PUBLIC_DNG))
  return {
    name,
    mimeType: 'image/x-adobe-dng',
    buffer:
      orientation === undefined ? buffer : withOrientation(buffer, orientation),
  }
}

/** A copy of an upright TIFF-based RAW whose IFD0 Orientation (tag 274) is replaced. */
function withOrientation(bytes: Buffer, orientation: number) {
  const copy = Buffer.from(bytes)
  const little = copy.toString('latin1', 0, 2) === 'II'
  const u16 = (offset: number) =>
    little ? copy.readUInt16LE(offset) : copy.readUInt16BE(offset)
  const u32 = (offset: number) =>
    little ? copy.readUInt32LE(offset) : copy.readUInt32BE(offset)
  const ifd = u32(4)
  for (let index = 0; index < u16(ifd); index++) {
    const entry = ifd + 2 + index * 12
    if (u16(entry) !== 274) continue
    expect(u16(entry + 2), 'Orientation is one SHORT').toBe(3)
    expect(u32(entry + 4), 'Orientation is one SHORT').toBe(1)
    expect(u16(entry + 8), 'the RAW is upright as it ships').toBe(1)
    if (little) copy.writeUInt16LE(orientation, entry + 8)
    else copy.writeUInt16BE(orientation, entry + 8)
    return copy
  }
  throw new Error('The RAW names no orientation in IFD0')
}

function stage(page: Page) {
  return page.getByRole('region', { name: 'RAW preview comparison' })
}

function cpuCanvas(page: Page) {
  return stage(page).locator('canvas[aria-label="Embedded RAW preview"]')
}

function gpuCanvas(page: Page) {
  return page.locator('canvas.raw-preview-canvas')
}

function previewFrame(page: Page) {
  return page.locator('[data-raw-preview-frame]')
}

function lens(page: Page) {
  return page.locator('[data-mobile-compare-lens]')
}

function splitSlider(page: Page) {
  return page.getByRole('slider', {
    name: 'Compare unprocessed RAW and final JPEG',
  })
}

function dockTab(page: Page, name: 'Look' | 'Adjust' | 'Transform') {
  return page
    .getByRole('tablist', { name: 'Lab modes' })
    .getByRole('tab', { name, exact: true })
}

function deck(page: Page) {
  return page.locator('[data-mobile-dock-panel]')
}

function exportAction(page: Page) {
  return page.getByRole('banner').locator('[data-mobile-export-action]')
}

/** Where the export actions and their reasons live on each surface. */
function exportSurface(page: Page) {
  return isMobile(page)
    ? deck(page).locator('[data-mobile-export-panel]')
    : page.locator('[data-raw-export-block="persistent"]')
}

function exportButton(page: Page, name: string) {
  return exportSurface(page).getByRole('button', { name, exact: true })
}

function fullExportButton(page: Page) {
  return exportButton(page, 'Export full-resolution JPEG')
}

function downloadButton(page: Page) {
  return exportButton(page, 'Download')
}

function restoreButton(page: Page) {
  return page.getByRole('button', { name: 'Restore preview' })
}

function transformTool(page: Page) {
  return page.locator('[data-raw-transform-tool]')
}

function transformOverlay(page: Page) {
  return page.locator('[data-raw-transform-preview]')
}

function rotateSlider(page: Page) {
  return transformTool(page).getByRole('slider', {
    name: 'Rotate',
    exact: true,
  })
}

/** Opens a tool: the topbar Export or a dock tab on mobile, a rail card on desktop. */
async function openTool(page: Page, name: 'Transform' | 'Adjust' | 'Export') {
  if (isMobile(page)) {
    if (name === 'Export') {
      if ((await exportAction(page).getAttribute('aria-expanded')) !== 'true') {
        await exportAction(page).click()
      }
      await expect(exportSurface(page)).toBeVisible()
      return
    }
    const tab = dockTab(page, name)
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    return
  }
  const transform = page.locator('[data-tool-card-trigger="transform"]')
  if (
    name !== 'Transform' &&
    (await transform.getAttribute('aria-expanded')) === 'true'
  ) {
    await transform.click()
    await expect(transformTool(page)).not.toBeVisible()
  }
  if (name === 'Export') return
  const trigger = page.locator(
    `[data-tool-card-trigger="${name.toLowerCase()}"]`,
  )
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click()
  }
}

async function waitForTransform(page: Page) {
  const tool = transformTool(page)
  await expect(tool).toBeVisible()
  await expect(
    tool.locator('[data-testid="mode-auto"], [role="slider"]').first(),
  ).toBeEnabled({ timeout: 30_000 })
  if (await transformOverlay(page).count()) {
    await expect(transformOverlay(page)).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    })
  }
  await expect(tool.getByRole('alert')).toHaveCount(0)
}

async function selectPerspective(page: Page) {
  if (!isMobile(page)) return
  await transformTool(page)
    .getByRole('tab', { name: 'Perspective', exact: true })
    .click()
  await expect(
    transformTool(page).locator('[data-transform-list-section="perspective"]'),
  ).toBeVisible()
}

async function transformMatrix(page: Page) {
  const value = await transformOverlay(page).getAttribute(
    'data-transform-matrix',
  )
  expect(value, 'the overlay names the geometry it shows').toBeTruthy()
  return value!.split(',').map(Number)
}

async function nudgeExposure(page: Page, steps: number) {
  await openTool(page, 'Adjust')
  const exposure = (isMobile(page) ? deck(page) : page).getByRole('slider', {
    name: 'Exposure',
    exact: true,
  })
  await expect(exposure).toBeEnabled()
  await exposure.focus()
  for (let step = 0; step < steps; step++) await exposure.press('PageUp')
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0')
}

/** Libjpeg-style marker walk: the frame size from the SOF segment. */
function readJpegSize(bytes: Buffer) {
  expect(bytes.readUInt16BE(0), 'a JPEG starts with SOI').toBe(0xFFD8)
  let offset = 2
  while (offset + 4 <= bytes.length) {
    expect(bytes[offset], `JPEG marker at ${offset}`).toBe(0xFF)
    const marker = bytes[offset + 1]!
    const length = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xC0 && marker <= 0xC2) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      }
    }
    if (marker === 0xDA) break
    offset += 2 + length
  }
  throw new Error('The JPEG has no frame header')
}

async function readDownload(download: Download): Promise<JpegFile> {
  const path = await download.path()
  expect(path, 'the download lands on disk').toBeTruthy()
  const bytes = await readFile(path!)
  return {
    name: download.suggestedFilename(),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...readJpegSize(bytes),
  }
}

async function downloadJpeg(page: Page) {
  await expect(downloadButton(page)).toBeEnabled({ timeout: 240_000 })
  const downloading = page.waitForEvent('download')
  await downloadButton(page).click()
  return readDownload(await downloading)
}

async function downloadManifest(page: Page) {
  // Mobile names the action in full; the desktop result row says Manifest.
  const button = exportButton(
    page,
    isMobile(page) ? 'Download render manifest (JSON)' : 'Manifest',
  )
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  const download = await downloading
  const manifest = JSON.parse(
    await readFile((await download.path())!, 'utf8'),
  ) as ExportManifest
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  return manifest
}

/** Starts the full-resolution export and waits until its file is ready. */
async function exportFullResolution(page: Page) {
  await openTool(page, 'Export')
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 60_000 })
  await fullExportButton(page).click()
  await expect(downloadButton(page)).toBeVisible({ timeout: 300_000 })
}

/** The CPU canvas pixels, hashed, once the worker answered its last render. */
async function settledCpuFrame(page: Page) {
  await expect(cpuCanvas(page)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('cpu-preview-spinner')).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect
    .poll(
      async () => {
        const trace = await readTrace(page)
        const last = trace.cpuRenders.at(-1)
        return Boolean(
          last &&
          trace.cpuFrames.some(
            (frame) =>
              frame.worker === last.worker &&
              frame.requestId === last.requestId,
          ),
        )
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  return cpuCanvas(page).evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas
      .getContext('2d')!
      .getImageData(0, 0, canvas.width, canvas.height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  })
}

/**
 * The photo is on screen under the project's executor: a load ends on its
 * bounded HQ frame, a Restore on a fresh quick frame.
 */
async function expectPreviewShown(
  page: Page,
  testInfo: TestInfo,
  source: 'bounded-hq' | 'quick' = 'bounded-hq',
) {
  if (projectHasWebGPU(testInfo)) {
    await expectWebGPUPreview(page, testInfo)
    await expect(previewFrame(page)).toHaveAttribute(
      'data-display-source',
      source,
      { timeout: 120_000 },
    )
    await expect(
      page.locator('[data-raw-compare-track="image"]'),
    ).toHaveAttribute('data-preview-track-ready', 'true', { timeout: 60_000 })
    return
  }
  await settledCpuFrame(page)
}

/**
 * The lens each executor offers: the GPU preview's tap opens the split, the
 * CPU preview's tap pins the original, which the CPU worker draws as its
 * neutral variant of the source it was given. Returns the source the
 * original was drawn from on the CPU preview.
 */
async function expectExecutorLens(page: Page, testInfo: TestInfo) {
  await expect(lens(page)).toBeVisible({ timeout: 60_000 })
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await lens(page).hover()
  if (projectHasWebGPU(testInfo)) {
    await expect(lens(page)).toHaveAttribute('data-lens-mode', 'split')
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(splitSlider(page)).toBeVisible()
    await lens(page).click()
    await expect(splitSlider(page)).toHaveCount(0)
    return null
  }
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
  const processed = await settledCpuFrame(page)
  const before = (await readTrace(page)).cpuRenders.length
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(
      async () =>
        (await readTrace(page)).cpuRenders.slice(before).map((r) => r.variant),
      { timeout: 60_000 },
    )
    .toEqual(['neutral'])
  expect(await settledCpuFrame(page)).not.toBe(processed)
  const neutral = (await readTrace(page)).cpuRenders.at(-1)!
  await expect(splitSlider(page)).toHaveCount(0)
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => (await readTrace(page)).cpuRenders.at(-1)?.variant, {
      timeout: 60_000,
    })
    .toBe('processed')
  expect(await settledCpuFrame(page)).toBe(processed)
  return neutral.sourceId
}

/** A photo as a 32x24 grid of mean light, row by row. */
type PhotoSignature = number[]

type PhotoCapture = {
  signature: PhotoSignature
  /** Mean and 99th percentile of each pixel's brightest channel. */
  mean: number
  p99: number
}

/** Pearson correlation of two signatures. */
function correlation(left: PhotoSignature, right: PhotoSignature) {
  const mean = (values: PhotoSignature) =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  const leftMean = mean(left)
  const rightMean = mean(right)
  let covariance = 0
  let leftSpread = 0
  let rightSpread = 0
  for (let index = 0; index < left.length; index++) {
    const l = left[index]! - leftMean
    const r = right[index]! - rightMean
    covariance += l * r
    leftSpread += l * l
    rightSpread += r * r
  }
  return covariance / Math.sqrt(leftSpread * rightSpread)
}

/** The signature of the same photo turned half a turn. */
function halfTurn(signature: PhotoSignature) {
  return [...signature].reverse()
}

/**
 * The chrome and the embedded JPEG stand-ins over the GPU photo, hidden
 * for a capture so only the photo layers remain; the track and the canvas
 * show even before they count as ready, so a capture reads what the canvas
 * holds rather than what readiness lets show.
 */
const PHOTO_ONLY_STYLE = `
  .raw-lab-compare-handle, .raw-lab-compare-label, [data-mobile-lab-chrome],
  [data-mobile-compare-lens], [data-sonner-toaster],
  [data-raw-preview-handoff-preview], .raw-preview-embedded {
    visibility: hidden !important;
  }
  [data-raw-compare-track] { visibility: visible !important; opacity: 1 !important; }
  canvas.raw-preview-canvas { opacity: 1 !important; }
`
const LAYERS_UNCLIPPED_STYLE = `
  .raw-preview-original-gpu-shell, .raw-preview-processed-layer {
    clip-path: none !important;
    -webkit-clip-path: none !important;
  }
`
/** The processed layer over the original as their per-pixel difference. */
const LAYER_DIFFERENCE_STYLE = `${LAYERS_UNCLIPPED_STYLE}
  .raw-preview-processed-layer { mix-blend-mode: difference !important; }
`
const ORIGINAL_LAYER_ONLY_STYLE = `${LAYERS_UNCLIPPED_STYLE}
  .raw-preview-processed-layer { visibility: hidden !important; }
`
const PROCESSED_LAYER_ONLY_STYLE = `${LAYERS_UNCLIPPED_STYLE}
  .raw-preview-original-gpu-shell { visibility: hidden !important; }
`

/**
 * The GPU photo as the page composites it: the processed canvas's box,
 * inset from its edges, under `style`. A WebGPU canvas cannot be read back
 * from script once presented, so the capture is a screenshot.
 */
async function captureGpuPhoto(page: Page, style = '') {
  const box = await gpuCanvas(page).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const viewport = page.viewportSize()!
  const x = Math.ceil(box.x) + 3
  const y = Math.ceil(box.y) + 3
  const clip = {
    x,
    y,
    width: Math.floor(Math.min(box.x + box.width, viewport.width)) - 3 - x,
    height: Math.floor(Math.min(box.y + box.height, viewport.height)) - 3 - y,
  }
  expect(clip.width, 'the photo has a box to capture').toBeGreaterThan(64)
  expect(clip.height, 'the photo has a box to capture').toBeGreaterThan(48)
  const png = await page.screenshot({ clip, style: PHOTO_ONLY_STYLE + style })
  return readPhotoCapture(page, png)
}

/** Decodes a PNG capture in the page into its signature and light. */
async function readPhotoCapture(
  page: Page,
  png: Buffer,
): Promise<PhotoCapture> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' }),
    )
    const full = new OffscreenCanvas(bitmap.width, bitmap.height)
    const fullContext = full.getContext('2d')!
    fullContext.drawImage(bitmap, 0, 0)
    const pixels = fullContext.getImageData(
      0,
      0,
      bitmap.width,
      bitmap.height,
    ).data
    const light: number[] = []
    for (let offset = 0; offset < pixels.length; offset += 4) {
      light.push(
        Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!),
      )
    }
    const sorted = [...light].sort((a, b) => a - b)
    const grid = new OffscreenCanvas(32, 24)
    const gridContext = grid.getContext('2d')!
    gridContext.drawImage(bitmap, 0, 0, 32, 24)
    bitmap.close()
    const cells = gridContext.getImageData(0, 0, 32, 24).data
    const signature: number[] = []
    for (let offset = 0; offset < cells.length; offset += 4) {
      signature.push(
        (cells[offset]! + cells[offset + 1]! + cells[offset + 2]!) / 3,
      )
    }
    return {
      signature,
      mean: light.reduce((sum, value) => sum + value, 0) / light.length,
      p99: sorted[Math.floor(sorted.length * 0.99)]!,
    }
  }, png.toString('base64'))
}

/**
 * The photo on screen under the project's executor, as a signature: the
 * GPU canvas captured, or the CPU canvas's photo rect (the frame's aspect,
 * centred) read back.
 */
async function photoSignature(page: Page, testInfo: TestInfo) {
  if (projectHasWebGPU(testInfo)) {
    return (await captureGpuPhoto(page)).signature
  }
  return cpuCanvas(page).evaluate((element, aspect) => {
    const canvas = element as HTMLCanvasElement
    const fitWidth = Math.min(canvas.width, canvas.height * aspect)
    const fitHeight = fitWidth / aspect
    const inset = 0.02
    const grid = new OffscreenCanvas(32, 24)
    const context = grid.getContext('2d')!
    context.drawImage(
      canvas,
      (canvas.width - fitWidth) / 2 + fitWidth * inset,
      (canvas.height - fitHeight) / 2 + fitHeight * inset,
      fitWidth * (1 - 2 * inset),
      fitHeight * (1 - 2 * inset),
      0,
      0,
      32,
      24,
    )
    const cells = context.getImageData(0, 0, 32, 24).data
    const signature: number[] = []
    for (let offset = 0; offset < cells.length; offset += 4) {
      signature.push(
        (cells[offset]! + cells[offset + 1]! + cells[offset + 2]!) / 3,
      )
    }
    return signature
  }, PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height)
}

/** The photo on screen is the reference photo turned half a turn. */
function expectHalfTurnOf(
  shown: PhotoSignature,
  reference: PhotoSignature,
  label: string,
) {
  expect(
    correlation(shown, halfTurn(reference)),
    `${label}: the photo is the replacement's own`,
  ).toBeGreaterThan(0.9)
  expect(
    correlation(shown, reference),
    `${label}: the photo is not the replaced RAW's`,
  ).toBeLessThan(0.5)
}

type LayerAlignment = {
  difference: { mean: number; p99: number }
  /** How closely each layer alone matches the reference photo. */
  original: number
  processed: number
}

/** The two GPU layers, unclipped: their difference and each alone. */
async function measureLayers(
  page: Page,
  reference: PhotoSignature,
): Promise<LayerAlignment> {
  const difference = await captureGpuPhoto(page, LAYER_DIFFERENCE_STYLE)
  const original = await captureGpuPhoto(page, ORIGINAL_LAYER_ONLY_STYLE)
  const processed = await captureGpuPhoto(page, PROCESSED_LAYER_ONLY_STYLE)
  return {
    difference: { mean: difference.mean, p99: difference.p99 },
    original: correlation(original.signature, reference),
    processed: correlation(processed.signature, reference),
  }
}

/**
 * With nothing edited, the original layer draws the very pixels the
 * processed layer does, so where the two coincide their difference is
 * black; a layer a pixel off, scaled apart, holding another frame or
 * blank leaves light in it. Each layer alone also has to be the photo,
 * so two blank layers do not pass.
 */
function layersAligned(alignment: LayerAlignment) {
  return (
    alignment.difference.mean <= 2 &&
    alignment.difference.p99 <= 16 &&
    alignment.original >= 0.95 &&
    alignment.processed >= 0.95
  )
}

function expectLayersAligned(alignment: LayerAlignment, label: string) {
  expect(
    alignment.difference.mean,
    `${label}: mean layer difference`,
  ).toBeLessThanOrEqual(2)
  expect(
    alignment.difference.p99,
    `${label}: layer difference p99`,
  ).toBeLessThanOrEqual(16)
  expect(
    alignment.original,
    `${label}: the original layer is the photo`,
  ).toBeGreaterThanOrEqual(0.95)
  expect(
    alignment.processed,
    `${label}: the processed layer is the photo`,
  ).toBeGreaterThanOrEqual(0.95)
}

async function expectLayersAlignedSoon(
  page: Page,
  reference: PhotoSignature,
  label: string,
) {
  let last: LayerAlignment | null = null
  await expect
    .poll(
      async () => {
        last = await measureLayers(page, reference)
        return layersAligned(last)
      },
      { message: label, timeout: 15_000, intervals: [100, 200, 400] },
    )
    .toBe(true)
  expectLayersAligned(last!, label)
}

type Box = { x: number; y: number; width: number; height: number }

function boxDistance(left: Box, right: Box) {
  return Math.max(
    Math.abs(left.x - right.x),
    Math.abs(left.y - right.y),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  )
}

/** The processed canvas's box and how many stage inset transitions run. */
async function stageMotion(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.raw-lab-stage')!
    const rect = document
      .querySelector('canvas.raw-preview-canvas')!
      .getBoundingClientRect()
    return {
      running: stage
        .getAnimations()
        .filter((animation) => animation.playState === 'running').length,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })
}

type LayerSample = {
  at: number
  mode: string | null
  insetTop: string
  insetBottom: string
  processed: Box | null
  original: Box | null
}

/**
 * The GPU split on the mobile stage: the processed canvas and the original
 * layer over it show one photo, pixel on pixel, while decks of different
 * heights come and go under them and the stage insets animate, and the
 * split stays dual-GPU throughout. On a short phone each deck takes its
 * height from the photo, so every transition moves and resizes it.
 *
 * Each transition is frozen part-way: the layers are compared while CSS
 * alone scales their backing stores, again once the backing stores have
 * followed the moving box and redrawn, and again after the motion settles.
 * The two layers' boxes are also sampled every animation frame throughout.
 */
async function expectDualGpuLayersAligned(page: Page) {
  await page.setViewportSize(SHORT_MOBILE_VIEWPORT)
  if ((await dockTab(page, 'Look').getAttribute('aria-selected')) !== 'true') {
    await dockTab(page, 'Look').click()
  }
  await expect.poll(async () => (await stageMotion(page)).running).toBe(0)
  await page.waitForTimeout(600)

  await lens(page).hover()
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'split')
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(splitSlider(page)).toBeVisible()
  await expect(page.locator('[data-compare-mode]')).toHaveAttribute(
    'data-compare-mode',
    'dual-gpu',
    { timeout: 60_000 },
  )
  await expect(
    page.locator('canvas.raw-preview-original-gpu-canvas'),
  ).toHaveCount(1)
  await moveAwayFromToasts(page)
  const reference = (await captureGpuPhoto(page, PROCESSED_LAYER_ONLY_STYLE))
    .signature
  await expectLayersAlignedSoon(page, reference, 'the split at rest')

  await page.evaluate(() => {
    const samples: LayerSample[] = []
    const state = { samples, running: true }
    Object.assign(window, { __p3Layers: state })
    const box = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const sample = () => {
      if (!state.running) return
      const stage = document.querySelector('.raw-lab-stage')
      const style = stage ? getComputedStyle(stage) : null
      samples.push({
        at: performance.now(),
        mode:
          document
            .querySelector('[data-compare-mode]')
            ?.getAttribute('data-compare-mode') ?? null,
        insetTop: style?.paddingTop ?? '',
        insetBottom: style?.paddingBottom ?? '',
        processed: box('canvas.raw-preview-canvas'),
        original: box('canvas.raw-preview-original-gpu-canvas'),
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  // A tap on the photo, clear of the split handle, goes immersive: the
  // chrome leaves and the stage insets animate to the full bleed and back.
  const tapPhoto = async () => {
    const box = (await previewFrame(page).boundingBox())!
    await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2)
  }
  const transitions = [
    {
      label: 'the Adjust deck',
      act: () => dockTab(page, 'Adjust').click(),
      done: () =>
        expect(dockTab(page, 'Adjust')).toHaveAttribute(
          'aria-selected',
          'true',
        ),
    },
    {
      label: 'the Look deck',
      act: () => dockTab(page, 'Look').click(),
      done: () =>
        expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true'),
    },
    {
      label: 'the export panel opening',
      act: () => exportAction(page).click(),
      done: () => expect(exportSurface(page)).toBeVisible(),
    },
    {
      label: 'the export panel closing',
      act: () => exportAction(page).click(),
      done: () => expect(exportSurface(page)).toHaveCount(0),
    },
    {
      label: 'going immersive',
      act: tapPhoto,
      done: () => expect(page.getByRole('banner')).toHaveCount(0),
    },
    {
      label: 'leaving immersive',
      act: tapPhoto,
      done: () => expect(page.getByRole('banner')).toBeVisible(),
    },
  ]

  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Animation.enable')
  const playbackRate = (rate: number) =>
    devtools.send('Animation.setPlaybackRate', { playbackRate: rate })
  try {
    for (const { label, act, done } of transitions) {
      const start = (await stageMotion(page)).box
      // The backing stores keep their size while the box moves, and the
      // insets move at a twentieth of their speed until they stop.
      await setTrace(page, { holdSettleTimers: true })
      await playbackRate(0.05)
      await act()
      await page.waitForTimeout(800)
      await playbackRate(0)
      const frozen = await stageMotion(page)
      expect(frozen.running, `${label}: the insets are moving`).toBeGreaterThan(
        0,
      )
      expect(
        boxDistance(frozen.box, start),
        `${label}: the photo has moved`,
      ).toBeGreaterThan(1)
      expectLayersAligned(
        await measureLayers(page, reference),
        `${label}, part-way, scaled by CSS`,
      )
      // The backing stores follow the box where it stands and redraw.
      await release(page, '__p3ReleaseSettleTimers')
      await expectLayersAlignedSoon(
        page,
        reference,
        `${label}, part-way, redrawn at the new size`,
      )
      await playbackRate(1)
      await expect
        .poll(async () => (await stageMotion(page)).running, {
          timeout: 10_000,
        })
        .toBe(0)
      await done()
      const settled = (await stageMotion(page)).box
      expect(
        boxDistance(settled, frozen.box),
        `${label}: the freeze was part-way`,
      ).toBeGreaterThan(1)
      await expectLayersAlignedSoon(page, reference, `${label}, settled`)
    }
  } finally {
    await playbackRate(1).catch(() => {})
    await setTrace(page, { holdSettleTimers: false })
    await release(page, '__p3ReleaseSettleTimers')
    await devtools.detach().catch(() => {})
  }

  const samples = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __p3Layers: { samples: LayerSample[]; running: boolean }
      }
    ).__p3Layers
    state.running = false
    return state.samples
  })
  expect(samples.length).toBeGreaterThan(30)
  // The stage insets moved, so the boxes were sampled through their motion.
  const insets = new Set(
    samples.map((sample) => `${sample.insetTop}/${sample.insetBottom}`),
  )
  expect(insets.size).toBeGreaterThan(2)
  const boxes = new Set(
    samples.map((sample) =>
      sample.processed
        ? `${sample.processed.width.toFixed(1)}x${sample.processed.height.toFixed(1)}@${sample.processed.y.toFixed(1)}`
        : 'none',
    ),
  )
  expect(boxes.size).toBeGreaterThan(2)
  for (const sample of samples) {
    expect(sample.mode, `compare mode at ${sample.at}`).toBe('dual-gpu')
    expect(sample.processed, `processed layer at ${sample.at}`).not.toBeNull()
    expect(sample.original, `original layer at ${sample.at}`).not.toBeNull()
    expect(
      boxDistance(sample.processed!, sample.original!),
      `the two layers' boxes at ${sample.at}`,
    ).toBeLessThanOrEqual(1)
  }

  await lens(page).hover()
  await lens(page).click()
  await expect(splitSlider(page)).toHaveCount(0)
  await page.setViewportSize(MOBILE_VIEWPORT)
  await expect.poll(async () => (await stageMotion(page)).running).toBe(0)
  await page.waitForTimeout(600)
}

function toastsMentioning(trace: PageTrace, text: string) {
  return trace.toasts.filter((toast) => toast.text.includes(text))
}

test('route departure: leaving /raw ends the loaded session and a pending load with it; coming back opens an empty lab that loads the next RAW on a fresh runtime', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(420_000)
  const first = await dngFile(testInfo, 'departed-loaded.dng')
  const pending = await dngFile(testInfo, 'departed-pending.dng')
  const next = await dngFile(testInfo, 'after-return.dng')
  await openLab(page, testInfo, { surface: 'project', path: '/' })
  const openRawLab = page.locator('.lf-hero-actions a[href="/raw"]')
  const landing = page.locator('#lf-hero-title')
  await expect(landing).toBeVisible()
  // A full document load would reset this mark: every route change below
  // stays inside one page and one router.
  await page.evaluate(() => {
    ;(window as unknown as { __p3Document: string }).__p3Document = 'same'
  })
  const sameDocument = () =>
    page.evaluate(
      () => (window as unknown as { __p3Document?: string }).__p3Document,
    )

  // A loaded session, then the route is left.
  await openRawLab.click()
  await expect(page).toHaveURL(/\/raw$/)
  await chooseRaw(page, first)
  await waitForLoaded(page, first.name)
  await expectPreviewShown(page, testInfo)
  const loadedOn = sessionWorker(await readTrace(page))!

  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(landing).toBeVisible()
  await expect(page.locator('.raw-lab')).toHaveCount(0)
  expect(await sameDocument()).toBe('same')
  // The departed mount's CPU preview and Transform workers end with it.
  await expect
    .poll(
      async () =>
        (await readTrace(page)).workers
          .filter(
            (worker) =>
              (worker.kind === 'cpu-preview' || worker.kind === 'transform') &&
              worker.terminatedAt === null,
          )
          .map((worker) => worker.index),
      { timeout: 30_000 },
    )
    .toEqual([])

  // Coming back finds no session: the photo, its name and its tools are
  // gone, and nothing the departed mount started reports.
  const returnedAt = await now(page)
  await page.goForward()
  await expect(page).toHaveURL(/\/raw$/)
  await expect(emptyLab(page)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(emptyLab(page)).toBeVisible()
  await expect(loadedLab(page)).toHaveCount(0)
  await expect(page.getByText(first.name, { exact: true })).toHaveCount(0)
  await expect(gpuCanvas(page)).toHaveCount(0)
  await expect(cpuCanvas(page)).toHaveCount(0)
  let trace = await readTrace(page)
  expect(
    trace.toasts.filter((toast) => toast.at > returnedAt).map((t) => t.text),
  ).toEqual([])
  // Nothing asks the departed session's runtime for more work.
  const since = workerByIndex(trace, loadedOn.index).requests.filter(
    (request) => request.at > returnedAt && request.type !== 'closeSession',
  )
  expect(since).toEqual([])

  // A load still waiting on its bounded HQ when the route is left. The idle
  // window is held, so only an explicit end can stop its runtime.
  await setTrace(page, {
    holdIdleTimers: true,
    holdRawRequest: 'decodeBoundedHqFromSession',
  })
  await chooseRaw(page, pending)
  await expect(loadedLab(page)).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(async () => (await readTrace(page)).heldRawRequests, {
      timeout: 120_000,
    })
    .toBe(1)
  const stalled = sessionWorker(await readTrace(page))!
  expect(stalled.index).not.toBe(loadedOn.index)
  expect(stalled.terminatedAt).toBeNull()

  const departedAt = await now(page)
  await page.goBack()
  await expect(landing).toBeVisible()
  await expect(page.locator('.raw-lab')).toHaveCount(0)
  // The departure ends the stalled runtime itself; the idle window could not.
  await expect
    .poll(
      async () =>
        workerByIndex(await readTrace(page), stalled.index).terminatedAt,
      { timeout: 30_000 },
    )
    .not.toBeNull()
  trace = await readTrace(page)
  expect(workerByIndex(trace, stalled.index).terminatedAt!).toBeGreaterThan(
    departedAt,
  )
  // The held request now reaches no runtime: the one it was for has ended.
  await release(page, '__p3ReleaseRawRequests')
  await release(page, '__p3ReleaseIdleTimers')
  await page.waitForTimeout(2_000)

  const returnedAgainAt = await now(page)
  await openRawLab.click()
  await expect(page).toHaveURL(/\/raw$/)
  expect(await sameDocument()).toBe('same')
  await expect(emptyLab(page)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(loadedLab(page)).toHaveCount(0)
  await expect(page.getByText(pending.name, { exact: true })).toHaveCount(0)
  trace = await readTrace(page)
  expect(toastsMentioning(trace, pending.name)).toEqual([])
  expect(
    trace.toasts
      .filter((toast) => toast.at > departedAt)
      .map((toast) => toast.text),
  ).toEqual([])

  // The next RAW loads on a runtime started after the departures, and only
  // its own load reports.
  await chooseRaw(page, next)
  await waitForLoaded(page, next.name)
  await expectPreviewShown(page, testInfo)
  trace = await readTrace(page)
  const current = sessionWorker(trace)!
  expect(current.index).not.toBe(stalled.index)
  expect(current.createdAt).toBeGreaterThan(departedAt)
  expect(requested(current, 'decodeBoundedHqFromSession')).toBe(true)
  const reported = trace.toasts.filter((toast) => toast.at > returnedAgainAt)
  expect(reported).toHaveLength(1)
  expect(reported[0]!.text.startsWith(`Loaded ${next.name}`)).toBe(true)
  if (!projectHasWebGPU(testInfo)) {
    // The CPU preview draws only sources this mount was handed.
    const sources = new Set(
      trace.cpuSources
        .filter((source) => source.at > returnedAgainAt)
        .map((source) => `${source.worker}:${source.sourceId}`),
    )
    const last = trace.cpuRenders.at(-1)!
    expect(sources.has(`${last.worker}:${last.sourceId}`)).toBe(true)
  }
})

test('equal-sized replacement: a RAW the size of the one it replaces shows its own pixels, from its own quick frame until its own bounded HQ, and an answer the replaced RAW was owed readies nothing, under the mobile dock, deck and executor lens', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(420_000)
  const gpu = projectHasWebGPU(testInfo)
  // The same sensor data turned half a turn: frames of the very same size
  // whose pixels tell the two RAWs apart.
  const first = await dngFile(testInfo, 'replaced-first.dng')
  const second = await dngFile(testInfo, 'replacing-second.dng', {
    orientation: 3,
  })
  await openLab(page, testInfo, { surface: 'mobile' })
  // On the GPU preview the first RAW's bounded HQ is held at first, so its
  // HQ frame can be left waiting for the GPU's answer below.
  if (gpu)
    await setTrace(page, { holdRawRequest: 'decodeBoundedHqFromSession' })
  await chooseRaw(page, first)
  if (gpu) {
    await expect
      .poll(async () => (await readTrace(page)).heldRawRequests, {
        timeout: 120_000,
      })
      .toBe(1)
    await expectPreviewShown(page, testInfo, 'quick')
  } else {
    await waitForLoaded(page, first.name)
    await expectPreviewShown(page, testInfo)
  }
  await moveAwayFromToasts(page)
  const reference = await photoSignature(page, testInfo)
  let trace = await readTrace(page)
  const firstSources = trace.cpuSources.map(
    (source) => `${source.worker}:${source.sourceId}`,
  )
  if (!gpu) {
    expect(firstSources.length).toBeGreaterThanOrEqual(1)
  }

  // The replaced RAW is owed an answer when it is replaced. On the GPU
  // preview its HQ frame is drawn and waits for the GPU to answer that it
  // was; on the CPU preview a render it asked for is answered by the worker
  // and kept from the page.
  const owedFrom = await now(page)
  if (gpu) {
    await setTrace(page, { holdGpuCompletions: true })
    await release(page, '__p3ReleaseRawRequests')
    await expect
      .poll(
        async () => {
          const traced = await readTrace(page)
          const hq = uploadedFrames(traced, owedFrom).at(-1)
          return Boolean(
            hq &&
            hq.width * hq.height > QUICK_PREVIEW_MAX_PIXELS &&
            traced.heldGpuCompletions.some((at) => at > hq.uploadedAt),
          )
        },
        { timeout: 120_000 },
      )
      .toBe(true)
    await waitForLoaded(page, first.name)
    // Marks the surface that drew the first RAW.
    await gpuCanvas(page).evaluate((element) => {
      element.setAttribute('data-p3-first-surface', '')
    })
  } else {
    await setTrace(page, { holdCpuFrames: true })
    await nudgeExposure(page, 1)
    await expect
      .poll(async () => (await readTrace(page)).heldCpuFrames.length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(1)
  }
  trace = await readTrace(page)
  const owed = gpu ? trace.pendingGpuCompletions : trace.pendingCpuFrames
  expect(owed, 'the replaced RAW is owed an answer').toBeGreaterThanOrEqual(1)

  // The replacement's bounded HQ is held, so only its quick frame can show.
  const heldHq = trace.heldRawRequests + 1
  await setTrace(page, { holdRawRequest: 'decodeBoundedHqFromSession' })
  const replacedAt = await now(page)
  await chooseReplacement(page, second)
  await expect
    .poll(async () => (await readTrace(page)).heldRawRequests, {
      timeout: 120_000,
    })
    .toBe(heldHq)
  await expect(loadedLab(page)).toBeVisible()
  trace = await readTrace(page)
  // The replacement opens its own session, on the warm runtime or a fresh
  // one.
  const opens = rawWorkers(trace).flatMap((worker) =>
    worker.requests.filter((request) => request.type === 'openSession'),
  )
  expect(opens).toHaveLength(2)
  const replacementOpenedAt = Math.max(...opens.map((request) => request.at))
  expect(replacementOpenedAt).toBeGreaterThan(replacedAt)
  const handoff = page.locator('[data-raw-preview-handoff-preview]')
  const track = page.locator('[data-raw-compare-track="image"]')

  if (gpu) {
    // The replacement's quick frame reaches the GPU after its session
    // opened, and is drawn after it arrived; the GPU's answer is held.
    await expectWebGPUPreview(page, testInfo)
    await expect(previewFrame(page)).toHaveAttribute(
      'data-display-source',
      'quick',
      { timeout: 60_000 },
    )
    let quickFrame: UploadedFrame | undefined
    await expect
      .poll(
        async () => {
          quickFrame = uploadedFrames(
            await readTrace(page),
            replacementOpenedAt,
          ).at(-1)
          return quickFrame !== undefined
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    expect(quickFrame!.width * quickFrame!.height).toBeLessThanOrEqual(
      QUICK_PREVIEW_MAX_PIXELS,
    )
    expect(quickFrame!.width / quickFrame!.height).toBeCloseTo(
      PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height,
      2,
    )
    await expect
      .poll(
        async () =>
          (await readTrace(page)).heldGpuCompletions.filter(
            (at) => at > quickFrame!.uploadedAt,
          ).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(1)
    // It draws on a surface of its own: the canvas that drew the first RAW,
    // with the frame and readiness it held, has left the stage.
    await expect(gpuCanvas(page)).toHaveCount(1)
    await expect(page.locator('canvas[data-p3-first-surface]')).toHaveCount(0)
    // Before anything counts as ready, the new surface already holds the
    // replacement's own pixels, not the first RAW's.
    expectHalfTurnOf(
      await photoSignature(page, testInfo),
      reference,
      'drawn, not yet answered',
    )
    trace = await readTrace(page)
    // Every answer the replaced RAW was owed was asked for before the
    // replacement's frame went up; the rest are the replacement's.
    const owedNow = trace.heldGpuCompletions.filter(
      (at) => at < quickFrame!.uploadedAt,
    ).length
    expect(owedNow).toBeGreaterThanOrEqual(owed)
    expect(trace.pendingGpuCompletions).toBeGreaterThan(owedNow)
    const replacementOwed = trace.pendingGpuCompletions - owedNow
    // The embedded JPEG covers the stage for as long as the quick frame on
    // screen does not count as drawn.
    await expect(handoff).toBeVisible()

    // The replaced RAW's answers arrive late, the replacement's still held:
    // nothing becomes ready for the replacement, though the first RAW's
    // frames had the same size.
    await releaseGpuCompletions(page, owedNow)
    await page.waitForTimeout(1_500)
    expect((await readTrace(page)).pendingGpuCompletions).toBe(replacementOwed)
    await expect(handoff).toBeVisible()
    await expect(previewFrame(page)).toHaveAttribute(
      'data-display-source',
      'quick',
    )

    // Once the GPU answers for the replacement, its quick frame takes the
    // stage while its bounded HQ is still held.
    await release(page, '__p3ReleaseGpuCompletions')
    await expect(handoff).toHaveCount(0, { timeout: 30_000 })
    await expect(track).toHaveAttribute('data-preview-track-ready', 'true', {
      timeout: 60_000,
    })
    await page.waitForTimeout(1_500)
    await expect(previewFrame(page)).toHaveAttribute(
      'data-display-source',
      'quick',
    )
    expect((await readTrace(page)).heldRawRequests).toBe(heldHq)
  } else {
    // The CPU preview draws a source handed to it for the replacement, never
    // a source of the first RAW, however alike their frames are.
    await expect
      .poll(
        async () => {
          const traced = await readTrace(page)
          return traced.heldCpuFrames.filter((frame) => frame.at > replacedAt)
            .length
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(1)
    // Until the replacement's frame reaches the page, nothing of either RAW
    // is drawn.
    await expect(cpuCanvas(page)).toHaveCount(0)
    await expect(page.getByTestId('cpu-preview-spinner')).toBeVisible()

    // The frame the replaced RAW was owed arrives late, the replacement's
    // still held: it draws nothing and settles nothing.
    await releaseCpuFramesBefore(page, replacedAt)
    await page.waitForTimeout(1_500)
    trace = await readTrace(page)
    expect(trace.pendingCpuFrames).toBeGreaterThanOrEqual(1)
    await expect(cpuCanvas(page)).toHaveCount(0)
    await expect(page.getByTestId('cpu-preview-spinner')).toBeVisible()

    await release(page, '__p3ReleaseCpuFrames')
    await settledCpuFrame(page)
    trace = await readTrace(page)
    const handed = trace.cpuSources.filter((source) => source.at > replacedAt)
    expect(handed.length).toBeGreaterThanOrEqual(1)
    for (const source of handed) {
      expect(firstSources).not.toContain(`${source.worker}:${source.sourceId}`)
    }
    const quick = handed.at(-1)!
    expect(quick.width).toBeLessThan(PUBLIC_DNG_SIZE.width)
    const last = trace.cpuRenders.at(-1)!
    expect(`${last.worker}:${last.sourceId}`).toBe(
      `${quick.worker}:${quick.sourceId}`,
    )
    expect(
      trace.cpuRenders
        .filter((render) => render.at > replacementOpenedAt)
        .filter((render) =>
          firstSources.includes(`${render.worker}:${render.sourceId}`),
        ),
    ).toEqual([])
  }
  // The photo on screen is the replacement's own quick frame.
  expectHalfTurnOf(
    await photoSignature(page, testInfo),
    reference,
    'the quick frame',
  )
  // The replacement has not reported a finished load yet.
  trace = await readTrace(page)
  expect(toastsMentioning(trace, `Loaded ${second.name}`)).toEqual([])

  // Its bounded HQ answers: the replacement's own HQ frame takes over and
  // the load reports.
  await release(page, '__p3ReleaseRawRequests')
  await waitForLoaded(page, second.name)
  await expectPreviewShown(page, testInfo)
  trace = await readTrace(page)
  expect(toastsMentioning(trace, first.name)).toHaveLength(1)
  if (gpu) {
    // The HQ frame on screen went up to the GPU for the replacement too.
    const hq = uploadedFrames(trace, replacementOpenedAt).at(-1)!
    expect(hq.width * hq.height).toBeGreaterThan(QUICK_PREVIEW_MAX_PIXELS)
  } else {
    const last = trace.cpuRenders.at(-1)!
    expect(firstSources).not.toContain(`${last.worker}:${last.sourceId}`)
  }
  expectHalfTurnOf(
    await photoSignature(page, testInfo),
    reference,
    'the bounded HQ frame',
  )

  // The GPU split holds its two layers together over the replacement while
  // the deck and the stage insets move.
  if (projectHasWebGPU(testInfo)) await expectDualGpuLayersAligned(page)

  // The dock and deck serve the replacement.
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled()
  }
  await nudgeExposure(page, 10)
  await expect(deck(page)).toBeVisible()
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)

  // The lens: the GPU preview's split, or the CPU preview's original, drawn
  // from the replacement's own source.
  const original = await expectExecutorLens(page, testInfo)
  if (original !== null) {
    trace = await readTrace(page)
    const neutral = trace.cpuRenders.findLast(
      (render) => render.variant === 'neutral',
    )!
    expect(firstSources).not.toContain(`${neutral.worker}:${neutral.sourceId}`)
  }
})

for (const surface of ['desktop', 'mobile'] as const) {
  test(`${surface} Transform across the bounded HQ: a geometry answered on the quick frame is answered again on the HQ frame before export runs it, and the export and Restore keep it`, async ({
    page,
  }, testInfo) => {
    // Desktop runs on the Chromium GPU preview; mobile on the WebKit CPU
    // preview, so each executor drives one surface.
    test.skip(
      (surface === 'desktop') !== isDesktopChromiumProject(testInfo),
      surface === 'desktop'
        ? 'The desktop GPU surface runs on the Chromium project'
        : 'The mobile CPU surface runs on the WebKit project',
    )
    testInfo.setTimeout(600_000)
    const raw = await dngFile(testInfo, 'transform-across-hq.dng')
    await openLab(page, testInfo, { surface })

    // Only the quick frame is decoded while the bounded HQ is held.
    await setTrace(page, { holdRawRequest: 'decodeBoundedHqFromSession' })
    await chooseRaw(page, raw)
    await expect(loadedLab(page)).toBeVisible({ timeout: 120_000 })
    await expect
      .poll(async () => (await readTrace(page)).heldRawRequests, {
        timeout: 120_000,
      })
      .toBe(1)
    if (projectHasWebGPU(testInfo)) {
      await expect(previewFrame(page)).toHaveAttribute(
        'data-display-source',
        'quick',
        { timeout: 60_000 },
      )
    } else {
      await settledCpuFrame(page)
    }

    // A geometry answered on the quick frame.
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectPerspective(page)
    await rotateSlider(page).focus()
    await rotateSlider(page).press('PageUp')
    await expect(rotateSlider(page)).toHaveAttribute('aria-valuenow', '1')
    await waitForTransform(page)
    const onQuick = await transformMatrix(page)

    // The bounded HQ arrives while the Transform worker holds its answers.
    await setTrace(page, { holdTransformRenders: true })
    const heldBefore = (await readTrace(page)).heldTransformRenders
    await release(page, '__p3ReleaseRawRequests')
    await expect(
      page.getByText(`Loaded ${raw.name}`, { exact: true }),
    ).toBeVisible({ timeout: 120_000 })
    await moveAwayFromToasts(page)
    if (projectHasWebGPU(testInfo)) {
      await expect(previewFrame(page)).toHaveAttribute(
        'data-display-source',
        'bounded-hq',
        { timeout: 120_000 },
      )
    }
    const answeredAgain = projectHasWebGPU(testInfo)
    if (answeredAgain) {
      // The HQ frame is a new frame: the geometry is asked again on it, and
      // until the worker answers, neither export runs the answer given on
      // the quick frame.
      await expect
        .poll(async () => (await readTrace(page)).heldTransformRenders, {
          timeout: 60_000,
        })
        .toBeGreaterThan(heldBefore)
      await openTool(page, 'Export')
      await expect(fullExportButton(page)).toBeDisabled()
      await expect(
        exportSurface(page).getByText(TRANSFORM_PENDING_COPY, { exact: true }),
      ).toBeVisible()
      await page.waitForTimeout(1_500)
      await expect(fullExportButton(page)).toBeDisabled()
    }
    await release(page, '__p3ReleaseTransformRenders')
    await openTool(page, 'Transform')
    await waitForTransform(page)
    // The same geometry, now answered on the photo as it looks.
    expect(await transformMatrix(page)).toEqual(onQuick)
    await openTool(page, 'Export')
    await expect(
      exportSurface(page).getByText(TRANSFORM_PENDING_COPY, { exact: true }),
    ).toHaveCount(0)

    await exportFullResolution(page)
    await expect(restoreButton(page)).toBeVisible()
    const jpeg = await downloadJpeg(page)
    const manifest = await downloadManifest(page)
    expect(manifest.output.sha256).toBe(jpeg.sha256)
    expect(manifest.output.dimensions).toEqual({
      width: jpeg.width,
      height: jpeg.height,
    })
    expect(manifest.source_raw.decoded_dimensions).toEqual(PUBLIC_DNG_SIZE)
    const geometry = manifest.render_params.geometry!
    expect(geometry, 'the manifest records the geometry').toBeTruthy()
    expect(geometry.output).toEqual(manifest.output.dimensions)
    const cosine = Math.cos(Math.PI / 180)
    expect(geometry.matrix[0]).toBeCloseTo(cosine, 9)
    expect(geometry.matrix[4]).toBeCloseTo(cosine, 9)
    expect(jpeg.width).toBeLessThan(PUBLIC_DNG_SIZE.width)

    // Restore hands the photo back with the geometry still accepted: export
    // is open again without waiting on the worker.
    await restoreButton(page).click()
    await expect(restoreButton(page)).toHaveCount(0, { timeout: 120_000 })
    await expectPreviewShown(page, testInfo, 'quick')
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectPerspective(page)
    await expect(rotateSlider(page)).toHaveAttribute('aria-valuenow', '1')
    expect(await transformMatrix(page)).toEqual(onQuick)
    await openTool(page, 'Export')
    await expect(downloadButton(page)).toBeEnabled({ timeout: 60_000 })
    await expect(
      exportSurface(page).getByText(TRANSFORM_PENDING_COPY, { exact: true }),
    ).toHaveCount(0)
  })
}

test('delivery: with the preview released the result downloads, shares and copies as itself; a delivery still reading its file when an edit retires the result is refused and says why', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(480_000)
  const raw = await dngFile(testInfo, 'delivered.dng')
  await openLab(page, testInfo, { surface: 'project' })
  let downloads = 0
  page.on('download', () => {
    downloads += 1
  })
  await chooseRaw(page, raw)
  await waitForLoaded(page, raw.name)
  await expectPreviewShown(page, testInfo)

  await exportFullResolution(page)
  await expect(restoreButton(page)).toBeVisible()
  let trace = await readTrace(page)
  const plan = trace.exportEvents.find(
    (event) => event.type === 'export-plan-selected',
  )!
  expect(plan, 'the export selected a plan').toBeTruthy()
  // Released: no RAW runtime holds a session for the preview.
  expect(
    rawWorkers(trace).filter(
      (worker) =>
        worker.terminatedAt === null && requested(worker, 'openSession'),
    ),
  ).toEqual([])

  // Each delivery hands over the delivered JPEG itself.
  const jpeg = await downloadJpeg(page)
  const manifest = await downloadManifest(page)
  expect(manifest.output.sha256).toBe(jpeg.sha256)
  expect(manifest.output.filename).toBe(jpeg.name)
  expect({ width: jpeg.width, height: jpeg.height }).toEqual(PUBLIC_DNG_SIZE)
  await exportButton(page, 'Share').click()
  await expect
    .poll(async () => (await readTrace(page)).shared, { timeout: 60_000 })
    .toEqual([{ name: jpeg.name, size: jpeg.bytes.length, type: 'image/jpeg' }])
  await exportButton(page, COPY_FULL_LABEL).click()
  await expect
    .poll(async () => (await readTrace(page)).copied, { timeout: 60_000 })
    .toEqual([{ type: 'image/jpeg', size: jpeg.bytes.length }])
  await expect(
    page.getByText('Full-resolution image copied', { exact: true }),
  ).toBeVisible()

  // Origin-private storage is where a delivery can be held mid-read.
  if (plan.payload.outputSink !== 'opfs-file') {
    testInfo.annotations.push({
      type: 'mid-read refusal',
      description: `not exercised: the ${String(plan.payload.outputSink)} output has no file to hold`,
    })
    return
  }
  await restoreButton(page).click()
  await expect(restoreButton(page)).toHaveCount(0, { timeout: 120_000 })
  await expectPreviewShown(page, testInfo, 'quick')
  await openTool(page, 'Export')
  await expect(downloadButton(page)).toBeEnabled({ timeout: 60_000 })

  // Download, share and copy are each reading the file when an edit
  // changes the photo.
  const downloadsBefore = downloads
  await setTrace(page, { delivery: { armed: true, held: 0 } })
  await downloadButton(page).click()
  await exportButton(page, 'Share').click()
  await exportButton(page, COPY_FULL_LABEL).click()
  await expect
    .poll(async () => (await readTrace(page)).delivery.held, {
      timeout: 30_000,
    })
    .toBe(3)
  await nudgeExposure(page, 5)
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await settledCpuFrame(page)
  const editedAt = await now(page)
  await release(page, '__p3ReleaseDeliveries')

  // Nothing is delivered, and each refusal says why.
  for (const title of ['Download failed', 'Share failed', 'Copy failed']) {
    await expect(page.getByText(title, { exact: true })).toBeVisible({
      timeout: 30_000,
    })
  }
  await page.waitForTimeout(1_500)
  trace = await readTrace(page)
  const refusals = trace.toasts.filter((toast) => toast.at > editedAt)
  expect(refusals).toHaveLength(3)
  for (const refusal of refusals) {
    expect(refusal.text).toContain(STALE_DELIVERY_COPY)
  }
  expect(downloads).toBe(downloadsBefore)
  expect(trace.shared).toHaveLength(1)
  expect(trace.copied).toHaveLength(1)
  // The edit retired the result, so nothing offers it again.
  await openTool(page, 'Export')
  await expect(downloadButton(page)).toHaveCount(0)
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 60_000 })
})
