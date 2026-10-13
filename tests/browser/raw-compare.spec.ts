import { basename } from 'node:path'

import type { Page } from '@playwright/test'
import { devices, expect, test } from '@playwright/test'

import { gateRawFixture, RAW_FIXTURE } from './support/fixtures'
import {
  chooseRaw,
  expectWebGPUPreview,
  isChromium,
  lens,
  loadedLab,
  previewFrame,
  splitSlider,
} from './support/lab'

// The compare ladder, split, zoom/pan and bounded-HQ handoff hold for any RAW
// above the quick-preview cap, so these run on any fixture. Both layered
// modes need the GPU preview, so they run on the Chromium project.

type PreviewViewport = { zoom: number; panX: number; panY: number }

type GpuStats = {
  // Render pass draws, completion waits, and queue submits.
  drawCalls: number
  finishCalls: number
  flushCalls: number
}

/** Counts GPU draws, completion waits and submits until the next reset. */
function installGpuCounters() {
  const stats: GpuStats = { drawCalls: 0, finishCalls: 0, flushCalls: 0 }
  Object.assign(window, {
    __compareGpuStats: stats,
    __compareGpuReset() {
      stats.drawCalls = 0
      stats.finishCalls = 0
      stats.flushCalls = 0
    },
  })
  const patch = (
    prototype: object | undefined,
    method: string,
    counter: keyof GpuStats,
  ) => {
    const target = prototype as Record<string, unknown> | undefined
    const original = target?.[method]
    if (typeof original !== 'function') return
    target![method] = function (this: unknown, ...args: unknown[]) {
      stats[counter] += 1
      return Reflect.apply(original, this, args)
    }
  }
  const pass =
    typeof GPURenderPassEncoder === 'undefined'
      ? undefined
      : GPURenderPassEncoder.prototype
  const queue = typeof GPUQueue === 'undefined' ? undefined : GPUQueue.prototype
  patch(pass, 'draw', 'drawCalls')
  patch(pass, 'drawIndexed', 'drawCalls')
  patch(queue, 'onSubmittedWorkDone', 'finishCalls')
  patch(queue, 'submit', 'flushCalls')
}

/** Records each compare mode the stage passes through, in order. */
function installCompareModeRecorder() {
  const samples: string[] = []
  Object.assign(window, { __compareModes: samples })
  const record = () => {
    const mode =
      document
        .querySelector('[data-compare-mode]')
        ?.getAttribute('data-compare-mode') ?? 'missing'
    if (samples.at(-1) !== mode) samples.push(mode)
  }
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      new MutationObserver(record).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-compare-mode'],
      })
      record()
    },
    { once: true },
  )
}

async function readGpuStats(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __compareGpuStats: GpuStats }).__compareGpuStats,
  )
}

async function resetGpuStats(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __compareGpuReset: () => void }
    ).__compareGpuReset(),
  )
}

async function waitForAnimationFrames(page: Page, count: number) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
    }
  }, count)
}

/** Waits until three idle seconds in a row draw and submit nothing. */
async function waitForGpuStatsIdle(page: Page) {
  await resetGpuStats(page)
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(3_000)
        const stats = await readGpuStats(page)
        const idle =
          stats.drawCalls === 0 &&
          stats.finishCalls === 0 &&
          stats.flushCalls === 0
        if (!idle) await resetGpuStats(page)
        return idle
      },
      { timeout: 45_000 },
    )
    .toBe(true)
}

async function readCompareMode(page: Page) {
  return page
    .locator('[data-compare-mode]')
    .first()
    .getAttribute('data-compare-mode')
    .catch(() => null)
}

async function waitForCompareMode(page: Page, expected: string) {
  await expect
    .poll(async () => (await readCompareMode(page)) ?? 'missing', {
      timeout: 120_000,
    })
    .toBe(expected)
}

async function readCompareHandleCenterX(page: Page) {
  const box = await splitSlider(page).boundingBox()
  expect(box).toBeTruthy()
  return box!.x + box!.width / 2
}

async function readPreviewViewport(page: Page): Promise<PreviewViewport> {
  return page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(
      '[data-raw-compare-track="image"]',
    )
    if (!track) return { zoom: 1, panX: 0, panY: 0 }
    const style = getComputedStyle(track)
    return {
      zoom: Number.parseFloat(style.getPropertyValue('--raw-preview-zoom')),
      panX: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-x')),
      panY: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-y')),
    }
  })
}

/**
 * Drags the split handle across the photo. Mid-gesture the handle and clip
 * follow the pointer on animation frames, but the split is committed only on
 * release, and moving it renders nothing on the GPU.
 */
async function dragSplit(page: Page, targetRatio: number) {
  const slider = splitSlider(page)
  await expect(slider).toBeVisible()
  const box = (await slider.boundingBox())!
  const track =
    (await page.locator('[data-raw-compare-track="image"]').boundingBox()) ??
    (await previewFrame(page).boundingBox())!
  const before = Number(await slider.getAttribute('aria-valuenow'))
  const startX = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width * targetRatio, y, { steps: 12 })
  await waitForAnimationFrames(page, 3)
  expect(
    Math.abs((await readCompareHandleCenterX(page)) - startX),
  ).toBeGreaterThan(4)
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(before)
  await page.mouse.up()

  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before)
  await waitForAnimationFrames(page, 3)
  const stats = await readGpuStats(page)
  expect(stats.drawCalls).toBe(0)
  expect(stats.finishCalls).toBe(0)
}

/**
 * Wheel zoom and drag pan move both layers together under a steady split
 * handle; the zoomed surface outgrows its layout box and the frame clips it.
 * Returns the GPU work the viewport moves cost.
 */
async function expectZoomAndPan(
  page: Page,
  at: { x: number; y: number },
  panTo: { x: number; y: number },
) {
  await resetGpuStats(page)
  const handleX = await readCompareHandleCenterX(page)
  const frame = (await previewFrame(page).boundingBox())!
  await page.mouse.move(
    frame.x + frame.width * at.x,
    frame.y + frame.height * at.y,
  )
  await page.mouse.wheel(0, -1200)
  await expect
    .poll(async () => (await readPreviewViewport(page)).zoom)
    .toBeGreaterThan(1)
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(handleX, 0)

  const bounds = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(
      '[data-raw-preview-frame]',
    )!
    const surface = document.querySelector<HTMLElement>(
      '[data-raw-preview-surface]',
    )!
    const rect = surface.getBoundingClientRect()
    return {
      frameOverflow: getComputedStyle(frame).overflow,
      width: rect.width,
      height: rect.height,
      layoutWidth: surface.offsetWidth,
      layoutHeight: surface.offsetHeight,
    }
  })
  expect(bounds.frameOverflow).toBe('hidden')
  expect(bounds.width).toBeGreaterThan(bounds.layoutWidth)
  expect(bounds.height).toBeGreaterThan(bounds.layoutHeight)

  const panBefore = await readPreviewViewport(page)
  await page.mouse.down()
  await page.mouse.move(
    frame.x + frame.width * panTo.x,
    frame.y + frame.height * panTo.y,
    { steps: 12 },
  )
  await page.mouse.up()
  await expect
    .poll(async () => {
      const next = await readPreviewViewport(page)
      return (
        Math.abs(next.panX - panBefore.panX) +
        Math.abs(next.panY - panBefore.panY)
      )
    })
    .toBeGreaterThan(0)
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(handleX, 0)

  const transforms = await page.evaluate(() => {
    const transform = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      return element ? getComputedStyle(element).transform : null
    }
    return {
      surface: transform('[data-raw-preview-surface]'),
      processed: transform('.raw-preview-canvas'),
      original: transform(
        '.raw-preview-original-image, .raw-preview-original-gpu-canvas',
      ),
    }
  })
  expect(transforms.surface).toBeTruthy()
  expect(transforms.surface).not.toBe('none')
  expect(transforms.processed).toBe(transforms.original)

  const stats = await readGpuStats(page)
  expect(stats.drawCalls).toBeLessThanOrEqual(2)
  expect(stats.finishCalls).toBe(0)
}

test('keeps dual-layer RAW compare usable through split zoom and pan', async ({
  page,
}, testInfo) => {
  test.skip(!isChromium(testInfo), 'The dual-GPU compare runs on Chromium')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(180_000)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(installGpuCounters)
  await page.addInitScript(installCompareModeRecorder)
  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })

  await waitForCompareMode(page, 'dual-gpu')
  await expect(page.locator('.raw-preview-original-gpu-canvas')).toHaveCount(1)
  await expectWebGPUPreview(page, testInfo)
  expect((await readGpuStats(page)).drawCalls).toBeGreaterThan(0)

  // The bounded HQ upgrade re-renders both layers; on WebGPU that work
  // completes asynchronously, so settle it before counting split-only draws.
  await expect(previewFrame(page)).toHaveAttribute(
    'data-display-source',
    'bounded-hq',
    { timeout: 120_000 },
  )
  await waitForGpuStatsIdle(page)
  // Once dual-GPU, the stage never fell back to the processed photo alone.
  const modes = await page.evaluate(
    () => (window as unknown as { __compareModes: string[] }).__compareModes,
  )
  expect(modes).toContain('dual-gpu')
  expect(modes.slice(modes.indexOf('dual-gpu') + 1)).not.toContain(
    'processed-only',
  )

  await dragSplit(page, 0.82)
  await expectZoomAndPan(page, { x: 0.35, y: 0.4 }, { x: 0.56, y: 0.62 })
  await expect(page.locator('[data-compare-mode]').first()).toHaveAttribute(
    'data-compare-mode',
    'dual-gpu',
  )

  // A double-click returns the view to fit.
  const frame = (await previewFrame(page).boundingBox())!
  await page.mouse.dblclick(
    frame.x + frame.width * 0.2,
    frame.y + frame.height * 0.5,
  )
  await expect
    .poll(async () => (await readPreviewViewport(page)).zoom)
    .toBeCloseTo(1)
  const fitted = await readPreviewViewport(page)
  expect(fitted.panX).toBeCloseTo(0, 0)
  expect(fitted.panY).toBeCloseTo(0, 0)
  await expectWebGPUPreview(page, testInfo)
})

test('keeps mobile-class JPEG fallback responsive through same-origin RAW drop and HQ upgrade', async ({
  browser,
}, testInfo) => {
  test.skip(
    !isChromium(testInfo),
    'The mobile-class fallback runs in a Chromium context with a WebKit-class UA',
  )
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(240_000)

  const context = await browser.newContext({
    ...devices['iPhone 14 Pro'],
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  })
  // A mobile UA alone retains the host Chromium memory/limits. Make the
  // low-memory device explicit so this exercises the JPEG fallback policy.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', {
      configurable: true,
      get: () => 4,
    })
  })
  await context.addInitScript(installGpuCounters)
  const page = await context.newPage()
  const fixtureName = basename(rawPath)
  const fixtureUrl = `/__lumaforge-test-fixtures/${fixtureName}`

  try {
    await page.route(fixtureUrl, (route) =>
      route.fulfill({ path: rawPath, contentType: 'application/octet-stream' }),
    )
    await page.goto('/raw')
    await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

    // The RAW arrives the way a drop from another page would: fetched, then
    // dropped onto the RAW input's target.
    const dropped = await page.evaluate(
      async ({ fixtureUrl, fixtureName }) => {
        const blob = await (await fetch(fixtureUrl)).blob()
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([blob], fixtureName, { type: 'application/octet-stream' }),
        )
        const input = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
        ).find((candidate) => /\.dng/i.test(candidate.accept))
        const target = input?.closest('label') ?? input?.parentElement
        if (!target) return false
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          )
        }
        return true
      },
      { fixtureUrl, fixtureName },
    )
    expect(dropped, 'the RAW drop target').toBe(true)
    await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })

    // Compare is a lens over the stage on mobile: a tap opens the split.
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('data-state', 'on')
    await waitForCompareMode(page, 'jpeg-fallback')
    await expectWebGPUPreview(page, testInfo)
    expect((await readGpuStats(page)).drawCalls).toBeGreaterThan(0)

    const originalLayer = page.locator('.raw-preview-original-layer').first()
    await expect(originalLayer).toBeVisible()
    await expect(originalLayer).toHaveAttribute(
      'data-original-reference-source',
      /quick|bounded-hq/,
    )
    await waitForGpuStatsIdle(page)

    await dragSplit(page, 0.72)
    await expectZoomAndPan(page, { x: 0.45, y: 0.4 }, { x: 0.62, y: 0.6 })

    // The JPEG reference upgrades to the bounded HQ frame without moving the
    // split or the viewport the user set.
    const split = await splitSlider(page).getAttribute('aria-valuenow')
    const viewport = await readPreviewViewport(page)
    await expect(originalLayer).toHaveAttribute(
      'data-original-reference-source',
      'bounded-hq',
      { timeout: 120_000 },
    )
    await expect(splitSlider(page)).toHaveAttribute('aria-valuenow', split!)
    const after = await readPreviewViewport(page)
    expect(after.zoom).toBeCloseTo(viewport.zoom, 2)
    expect(after.panX).toBeCloseTo(viewport.panX, 0)
    expect(after.panY).toBeCloseTo(viewport.panY, 0)
    await expectWebGPUPreview(page, testInfo)
  } finally {
    await context.close()
  }
})

test('compare: the split line and its labels hug the photograph', async ({
  page,
}, testInfo) => {
  test.skip(!isChromium(testInfo), 'Compare geometry is asserted on Chromium')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(300_000)

  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  await expectWebGPUPreview(page, testInfo)

  const handle = page.locator('.raw-lab-compare-handle')
  await expect(handle).toBeVisible()
  // The preview upgrades from the quick decode to the bounded HQ frame after
  // load, which re-fits the photo and moves the handle with it. Wait for the
  // box to stop moving before measuring, or the press lands on bare stage.
  await expect
    .poll(
      async () => {
        const first = await handle.boundingBox()
        await page.waitForTimeout(250)
        const second = await handle.boundingBox()
        return first && second && Math.abs(first.x - second.x) < 1
          ? 'stable'
          : 'moving'
      },
      { timeout: 30_000 },
    )
    .toBe('stable')

  const geometry = await page.evaluate(() => {
    const el = document.querySelector('.raw-lab-compare-handle') as HTMLElement
    const line = getComputedStyle(el, '::before')
    const photo = document
      .querySelector('[data-raw-compare-track="image"]')!
      .getBoundingClientRect()
    const frame = document
      .querySelector('[data-raw-preview-frame]')!
      .getBoundingClientRect()
    const label = document
      .querySelector('.raw-lab-compare-label')!
      .getBoundingClientRect()
    return {
      lineHeight: Number.parseFloat(line.height),
      lineTop: Number.parseFloat(line.top),
      photoHeight: photo.height,
      photoTopInFrame: photo.top - frame.top,
      photoBottom: photo.bottom,
      labelBottom: label.bottom,
      frameHeight: frame.height,
    }
  })

  // The line spans the photo, not the frame.
  expect(Math.abs(geometry.lineHeight - geometry.photoHeight)).toBeLessThan(2)
  expect(Math.abs(geometry.lineTop - geometry.photoTopInFrame)).toBeLessThan(2)
  // The frame is at least as tall as the photo; when the aspect ratios match
  // exactly there is no mat, and the line simply spans both.
  expect(geometry.photoHeight).toBeLessThanOrEqual(geometry.frameHeight + 1)
  // The labels sit on the photograph rather than in the mat below it.
  expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.photoBottom + 1)

  // Dragging lifts the knob and flags the drag.
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, {
    steps: 8,
  })
  const dragging = await page.evaluate(() => {
    const knob = document.querySelector('.raw-lab-compare-handle span')!
    return {
      flagged: Boolean(document.querySelector('[data-raw-compare-dragging]')),
      transform: getComputedStyle(knob).transform,
    }
  })
  await page.mouse.up()
  expect(dragging.flagged).toBe(true)
  // The knob springs to 1.06 over 180ms; assert it left rest rather than
  // pinning the exact frame the probe caught.
  const scale = Number.parseFloat(
    dragging.transform.replace('matrix(', '').split(',')[0] ?? '1',
  )
  expect(scale).toBeGreaterThan(1.03)
})
