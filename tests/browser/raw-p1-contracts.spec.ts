import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type {
  BrowserContext,
  Download,
  Locator,
  Page,
  TestInfo,
} from '@playwright/test'
import { expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'
import {
  gateRawFixture,
  REQUIRE_PUBLIC_FIXTURE_ENV,
  resolvePrivateRawFixture,
  resolvePublicRawFixture,
} from '../../scripts/ci/raw-fixtures.mjs'
import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  projectHasWebGPU,
  rawPreviewUrl,
} from './raw-preview-backend'

// The current mobile /raw surfaces, driven only through what a user does:
// the dock and its deck, the compare lens, the topbar Export and the panel it
// borrows the deck for, the Look strip with its inline contract and
// Strength, and the released preview after an export. The Chromium project
// runs them on the GPU preview, the WebKit project (no WebGPU adapter) on the
// CPU preview; each asserts the lens its executor offers.

// The assertions name the public DNG's own facts, so a missing copy fails
// instead of skipping.
const PUBLIC_DNG = resolvePublicRawFixture({
  env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
})
// The DNG's BaselineExposure decides every frame's exposure on its own, so
// it cannot show the source keeping its quick frame's estimate. That needs a
// RAW with no baseline whose quick and bounded HQ frames estimate different
// exposures from their own pixels.
const EXPOSURE_RAW = resolvePrivateRawFixture(
  'LUMAFORGE_EXPOSURE_RAW',
  'a local non-DNG RAW whose quick and bounded HQ frames estimate different image-statistics exposures (a Sony FX30 ARW or a Nikon Z 7 NEF does)',
)
/** The public DNG's sensor size, as the decoder reports it. */
const PUBLIC_DNG_SIZE = { width: 4032, height: 3024 }
const MOBILE_VIEWPORT = { width: 393, height: 852 }
/** The app writes every JPEG at this quality, full resolution or HQ. */
const EXPORT_JPEG_QUALITY_PERCENT = 92

type PreviewExecutor = 'gpu' | 'cpu'

type CpuPreviewTrace = {
  /** Frames loaded into the CPU preview worker, with their size. */
  sources: Array<{
    worker: number
    sourceId: string
    width: number
    height: number
  }>
  /** Renders posted to the CPU preview worker, with the EV each draws. */
  renders: Array<{
    worker: number
    requestId: number
    sourceId: string
    variant: string
    rawRenderExposureEv: number | null
  }>
  /** Frames the CPU preview worker answered. */
  frames: Array<{ worker: number; requestId: number }>
}

type CanvasDigest = { hash: string; meanLight: number; colors: number }

type ExportManifest = {
  kind: string
  manifest_sha256: string
  source_raw: {
    filename: string
    sha256: string
    byte_size: number
    decoded_dimensions: { width: number; height: number }
  }
  output: {
    sha256: string
    filename: string
    quality: number
    dimensions: { width: number; height: number }
  }
  render_params: {
    intensity?: number
    raw_render_exposure_ev?: number
    raw_render_exposure_source?: string
  }
  lut: unknown
}

type JpegFile = {
  name: string
  bytes: Buffer
  sha256: string
  width: number
  height: number
  quality: number | null
}

/**
 * Records the CPU preview worker's traffic: every frame the page loads into
 * it, every render the page posts, with its variant and the raw-render
 * exposure of the graph it draws, and every frame the worker sends back.
 */
function traceCpuPreviewWorker() {
  // Playwright compiles this function before it reaches the page, so it
  // keeps to syntax that needs no helpers: no class fields.
  const NativeWorker = window.Worker
  const trace: CpuPreviewTrace = { sources: [], renders: [], frames: [] }
  Object.assign(window, { __cpuPreviewTrace: trace })
  const indexes = new WeakMap<Worker, number>()
  let created = 0
  const cpuPreviewWorkers = new WeakSet<Worker>()
  class TracedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      const index = ++created
      indexes.set(this, index)
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: number }
        if (cpuPreviewWorkers.has(this) && data?.type === 'rendered') {
          trace.frames.push({
            worker: index,
            requestId: Number(data.requestId),
          })
        }
      })
    }

    postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as {
        type?: string
        sourceId?: string
        width?: number
        height?: number
        requestId?: number
        variant?: string
        graph?: { steps?: Array<{ kind?: string; ev?: number }> }
      }
      if (
        request?.type === 'loadSource' &&
        typeof request.sourceId === 'string'
      ) {
        cpuPreviewWorkers.add(this)
        trace.sources.push({
          worker: indexes.get(this) ?? 0,
          sourceId: request.sourceId,
          width: Number(request.width),
          height: Number(request.height),
        })
      }
      if (request?.type === 'render' && typeof request.variant === 'string') {
        cpuPreviewWorkers.add(this)
        const exposure = request.graph?.steps?.find(
          (step) => step.kind === 'raw-render-exposure',
        )
        trace.renders.push({
          worker: indexes.get(this) ?? 0,
          requestId: Number(request.requestId),
          sourceId: String(request.sourceId),
          variant: request.variant,
          rawRenderExposureEv:
            typeof exposure?.ev === 'number' ? exposure.ev : null,
        })
      }
      if (options === undefined) super.postMessage(message)
      else super.postMessage(message, options as StructuredSerializeOptions)
    }
  }
  window.Worker = TracedWorker
}

async function readCpuTrace(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __cpuPreviewTrace: CpuPreviewTrace })
        .__cpuPreviewTrace,
  )
}

function cpuTraceIdle(trace: CpuPreviewTrace) {
  const last = trace.renders.at(-1)
  return Boolean(
    last &&
    trace.frames.some(
      (frame) =>
        frame.worker === last.worker && frame.requestId === last.requestId,
    ),
  )
}

async function prepareLab(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
    // The first-run lens hint is not what these tests are about.
    localStorage.setItem('lumaforge.raw.mobile.lensHintSeen.v1', '1')
  })
  await page.addInitScript(traceCpuPreviewWorker)
}

/**
 * The mobile lab on the project's own preview executor: WebGPU on the
 * Chromium project, the CPU preview on WebKit, which has no adapter here.
 */
async function openMobileLab(
  page: Page,
  testInfo: TestInfo,
  path = '/raw',
): Promise<PreviewExecutor> {
  await prepareLab(page)
  if (isDesktopChromiumProject(testInfo)) {
    await page.setViewportSize(MOBILE_VIEWPORT)
  }
  await page.goto(rawPreviewUrl(testInfo, path))
  expect(page.viewportSize()!.width).toBeLessThanOrEqual(640)
  const executor = projectHasWebGPU(testInfo) ? 'gpu' : 'cpu'
  if (executor === 'cpu') {
    await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  }
  return executor
}

async function loadMobileRaw(page: Page, path: string) {
  const choosing = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Browse RAW files' }).click()
  await (await choosing).setFiles(path)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })
  // Ingest reports success only after the bounded HQ decode.
  const loaded = page.getByText(`Loaded ${basename(path)}`, { exact: true })
  await expect(loaded).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  // The toast sits over the top of the photo, where the lens is.
  await expect(loaded).toBeHidden({ timeout: 30_000 })
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

function dockTabs(page: Page) {
  return page.getByRole('tablist', { name: 'Lab modes' }).getByRole('tab')
}

function dockTab(page: Page, name: 'Look' | 'Adjust' | 'Transform') {
  return page
    .getByRole('tablist', { name: 'Lab modes' })
    .getByRole('tab', { name, exact: true })
}

async function selectTool(page: Page, name: 'Look' | 'Adjust' | 'Transform') {
  const tab = dockTab(page, name)
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

function deck(page: Page) {
  return page.locator('[data-mobile-dock-panel]')
}

function exportAction(page: Page) {
  return page.getByRole('banner').locator('[data-mobile-export-action]')
}

function exportPanel(page: Page) {
  return deck(page).locator('[data-mobile-export-panel]')
}

function lookStrip(page: Page) {
  return page.getByRole('group', { name: 'Looks' })
}

function strengthSlider(page: Page) {
  return page
    .locator('[data-mobile-look-strength]')
    .getByRole('slider', { name: 'Strength' })
}

async function openExportPanel(page: Page) {
  if ((await exportAction(page).getAttribute('aria-expanded')) !== 'true') {
    await exportAction(page).click()
  }
  await expect(exportPanel(page)).toBeVisible()
  return exportPanel(page)
}

async function closeExportPanel(page: Page) {
  await exportPanel(page).getByRole('button', { name: 'Close export' }).click()
  await expect(exportPanel(page)).toHaveCount(0)
}

async function readCpuCanvas(canvas: Locator): Promise<CanvasDigest> {
  return canvas.evaluate(async (element) => {
    const target = element as HTMLCanvasElement
    const pixels = target
      .getContext('2d')!
      .getImageData(0, 0, target.width, target.height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    let light = 0
    let samples = 0
    const colors = new Set<number>()
    for (let offset = 0; offset < pixels.length; offset += 64) {
      if (pixels[offset + 3] === 0) continue
      light += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
      colors.add(
        (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2],
      )
      samples++
    }
    return {
      hash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      meanLight: samples ? light / samples : 0,
      colors: colors.size,
    }
  })
}

/** The CPU canvas once the worker has answered its last render and settled. */
async function settledCpuFrame(page: Page) {
  await expect(cpuCanvas(page)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('cpu-preview-spinner')).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect
    .poll(async () => cpuTraceIdle(await readCpuTrace(page)), {
      timeout: 60_000,
    })
    .toBe(true)
  let previous = await readCpuCanvas(cpuCanvas(page))
  await expect
    .poll(
      async () => {
        const next = await readCpuCanvas(cpuCanvas(page))
        const settled = next.hash === previous.hash
        previous = next
        return settled
      },
      { intervals: [300], timeout: 15_000 },
    )
    .toBe(true)
  expect(previous.colors, 'the canvas shows the photograph').toBeGreaterThan(
    1000,
  )
  return previous
}

/**
 * The GPU canvas as the page composites it, once two captures in a row
 * agree. The capture is the canvas element only, so chrome around the
 * photo does not enter it.
 */
async function settledGpuFrame(page: Page) {
  await expect(gpuCanvas(page)).toBeVisible({ timeout: 60_000 })
  let previous = await gpuCanvas(page).screenshot({ animations: 'disabled' })
  await expect
    .poll(
      async () => {
        const next = await gpuCanvas(page).screenshot({
          animations: 'disabled',
        })
        const settled = next.equals(previous)
        previous = next
        return settled
      },
      { intervals: [400], timeout: 30_000 },
    )
    .toBe(true)
  return createHash('sha256').update(previous).digest('hex')
}

async function settledFrameHash(page: Page, executor: PreviewExecutor) {
  return executor === 'cpu'
    ? (await settledCpuFrame(page)).hash
    : settledGpuFrame(page)
}

/**
 * A .cube at the smallest size the LUT parser accepts; `map` shapes every
 * channel and leaves it unchanged by default.
 */
function createCube(title: string, map = (value: number) => value, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${map(r * step).toFixed(6)} ${map(g * step).toFixed(6)} ${map(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/** Libjpeg's baseline luminance table, in natural order. */
const LIBJPEG_LUMINANCE_TABLE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]
/** Zigzag position -> natural index, the order DQT stores a table in. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]

/** The libjpeg quality whose scaled luminance table this one is, if any. */
function libjpegQuality(table: number[]) {
  for (let quality = 1; quality <= 100; quality += 1) {
    const scale = quality < 50 ? 5000 / quality : 200 - quality * 2
    const matches = ZIGZAG.every((natural, position) => {
      const expected = Math.min(
        255,
        Math.max(
          1,
          Math.floor((LIBJPEG_LUMINANCE_TABLE[natural]! * scale + 50) / 100),
        ),
      )
      return table[position] === expected
    })
    if (matches) return quality
  }
  return null
}

/** Frame size and luminance quantization read from the JPEG's markers. */
function readJpegFacts(bytes: Buffer) {
  expect(bytes.readUInt16BE(0), 'a JPEG starts with SOI').toBe(0xFFD8)
  let offset = 2
  let width = 0
  let height = 0
  let luminance: number[] | null = null
  while (offset + 4 <= bytes.length) {
    expect(bytes[offset], `JPEG marker at ${offset}`).toBe(0xFF)
    const marker = bytes[offset + 1]!
    const length = bytes.readUInt16BE(offset + 2)
    if (marker === 0xDB) {
      let table = offset + 4
      while (table < offset + 2 + length) {
        const precision = bytes[table]! >> 4
        const id = bytes[table]! & 0x0F
        const values: number[] = []
        for (let index = 0; index < 64; index += 1) {
          values.push(
            precision
              ? bytes.readUInt16BE(table + 1 + index * 2)
              : bytes[table + 1 + index]!,
          )
        }
        if (id === 0) luminance = values
        table += 1 + 64 * (precision ? 2 : 1)
      }
    }
    if (marker >= 0xC0 && marker <= 0xC2) {
      height = bytes.readUInt16BE(offset + 5)
      width = bytes.readUInt16BE(offset + 7)
    }
    if (marker === 0xDA) break
    offset += 2 + length
  }
  return {
    width,
    height,
    quality: luminance ? libjpegQuality(luminance) : null,
  }
}

async function readDownload(download: Download): Promise<JpegFile> {
  const path = await download.path()
  expect(path, 'the download lands on disk').toBeTruthy()
  const bytes = await readFile(path!)
  return {
    name: download.suggestedFilename(),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...readJpegFacts(bytes),
  }
}

async function downloadJpeg(page: Page) {
  const button = exportPanel(page).getByRole('button', {
    name: 'Download',
    exact: true,
  })
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  return readDownload(await downloading)
}

async function downloadManifest(page: Page) {
  const button = exportPanel(page).getByRole('button', {
    name: 'Download render manifest (JSON)',
  })
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  const download = await downloading
  const text = await readFile((await download.path())!, 'utf8')
  const manifest = JSON.parse(text) as ExportManifest
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  return manifest
}

/** The mean light of a JPEG as this browser decodes it, on a small canvas. */
async function decodedMeanLight(page: Page, jpeg: JpegFile) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const canvas = new OffscreenCanvas(256, 192)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0, 256, 192)
    const pixels = context.getImageData(0, 0, 256, 192).data
    let light = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      light += (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / 3
    }
    return light / (pixels.length / 4)
  }, jpeg.bytes.toString('base64'))
}

/**
 * Imports a .cube from the Look strip and confirms its suggested contract.
 * The cube darkens every channel, so Strength shows on the photo.
 */
async function importLookWithContract(page: Page, testInfo: TestInfo) {
  const cubePath = testInfo.outputPath('p1-contracts.cube')
  await writeFile(
    cubePath,
    createCube('P1 Contracts', (value) => value * 0.55),
    'utf8',
  )
  await selectTool(page, 'Look')
  const importing = page.waitForEvent('filechooser')
  await lookStrip(page).getByRole('button', { name: 'Import .cube' }).click()
  await (await importing).setFiles(cubePath)
  // Nothing resolved this file, so its contract opens inline in the deck.
  const input = page.getByRole('region', { name: /: input$/ })
  await expect(input).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await input
    .getByRole('group', { name: 'Recommended input' })
    .getByRole('button', { name: 'Display sRGB · Apply' })
    .click()
  await expect(lookStrip(page)).toBeVisible()
  await expect(
    lookStrip(page).locator('[data-mobile-lut-tile="custom"]'),
  ).toHaveAttribute('data-state', 'applied')
}

/** Sets Strength from its 70% default to 37% with the keyboard. */
async function setStrength37(page: Page) {
  const strength = strengthSlider(page)
  await expect(strength).not.toHaveAttribute('data-disabled')
  await expect(strength).toHaveAttribute('aria-valuetext', '70%')
  await strength.focus()
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('Shift+ArrowLeft')
  }
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', '37%')
}

/** One step of Strength and back: an edit that leaves the intent as it was. */
async function touchStrength(page: Page) {
  await selectTool(page, 'Look')
  const strength = strengthSlider(page)
  await expect(strength).not.toHaveAttribute('data-disabled')
  const value = Number.parseInt(
    (await strength.getAttribute('aria-valuetext')) ?? '',
    10,
  )
  expect(value).toBeLessThan(100)
  await strength.focus()
  await page.keyboard.press('ArrowRight')
  await expect(strength).toHaveAttribute('aria-valuetext', `${value + 1}%`)
  await page.keyboard.press('ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', `${value}%`)
}

async function exportFullResolution(page: Page) {
  const panel = await openExportPanel(page)
  await expect(
    panel.getByRole('button', { name: 'Export full-resolution JPEG' }),
  ).toBeEnabled({ timeout: 60_000 })
  await panel
    .getByRole('button', { name: 'Export full-resolution JPEG' })
    .click()
  await expect(exportAction(page)).toHaveAttribute('data-state', 'done', {
    timeout: 300_000,
  })
  await expect(panel).toContainText('Exported')
}

async function expectReleasedPreview(page: Page) {
  await expect(
    stage(page).getByRole('button', { name: 'Restore preview' }),
  ).toBeVisible()
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeDisabled()
  }
  await expect(lens(page)).toHaveCount(0)
  await expect(deck(page).getByRole('slider')).toHaveCount(0)
}

async function restorePreview(page: Page, executor: PreviewExecutor) {
  await stage(page).getByRole('button', { name: 'Restore preview' }).click()
  await expect(
    executor === 'cpu' ? cpuCanvas(page) : gpuCanvas(page),
  ).toBeVisible({ timeout: 120_000 })
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled({ timeout: 60_000 })
  }
}

/**
 * Every processed frame the CPU preview has been asked for, in order: the
 * size of the frame it draws from and the raw-render exposure it draws at.
 */
async function cpuProcessedFrames(page: Page) {
  const trace = await readCpuTrace(page)
  return trace.renders
    .filter((render) => render.variant === 'processed')
    .map((render) => {
      const source = trace.sources.findLast(
        (loaded) =>
          loaded.worker === render.worker &&
          loaded.sourceId === render.sourceId,
      )
      return {
        width: source?.width ?? 0,
        height: source?.height ?? 0,
        ev: render.rawRenderExposureEv,
      }
    })
}

/** Every raw-render exposure the CPU preview has drawn a processed frame at. */
async function cpuProcessedExposures(page: Page) {
  const trace = await readCpuTrace(page)
  return [
    ...new Set(
      trace.renders
        .filter((render) => render.variant === 'processed')
        .map((render) => render.rawRenderExposureEv),
    ),
  ]
}

async function expectLensForExecutor(page: Page, executor: PreviewExecutor) {
  await expect(lens(page)).toBeVisible()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(splitSlider(page)).toHaveCount(0)
  if (executor === 'gpu') {
    // The GPU preview has the split surface: a tap opens it, a second tap
    // closes it.
    await expect(lens(page)).toHaveAttribute('data-lens-mode', 'split')
    await expect(lens(page)).toHaveAccessibleName('Split compare')
    await lens(page).hover()
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(splitSlider(page)).toBeVisible()
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(splitSlider(page)).toHaveCount(0)
    return
  }
  // The CPU preview has no split: the lens pins the original instead, and
  // the CPU worker draws its neutral variant.
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
  await expect(lens(page)).toHaveAccessibleName('Show original')
  const processed = await settledCpuFrame(page)
  const rendersBefore = (await readCpuTrace(page)).renders.length
  const lastVariantSettled = async (variant: string) => {
    const trace = await readCpuTrace(page)
    return trace.renders.at(-1)?.variant === variant && cpuTraceIdle(trace)
  }
  await lens(page).hover()
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => lastVariantSettled('neutral'), { timeout: 60_000 })
    .toBe(true)
  await settledCpuFrame(page)
  expect(
    (await readCpuTrace(page)).renders
      .slice(rendersBefore)
      .map((render) => render.variant),
  ).toEqual(['neutral'])
  await expect(splitSlider(page)).toHaveCount(0)
  await expect(
    stage(page).getByRole('button', { name: 'Original' }),
  ).toHaveCount(0)
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => lastVariantSettled('processed'), { timeout: 60_000 })
    .toBe(true)
  expect((await settledCpuFrame(page)).hash).toBe(processed.hash)
  await expect(splitSlider(page)).toHaveCount(0)
}

test('mobile: tools-only dock, the executor’s own lens, and a 37% look exported at quality 92 with the DNG baseline exposure through export, restore and re-export', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(600_000)
  const executor = await openMobileLab(page, testInfo)
  await loadMobileRaw(page, rawPath)
  if (executor === 'gpu') {
    await expectWebGPUPreview(page, testInfo)
    await expect(page.locator('[data-cpu-preview-banner]')).toHaveCount(0)
  }

  // The dock holds the three tools; compare and export are not tabs.
  await expect(dockTabs(page)).toHaveText(['Look', 'Adjust', 'Transform'])
  await expect(page.getByRole('tab', { name: /compare|export/i })).toHaveCount(
    0,
  )
  await expectLensForExecutor(page, executor)

  // The Look: a local .cube, its contract chosen inline, Strength at 37%,
  // which the preview draws differently from the 70% default.
  await importLookWithContract(page, testInfo)
  const at70 = await settledFrameHash(page, executor)
  await setStrength37(page)
  await expect
    .poll(() => settledFrameHash(page, executor), { timeout: 60_000 })
    .not.toBe(at70)

  // Export borrows the deck: no tool stays selected while it is open, and
  // closing it hands the deck back to Look.
  let panel = await openExportPanel(page)
  for (const tab of await dockTabs(page).all()) {
    await expect(tab).toHaveAttribute('aria-selected', 'false')
  }
  const recap = panel.locator('[data-export-recap]')
  await expect(recap).toContainText(
    `Full-resolution JPEG · ${PUBLIC_DNG_SIZE.width}×${PUBLIC_DNG_SIZE.height}`,
  )
  await expect(recap).toContainText('· 37%')
  // Quality is fixed: the panel offers no quality or fidelity choice.
  await expect(panel.getByRole('radio')).toHaveCount(0)
  await expect(panel.getByRole('combobox')).toHaveCount(0)
  await expect(panel.getByRole('slider')).toHaveCount(0)
  await expect(panel).not.toContainText(/quality|fidelity/i)
  await closeExportPanel(page)
  await expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true')
  await expect(strengthSlider(page)).toHaveAttribute('aria-valuetext', '37%')

  // The GPU preview also writes the HQ preview JPEG from its bounded HQ
  // frame. It must be written at the app's one quality.
  let hq: JpegFile | null = null
  if (executor === 'gpu') {
    panel = await openExportPanel(page)
    const hqExport = panel.getByRole('button', {
      name: 'Export HQ preview JPEG',
    })
    await expect(hqExport).toBeEnabled({ timeout: 120_000 })
    await hqExport.click()
    await expect(exportAction(page)).toHaveAttribute(
      'data-state',
      'preview-done',
      { timeout: 120_000 },
    )
    await expect(panel).toContainText('HQ preview JPEG ready')
    hq = await downloadJpeg(page)
    await expect(panel).toContainText(`${hq.width} x ${hq.height}`)
    expect(hq.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
    expect(hq.width).toBeLessThanOrEqual(PUBLIC_DNG_SIZE.width)
    expect(hq.width / hq.height).toBeCloseTo(
      PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height,
      2,
    )
    await closeExportPanel(page)
    // The HQ result stands until an edit; the edit clears it for the full
    // export.
    await touchStrength(page)
  }

  // The full-resolution export releases the preview and locks the tools.
  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const first = await downloadJpeg(page)
  const firstManifest = await downloadManifest(page)
  await expect(exportPanel(page)).toContainText(
    `${first.width} x ${first.height}`,
  )
  // The file, its markers and its manifest agree.
  expect(firstManifest.output.sha256).toBe(first.sha256)
  expect(firstManifest.output.filename).toBe(first.name)
  expect({ width: first.width, height: first.height }).toEqual(PUBLIC_DNG_SIZE)
  expect(firstManifest.output.dimensions).toEqual(PUBLIC_DNG_SIZE)
  expect(firstManifest.output.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  expect(first.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  expect(firstManifest.render_params.intensity).toBeCloseTo(0.37, 6)
  expect(firstManifest.lut).toBeTruthy()
  const source = await readFile(rawPath)
  expect(firstManifest.source_raw).toMatchObject({
    filename: basename(rawPath),
    sha256: createHash('sha256').update(source).digest('hex'),
    byte_size: source.byteLength,
    decoded_dimensions: PUBLIC_DNG_SIZE,
  })
  // The DNG's BaselineExposure sets the exposure of every frame and of the
  // export; it is not the quick-frame estimate the source keeps for a RAW
  // without one, which the next test covers.
  expect(firstManifest.render_params.raw_render_exposure_source).toBe(
    'dng-baseline',
  )
  const exposureEv = firstManifest.render_params.raw_render_exposure_ev
  expect(Number.isFinite(exposureEv)).toBe(true)
  if (executor === 'cpu') {
    // Every processed CPU frame so far, from the quick source on, drew the
    // exposure the export recorded.
    expect(await cpuProcessedExposures(page)).toEqual([exposureEv])
  }
  if (hq) {
    // The HQ file is written from the same look and exposure: both files
    // carry about the same light.
    const fullLight = await decodedMeanLight(page, first)
    const hqLight = await decodedMeanLight(page, hq)
    expect(Math.abs(hqLight - fullLight)).toBeLessThan(2)
  }

  // Restore hands editing back with the look as it was, on the quick frame.
  await restorePreview(page, executor)
  await selectTool(page, 'Look')
  await expect(strengthSlider(page)).toHaveAttribute('aria-valuetext', '37%')
  await settledFrameHash(page, executor)

  // An edit that leaves the intent as it was clears the result; the second
  // export of the same RAW records the same exposure and writes the same
  // bytes.
  await touchStrength(page)
  await settledFrameHash(page, executor)
  if (executor === 'cpu') {
    expect(await cpuProcessedExposures(page)).toEqual([exposureEv])
  }
  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const second = await downloadJpeg(page)
  const secondManifest = await downloadManifest(page)
  expect(secondManifest.render_params.raw_render_exposure_ev).toBe(exposureEv)
  expect(secondManifest.render_params.raw_render_exposure_source).toBe(
    'dng-baseline',
  )
  expect(secondManifest.render_params.intensity).toBeCloseTo(0.37, 6)
  expect(secondManifest.output.sha256).toBe(second.sha256)
  expect(second.sha256).toBe(first.sha256)
})

test('mobile: a RAW without a DNG baseline keeps its quick frame’s exposure through the bounded HQ frame, export, restore and re-export', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, EXPOSURE_RAW)
  testInfo.setTimeout(900_000)
  const executor = await openMobileLab(page, testInfo)
  // The load reports success only once the bounded HQ frame has replaced the
  // quick one: the frame whose own estimate differs from the quick frame's.
  await loadMobileRaw(page, rawPath)
  let framesBeforeHq = 0
  if (executor === 'gpu') {
    await expectWebGPUPreview(page, testInfo)
    await expect(page.locator('[data-raw-preview-frame]')).toHaveAttribute(
      'data-display-source',
      'bounded-hq',
      { timeout: 120_000 },
    )
  } else {
    framesBeforeHq = (await cpuProcessedFrames(page)).length
    expect(framesBeforeHq, 'the quick frame was drawn').toBeGreaterThan(0)
  }
  // A look gives the re-export an edit to clear the first result with. On
  // the CPU preview, which keeps drawing from its quick source, the renders
  // it asks for take the bounded HQ frame's exposure.
  await importLookWithContract(page, testInfo)
  await settledFrameHash(page, executor)

  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const first = await downloadJpeg(page)
  const firstManifest = await downloadManifest(page)
  expect(firstManifest.output.sha256).toBe(first.sha256)
  expect({ width: first.width, height: first.height }).toEqual(
    firstManifest.output.dimensions,
  )
  expect(first.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  // No baseline: the exposure is estimated from the pixels of a frame.
  expect(firstManifest.render_params.raw_render_exposure_source).toBe(
    'image-statistics',
  )
  const exposureEv = firstManifest.render_params.raw_render_exposure_ev!
  expect(Number.isFinite(exposureEv)).toBe(true)
  let framesBeforeRestore = 0
  if (executor === 'cpu') {
    // The frames drawn before and after the bounded HQ frame landed all drew
    // the exposure the export recorded.
    const frames = await cpuProcessedFrames(page)
    framesBeforeRestore = frames.length
    expect(framesBeforeRestore).toBeGreaterThan(framesBeforeHq)
    expect([...new Set(frames.map((frame) => frame.ev))]).toEqual([exposureEv])
  }

  // Restore decodes a new quick frame of the same source; it keeps the
  // exposure rather than estimating its own.
  await restorePreview(page, executor)
  await touchStrength(page)
  await settledFrameHash(page, executor)
  if (executor === 'cpu') {
    const trace = await readCpuTrace(page)
    const frames = await cpuProcessedFrames(page)
    // The restored frame is a second quick source of the same size.
    expect(trace.sources.length).toBeGreaterThanOrEqual(2)
    expect(trace.sources.at(-1)!.width).toBe(trace.sources[0]!.width)
    expect(frames.length).toBeGreaterThan(framesBeforeRestore)
    expect(frames.at(-1)!.width).toBe(trace.sources[0]!.width)
    expect([...new Set(frames.map((frame) => frame.ev))]).toEqual([exposureEv])
  }

  // The re-export from the restored quick frame records the same exposure
  // and writes the same bytes.
  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const second = await downloadJpeg(page)
  const secondManifest = await downloadManifest(page)
  expect(secondManifest.render_params.raw_render_exposure_source).toBe(
    'image-statistics',
  )
  expect(secondManifest.render_params.raw_render_exposure_ev).toBe(exposureEv)
  expect(secondManifest.output.sha256).toBe(second.sha256)
  expect(second.sha256).toBe(first.sha256)
})

/** A catalog of two visibly equal looks that differ in contract. */
const CATALOG_URL = 'https://luts.example.com/p1/catalog.json'
const ACCEPTED_TITLE = 'Accepted Print'
const REFUSED_TITLE = 'Linear Print'

async function serveContractCatalog(context: BrowserContext) {
  const entry = (id: string, title: string, lut: Record<string, unknown>) => {
    // Darkens every channel, so a drawn look shows on the photo. Each look
    // has its own file: one LUT is one look, whatever its catalog row says.
    const cube = createCube(title, (value) => value * 0.55)
    const primaryAsset = {
      url: `https://luts.example.com/p1/${id}.cube`,
      role: 'cube-lut',
      mediaType: 'application/x-cube-lut',
      sha256: createHash('sha256').update(cube).digest('hex'),
      size: Buffer.byteLength(cube),
      title,
    }
    const row = {
      id,
      kind: 'lut',
      version: '1.0.0',
      title,
      family: 'Contract',
      license: 'CC0-1.0',
      redistributionAllowed: true,
      primaryAsset,
      entryUrl: `https://luts.example.com/p1/entries/${id}.json`,
    }
    return {
      row,
      cube,
      document: { ...row, schemaVersion: 1, format: 'cube', lut },
    }
  }
  const accepted = entry('accepted-print', ACCEPTED_TITLE, {
    intent: 'display-look',
    input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
  })
  // Export refuses a linear LUT output, so the preview must not draw it.
  const refused = entry('linear-print', REFUSED_TITLE, {
    intent: 'combined-look-output',
    input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
    output: { gamut: 'srgb-rec709', transfer: 'linear', range: 'full' },
  })
  const documents = new Map<string, string>([
    [
      CATALOG_URL,
      JSON.stringify({
        schemaVersion: 1,
        entries: [accepted.row, refused.row],
      }),
    ],
    [accepted.row.entryUrl, JSON.stringify(accepted.document)],
    [refused.row.entryUrl, JSON.stringify(refused.document)],
    [accepted.row.primaryAsset.url, accepted.cube],
    [refused.row.primaryAsset.url, refused.cube],
  ])
  await context.route('https://luts.example.com/**', async (route) => {
    const body = documents.get(route.request().url())
    await route.fulfill(
      body === undefined
        ? { status: 404, body: 'not found' }
        : {
            contentType: route.request().url().endsWith('.cube')
              ? 'text/plain'
              : 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body,
          },
    )
  })
  // The default catalog is not part of this test; answer it with no looks.
  await context.route('https://luma-prof.ichr.me/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ schemaVersion: 1, entries: [] }),
    }),
  )
}

function lookTile(page: Page, title: string) {
  return lookStrip(page)
    .locator('[data-mobile-lut-tile="entry"]')
    .filter({ hasText: title })
}

test('mobile: a look export refuses draws as no look, says why, and cannot be exported', async ({
  context,
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(300_000)
  await serveContractCatalog(context)
  const executor = await openMobileLab(
    page,
    testInfo,
    `/raw?luts=${encodeURIComponent(CATALOG_URL)}`,
  )
  await loadMobileRaw(page, rawPath)
  await selectTool(page, 'Look')
  await expect(lookTile(page, ACCEPTED_TITLE)).toBeVisible({ timeout: 60_000 })
  await expect(lookTile(page, REFUSED_TITLE)).toBeVisible()
  const noLook = await settledFrameHash(page, executor)

  // The accepted contract draws the cube: the photo changes.
  await lookTile(page, ACCEPTED_TITLE).click()
  await expect(lookTile(page, ACCEPTED_TITLE)).toHaveAttribute(
    'data-state',
    'applied',
    { timeout: 60_000 },
  )
  await expect(page.getByText(/^Not in (the CPU )?preview/)).toHaveCount(0)
  await expect
    .poll(() => settledFrameHash(page, executor), { timeout: 60_000 })
    .not.toBe(noLook)

  // The same cube under a contract export refuses: the look stays selected,
  // the preview drops it (user color kept, nothing blanked) and says why.
  await lookTile(page, REFUSED_TITLE).click()
  await expect(lookTile(page, REFUSED_TITLE)).toHaveAttribute(
    'data-state',
    'needs-contract',
    { timeout: 60_000 },
  )
  await expect(lookTile(page, REFUSED_TITLE)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(lookTile(page, ACCEPTED_TITLE)).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(
    page.getByRole('button', {
      name: 'Not in preview · linear LUT output not supported',
    }),
  ).toBeVisible()
  await expect
    .poll(() => settledFrameHash(page, executor), { timeout: 60_000 })
    .toBe(noLook)

  // Export fails closed on it, and says it is the contract.
  const panel = await openExportPanel(page)
  await expect(
    panel.getByRole('button', { name: 'Export full-resolution JPEG' }),
  ).toBeDisabled()
  const reason = panel.locator('[data-export-unavailable-reason]')
  await expect(reason).toBeVisible()
  await expect(reason).toHaveAttribute('data-tone', 'contract')
  // The HQ preview JPEG is the preview's own render, which leaves the look
  // out, so it refuses as well and says why. The recap does not claim the
  // look either.
  const hqExport = panel.getByRole('button', {
    name: 'Export HQ preview JPEG',
  })
  await expect(hqExport).toBeDisabled()
  await expect(hqExport).toHaveAccessibleDescription(
    'The preview leaves out the selected LUT. Fix its color contract or clear the LUT to export an HQ preview JPEG.',
  )
  const recap = panel.locator('[data-export-recap]')
  await expect(recap).toBeVisible()
  await expect(recap).not.toContainText(REFUSED_TITLE)
  await expect(recap).toContainText('No LUT')
  await expect(exportAction(page)).toHaveAccessibleName(
    'Export blocked: open details',
  )
})
