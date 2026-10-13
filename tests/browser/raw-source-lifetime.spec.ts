import type { Buffer } from 'node:buffer'
import { basename } from 'node:path'

import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { QUICK_PREVIEW_MAX_PIXELS } from '../../packages/render-engine/src/preview/preview-plan'
import { downloadJpeg, downloadManifest } from './support/files'
import {
  dngFile,
  gateRawFixture,
  PUBLIC_DNG,
  PUBLIC_DNG_SIZE,
} from './support/fixtures'
import { settledCpuFrame } from './support/frames'
import {
  chooseRaw,
  chooseReplacement,
  cpuCanvas,
  deck,
  dockTab,
  downloadButton,
  emptyLab,
  expectWebGPUPreview,
  exportAction,
  exportButton,
  exportFullResolution,
  exportSurface,
  fullExportButton,
  gpuCanvas,
  isChromium,
  isMobile,
  lens,
  loadedLab,
  MOBILE_VIEWPORT,
  moveAwayFromToasts,
  nudgeExposure,
  openLab,
  openTool,
  previewFrame,
  restoreButton,
  splitSlider,
  uploadDock,
  waitForLoaded,
} from './support/lab'
import type { PageTrace, TracedWorker } from './support/trace'
import {
  IDLE_GAP_MIN_MS,
  installPageTrace,
  now,
  RAW_RUNTIME_IDLE_MS,
  rawWorkers,
  readTrace,
  release,
  requested,
  sessionWorker,
  setTrace,
  workerByIndex,
} from './support/trace'

// How long a source's work may live, observed only through what a user can
// do and what the page then holds: an idle runtime ends on its own and a
// loaded RAW gives its runtime back once its bounded HQ settled, a RAW chosen
// over a stalled load replaces it at once, leaving the route ends the
// session and the work it started, a replacement with the same frame size
// gets frames of its own, and a delivery reads the result it was asked for
// or refuses. The Chromium project runs the GPU preview on a software
// adapter, the WebKit project (no WebGPU adapter) the CPU preview.

/** A phone short enough that each deck takes its height from the photo. */
const SHORT_MOBILE_VIEWPORT = { width: 393, height: 600 }
/** An idle window for probing the trace's own timer hold. */
const TIMER_PROBE_MS = 1_357
const STALE_DELIVERY_COPY =
  'This export no longer matches the photo. Export again to deliver it.'
const COPY_FULL_LABEL = 'Copy full-resolution image'

/** The CPU canvas's settled frame, by the hash of its pixels. */
async function cpuFrameHash(page: Page) {
  return (await settledCpuFrame(page)).hash
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

/**
 * The photo is on screen under the project's executor: a load ends on its
 * bounded HQ frame, a Restore on a fresh quick frame.
 */
async function expectPreviewShown(
  page: Page,
  testInfo: TestInfo,
  source: 'bounded-hq' | 'quick' = 'bounded-hq',
) {
  if (isChromium(testInfo)) {
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
  await cpuFrameHash(page)
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
  if (isChromium(testInfo)) {
    await expect(lens(page)).toHaveAttribute('data-lens-mode', 'split')
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(splitSlider(page)).toBeVisible()
    await lens(page).click()
    await expect(splitSlider(page)).toHaveCount(0)
    return null
  }
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
  const processed = await cpuFrameHash(page)
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
  expect(await cpuFrameHash(page)).not.toBe(processed)
  const neutral = (await readTrace(page)).cpuRenders.at(-1)!
  await expect(splitSlider(page)).toHaveCount(0)
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => (await readTrace(page)).cpuRenders.at(-1)?.variant, {
      timeout: 60_000,
    })
    .toBe('processed')
  expect(await cpuFrameHash(page)).toBe(processed)
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
  if (isChromium(testInfo)) {
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
    Object.assign(window, { __labLayers: state })
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
      await release(page, 'settleTimers')
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
    await release(page, 'settleTimers')
    await devtools.detach().catch(() => {})
  }

  const samples = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __labLayers: { samples: LayerSample[]; running: boolean }
      }
    ).__labLayers
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

test('trace: an idle-window timer the trace held and then released is still cancelled by the id the page was given, and forgotten once it fires', async ({
  page,
}) => {
  // A window no timer of the app uses, so only the probe's timers are held.
  await page.addInitScript(installPageTrace, {
    idleMs: TIMER_PROBE_MS,
    settleMs: TIMER_PROBE_MS * 7,
  })
  await page.goto('/')
  // One synchronous turn: nothing else can schedule while the hold is on.
  const scheduled = await page.evaluate((delay) => {
    const probe = window as unknown as {
      __labTrace: PageTrace
      __labRelease: { idleTimers: () => void }
      __labFired: string[]
    }
    probe.__labFired = []
    const fire = (name: string) => () => probe.__labFired.push(name)
    probe.__labTrace.holdIdleTimers = true
    const forgotten = window.setTimeout(fire('forgotten'), delay)
    const cancelled = window.setTimeout(fire('cancelled'), delay)
    window.setTimeout(fire('kept'), delay)
    const held = probe.__labTrace.heldIdleTimers
    // Cleared while held: it is forgotten and never scheduled.
    window.clearTimeout(forgotten)
    probe.__labRelease.idleTimers()
    const released = probe.__labTrace.releasedIdleTimers
    // Cleared after the release: the browser timer it became is cancelled.
    window.clearTimeout(cancelled)
    return {
      held,
      released,
      afterCancel: probe.__labTrace.releasedIdleTimers,
      heldAfterRelease: probe.__labTrace.heldIdleTimers,
    }
  }, TIMER_PROBE_MS)
  await page.waitForTimeout(TIMER_PROBE_MS * 2 + 500)
  const after = await page.evaluate(() => {
    const probe = window as unknown as {
      __labTrace: PageTrace
      __labFired: string[]
    }
    return {
      fired: probe.__labFired,
      released: probe.__labTrace.releasedIdleTimers,
    }
  })
  expect(after.fired, 'only the timer nobody cleared runs').toEqual(['kept'])
  expect(scheduled).toEqual({
    held: 3,
    released: 2,
    afterCancel: 1,
    heldAfterRelease: 0,
  })
  // The one that ran is forgotten too.
  expect(after.released).toBe(0)
})

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
  if (isChromium(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await cpuFrameHash(page)

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
  if (isChromium(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await cpuFrameHash(page)

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
  expect(
    toasts.some((toast) => toast.text.includes(`Loaded ${second.name}`)),
  ).toBe(true)
  expect(toasts.filter((toast) => toast.text.includes(first.name))).toEqual([])
  if (isChromium(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await cpuFrameHash(page)
})

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
    ;(window as unknown as { __labDocument: string }).__labDocument = 'same'
  })
  const sameDocument = () =>
    page.evaluate(
      () => (window as unknown as { __labDocument?: string }).__labDocument,
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
  await release(page, 'rawRequests')
  await release(page, 'idleTimers')
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
  if (!isChromium(testInfo)) {
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
  const gpu = isChromium(testInfo)
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
    await release(page, 'rawRequests')
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
    await release(page, 'gpuCompletions', owedNow)
    await page.waitForTimeout(1_500)
    expect((await readTrace(page)).pendingGpuCompletions).toBe(replacementOwed)
    await expect(handoff).toBeVisible()
    await expect(previewFrame(page)).toHaveAttribute(
      'data-display-source',
      'quick',
    )

    // Once the GPU answers for the replacement, its quick frame takes the
    // stage while its bounded HQ is still held.
    await release(page, 'gpuCompletions')
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
    await release(page, 'cpuFrames', replacedAt)
    await page.waitForTimeout(1_500)
    trace = await readTrace(page)
    expect(trace.pendingCpuFrames).toBeGreaterThanOrEqual(1)
    await expect(cpuCanvas(page)).toHaveCount(0)
    await expect(page.getByTestId('cpu-preview-spinner')).toBeVisible()

    await release(page, 'cpuFrames')
    await cpuFrameHash(page)
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
  await release(page, 'rawRequests')
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
  if (isChromium(testInfo)) await expectDualGpuLayersAligned(page)

  // The dock and deck serve the replacement.
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled()
  }
  await nudgeExposure(page, 10)
  await expect(deck(page)).toBeVisible()
  if (isChromium(testInfo)) await expectWebGPUPreview(page, testInfo)

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

test('delivery: with the preview released the result downloads, shares and copies as itself; a delivery still reading its file when an edit retires the result is refused and says why', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(480_000)
  const raw = await dngFile(testInfo, 'delivered.dng')
  await openLab(page, testInfo, { surface: 'project', deliveryStandIns: true })
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
  const { manifest } = await downloadManifest(page)
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
  // changes the photo. The desktop rail runs one share or copy at a time,
  // so there the copy waits out of this race and download and share hold.
  const held = isMobile(page)
    ? ['Download failed', 'Share failed', 'Copy failed']
    : ['Download failed', 'Share failed']
  const downloadsBefore = downloads
  await setTrace(page, { delivery: { armed: true, held: 0 } })
  await downloadButton(page).click()
  await exportButton(page, 'Share').click()
  if (isMobile(page)) await exportButton(page, COPY_FULL_LABEL).click()
  await expect
    .poll(async () => (await readTrace(page)).delivery.held, {
      timeout: 30_000,
    })
    .toBe(held.length)
  await nudgeExposure(page, 5)
  if (isChromium(testInfo)) await expectWebGPUPreview(page, testInfo)
  else await cpuFrameHash(page)
  const editedAt = await now(page)
  await release(page, 'deliveries')

  // Nothing is delivered, and each refusal says why.
  for (const title of held) {
    await expect(page.getByText(title, { exact: true })).toBeVisible({
      timeout: 30_000,
    })
  }
  await page.waitForTimeout(1_500)
  trace = await readTrace(page)
  const refusals = trace.toasts.filter((toast) => toast.at > editedAt)
  expect(refusals).toHaveLength(held.length)
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
