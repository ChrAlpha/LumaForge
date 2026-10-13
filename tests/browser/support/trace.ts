import type { Page } from '@playwright/test'

/** The RAW worker bridge ends an unleased runtime after this long. */
export const RAW_RUNTIME_IDLE_MS = 10_000
/**
 * An idle end comes about the idle window after the runtime's last answer.
 * A session's close can answer just after its lease already started the
 * window, so the gap may fall a little short of it, but never near zero as
 * an explicit end would.
 */
export const IDLE_GAP_MIN_MS = RAW_RUNTIME_IDLE_MS - 2_000

type WorkerKind = 'raw' | 'transform' | 'cpu-preview' | 'export' | 'other'

export type TracedWorker = {
  index: number
  kind: WorkerKind
  createdAt: number
  terminatedAt: number | null
  /** Every message the page posted, `held` when the trace kept it back. */
  requests: Array<{ type: string; at: number; held: boolean }>
  lastReplyAt: number | null
}

export type ExportDebugEvent = {
  type: string
  payload: Record<string, unknown>
}

export type PageTrace = {
  workers: TracedWorker[]
  /** Sources the page handed the CPU preview worker. */
  cpuSources: Array<{
    worker: number
    sourceId: string
    width: number
    height: number
    at: number
  }>
  /** Renders posted to the CPU preview worker, with the EV each draws. */
  cpuRenders: Array<{
    worker: number
    sourceId: string
    requestId: number
    variant: string
    ev: number | null
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
  /**
   * Whether idle-window timers are kept from running for now. A worker
   * bridge then cannot end its worker by idle, only by an explicit end.
   */
  holdIdleTimers: boolean
  /** Idle-window timers scheduled while held and not yet cleared. */
  heldIdleTimers: number
  /** Released held timers that have neither run nor been cleared. */
  releasedIdleTimers: number
  /** Whether GPU backing-store settle timers are kept from running for now. */
  holdSettleTimers: boolean
  heldSettleTimers: number
  /** Image rows written to GPU textures: RGBA16 bands of a decoded frame. */
  gpuUploads: Array<{ width: number; y: number; rows: number; at: number }>
  /** Whether GPU completions are kept from the page for now. */
  holdGpuCompletions: boolean
  /** When each completion held so far was asked for, and how many still wait. */
  heldGpuCompletions: number[]
  pendingGpuCompletions: number
  /** Every toast the page showed, once each, in order. */
  toasts: Array<{ text: string; at: number }>
  exportEvents: ExportDebugEvent[]
  /** While armed, every materialized JPEG read is held until released. */
  delivery: { armed: boolean; held: number }
  /** What reached the system share sheet (with the delivery stand-ins). */
  shared: Array<{ name: string; size: number; type: string }>
  /** What reached the clipboard (with the delivery stand-ins). */
  copied: Array<{ type: string; size: number }>
}

/**
 * Init script that records the page's workers (RAW runtime, Transform, CPU
 * preview, export), every message posted to them, when each last answered and
 * when the page ended it, and the sources, renders and frames the CPU preview
 * worker handled. It can keep one RAW request type or the Transform renders
 * from their worker until released, hold the worker bridges' idle timers and
 * the GPU canvases' backing-store settle timers, hold answers to submitted GPU
 * work and CPU preview frames, and hold JPEG reads from export storage.
 * Toasts and export debug events are recorded too.
 */
export function installPageTrace({
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
    releasedIdleTimers: 0,
    holdSettleTimers: false,
    heldSettleTimers: 0,
    gpuUploads: [],
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
  // schedules an idle timer again with its whole window and runs a settle
  // timer at once. The page keeps the id it was given, so a released timer
  // stays mapped to the browser timer it became until that runs or the page
  // clears it.
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const heldTimers = new Map<
    number,
    { kind: 'idle' | 'settle'; run: () => void }
  >()
  const releasedTimers = new Map<number, number>()
  const countTimers = () => {
    const kinds = Array.from(heldTimers.values(), (timer) => timer.kind)
    trace.heldIdleTimers = kinds.filter((kind) => kind === 'idle').length
    trace.heldSettleTimers = kinds.filter((kind) => kind === 'settle').length
    trace.releasedIdleTimers = releasedTimers.size
  }
  const releaseTimers = (kind: 'idle' | 'settle', delay: number) => {
    for (const [id, timer] of [...heldTimers]) {
      if (timer.kind !== kind) continue
      heldTimers.delete(id)
      const native = nativeSetTimeout(() => {
        releasedTimers.delete(id)
        countTimers()
        timer.run()
      }, delay)
      releasedTimers.set(id, native)
    }
    countTimers()
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
      countTimers()
      return id
    }
    return nativeSetTimeout(handler, delay, ...args)
  } as typeof window.setTimeout
  window.clearTimeout = function (id?: number) {
    if (id !== undefined && heldTimers.delete(id)) {
      countTimers()
      return
    }
    const released = id === undefined ? undefined : releasedTimers.get(id)
    if (released !== undefined) {
      releasedTimers.delete(id!)
      countTimers()
      nativeClearTimeout(released)
      return
    }
    nativeClearTimeout(id)
  } as typeof window.clearTimeout

  const terminated = new WeakSet<Worker>()
  const controls = {
    idleTimers() {
      trace.holdIdleTimers = false
      releaseTimers('idle', idleMs)
    },
    settleTimers() {
      trace.holdSettleTimers = false
      releaseTimers('settle', 0)
    },
    rawRequests() {
      trace.holdRawRequest = null
      for (const held of heldRaw.splice(0)) {
        if (!terminated.has(held.worker)) held.send()
      }
    },
    transformRenders() {
      trace.holdTransformRenders = false
      for (const send of heldTransform.splice(0)) send()
    },
    deliveries() {
      trace.delivery.armed = false
      for (const release of heldDeliveries.splice(0)) release()
    },
    /**
     * Answers the oldest `count` held completions and keeps holding later
     * ones; with no count, answers all of them and stops holding.
     */
    gpuCompletions(count?: number) {
      if (count === undefined) trace.holdGpuCompletions = false
      const released = heldGpuCompletions.splice(
        0,
        count ?? heldGpuCompletions.length,
      )
      trace.pendingGpuCompletions = heldGpuCompletions.length
      for (const release of released) release()
    },
    /**
     * Hands the page the CPU frames that arrived before `before`, or all of
     * them and stops holding. A frame is handed over even when its worker
     * has ended since: it arrives late, as a reply already sent would.
     */
    cpuFrames(before?: number) {
      if (before === undefined) trace.holdCpuFrames = false
      const due = heldCpuFrames.filter(
        (frame) => before === undefined || frame.at < before,
      )
      for (const frame of due) {
        heldCpuFrames.splice(heldCpuFrames.indexOf(frame), 1)
      }
      trace.pendingCpuFrames = heldCpuFrames.length
      for (const frame of due) frame.deliver()
    },
  }
  Object.assign(window, { __labTrace: trace, __labRelease: controls })

  // The GPU queue: which decoded rows reach a texture and, while held, when
  // the page learns that submitted work completed. A held completion still
  // completes on the GPU; only its answer waits.
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
        graph?: { steps?: Array<{ kind?: string; ev?: number }> }
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
        } else if (type === 'render') {
          const exposure = request.graph?.steps?.find(
            (step) => step.kind === 'raw-render-exposure',
          )
          trace.cpuRenders.push({
            worker: record.index,
            sourceId,
            requestId: Number(request.requestId),
            variant: String(request.variant),
            ev: typeof exposure?.ev === 'number' ? exposure.ev : null,
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
    trace.exportEvents.push((event as CustomEvent).detail as ExportDebugEvent)
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

/**
 * Init script, after the trace: stand-ins for the share sheet and the
 * clipboard that record what the page handed them, so a refused delivery
 * shows up as nothing recorded.
 */
export function installDeliveryStandIns() {
  const trace = (window as unknown as { __labTrace: PageTrace }).__labTrace
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
}

export async function readTrace(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __labTrace: PageTrace }).__labTrace,
  )
}

export async function setTrace(
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
      (window as unknown as { __labTrace: PageTrace }).__labTrace,
      next,
    )
  }, patch)
}

type Releasable =
  | 'idleTimers'
  | 'settleTimers'
  | 'rawRequests'
  | 'transformRenders'
  | 'deliveries'
  | 'gpuCompletions'
  | 'cpuFrames'

/**
 * Lets what the trace held go on. `gpuCompletions` with an argument answers
 * that many of the oldest; `cpuFrames` with one hands over those that arrived
 * before that time; both keep holding the rest.
 */
export async function release(page: Page, what: Releasable, arg?: number) {
  await page.evaluate(
    ({ name, value }) => {
      const controls = (
        window as unknown as {
          __labRelease: Record<string, (value?: number) => void>
        }
      ).__labRelease
      controls[name]!(value ?? undefined)
    },
    { name: what, value: arg ?? null },
  )
}

export async function now(page: Page) {
  return page.evaluate(() => performance.now())
}

export function rawWorkers(trace: PageTrace) {
  return trace.workers.filter((worker) => worker.kind === 'raw')
}

export function requested(worker: TracedWorker, type: string) {
  return worker.requests.some((request) => request.type === type)
}

/** The RAW runtime worker the page opened its newest source session on. */
export function sessionWorker(trace: PageTrace) {
  return rawWorkers(trace).findLast((worker) =>
    requested(worker, 'openSession'),
  )
}

export function workerByIndex(trace: PageTrace, index: number) {
  return trace.workers.find((worker) => worker.index === index)!
}

export function eventPayload(events: ExportDebugEvent[], type: string) {
  return events.find((event) => event.type === type)?.payload ?? null
}

export function eventIndex(events: ExportDebugEvent[], type: string) {
  return events.findIndex((event) => event.type === type)
}

/** The CPU preview has answered every render it was asked for. */
export function cpuTraceIdle(trace: PageTrace) {
  const last = trace.cpuRenders.at(-1)
  return Boolean(
    last &&
    trace.cpuFrames.some(
      (frame) =>
        frame.worker === last.worker && frame.requestId === last.requestId,
    ),
  )
}
