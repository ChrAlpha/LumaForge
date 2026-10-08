import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { Download, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'
import {
  gateRawFixture,
  REQUIRE_PUBLIC_FIXTURE_ENV,
  resolvePublicRawFixture,
} from '../../scripts/ci/raw-fixtures.mjs'
import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  projectHasWebGPU,
  rawPreviewUrl,
} from './raw-preview-backend'

// Who owns the RAW runtime, the export attempt and the delivery, observed
// only through what a user can do and what the page then holds: the runtime
// worker each load, export and restore runs on, the frame and file that
// come out, and the copy that says why when something is refused. The
// Chromium project runs the GPU preview, the WebKit project (no WebGPU
// adapter) the CPU preview; the desktop forced-CPU case runs on Chromium.

// The assertions name the public DNG's own facts, so a missing copy fails
// instead of skipping.
const PUBLIC_DNG = resolvePublicRawFixture({
  env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
})
/** The public DNG's sensor size, as the decoder reports it. */
const PUBLIC_DNG_SIZE = { width: 4032, height: 3024 }
const MOBILE_VIEWPORT = { width: 393, height: 852 }
const DESKTOP_VIEWPORT = { width: 1440, height: 1000 }
/** The RAW worker bridge ends an unleased runtime after this long. */
const RAW_RUNTIME_IDLE_MS = 10_000
/**
 * An idle end comes about the idle window after the runtime's last answer.
 * A session's close can answer just after its lease already started the
 * window, so the gap may fall a little short of it, but never near zero as
 * an explicit end would.
 */
const IDLE_GAP_MIN_MS = RAW_RUNTIME_IDLE_MS - 2_000
const STALE_DELIVERY_COPY =
  'This export no longer matches the photo. Export again to deliver it.'
/** What the export surface says while Transform waits on its worker. */
const TRANSFORM_PENDING_COPY = 'Preparing the current photo…'
const LMFG_BIN = fileURLToPath(
  new URL('../../packages/lmfg-cli/bin/lmfg.mjs', import.meta.url),
)
const LMFG_DIST = fileURLToPath(
  new URL('../../packages/lmfg-cli/dist/index.js', import.meta.url),
)
/** The sources `pnpm cli:build` builds into the lmfg the replay runs. */
const LMFG_SOURCES = [
  'lmfg-cli',
  'render-engine',
  'luma-color-runtime',
  'luma-raw-runtime',
  'luma-jpeg-runtime',
].map((name) =>
  fileURLToPath(new URL(`../../packages/${name}/src`, import.meta.url)),
)

const execFileAsync = promisify(execFile)

type WorkerKind = 'raw' | 'transform' | 'cpu-preview' | 'export' | 'other'

type TracedWorker = {
  index: number
  url: string
  kind: WorkerKind
  createdAt: number
  terminatedAt: number | null
  /** Every message the page posted, `held` when the trace kept it back. */
  requests: Array<{ type: string; at: number; held: boolean }>
  lastReplyAt: number | null
}

type PageTrace = {
  workers: TracedWorker[]
  /** Renders posted to the CPU preview worker, with their variant. */
  cpuRenders: Array<{ worker: number; requestId: number; variant: string }>
  /** Frames the CPU preview worker answered. */
  cpuFrames: Array<{ worker: number; requestId: number }>
  /** A RAW request type the trace keeps from the worker, if any. */
  holdRawRequest: string | null
  /** Whether Transform renders are kept from the worker for now. */
  holdTransformRenders: boolean
  heldTransformRenders: number
  /** The text of every toast the page showed. */
  toasts: string[]
  exportEvents: Array<{ type: string; payload: Record<string, unknown> }>
  /** Holds the next materialized JPEG read until released. */
  delivery: { armed: boolean; held: number }
  /**
   * Whether idle-window timers are kept from running for now. A worker
   * bridge then cannot end its worker by idle, only by an explicit end.
   */
  holdIdleTimers: boolean
  /** Idle-window timers scheduled while held and not yet cleared. */
  heldIdleTimers: number
}

type ExportManifest = {
  kind: string
  manifest_sha256: string
  source_raw: {
    filename: string
    sha256: string
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
  environment: {
    native_artifacts: { build_id: string; variant: 'desktop' | 'low-memory' }
  }
}

type JpegFile = {
  name: string
  path: string
  bytes: Buffer
  sha256: string
  width: number
  height: number
}

/**
 * Records the page's workers: what each is (RAW runtime, Transform, CPU
 * preview, export), every message posted to it, when it last answered and
 * when the page terminated it. It can keep one RAW request type or the
 * Transform renders from their worker, which then never answers them, hold
 * the next JPEG read from export storage, and hold the timers of the worker
 * bridges' idle window. It also records toasts and export debug events.
 */
function installPageTrace({ idleMs }: { idleMs: number }) {
  // Playwright compiles this function before it reaches the page, so it
  // keeps to syntax that needs no helpers: no class fields.
  const NativeWorker = window.Worker
  const releases: Array<() => void> = []
  let releaseDelivery: (() => void) | null = null
  const trace: PageTrace = {
    workers: [],
    cpuRenders: [],
    cpuFrames: [],
    holdRawRequest: null,
    holdTransformRenders: false,
    heldTransformRenders: 0,
    toasts: [],
    exportEvents: [],
    delivery: { armed: false, held: 0 },
    holdIdleTimers: false,
    heldIdleTimers: 0,
  }
  // A held idle timer is not scheduled at all; clearing it forgets it, and
  // releasing schedules it again with its whole window.
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const heldIdleTimers = new Map<number, () => void>()
  let nextHeldTimer = 2 ** 30
  const countHeldIdleTimers = () => {
    trace.heldIdleTimers = heldIdleTimers.size
  }
  window.setTimeout = function (
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) {
    if (
      trace.holdIdleTimers &&
      delay === idleMs &&
      typeof handler === 'function'
    ) {
      const id = nextHeldTimer++
      heldIdleTimers.set(id, () => handler(...args))
      countHeldIdleTimers()
      return id
    }
    return nativeSetTimeout(handler, delay, ...args)
  } as typeof window.setTimeout
  window.clearTimeout = function (id?: number) {
    if (id !== undefined && heldIdleTimers.delete(id)) {
      countHeldIdleTimers()
      return
    }
    nativeClearTimeout(id)
  } as typeof window.clearTimeout
  Object.assign(window, {
    __p2ReleaseIdleTimers() {
      trace.holdIdleTimers = false
      for (const [id, run] of [...heldIdleTimers]) {
        heldIdleTimers.delete(id)
        nativeSetTimeout(run, idleMs)
      }
      countHeldIdleTimers()
    },
    __p2Trace: trace,
    __p2ReleaseTransformRenders() {
      trace.holdTransformRenders = false
      for (const send of releases.splice(0)) send()
    },
    __p2ReleaseDelivery() {
      releaseDelivery?.()
      releaseDelivery = null
    },
  })
  const rawRequests = new Set([
    'openSession',
    'extractEmbeddedPreviewFromSession',
    'decodeQuickFromSession',
    'decodeBoundedHqFromSession',
    'probeExportCapabilityFromSession',
    'closeSession',
    'probe',
    'extractEmbeddedPreview',
    'decodeQuick',
    'decodeBoundedHq',
  ])
  const records = new WeakMap<Worker, TracedWorker>()
  class TracedPageWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      const href = String(url)
      const record: TracedWorker = {
        index: trace.workers.length + 1,
        url: href,
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
      this.addEventListener('message', (event: MessageEvent) => {
        record.lastReplyAt = performance.now()
        const data = event.data as { type?: string; requestId?: number }
        if (record.kind === 'cpu-preview' && data?.type === 'rendered') {
          trace.cpuFrames.push({
            worker: record.index,
            requestId: Number(data.requestId),
          })
        }
      })
    }

    postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const record = records.get(this)!
      const request = message as {
        type?: unknown
        payload?: unknown
        variant?: unknown
        requestId?: unknown
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
      let held = false
      if (record.kind === 'raw' && trace.holdRawRequest === type) held = true
      if (
        record.kind === 'transform' &&
        type === 'render' &&
        trace.holdTransformRenders
      ) {
        held = true
        trace.heldTransformRenders += 1
        releases.push(send)
      }
      record.requests.push({ type, at: performance.now(), held })
      if (record.kind === 'cpu-preview' && type === 'render') {
        trace.cpuRenders.push({
          worker: record.index,
          requestId: Number(request.requestId),
          variant: String(request.variant),
        })
      }
      if (!held) send()
    }

    terminate() {
      const record = records.get(this)!
      if (record.terminatedAt === null) record.terminatedAt = performance.now()
      super.terminate()
    }
  }
  window.Worker = TracedPageWorker

  new MutationObserver(() => {
    for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
      const text = toast.textContent?.trim()
      if (text && !trace.toasts.includes(text)) trace.toasts.push(text)
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })

  window.addEventListener('lumaforge-export-debug', (event) => {
    trace.exportEvents.push(
      (event as CustomEvent).detail as PageTrace['exportEvents'][number],
    )
  })

  // Export output lives in origin-private storage where the browser has it.
  // An armed hold reads the next JPEG in full, then keeps it from the
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
      trace.delivery.armed = false
      const bytes = await file.arrayBuffer()
      trace.delivery.held += 1
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve
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
    () => (window as unknown as { __p2Trace: PageTrace }).__p2Trace,
  )
}

async function setTrace(
  page: Page,
  patch: Partial<
    Pick<
      PageTrace,
      'holdRawRequest' | 'holdTransformRenders' | 'delivery' | 'holdIdleTimers'
    >
  >,
) {
  await page.evaluate((next) => {
    Object.assign(
      (window as unknown as { __p2Trace: PageTrace }).__p2Trace,
      next,
    )
  }, patch)
}

function rawWorkers(trace: PageTrace) {
  return trace.workers.filter((worker) => worker.kind === 'raw')
}

function requested(worker: TracedWorker, type: string) {
  return worker.requests.some((request) => request.type === type)
}

/**
 * What the idle window allows of a worker no test barrier holds: it is still
 * up, or the idle window ended it long after its last answer. An explicit
 * end would come right after it.
 */
function expectAliveOrIdled(worker: TracedWorker) {
  if (worker.terminatedAt === null) return
  expect(
    worker.terminatedAt - worker.lastReplyAt!,
    `RAW runtime ${worker.index} ended by idle, not explicitly`,
  ).toBeGreaterThanOrEqual(IDLE_GAP_MIN_MS)
}

async function releaseIdleTimers(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __p2ReleaseIdleTimers: () => void }
    ).__p2ReleaseIdleTimers(),
  )
}

/** The RAW runtime worker the page opened its newest source session on. */
function sessionWorker(trace: PageTrace) {
  return rawWorkers(trace).findLast((worker) =>
    requested(worker, 'openSession'),
  )
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
  await page.addInitScript(installPageTrace, { idleMs: RAW_RUNTIME_IDLE_MS })
  if (isDesktopChromiumProject(testInfo)) {
    await page.setViewportSize(
      surface === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    )
  }
  await page.goto(rawPreviewUrl(testInfo, path))
  if (surface === 'mobile') {
    expect(isMobile(page)).toBe(true)
  }
  if (surface === 'desktop') {
    expect(isMobile(page)).toBe(false)
  }
}

function uploadDock(page: Page) {
  return page.getByRole('button', { name: /finish a raw with a lut/i })
}

async function chooseRaw(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
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

async function waitForLoaded(page: Page, name: string) {
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })
  // Ingest reports success only after the bounded HQ decode.
  const loaded = page.getByText(`Loaded ${name}`, { exact: true })
  await expect(loaded).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  // The toast sits over the top of the photo, where the lens is. A pointer
  // left over it after the More menu holds it open, so it moves away first.
  const viewport = page.viewportSize()!
  await page.mouse.move(viewport.width / 2, viewport.height - 4)
  await expect(loaded).toBeHidden({ timeout: 30_000 })
}

/** The public DNG under another name, as a second, distinct source. */
async function dngFile(testInfo: TestInfo, name: string) {
  return {
    name,
    mimeType: 'image/x-adobe-dng',
    buffer: await readFile(gateRawFixture(testInfo, PUBLIC_DNG)),
  }
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

function fullExportButton(page: Page) {
  return exportSurface(page).getByRole('button', {
    name: 'Export full-resolution JPEG',
    exact: true,
  })
}

function hqExportButton(page: Page) {
  return exportSurface(page).getByRole('button', {
    name: 'Export HQ preview JPEG',
    exact: true,
  })
}

function downloadButton(page: Page) {
  return exportSurface(page).getByRole('button', {
    name: 'Download',
    exact: true,
  })
}

function transformTool(page: Page) {
  return page.locator('[data-raw-transform-tool]')
}

function transformOverlay(page: Page) {
  return page.locator('[data-raw-transform-preview]')
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

function rotateSlider(page: Page) {
  return transformTool(page).getByRole('slider', {
    name: 'Rotate',
    exact: true,
  })
}

async function transformMatrix(page: Page) {
  const value = await transformOverlay(page).getAttribute(
    'data-transform-matrix',
  )
  expect(value, 'the overlay names the geometry it shows').toBeTruthy()
  return value!.split(',').map(Number)
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
    path: path!,
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
  const button = exportSurface(page).getByRole('button', {
    name: isMobile(page) ? 'Download render manifest (JSON)' : 'Manifest',
    exact: true,
  })
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  const download = await downloading
  const path = (await download.path())!
  const manifest = JSON.parse(await readFile(path, 'utf8')) as ExportManifest
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  return { manifest, path }
}

/** Starts the full-resolution export and waits until its file is ready. */
async function exportFullResolution(page: Page) {
  await openTool(page, 'Export')
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 60_000 })
  await fullExportButton(page).click()
  await expect(downloadButton(page)).toBeVisible({ timeout: 300_000 })
}

function restoreButton(page: Page) {
  return page.getByRole('button', { name: 'Restore preview' })
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
 * The lens each executor offers: the GPU preview's tap opens the split, the
 * CPU preview's tap pins the original, which the CPU worker draws as its
 * neutral variant.
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
    return
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
  await expect(splitSlider(page)).toHaveCount(0)
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => (await readTrace(page)).cpuRenders.at(-1)?.variant, {
      timeout: 60_000,
    })
    .toBe('processed')
  expect(await settledCpuFrame(page)).toBe(processed)
}

test('runtime: an idle prewarmed runtime ends on its own, the next RAW warms a fresh one, and a loaded RAW gives its runtime back only once its bounded HQ settled', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  // The desktop empty stage shows the runtime's readiness; mobile has no
  // such row, so there only the workers say it.
  await openLab(page, testInfo, { surface: 'project' })
  const readiness = page.locator('[data-raw-runtime-readiness]')
  const desktop = !isMobile(page)

  // The page warms one runtime on its own, without a source.
  await expect
    .poll(async () => rawWorkers(await readTrace(page)).length, {
      timeout: 30_000,
    })
    .toBe(1)
  if (desktop) {
    await expect(readiness).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    })
  }

  // Nothing leases it, so the idle window ends it: an idle termination long
  // after its last answer, not an explicit one, and no source ever opened
  // on it.
  await expect
    .poll(
      async () => rawWorkers(await readTrace(page))[0]!.terminatedAt !== null,
      { timeout: RAW_RUNTIME_IDLE_MS * 4 },
    )
    .toBe(true)
  const idle = rawWorkers(await readTrace(page))[0]!
  expect(idle.requests.map((request) => request.type)).toEqual(['init'])
  expect(idle.terminatedAt! - idle.lastReplyAt!).toBeGreaterThanOrEqual(
    IDLE_GAP_MIN_MS,
  )
  if (desktop) {
    await expect(readiness).toHaveAttribute('data-state', 'idle')
    // Pointing at the upload rewarms a fresh generation.
    await uploadDock(page).hover({ position: { x: 24, y: 24 } })
    await expect(readiness).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    })
    expect(rawWorkers(await readTrace(page))).toHaveLength(2)
  }

  // The RAW loads on a runtime started after the idle one ended.
  await chooseRaw(page, rawPath)
  await waitForLoaded(page, basename(rawPath))
  let trace = await readTrace(page)
  const session = sessionWorker(trace)!
  expect(session.index).not.toBe(idle.index)
  expect(session.createdAt).toBeGreaterThan(idle.terminatedAt!)
  expectAliveOrIdled(session)
  expect(requested(session, 'decodeQuickFromSession')).toBe(true)
  expect(requested(session, 'decodeBoundedHqFromSession')).toBe(true)
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await settledCpuFrame(page)

  // The load leases its runtime until its bounded HQ settled, then gives it
  // back: the idle window ends it only after its last answer, and the photo
  // stays on screen without it.
  await expect
    .poll(
      async () =>
        (await readTrace(page)).workers.find(
          (worker) => worker.index === session.index,
        )!.terminatedAt !== null,
      { timeout: RAW_RUNTIME_IDLE_MS * 4 },
    )
    .toBe(true)
  trace = await readTrace(page)
  const released = trace.workers.find(
    (worker) => worker.index === session.index,
  )!
  const hqAnswered = released.requests.find(
    (request) => request.type === 'decodeBoundedHqFromSession',
  )!
  expect(released.lastReplyAt!).toBeGreaterThan(hqAnswered.at)
  expect(released.terminatedAt! - released.lastReplyAt!).toBeGreaterThanOrEqual(
    IDLE_GAP_MIN_MS,
  )
  expect(rawWorkers(trace).filter((worker) => !worker.terminatedAt)).toEqual([])
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await settledCpuFrame(page)

  // The next RAW warms a fresh runtime rather than waiting on the ended one.
  const next = await dngFile(testInfo, 'rewarmed-next.dng')
  await chooseReplacement(page, next)
  await waitForLoaded(page, next.name)
  trace = await readTrace(page)
  const rewarmed = sessionWorker(trace)!
  expect(rewarmed.index).not.toBe(session.index)
  expect(rewarmed.createdAt).toBeGreaterThan(released.terminatedAt!)
  expect(requested(rewarmed, 'decodeQuickFromSession')).toBe(true)
})

test('supersession: a RAW chosen while the previous RAW’s bounded HQ never answers replaces it at once; the stalled runtime is ended and its load never reports', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(240_000)
  const first = await dngFile(testInfo, 'superseded-first.dng')
  const second = await dngFile(testInfo, 'current-second.dng')
  await openLab(page, testInfo, { surface: 'project' })

  // The first RAW's runtime takes its bounded HQ request and never answers
  // it: the quick frame shows, the load never finishes on its own.
  await setTrace(page, { holdRawRequest: 'decodeBoundedHqFromSession' })
  await chooseRaw(page, first)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(
      async () =>
        sessionWorker(await readTrace(page))?.requests.some(
          (request) =>
            request.type === 'decodeBoundedHqFromSession' && request.held,
        ),
      { timeout: 120_000 },
    )
    .toBe(true)
  await setTrace(page, { holdRawRequest: null })
  const stalled = sessionWorker(await readTrace(page))!
  expect(stalled.terminatedAt).toBeNull()

  // The replacement does not wait behind work that never answers.
  await chooseReplacement(page, second)
  await waitForLoaded(page, second.name)
  if (!isMobile(page)) {
    await expect(
      page.getByRole('heading', { name: second.name, exact: true }),
    ).toBeVisible()
  }
  const trace = await readTrace(page)
  const current = sessionWorker(trace)!
  expect(current.index).not.toBe(stalled.index)
  expectAliveOrIdled(current)
  const opened = current.requests.find(
    (request) => request.type === 'openSession',
  )!
  // The stalled generation was ended before the replacement opened.
  const ended = trace.workers.find((worker) => worker.index === stalled.index)!
  expect(ended.terminatedAt).not.toBeNull()
  expect(ended.terminatedAt!).toBeLessThanOrEqual(opened.at)
  expect(
    current.requests
      .filter((request) => request.type.endsWith('FromSession'))
      .every((request) => !request.held),
  ).toBe(true)
  expect(requested(current, 'decodeBoundedHqFromSession')).toBe(true)
  // No RAW runtime but the current one is alive.
  expect(
    rawWorkers(trace)
      .filter((worker) => !worker.terminatedAt)
      .map((worker) => worker.index)
      .filter((index) => index !== current.index),
  ).toEqual([])

  // The superseded load never reports, even late.
  await page.waitForTimeout(2_000)
  const toasts = (await readTrace(page)).toasts
  expect(toasts.some((text) => text.includes(`Loaded ${second.name}`))).toBe(
    true,
  )
  expect(toasts.filter((text) => text.includes(first.name))).toEqual([])
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await settledCpuFrame(page)
})

test('mobile evacuation and restore: the topbar export ends the preview’s runtime, the JPEG and manifest deliver with the preview released, and Restore warms a fresh runtime under the executor’s own lens', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(600_000)
  await openLab(page, testInfo, { surface: 'mobile' })
  // The loaded RAW's runtime may not idle out before the export: with its
  // idle window held, only an explicit end can stop it.
  await setTrace(page, { holdIdleTimers: true })
  await chooseRaw(page, rawPath)
  await waitForLoaded(page, basename(rawPath))
  if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)
  const loadedOn = sessionWorker(await readTrace(page))!
  // The load gave its runtime back, and the idle end that would follow is
  // held.
  await expect
    .poll(async () => (await readTrace(page)).heldIdleTimers, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(1)

  // The topbar Export opens the panel in the deck; the export evacuates the
  // preview first and its runtime is ended.
  await openTool(page, 'Export')
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 60_000 })
  const exportClickedAt = await page.evaluate(() => performance.now())
  const aliveAtExport = (await readTrace(page)).workers.find(
    (worker) => worker.index === loadedOn.index,
  )!
  expect(aliveAtExport.terminatedAt).toBeNull()
  await fullExportButton(page).click()
  await expect(exportAction(page)).toHaveAttribute('data-state', 'done', {
    timeout: 300_000,
  })
  let trace = await readTrace(page)
  // From here on the idle window runs as it does for a user.
  await releaseIdleTimers(page)
  const evacuated = trace.exportEvents.findIndex(
    (event) => event.type === 'resource-evacuated',
  )
  const planned = trace.exportEvents.findIndex(
    (event) => event.type === 'export-plan-selected',
  )
  expect(planned).toBeGreaterThanOrEqual(0)
  expect(evacuated).toBeGreaterThan(planned)
  expect(trace.exportEvents[evacuated]!.payload).toMatchObject({
    registryCheck: expect.objectContaining({ ok: true }),
  })
  const ended = trace.workers.find((worker) => worker.index === loadedOn.index)!
  expect(ended.terminatedAt).not.toBeNull()
  // Ended by the export (its idle end was held), and before the export
  // worker started.
  expect(ended.terminatedAt!).toBeGreaterThan(exportClickedAt)
  const exportWorker = trace.workers.find(
    (worker) => worker.kind === 'export' && worker.createdAt > exportClickedAt,
  )!
  expect(exportWorker, 'the export ran on its own worker').toBeTruthy()
  expect(ended.terminatedAt!).toBeLessThanOrEqual(exportWorker.createdAt)
  expect(rawWorkers(trace).filter((worker) => !worker.terminatedAt)).toEqual([])

  // Released: the tools lock and the lens leaves, while the file and its
  // manifest still deliver and agree.
  await expect(restoreButton(page)).toBeVisible()
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeDisabled()
  }
  await expect(lens(page)).toHaveCount(0)
  const jpeg = await downloadJpeg(page)
  const { manifest } = await downloadManifest(page)
  expect(manifest.output.sha256).toBe(jpeg.sha256)
  expect(manifest.output.filename).toBe(jpeg.name)
  expect({ width: jpeg.width, height: jpeg.height }).toEqual(PUBLIC_DNG_SIZE)
  expect(manifest.output.dimensions).toEqual(PUBLIC_DNG_SIZE)
  expect(manifest.source_raw.decoded_dimensions).toEqual(PUBLIC_DNG_SIZE)
  await expect(exportSurface(page)).toContainText(
    `${jpeg.width} x ${jpeg.height}`,
  )
  // Delivery reads storage only: it starts no runtime.
  expect(rawWorkers(await readTrace(page))).toHaveLength(
    rawWorkers(trace).length,
  )

  // Restore warms a fresh runtime and reopens the source on it.
  const restoreClickedAt = await page.evaluate(() => performance.now())
  await restoreButton(page).click()
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled({ timeout: 120_000 })
  }
  await expect(
    projectHasWebGPU(testInfo) ? gpuCanvas(page) : cpuCanvas(page),
  ).toBeVisible({ timeout: 120_000 })
  trace = await readTrace(page)
  const restored = sessionWorker(trace)!
  expect(restored.index).not.toBe(loadedOn.index)
  expect(restored.createdAt).toBeGreaterThan(restoreClickedAt)
  expectAliveOrIdled(restored)
  expect(requested(restored, 'decodeQuickFromSession')).toBe(true)
  // An edit after Restore, so the original the lens shows differs from the
  // processed photo.
  await openTool(page, 'Adjust')
  const exposure = deck(page).getByRole('slider', {
    name: 'Exposure',
    exact: true,
  })
  await expect(exposure).toBeEnabled()
  await exposure.focus()
  for (let step = 0; step < 10; step++) await exposure.press('PageUp')
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0')
  await expectExecutorLens(page, testInfo)

  // Once restored, its runtime idles out like a loaded RAW's; the photo,
  // the tools and the lens stay.
  await expect
    .poll(
      async () =>
        (await readTrace(page)).workers.find(
          (worker) => worker.index === restored.index,
        )!.terminatedAt !== null,
      { timeout: RAW_RUNTIME_IDLE_MS * 4 },
    )
    .toBe(true)
  trace = await readTrace(page)
  const idled = trace.workers.find((worker) => worker.index === restored.index)!
  expect(idled.terminatedAt! - idled.lastReplyAt!).toBeGreaterThanOrEqual(
    IDLE_GAP_MIN_MS,
  )
  await expect(lens(page)).toBeVisible()
  await expect(dockTab(page, 'Look')).toBeEnabled()
  await expect(
    projectHasWebGPU(testInfo) ? gpuCanvas(page) : cpuCanvas(page),
  ).toBeVisible()
})

test('desktop forced CPU: a download still reading its file when the photo changes is refused and says why; the current result delivers with the preview released', async ({
  page,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'The desktop command rail and origin-private export storage run on the desktop project',
  )
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(360_000)
  await openLab(page, testInfo, {
    surface: 'desktop',
    path: '/raw?forcePreview=cpu',
  })
  await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  await chooseRaw(page, rawPath)
  await waitForLoaded(page, basename(rawPath))
  await expect(gpuCanvas(page)).toHaveCount(0)
  await settledCpuFrame(page)

  await exportFullResolution(page)
  const trace = await readTrace(page)
  const plan = trace.exportEvents.find(
    (event) => event.type === 'export-plan-selected',
  )!
  expect(plan.payload.outputSink).toBe('opfs-file')
  await expect(restoreButton(page)).toBeVisible()

  // The current result delivers while the preview is released.
  const delivered = await downloadJpeg(page)
  const { manifest } = await downloadManifest(page)
  expect(manifest.output.sha256).toBe(delivered.sha256)
  expect({ width: delivered.width, height: delivered.height }).toEqual(
    PUBLIC_DNG_SIZE,
  )

  // Restore hands editing back; the result is still the photo's.
  await restoreButton(page).click()
  await settledCpuFrame(page)
  await expect(downloadButton(page)).toBeEnabled({ timeout: 60_000 })

  // A download is reading its file when an edit changes the photo.
  let downloads = 0
  page.on('download', () => {
    downloads += 1
  })
  await setTrace(page, { delivery: { armed: true, held: 0 } })
  await downloadButton(page).click()
  await expect
    .poll(async () => (await readTrace(page)).delivery.held, {
      timeout: 30_000,
    })
    .toBe(1)
  await openTool(page, 'Adjust')
  const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
  await exposure.focus()
  for (let step = 0; step < 5; step++) await exposure.press('PageUp')
  await expect(exposure).not.toHaveAttribute('aria-valuenow', '0')
  await settledCpuFrame(page)
  await page.evaluate(() =>
    (
      window as unknown as { __p2ReleaseDelivery: () => void }
    ).__p2ReleaseDelivery(),
  )

  // Nothing is delivered, and the toast says why.
  await expect(
    page.getByText(STALE_DELIVERY_COPY, { exact: true }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Download failed', { exact: true })).toBeVisible()
  await page.waitForTimeout(1_500)
  expect(downloads).toBe(0)
  // The edit retired the result, so nothing offers it again.
  await expect(downloadButton(page)).toHaveCount(0)
  await expect(fullExportButton(page)).toBeEnabled()
})

/** The newest source file `pnpm cli:build` builds the replay's lmfg from. */
async function newestLmfgSource() {
  let newest = { path: '', mtimeMs: 0 }
  for (const root of LMFG_SOURCES) {
    for (const entry of await readdir(root, { recursive: true })) {
      if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue
      const path = join(root, entry)
      const { mtimeMs } = await stat(path)
      if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }
    }
  }
  return newest
}

/**
 * Runs `lmfg render replay` on a browser manifest against the same RAW, in a
 * fresh workspace, with the native variant the browser recorded.
 */
async function replayWithLmfg(
  testInfo: TestInfo,
  manifestPath: string,
  manifest: ExportManifest,
  rawPath: string,
) {
  expect(
    existsSync(LMFG_DIST),
    'The lmfg CLI is not built. Run pnpm cli:build before this browser validation.',
  ).toBe(true)
  // A replay on a stale build would refuse for reasons the browser export
  // never had.
  const built = (await stat(LMFG_DIST)).mtimeMs
  const newest = await newestLmfgSource()
  expect(
    newest.mtimeMs,
    `The lmfg CLI build is older than ${newest.path}. Run pnpm cli:build before this browser validation.`,
  ).toBeLessThanOrEqual(built)
  const workspace = testInfo.outputPath('lmfg-replay')
  await mkdir(workspace, { recursive: true })
  const args = [
    LMFG_BIN,
    '--workspace',
    workspace,
    '--json',
    '--quiet',
    '--memory-profile',
    manifest.environment.native_artifacts.variant,
    'render',
    'replay',
    '--manifest',
    manifestPath,
    '--source',
    rawPath,
    '--name',
    'browser-export',
  ]
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? ''
    if (!stdout) throw error
  }
  const envelope = JSON.parse(stdout) as
    | {
        ok: true
        result: {
          reproduced: boolean
          actual_sha256: string
          output: { path: string; sha256: string }
          manifest_uri: string
        }
      }
    | {
        ok: false
        error: {
          code: string
          message: string
          details?: Record<string, unknown>
        }
      }
  const published = {
    jpeg: join(workspace, 'replays', 'browser-export', 'output.jpg'),
    manifest: join(workspace, 'replays', 'browser-export', 'manifest.json'),
  }
  return { envelope, published }
}

for (const surface of ['desktop', 'mobile'] as const) {
  test(`${surface} Transform: an edit still waiting on its worker holds both exports, the export then delivers the newest geometry, and lmfg replays its manifest or refuses before publishing`, async ({
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
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(600_000)
    await openLab(page, testInfo, { surface })
    await chooseRaw(page, rawPath)
    await waitForLoaded(page, basename(rawPath))
    if (projectHasWebGPU(testInfo)) await expectWebGPUPreview(page, testInfo)

    // An accepted geometry: full resolution exports it, HQ refuses it.
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectPerspective(page)
    await rotateSlider(page).focus()
    await rotateSlider(page).press('PageUp')
    await expect(rotateSlider(page)).toHaveAttribute('aria-valuenow', '1')
    await waitForTransform(page)
    const accepted = await transformMatrix(page)
    await openTool(page, 'Export')
    await expect(fullExportButton(page)).toBeEnabled({ timeout: 30_000 })
    await expect(hqExportButton(page)).toBeDisabled()

    // The next edit reaches the worker, which has not answered yet.
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectPerspective(page)
    await setTrace(page, { holdTransformRenders: true })
    await rotateSlider(page).focus()
    await rotateSlider(page).press('PageUp')
    await expect(rotateSlider(page)).toHaveAttribute('aria-valuenow', '2')
    await expect
      .poll(async () => (await readTrace(page)).heldTransformRenders, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1)
    await expect(transformOverlay(page)).toHaveAttribute('aria-busy', 'true')

    // Neither export runs on the accepted geometry the preview is leaving,
    // and the surface says why. Nothing reopens it while the worker waits.
    const expectHeld = async () => {
      await openTool(page, 'Export')
      await expect(fullExportButton(page)).toBeDisabled()
      await expect(hqExportButton(page)).toBeDisabled()
      await expect(
        exportSurface(page).getByText(TRANSFORM_PENDING_COPY, { exact: true }),
      ).toBeVisible()
    }
    await expectHeld()
    await page.waitForTimeout(1_500)
    await expectHeld()
    expect(await transformMatrix(page)).toEqual(accepted)

    // The worker answers: the newest geometry is accepted and exports.
    await page.evaluate(() =>
      (
        window as unknown as { __p2ReleaseTransformRenders: () => void }
      ).__p2ReleaseTransformRenders(),
    )
    await openTool(page, 'Transform')
    await waitForTransform(page)
    const newest = await transformMatrix(page)
    expect(newest).not.toEqual(accepted)
    const overlaySize = await transformOverlay(page)
      .locator('canvas')
      .evaluate((canvas) => ({
        width: (canvas as HTMLCanvasElement).width,
        height: (canvas as HTMLCanvasElement).height,
      }))
    await openTool(page, 'Export')
    await expect(
      exportSurface(page).getByText(TRANSFORM_PENDING_COPY, { exact: true }),
    ).toHaveCount(0)
    await exportFullResolution(page)
    const jpeg = await downloadJpeg(page)
    const { manifest, path: manifestPath } = await downloadManifest(page)

    // The file, its markers and its manifest agree on the delivered frame,
    // which is the newest geometry at full resolution, not the sensor frame.
    expect(manifest.output.sha256).toBe(jpeg.sha256)
    expect(manifest.output.dimensions).toEqual({
      width: jpeg.width,
      height: jpeg.height,
    })
    expect(manifest.source_raw.decoded_dimensions).toEqual(PUBLIC_DNG_SIZE)
    const geometry = manifest.render_params.geometry!
    expect(geometry, 'the manifest records the geometry').toBeTruthy()
    expect(geometry.constrain_crop).toBe(true)
    expect(geometry.output).toEqual(manifest.output.dimensions)
    // Rotate stood at 2 degrees when the worker answered and at 1 degree in
    // the geometry the edit left: the manifest records the newest one.
    expect(geometry.matrix).toHaveLength(9)
    const cosine = (degrees: number) => Math.cos((degrees * Math.PI) / 180)
    expect(geometry.matrix[0]).toBeCloseTo(cosine(2), 9)
    expect(geometry.matrix[4]).toBeCloseTo(cosine(2), 9)
    expect(Math.abs(geometry.matrix[0]! - cosine(1))).toBeGreaterThan(1e-4)
    expect(geometry.matrix.slice(6)).toEqual([0, 0, 1])
    expect(jpeg.width).not.toBe(PUBLIC_DNG_SIZE.width)
    expect(jpeg.width).toBeLessThan(PUBLIC_DNG_SIZE.width)
    expect(jpeg.width).toBeGreaterThan(overlaySize.width * 2)
    expect(jpeg.width / jpeg.height).toBeCloseTo(
      overlaySize.width / overlaySize.height,
      1,
    )

    // The same manifest through lmfg with the same native build: the bytes
    // match, or the replay refuses on the hash and publishes nothing.
    const copy = testInfo.outputPath('browser-export.manifest.json')
    await writeFile(copy, await readFile(manifestPath))
    const { envelope, published } = await replayWithLmfg(
      testInfo,
      copy,
      manifest,
      rawPath,
    )
    if (envelope.ok) {
      expect(envelope.result.reproduced).toBe(true)
      expect(envelope.result.actual_sha256).toBe(jpeg.sha256)
      expect(envelope.result.output.sha256).toBe(jpeg.sha256)
      const replayed = await readFile(envelope.result.output.path)
      expect(createHash('sha256').update(replayed).digest('hex')).toBe(
        jpeg.sha256,
      )
      testInfo.annotations.push({
        type: 'lmfg replay',
        description: `byte-identical: ${jpeg.sha256} (${jpeg.width}x${jpeg.height}, native ${manifest.environment.native_artifacts.variant} ${manifest.environment.native_artifacts.build_id})`,
      })
    } else {
      expect(envelope.error.code, envelope.error.message).toBe(
        'replay.mismatch',
      )
      expect(envelope.error.details).toMatchObject({
        stage: 'output',
        published: false,
        expected_sha256: jpeg.sha256,
        expected: { width: jpeg.width, height: jpeg.height },
        actual: expect.objectContaining({
          width: jpeg.width,
          height: jpeg.height,
        }),
      })
      expect(existsSync(published.jpeg)).toBe(false)
      expect(existsSync(published.manifest)).toBe(false)
      testInfo.annotations.push({
        type: 'lmfg replay',
        description: `refused before publication: expected ${jpeg.sha256}, replay ${String(envelope.error.details?.actual_sha256)} (native ${manifest.environment.native_artifacts.variant} ${manifest.environment.native_artifacts.build_id})`,
      })
    }
  })
}
