import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { Download, Locator, Page, TestInfo } from '@playwright/test'
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

// The assertions below name the public DNG's own facts (its support level,
// its size), so the spec always runs on that file, and a missing copy fails
// instead of skipping.
const PUBLIC_DNG = resolvePublicRawFixture({
  env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
})

/** The public DNG's sensor size, as the decoder reports it. */
const PUBLIC_DNG_SIZE = { width: 4032, height: 3024 }

const MOBILE_VIEWPORT = { width: 393, height: 852 }
const INTERRUPTED_COPY =
  'The previous export was interrupted. The next export you start uses the current RAW and adjustments with a safer setting.'

type CpuPreviewTrace = {
  /** Renders posted to the CPU preview worker, in order. */
  renders: Array<{ worker: number; requestId: number; variant: string }>
  /** Frames the CPU preview worker answered. */
  frames: Array<{ worker: number; requestId: number }>
}

type ExportDebugEvent = { type: string; payload: Record<string, unknown> }

type CanvasDigest = {
  width: number
  height: number
  boxWidth: number
  boxHeight: number
  hash: string
  meanLight: number
  colors: number
}

/**
 * Records the CPU preview worker's traffic: every render the page posts
 * with its variant, and every frame the worker sends back. Only workers that
 * receive a variant render are recorded; the other workers pass through.
 */
function traceCpuPreviewWorker() {
  // Playwright compiles this function before it reaches the page, so it
  // keeps to syntax that needs no helpers: no class fields.
  const NativeWorker = window.Worker
  const trace: CpuPreviewTrace = { renders: [], frames: [] }
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
        requestId?: number
        variant?: string
      }
      if (request?.type === 'render' && typeof request.variant === 'string') {
        cpuPreviewWorkers.add(this)
        trace.renders.push({
          worker: indexes.get(this) ?? 0,
          requestId: Number(request.requestId),
          variant: request.variant,
        })
      }
      if (options === undefined) super.postMessage(message)
      else super.postMessage(message, options as StructuredSerializeOptions)
    }
  }
  window.Worker = TracedWorker
}

function collectExportDebugEvents() {
  const events: ExportDebugEvent[] = []
  ;(
    window as unknown as { __exportEvents: ExportDebugEvent[] }
  ).__exportEvents = events
  window.addEventListener('lumaforge-export-debug', (event) => {
    events.push((event as CustomEvent<ExportDebugEvent>).detail)
  })
}

async function readCpuTrace(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __cpuPreviewTrace: CpuPreviewTrace })
        .__cpuPreviewTrace,
  )
}

async function readExportEvents(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __exportEvents?: ExportDebugEvent[] })
        .__exportEvents ?? [],
  )
}

/** The CPU preview has answered every render it was asked for. */
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
  await page.addInitScript(collectExportDebugEvents)
}

/**
 * The mobile lab on the CPU preview: Chromium at a phone viewport with the
 * preview forced to the CPU, WebKit (which has no WebGPU adapter here) on
 * the plain route, where it falls back by itself.
 */
async function openMobileCpuLab(page: Page, testInfo: TestInfo) {
  await prepareLab(page)
  if (isDesktopChromiumProject(testInfo)) {
    await page.setViewportSize(MOBILE_VIEWPORT)
    await page.goto(rawPreviewUrl(testInfo, '/raw?forcePreview=cpu'))
  } else {
    await page.goto(rawPreviewUrl(testInfo, '/raw'))
  }
  expect(page.viewportSize()!.width).toBeLessThanOrEqual(640)
  await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  await expect(page.getByText(/GPU preview unavailable/)).toBeVisible()
}

async function waitForLoadedRaw(page: Page, name: string) {
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })
  // Ingest reports success only after the bounded HQ decode.
  const loaded = page.getByText(`Loaded ${name}`, { exact: true })
  await expect(loaded).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  // The toast sits over the top of the photo, where the lens is.
  await expect(loaded).toBeHidden({ timeout: 30_000 })
}

async function loadMobileRaw(page: Page, path: string) {
  const choosing = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Browse RAW files' }).click()
  await (await choosing).setFiles(path)
  await waitForLoadedRaw(page, basename(path))
}

function stage(page: Page) {
  return page.getByRole('region', { name: 'RAW preview comparison' })
}

function cpuCanvas(page: Page) {
  return stage(page).locator('canvas[aria-label="Embedded RAW preview"]')
}

function lens(page: Page) {
  return page.locator('[data-mobile-compare-lens]')
}

function dockTabs(page: Page) {
  return page.getByRole('tablist', { name: 'Lab modes' }).getByRole('tab')
}

function dockTab(page: Page, name: 'Look' | 'Adjust' | 'Transform') {
  return page
    .getByRole('tablist', { name: 'Lab modes' })
    .getByRole('tab', { name, exact: true })
}

/** Opens a dock tool; tapping the tool already open would collapse it. */
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

async function readCanvas(canvas: Locator): Promise<CanvasDigest> {
  return canvas.evaluate(async (element) => {
    const target = element as HTMLCanvasElement
    const { width, height } = target
    const pixels = target
      .getContext('2d')!
      .getImageData(0, 0, width, height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    let light = 0
    let samples = 0
    const colors = new Set<number>()
    for (let offset = 0; offset < pixels.length; offset += 64) {
      // The letterbox around the fitted photo stays transparent.
      if (pixels[offset + 3] === 0) continue
      light += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
      colors.add(
        (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2],
      )
      samples++
    }
    return {
      width,
      height,
      boxWidth: target.clientWidth,
      boxHeight: target.clientHeight,
      hash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      meanLight: samples ? light / samples : 0,
      colors: colors.size,
    }
  })
}

/**
 * The CPU canvas once the worker has answered its last render and the
 * canvas has stopped changing (a resize redraw lands after its box settles).
 */
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
  let previous = await readCanvas(cpuCanvas(page))
  await expect
    .poll(
      async () => {
        const next = await readCanvas(cpuCanvas(page))
        const settled = next.hash === previous.hash
        previous = next
        return settled
      },
      { intervals: [300], timeout: 15_000 },
    )
    .toBe(true)
  expect(
    previous.colors,
    'the canvas must show the photograph',
  ).toBeGreaterThan(1000)
  return previous
}

/** Waits for the CPU canvas to settle on a frame other than `from`. */
async function nextCpuFrame(page: Page, from: CanvasDigest) {
  await expect
    .poll(async () => (await readCanvas(cpuCanvas(page))).hash, {
      timeout: 60_000,
    })
    .not.toBe(from.hash)
  return settledCpuFrame(page)
}

async function holdLens(page: Page) {
  // Hovering first waits until nothing (a toast) covers the lens.
  await lens(page).hover()
  await page.mouse.down()
  // Past the 250ms long press.
  await page.waitForTimeout(450)
}

/** Raises the exposure on the mobile Adjust list so processed ≠ neutral. */
async function raiseExposure(page: Page, steps: number) {
  await selectTool(page, 'Adjust')
  const exposure = deck(page).getByRole('slider', {
    name: 'Exposure',
    exact: true,
  })
  await expect(exposure).toBeEnabled()
  const before = Number(await exposure.getAttribute('aria-valuenow'))
  await exposure.focus()
  for (let step = 0; step < steps; step++) await exposure.press('PageUp')
  await expect
    .poll(async () => Number(await exposure.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before)
  return exposure
}

async function hashDownload(download: Download) {
  const path = await download.path()
  expect(path, 'the download must land on disk').toBeTruthy()
  const bytes = await readFile(path!)
  return {
    name: download.suggestedFilename(),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function downloadFrom(page: Page, button: Locator) {
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  return hashDownload(await downloading)
}

async function readManifestDownload(page: Page, button: Locator) {
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  const download = await downloading
  const path = await download.path()
  expect(path).toBeTruthy()
  const text = await readFile(path!, 'utf8')
  return {
    name: download.suggestedFilename(),
    sha256: createHash('sha256').update(text).digest('hex'),
    manifest: JSON.parse(text) as {
      kind: string
      manifest_sha256: string
      output: { sha256: string; filename: string }
      source_raw: { sha256: string; byte_size: number }
    },
  }
}

/**
 * Rows of one fact list in the File & pipeline sheet, keyed by label.
 */
async function readFactRows(sheet: Locator, heading: string) {
  return sheet
    .locator('section')
    .filter({ has: sheet.page().getByRole('heading', { name: heading }) })
    .locator('dl')
    .evaluate((list) => {
      const rows: Record<string, string> = {}
      for (const term of Array.from(list.querySelectorAll('dt'))) {
        rows[term.textContent?.trim() ?? ''] =
          term.nextElementSibling?.textContent?.trim() ?? ''
      }
      return rows
    })
}

async function readPipelineSteps(sheet: Locator) {
  return sheet
    .locator('section')
    .filter({
      has: sheet.page().getByRole('heading', { name: 'Color pipeline' }),
    })
    .locator('ol > li')
    .evaluateAll((items) =>
      items.map((item) => {
        const parts = item.querySelectorAll(':scope > span:last-child > span')
        return {
          label: parts[0]?.textContent?.trim() ?? '',
          detail: parts[1]?.textContent?.trim() ?? '',
        }
      }),
    )
}

async function openFileDetails(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page
    .getByRole('menuitem', { name: 'File & pipeline details', exact: true })
    .click()
  const sheet = page.getByRole('dialog', { name: 'File & pipeline' })
  await expect(sheet).toBeVisible()
  return sheet
}

async function closeFileDetails(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'File & pipeline' })
  await sheet
    .getByRole('button', { name: 'Close file & pipeline details' })
    .click()
  await expect(sheet).toHaveCount(0)
}

/**
 * The File facts rows for the public DNG. On the GPU preview the preview
 * size and its render time are measured; the CPU worker measures neither,
 * so those rows may only say so or carry a real measurement.
 */
async function expectPublicDngFileFacts(
  sheet: Locator,
  preview: 'gpu' | 'cpu',
) {
  const files = await readFactRows(sheet, 'File facts')
  expect(Object.keys(files)).toEqual([
    'Camera',
    'Support',
    'Size',
    'Preview',
    'Preview render',
    'Processing',
  ])
  expect(files.Camera).toBe('Apple iPhone8,4 back camera')
  expect(files.Support).toBe('Experimental support')
  expect(files.Size).toBe(
    `${PUBLIC_DNG_SIZE.width} x ${PUBLIC_DNG_SIZE.height}`,
  )
  expect(files.Processing).toBe('This browser, nothing uploaded')
  const previewSize = /^(\d+) x (\d+)$/.exec(files.Preview ?? '')
  if (preview === 'gpu' || previewSize) {
    expect(
      previewSize,
      `measured preview size: ${files.Preview}`,
    ).not.toBeNull()
    const [width, height] = [Number(previewSize![1]), Number(previewSize![2])]
    expect(width).toBeLessThanOrEqual(PUBLIC_DNG_SIZE.width)
    expect(width / height).toBeCloseTo(
      PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height,
      1,
    )
  } else {
    expect(files.Preview).toBe('Not loaded')
  }
  if (preview === 'gpu') {
    expect(files['Preview render']).toMatch(/^\d+ ms$/)
  } else {
    expect(files['Preview render']).toMatch(/^(Not loaded|\d+ ms)$/)
  }
  return files
}

/** An identity .cube at the smallest size the LUT parser accepts. */
function createIdentityCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/**
 * What a page that closed mid-export leaves behind: an unfinished
 * interruption marker for the public DNG's file tuple, written while its
 * owner held a lifetime lock that nobody holds any more. A marker matches
 * only the exact tuple, so it is seeded for the file's mtime as a browser may
 * report it (floored, rounded, or at second precision).
 */
async function seedInterruptedExport(page: Page, testInfo: TestInfo) {
  const { size, mtimeMs } = await stat(PUBLIC_DNG.path)
  await page.goto(rawPreviewUrl(testInfo, '/'))
  // Only a released owner lock proves the page is gone; a browser without
  // Web Locks never reports an interruption.
  const locks = await page.evaluate(() => Boolean(navigator.locks?.request))
  if (!isDesktopChromiumProject(testInfo)) {
    test.skip(
      !locks,
      'This browser build has no Web Locks to prove an export page closed',
    )
  }
  expect(locks, 'Web Locks are required to report an interruption').toBe(true)
  const lastModifiedCandidates = [
    ...new Set([
      Math.floor(mtimeMs),
      Math.round(mtimeMs),
      Math.floor(mtimeMs / 1000) * 1000,
    ]),
  ]
  await page.evaluate(
    ({ name, size, lastModifiedCandidates }) => {
      const now = Date.now()
      lastModifiedCandidates.forEach((lastModified, index) => {
        const attempt = `p0-safety-interrupted-${index}`
        localStorage.setItem(
          `lumaforge.export-interruption.v1.${attempt}`,
          JSON.stringify({
            version: 1,
            attempt,
            owner: 'p0-safety-closed-page',
            ownerLocked: true,
            source: JSON.stringify([name, size, lastModified]),
            startedAt: now,
            updatedAt: now,
            terminal: null,
          }),
        )
      })
    },
    { name: basename(PUBLIC_DNG.path), size, lastModifiedCandidates },
  )
}

test.describe('mobile CPU lab', () => {
  test('keeps tools in the dock, compare on the stage lens and Export in the topbar; the lens switches executors and the frame survives a resize', async ({
    page,
  }, testInfo) => {
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(240_000)
    await openMobileCpuLab(page, testInfo)
    await loadMobileRaw(page, rawPath)

    // The dock holds the three tools and nothing else.
    await expect(dockTabs(page)).toHaveText(['Look', 'Adjust', 'Transform'])
    await expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.getByRole('tab', { name: /compare|export/i }),
    ).toHaveCount(0)

    // Compare is a lens on the photograph. The CPU preview has no split
    // surface, so the lens is an original toggle and no split control exists.
    await expect(lens(page)).toBeVisible()
    await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
    await expect(lens(page)).toHaveAccessibleName('Show original')
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    const stageBox = (await stage(page).boundingBox())!
    const lensBox = (await lens(page).boundingBox())!
    expect(lensBox.x).toBeGreaterThanOrEqual(stageBox.x - 1)
    expect(lensBox.y).toBeGreaterThanOrEqual(stageBox.y - 1)
    expect(lensBox.x + lensBox.width).toBeLessThanOrEqual(
      stageBox.x + stageBox.width + 1,
    )
    expect(lensBox.y + lensBox.height).toBeLessThanOrEqual(
      stageBox.y + stageBox.height + 1,
    )
    const noSplit = async () => {
      await expect(
        page.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toHaveCount(0)
      await expect(
        stage(page).getByRole('button', { name: 'Original' }),
      ).toHaveCount(0)
    }
    await noSplit()

    // Export is the topbar action; it borrows the deck and hands it back to
    // the tool that held it.
    await expect(exportAction(page)).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    })
    await exportAction(page).click()
    await expect(exportAction(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(exportPanel(page)).toBeVisible()
    for (const tab of await dockTabs(page).all()) {
      await expect(tab).toHaveAttribute('aria-selected', 'false')
    }
    await exportPanel(page)
      .getByRole('button', { name: 'Close export' })
      .click()
    await expect(exportPanel(page)).toHaveCount(0)
    await expect(exportAction(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('group', { name: 'Looks' })).toBeVisible()
    await expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true')

    // A visible edit, so the processed and the neutral executors differ.
    const unedited = await settledCpuFrame(page)
    await raiseExposure(page, 10)
    const processed = await nextCpuFrame(page, unedited)
    expect(processed.meanLight).toBeGreaterThan(unedited.meanLight + 4)
    const rendersBeforeLens = (await readCpuTrace(page)).renders.length
    expect((await readCpuTrace(page)).renders.at(-1)?.variant).toBe('processed')

    // Tap: the CPU worker renders the neutral variant and the canvas shows it.
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    const neutral = await nextCpuFrame(page, processed)
    const afterTap = await readCpuTrace(page)
    expect(
      afterTap.renders.slice(rendersBeforeLens).map((render) => render.variant),
    ).toEqual(['neutral'])
    expect(neutral.meanLight).toBeLessThan(processed.meanLight - 4)
    await noSplit()

    // Tap again: back to the processed executor and the same frame.
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
    expect((await readCpuTrace(page)).renders.at(-1)?.variant).toBe('processed')

    // Hold peeks the original; release hands back the processed photo, and
    // a hold is never a tap.
    await holdLens(page)
    expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
    await page.mouse.up()
    expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')

    // A cancelled hold ends the peek the same way.
    await lens(page).evaluate((element) => {
      element.addEventListener(
        'pointerdown',
        (event) => {
          ;(window as unknown as { __lensPointer: number }).__lensPointer = (
            event as PointerEvent
          ).pointerId
        },
        { once: true },
      )
    })
    await holdLens(page)
    expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
    await lens(page).evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          pointerId: (window as unknown as { __lensPointer: number })
            .__lensPointer,
          pointerType: 'mouse',
        }),
      )
    })
    expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
    await page.mouse.up()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    expect((await settledCpuFrame(page)).hash).toBe(processed.hash)

    // A press that slides off before the hold lands is neither a tap nor a
    // peek.
    const box = (await lens(page).boundingBox())!
    await lens(page).hover()
    await page.mouse.down()
    await page.mouse.move(box.x - 30, box.y + box.height + 30, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    expect((await settledCpuFrame(page)).hash).toBe(processed.hash)

    // From a pinned original, a hold keeps the original and its release
    // returns to the pin, not to the processed photo.
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
    await holdLens(page)
    await page.mouse.up()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    expect((await settledCpuFrame(page)).hash).toBe(neutral.hash)
    // Changing tools drops the pin, so the next edit is seen: the processed
    // executor renders again.
    await selectTool(page, 'Look')
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    const edited = await nextCpuFrame(page, neutral)
    expect(edited.hash).toBe(processed.hash)
    expect((await readCpuTrace(page)).renders.at(-1)?.variant).toBe('processed')
    await noSplit()

    // A tap on the photo goes immersive and the stage takes the whole
    // screen. The frame already on the canvas is redrawn at the new box
    // without a new render, and again on the way back.
    const rendersBeforeResize = (await readCpuTrace(page)).renders.length
    const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio, 2))
    const expectRedrawnWithoutRender = async (from: CanvasDigest) => {
      // Redrawn: the backing store follows the new box, which a resize alone
      // (the canvas stretched by CSS) would not do.
      await expect
        .poll(async () => {
          const next = await readCanvas(cpuCanvas(page))
          return (
            `${next.boxWidth}x${next.boxHeight}` !==
              `${from.boxWidth}x${from.boxHeight}` &&
            next.width === Math.round(next.boxWidth * dpr) &&
            next.height === Math.round(next.boxHeight * dpr)
          )
        })
        .toBe(true)
      const resized = await settledCpuFrame(page)
      expect(resized.width).toBe(Math.round(resized.boxWidth * dpr))
      expect(resized.height).toBe(Math.round(resized.boxHeight * dpr))
      expect(Math.abs(resized.meanLight - edited.meanLight)).toBeLessThan(3)
      expect((await readCpuTrace(page)).renders).toHaveLength(
        rendersBeforeResize,
      )
      return resized
    }
    const tapPhoto = async () => {
      const box = (await cpuCanvas(page).boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    await tapPhoto()
    await expect(page.getByRole('banner')).toHaveCount(0)
    const immersive = await expectRedrawnWithoutRender(edited)
    await tapPhoto()
    await expect(page.getByRole('banner')).toBeVisible()
    await expectRedrawnWithoutRender(immersive)
    await noSplit()
  })

  test('the More menu holds real actions; support and measured facts read in the topbar and File & pipeline details', async ({
    page,
  }, testInfo) => {
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(240_000)
    await openMobileCpuLab(page, testInfo)
    await loadMobileRaw(page, rawPath)

    // The public DNG is not on the official support matrix: the topbar names
    // that level beside the camera rather than by colour alone.
    const topbar = page.getByRole('banner')
    await expect(topbar).toContainText('Experimental support')
    await expect(topbar).not.toContainText('Official support')

    // The menu lists actions only, each of which does something.
    await page.getByRole('button', { name: 'More actions' }).click()
    const menu = page.getByRole('menu')
    await expect(
      menu.getByRole('menuitem').or(menu.getByRole('menuitemcheckbox')),
    ).toHaveText([
      'Replace RAW',
      'File & pipeline details',
      'Histogram',
      'LanguageEnglish',
      'Reset session',
    ])
    await expect(menu).not.toContainText(/support/i)
    const choosing = page.waitForEvent('filechooser')
    await menu.getByRole('menuitem', { name: 'Replace RAW' }).click()
    const replacing = await choosing
    expect(replacing.isMultiple()).toBe(false)
    // Choosing nothing closes the picker and keeps the open RAW.
    await replacing.setFiles([])
    await expect(
      page.getByRole('heading', { name: basename(rawPath) }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'More actions' }).click()
    const histogram = page.getByRole('menuitemcheckbox', { name: 'Histogram' })
    await expect(histogram).toHaveAttribute('aria-checked', 'false')
    await histogram.click()
    await expect(page.locator('[data-mobile-histogram-card]')).toBeVisible()
    await page.getByRole('button', { name: 'More actions' }).click()
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Histogram' }),
    ).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemcheckbox', { name: 'Histogram' }).click()
    await expect(page.locator('[data-mobile-histogram-card]')).toHaveCount(0)

    // Language switches the lab's copy, and the same item switches it back.
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /^Language/ }).click()
    await expect(topbar).toContainText('实验支持')
    await page.getByRole('button', { name: '更多操作' }).click()
    const chinese = page.getByRole('menuitem', { name: /^语言/ })
    await expect(chinese).toContainText('中文')
    await chinese.click()
    await expect(topbar).toContainText('Experimental support')

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Reset session' }).click()
    const reset = page.getByRole('alertdialog', { name: 'Reset session' })
    await expect(reset).toBeVisible()
    await reset.getByRole('button', { name: 'Cancel' }).click()
    await expect(reset).toHaveCount(0)
    await expect(
      page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
    ).toBeVisible()

    // File & pipeline details: measured facts, each in its own row. The CPU
    // worker does not time its renders, so no render time is invented.
    let sheet = await openFileDetails(page)
    const files = await expectPublicDngFileFacts(sheet, 'cpu')
    await expect(topbar).toContainText(files.Camera!)

    // No LUT yet: the contract reads as unused and Output names the
    // full-resolution JPEG it can write.
    expect(await readFactRows(sheet, 'LUT contract')).toEqual({
      LUT: 'Not used',
    })
    const steps = await readPipelineSteps(sheet)
    expect(steps.map((step) => step.label)).toEqual([
      'RAW decode',
      'Adjust',
      'LUT',
      'Transform',
      'Output',
    ])
    expect(steps[0]!.detail).toBe(`${files.Camera} · Experimental support`)
    expect(steps[2]!.detail).toBe('Not used')
    expect(steps[4]!.detail).toBe('Full-resolution JPEG')
    await closeFileDetails(page)

    // Build the Look through its own entry points: the LUT sources sheet,
    // the strip's import, the contract chosen inline, then Strength.
    await selectTool(page, 'Look')
    await page.getByRole('button', { name: 'LUT sources' }).click()
    const sources = page.getByRole('dialog', { name: 'LUT sources' })
    await expect(sources).toBeVisible()
    await sources.getByRole('button', { name: 'Close LUT sources' }).click()
    await expect(sources).toHaveCount(0)

    const cubePath = testInfo.outputPath('p0-safety.cube')
    await writeFile(cubePath, createIdentityCube('P0 Safety'), 'utf8')
    const importing = page.waitForEvent('filechooser')
    await page
      .getByRole('group', { name: 'Looks' })
      .getByRole('button', { name: 'Import .cube' })
      .click()
    await (await importing).setFiles(cubePath)
    const contractInput = page.getByRole('region', { name: /: input$/ })
    await expect(contractInput).toBeVisible({ timeout: 60_000 })

    // While the contract is open the LUT cannot be confirmed, so no JPEG can
    // be written yet.
    sheet = await openFileDetails(page)
    expect((await readFactRows(sheet, 'LUT contract')).Contract).toBe(
      'Needs contract',
    )
    expect((await readPipelineSteps(sheet))[4]!.detail).not.toBe(
      'Full-resolution JPEG',
    )
    await closeFileDetails(page)

    // The recommended pair completes the contract in one tap.
    await contractInput
      .getByRole('group', { name: 'Recommended input' })
      .getByRole('button', { name: 'Display sRGB · Apply' })
      .click()
    await expect(page.getByRole('group', { name: 'Looks' })).toBeVisible()

    const strength = page
      .locator('[data-mobile-look-strength]')
      .getByRole('slider', { name: 'Strength' })
    await expect(strength).not.toHaveAttribute('data-disabled')
    await expect(strength).toHaveAttribute('aria-valuetext', '70%')
    await strength.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(strength).toHaveAttribute('aria-valuetext', '59%')

    sheet = await openFileDetails(page)
    const look = await readFactRows(sheet, 'LUT contract')
    expect(look.LUT).toBeTruthy()
    expect(look.Contract).toMatch(/^Contract confirmed · /)
    const confirmedSteps = await readPipelineSteps(sheet)
    expect(confirmedSteps[2]!.detail).toBe(`${look.LUT} · Contract confirmed`)
    expect(confirmedSteps[4]!.detail).toBe('Full-resolution JPEG')
    await closeFileDetails(page)

    // The export recap writes what the details promise: the source size and
    // the look at its continuous strength.
    await exportAction(page).click()
    const recap = exportPanel(page).locator('[data-export-recap]')
    await expect(recap).toContainText(
      `Full-resolution JPEG · ${PUBLIC_DNG_SIZE.width}×${PUBLIC_DNG_SIZE.height}`,
    )
    await expect(recap).toContainText('59%')
  })

  test('a finished export holds the preview released: tools lock, the JPEG and manifest stay reachable, and Restore hands editing back', async ({
    page,
  }, testInfo) => {
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(420_000)
    await openMobileCpuLab(page, testInfo)
    await loadMobileRaw(page, rawPath)

    // An Adjust panel is open and edited when the export starts.
    const exposure = await raiseExposure(page, 5)
    const exposureBefore = await exposure.getAttribute('aria-valuenow')
    await expect(exportAction(page)).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    })
    await exportAction(page).click()
    await exportPanel(page)
      .getByRole('button', { name: 'Export full-resolution JPEG' })
      .click()
    await expect(exportAction(page)).toHaveAttribute('data-state', 'done', {
      timeout: 300_000,
    })

    // Released: the stage offers Restore, the deck holds the result, and the
    // three tools are off.
    const restore = stage(page).getByRole('button', { name: 'Restore preview' })
    await expect(restore).toBeVisible()
    await expect(exportPanel(page)).toBeVisible()
    await expect(exportPanel(page)).toContainText('Exported')
    for (const name of ['Look', 'Adjust', 'Transform'] as const) {
      await expect(dockTab(page, name)).toBeDisabled()
    }
    await expect(lens(page)).toHaveCount(0)
    await expect(deck(page).getByRole('slider')).toHaveCount(0)

    const download = exportPanel(page).getByRole('button', {
      name: 'Download',
      exact: true,
    })
    const manifestButton = exportPanel(page).getByRole('button', {
      name: 'Download render manifest (JSON)',
    })
    const jpeg = await downloadFrom(page, download)
    const manifest = await readManifestDownload(page, manifestButton)
    expect(verifyManifestSha256(manifest.manifest)).toBe(true)
    expect(manifest.manifest.kind).toBe('export')
    expect(manifest.manifest.output.sha256).toBe(jpeg.sha256)
    expect(manifest.manifest.output.filename).toBe(jpeg.name)
    const source = await readFile(rawPath)
    expect(manifest.manifest.source_raw.sha256).toBe(
      createHash('sha256').update(source).digest('hex'),
    )

    // Closing the result leaves the deck empty: the Adjust panel that was
    // open before the export does not come back to edit under the JPEG.
    await exportPanel(page)
      .getByRole('button', { name: 'Close export' })
      .click()
    await expect(exportPanel(page)).toHaveCount(0)
    await expect(deck(page)).toHaveCount(0)
    await expect(page.getByRole('slider')).toHaveCount(0)
    for (const name of ['Look', 'Adjust', 'Transform'] as const) {
      await expect(dockTab(page, name)).toBeDisabled()
    }
    await expect(restore).toBeVisible()

    // The topbar reopens the same result, still downloadable byte for byte.
    await expect(exportAction(page)).toHaveAttribute('data-state', 'done')
    await exportAction(page).click()
    await expect(exportPanel(page)).toContainText('Exported')
    await expect(exportPanel(page)).toContainText(jpeg.name)
    expect(await downloadFrom(page, download)).toEqual(jpeg)
    const again = await readManifestDownload(page, manifestButton)
    expect(again.sha256).toBe(manifest.sha256)

    // Restore returns the preview and the tools, with the edits intact.
    await restore.click()
    await expect(cpuCanvas(page)).toBeVisible({ timeout: 120_000 })
    for (const name of ['Look', 'Adjust', 'Transform'] as const) {
      await expect(dockTab(page, name)).toBeEnabled({ timeout: 60_000 })
    }
    const restored = await settledCpuFrame(page)
    await selectTool(page, 'Adjust')
    const restoredExposure = deck(page).getByRole('slider', {
      name: 'Exposure',
      exact: true,
    })
    await expect(restoredExposure).toHaveAttribute(
      'aria-valuenow',
      exposureBefore!,
    )
    await expect(restoredExposure).toBeEnabled()
    await restoredExposure.focus()
    await restoredExposure.press('PageUp')
    await expect(restoredExposure).not.toHaveAttribute(
      'aria-valuenow',
      exposureBefore!,
    )
    await nextCpuFrame(page, restored)
  })

  test('an interrupted export reads as a hint: no file picker, no export until one is started', async ({
    page,
  }, testInfo) => {
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(420_000)
    await prepareLab(page)
    if (isDesktopChromiumProject(testInfo)) {
      await page.setViewportSize(MOBILE_VIEWPORT)
    }
    await seedInterruptedExport(page, testInfo)
    // Loading the RAW opens the one file chooser this test expects.
    let choosers = 0
    page.on('filechooser', () => {
      choosers += 1
    })
    await page.goto(
      rawPreviewUrl(
        testInfo,
        isDesktopChromiumProject(testInfo) ? '/raw?forcePreview=cpu' : '/raw',
      ),
    )
    await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()

    await loadMobileRaw(page, rawPath)
    expect(choosers).toBe(1)

    await expect(exportAction(page)).toHaveAttribute('data-state', 'ready', {
      timeout: 60_000,
    })
    await exportAction(page).click()
    const hint = exportPanel(page).locator('[data-export-interruption]')
    await expect(hint).toHaveText(INTERRUPTED_COPY)
    await expect(exportPanel(page)).not.toContainText(/reselect/i)
    await expect(exportPanel(page).locator('input[type="file"]')).toHaveCount(0)
    const buttons = exportPanel(page).getByRole('button')
    await expect(buttons).toHaveCount(3)
    await expect(buttons.nth(0)).toHaveAccessibleName('Close export')
    await expect(buttons.nth(1)).toHaveAccessibleName(
      'Export full-resolution JPEG',
    )
    await expect(buttons.nth(2)).toHaveAccessibleName('Export HQ preview JPEG')

    // Nothing starts on its own, however long the hint is on screen.
    await page.waitForTimeout(3_000)
    expect(choosers).toBe(1)
    expect(
      (await readExportEvents(page)).map((event) => event.type),
    ).not.toContain('export-plan-selected')
    await expect(exportAction(page)).toHaveAttribute('data-state', 'ready')
    await expect(hint).toBeVisible()

    // The export the user starts takes the safer interrupted-retry plan.
    await exportPanel(page)
      .getByRole('button', { name: 'Export full-resolution JPEG' })
      .click()
    await expect
      .poll(async () =>
        (await readExportEvents(page)).find(
          (event) => event.type === 'export-plan-selected',
        ),
      )
      .toBeTruthy()
    const plan = (await readExportEvents(page)).find(
      (event) => event.type === 'export-plan-selected',
    )!
    expect(
      (plan.payload.policyVector as { productCopy: string }).productCopy,
    ).toBe('interrupted-retry')
    await expect(exportAction(page)).toHaveAttribute('data-state', 'done', {
      timeout: 300_000,
    })
    await expect(hint).toHaveCount(0)
    expect(choosers).toBe(1)
  })
})

test('mobile GPU preview: File & pipeline details carry the measured preview size and its own render time', async ({
  page,
}, testInfo) => {
  test.skip(
    !projectHasWebGPU(testInfo),
    'The measured GPU preview facts need a WebGPU adapter',
  )
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  await prepareLab(page)
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto(rawPreviewUrl(testInfo, '/raw'))
  await loadMobileRaw(page, rawPath)
  await expectWebGPUPreview(page, testInfo)
  await expect(page.locator('[data-cpu-preview-banner]')).toHaveCount(0)

  await expect(page.getByRole('banner')).toContainText(
    'Experimental support · Apple iPhone8,4 back camera',
  )
  const sheet = await openFileDetails(page)
  await expectPublicDngFileFacts(sheet, 'gpu')
  expect((await readPipelineSteps(sheet))[4]!.detail).toBe(
    'Full-resolution JPEG',
  )
})

test('desktop forced CPU: Reset compare view is off, the original row switches executors, and an interrupted export is a hint only', async ({
  page,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'The desktop command rail runs on the desktop project',
  )
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  await prepareLab(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await seedInterruptedExport(page, testInfo)
  await page.goto(rawPreviewUrl(testInfo, '/raw?forcePreview=cpu'))
  await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()

  const choosing = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  await (await choosing).setFiles(rawPath)
  await waitForLoadedRaw(page, basename(rawPath))
  let choosers = 0
  page.on('filechooser', () => {
    choosers += 1
  })
  await expect(page.locator('.raw-preview-canvas')).toHaveCount(0)

  // The CPU stage has no split, so the reset that returns to one is off.
  const compare = page.locator('[data-tool-card-trigger="compare"]')
  if ((await compare.getAttribute('aria-expanded')) !== 'true') {
    await compare.click()
  }
  const resetCompare = page.getByRole('button', { name: 'Reset compare view' })
  await expect(resetCompare).toBeVisible()
  await expect(resetCompare).toBeDisabled()
  // Desktop keeps the CPU stage's own original / processed row, on the same
  // executor switch: after a visible edit each choice shows its own frame,
  // the second original included, which comes from the cache.
  const adjust = page.locator('[data-tool-card-trigger="adjust"]')
  if ((await adjust.getAttribute('aria-expanded')) !== 'true') {
    await adjust.click()
  }
  const unedited = await settledCpuFrame(page)
  const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
  await exposure.focus()
  for (let step = 0; step < 10; step++) await exposure.press('PageUp')
  const processed = await nextCpuFrame(page, unedited)
  const showOriginal = stage(page).getByRole('button', {
    name: 'Original',
    exact: true,
  })
  const showProcessed = stage(page).getByRole('button', {
    name: 'Processed',
    exact: true,
  })
  await showOriginal.click()
  const neutral = await nextCpuFrame(page, processed)
  expect(neutral.meanLight).toBeLessThan(processed.meanLight - 4)
  await showProcessed.click()
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  await showOriginal.click()
  expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
  await showProcessed.click()
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  expect((await readCpuTrace(page)).renders.at(-1)?.variant).toBe('processed')

  // The persistent export block names the interruption and offers only the
  // normal exports.
  const exportBlock = page.locator('[data-raw-export-block="persistent"]')
  await expect(exportBlock.locator('[data-export-interruption]')).toHaveText(
    INTERRUPTED_COPY,
  )
  await expect(exportBlock).not.toContainText(/reselect/i)
  await expect(
    exportBlock.getByRole('button', { name: 'Export full-resolution JPEG' }),
  ).toBeEnabled()
  await page.waitForTimeout(3_000)
  expect(choosers).toBe(0)
  expect(
    (await readExportEvents(page)).map((event) => event.type),
  ).not.toContain('export-plan-selected')
})
