import { existsSync } from 'node:fs'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { devices, expect, test } from '@playwright/test'

import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  rawPreviewUrl,
  requireWebGPUFixture,
} from './raw-preview-backend'

const RAW_COMPARE_FIXTURE =
  process.env.LUMAFORGE_RAW_COMPARE_FIXTURE ??
  '/workspaces/LumaForge/test-images/SGL_1998.NEF'
const RAW_COMPARE_URL = process.env.LUMAFORGE_RAW_COMPARE_URL ?? '/raw'

type LayeredCompareMode = 'dual-webgl' | 'jpeg-fallback'

type PreviewViewport = {
  zoom: number
  panX: number
  panY: number
}

type WebglStats = {
  // Legacy diagnostic names count either backend: draw, completion wait, submit.
  drawCalls: number
  finishCalls: number
  flushCalls: number
  resetAt: number
}

type CompareModeSample = {
  mode: string
  at: number
}

async function installWebglCounters(page: Page) {
  await page.addInitScript(() => {
    type CounterWindow = Window & {
      __LUMAFORGE_COMPARE_WEBGL_STATS__?: WebglStats
      __LUMAFORGE_COMPARE_WEBGL_RESET__?: () => void
    }
    type PatchedFunction = ((...args: unknown[]) => unknown) & {
      __lumaforgeComparePatched?: true
    }

    const stats: WebglStats = {
      drawCalls: 0,
      finishCalls: 0,
      flushCalls: 0,
      resetAt: performance.now(),
    }
    const counterWindow = window as CounterWindow

    counterWindow.__LUMAFORGE_COMPARE_WEBGL_STATS__ = stats
    counterWindow.__LUMAFORGE_COMPARE_WEBGL_RESET__ = () => {
      stats.drawCalls = 0
      stats.finishCalls = 0
      stats.flushCalls = 0
      stats.resetAt = performance.now()
    }

    function patchMethod(
      prototype: object | undefined,
      method: string,
      counter: keyof Pick<
        WebglStats,
        'drawCalls' | 'finishCalls' | 'flushCalls'
      >,
    ) {
      if (!prototype) return

      const target = prototype as Record<string, unknown>
      const original = target[method]
      if (typeof original !== 'function') return
      if ((original as PatchedFunction).__lumaforgeComparePatched) return

      const wrapped: PatchedFunction = function (
        this: unknown,
        ...args: unknown[]
      ) {
        stats[counter] += 1
        return Reflect.apply(original, this, args)
      }
      wrapped.__lumaforgeComparePatched = true
      target[method] = wrapped
    }

    const webglPrototypes = [
      typeof WebGLRenderingContext === 'undefined'
        ? undefined
        : WebGLRenderingContext.prototype,
      typeof WebGL2RenderingContext === 'undefined'
        ? undefined
        : WebGL2RenderingContext.prototype,
    ]

    for (const prototype of webglPrototypes) {
      patchMethod(prototype, 'drawArrays', 'drawCalls')
      patchMethod(prototype, 'drawElements', 'drawCalls')
      patchMethod(prototype, 'finish', 'finishCalls')
      patchMethod(prototype, 'flush', 'flushCalls')
    }
    const queue =
      typeof GPUQueue === 'undefined' ? undefined : GPUQueue.prototype
    const pass =
      typeof GPURenderPassEncoder === 'undefined'
        ? undefined
        : GPURenderPassEncoder.prototype
    patchMethod(pass, 'draw', 'drawCalls')
    patchMethod(pass, 'drawIndexed', 'drawCalls')
    patchMethod(queue, 'onSubmittedWorkDone', 'finishCalls')
    patchMethod(queue, 'submit', 'flushCalls')
  })
}

async function installCompareModeRecorder(page: Page) {
  await page.addInitScript(() => {
    type RecorderWindow = Window & {
      __LUMAFORGE_COMPARE_MODE_SAMPLES__?: Array<{
        mode: string
        at: number
      }>
    }

    const recorderWindow = window as RecorderWindow
    const samples: NonNullable<
      RecorderWindow['__LUMAFORGE_COMPARE_MODE_SAMPLES__']
    > = []
    let lastMode = ''

    recorderWindow.__LUMAFORGE_COMPARE_MODE_SAMPLES__ = samples

    const record = () => {
      const mode =
        document
          .querySelector('[data-compare-mode]')
          ?.getAttribute('data-compare-mode') ?? 'missing'
      if (mode === lastMode) return
      lastMode = mode
      samples.push({ mode, at: performance.now() })
    }

    const start = () => {
      const root = document.documentElement
      if (!root) {
        requestAnimationFrame(start)
        return
      }

      const observer = new MutationObserver(record)
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-compare-mode'],
      })
      record()
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true })
    } else {
      start()
    }
  })
}

async function readCompareModeSamples(
  page: Page,
): Promise<CompareModeSample[]> {
  return page.evaluate(() => {
    type RecorderWindow = Window & {
      __LUMAFORGE_COMPARE_MODE_SAMPLES__?: CompareModeSample[]
    }

    return (window as RecorderWindow).__LUMAFORGE_COMPARE_MODE_SAMPLES__ ?? []
  })
}

function expectNoProcessedOnlyAfterDualWebgl(samples: CompareModeSample[]) {
  const firstDualIndex = samples.findIndex((sample) => {
    return sample.mode === 'dual-webgl'
  })

  expect(firstDualIndex).toBeGreaterThanOrEqual(0)
  expect(
    samples.slice(firstDualIndex + 1).map((sample) => sample.mode),
  ).not.toContain('processed-only')
}

async function loadRawFixture(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
}

async function loadRawFixtureViaSameOriginDrop(
  page: Page,
  fixtureUrl: string,
  fileName: string,
) {
  return page.evaluate(
    async ({ fixtureUrl, fileName }) => {
      try {
        const response = await fetch(fixtureUrl)
        if (!response.ok) {
          return {
            ok: false,
            reason: `Fixture fetch returned ${response.status}`,
          } as const
        }

        const blob = await response.blob()
        const file = new File([blob], fileName, {
          type: 'application/octet-stream',
        })
        const transfer = new DataTransfer()
        transfer.items.add(file)

        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
        )
        const input =
          inputs.find((candidate) => {
            const accept = candidate.accept.toLowerCase()
            return (
              accept.includes('.nef') ||
              accept.includes('.arw') ||
              accept.includes('.dng') ||
              accept.includes('.raf')
            )
          }) ?? inputs[0]
        const target =
          input?.closest('label') ??
          input?.closest('[data-raw-lut]') ??
          input?.parentElement ??
          document.querySelector('[data-raw-lab-shell="viewport"]')

        if (!target) {
          return { ok: false, reason: 'RAW drop target not found' } as const
        }

        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          )
        }

        return { ok: true } as const
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        } as const
      }
    },
    { fixtureUrl, fileName },
  )
}

async function routeSameOriginFixture(page: Page, fixtureUrl: string) {
  await page.route(fixtureUrl, async (route) => {
    await route.fulfill({
      path: RAW_COMPARE_FIXTURE,
      contentType: 'application/octet-stream',
    })
  })
}

function fixtureFileName() {
  return RAW_COMPARE_FIXTURE.split('/').pop() ?? 'fixture.raw'
}

async function dragSlider(page: Page, sliderName: string, targetRatio: number) {
  const slider = page.getByRole('slider', { name: sliderName })
  await expect(slider).toBeVisible()
  const box = await slider.boundingBox()
  const trackBox = await page
    .locator('[data-raw-compare-track="image"]')
    .boundingBox()
    .catch(() => null)
  const frameBox = await page
    .locator('[data-raw-preview-frame]')
    .boundingBox()
    .catch(() => null)

  expect(box).toBeTruthy()

  const before = Number(await slider.getAttribute('aria-valuenow'))
  const dragBox = trackBox ?? frameBox ?? box!
  const startX = box!.x + box!.width / 2
  const targetX = dragBox.x + dragBox.width * targetRatio
  const targetY = box!.y + box!.height / 2

  await page.mouse.move(startX, targetY)
  await page.mouse.down()
  await page.mouse.move(targetX, targetY, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .not.toBe(before)

  return {
    before,
    after: Number(await slider.getAttribute('aria-valuenow')),
  }
}

async function readCompareSplit(page: Page) {
  const slider = page.getByRole('slider', {
    name: 'Compare unprocessed RAW and final JPEG',
  })
  return Number(await slider.getAttribute('aria-valuenow'))
}

async function readCompareHandleCenterX(page: Page) {
  const slider = page.getByRole('slider', {
    name: 'Compare unprocessed RAW and final JPEG',
  })
  const box = await slider.boundingBox()

  expect(box).toBeTruthy()

  return box!.x + box!.width / 2
}

async function readPreviewViewport(page: Page): Promise<PreviewViewport> {
  return page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(
      '[data-raw-compare-track="image"]',
    )

    if (!track) {
      return { zoom: 1, panX: 0, panY: 0 }
    }

    const style = getComputedStyle(track)

    return {
      zoom: Number.parseFloat(style.getPropertyValue('--raw-preview-zoom')),
      panX: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-x')),
      panY: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-y')),
    }
  })
}

async function readLayerTransforms(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-raw-preview-surface]',
    )
    const processed = document.querySelector<HTMLElement>('.raw-preview-canvas')
    const original = document.querySelector<HTMLElement>(
      '.raw-preview-original-image, .raw-preview-original-webgl-canvas',
    )

    return {
      surface: surface ? getComputedStyle(surface).transform : null,
      original: original ? getComputedStyle(original).transform : null,
      processed: processed ? getComputedStyle(processed).transform : null,
    }
  })
}

function expectViewportClose(
  actual: PreviewViewport,
  expected: PreviewViewport,
) {
  expect(actual.zoom).toBeCloseTo(expected.zoom, 2)
  expect(actual.panX).toBeCloseTo(expected.panX, 0)
  expect(actual.panY).toBeCloseTo(expected.panY, 0)
}

async function readCompareMode(page: Page) {
  return page
    .locator('[data-compare-mode]')
    .first()
    .getAttribute('data-compare-mode')
    .catch(() => null)
}

async function waitForCompareMode(page: Page, expected: LayeredCompareMode) {
  await expect
    .poll(
      async () => {
        return (await readCompareMode(page)) ?? 'missing'
      },
      { timeout: 120_000 },
    )
    .toBe(expected)
}

async function resetWebglStats(page: Page) {
  await page.evaluate(() => {
    ;(
      window as Window & {
        __LUMAFORGE_COMPARE_WEBGL_RESET__?: () => void
      }
    ).__LUMAFORGE_COMPARE_WEBGL_RESET__?.()
  })
}

async function waitForWebglStatsIdle(page: Page) {
  await resetWebglStats(page)

  await expect
    .poll(
      async () => {
        await page.waitForTimeout(3_000)
        const stats = await readWebglStats(page)
        const idle =
          stats.drawCalls === 0 &&
          stats.finishCalls === 0 &&
          stats.flushCalls === 0

        if (!idle) {
          await resetWebglStats(page)
        }

        return idle
      },
      { timeout: 45_000 },
    )
    .toBe(true)
}

async function readWebglStats(page: Page): Promise<WebglStats> {
  return page.evaluate(() => {
    return (
      (
        window as Window & {
          __LUMAFORGE_COMPARE_WEBGL_STATS__?: WebglStats
        }
      ).__LUMAFORGE_COMPARE_WEBGL_STATS__ ?? {
        drawCalls: 0,
        finishCalls: 0,
        flushCalls: 0,
        resetAt: 0,
      }
    )
  })
}

async function waitForAnimationFrames(page: Page, count: number) {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
    }
  }, count)
}

async function expectNoSplitOnlyWebglRender(page: Page): Promise<WebglStats> {
  await waitForAnimationFrames(page, 3)
  const stats = await readWebglStats(page)
  expect(stats.drawCalls).toBe(0)
  expect(stats.finishCalls).toBe(0)

  return stats
}

test('keeps dual-layer RAW compare usable through split zoom and pan', async ({
  page,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'dual GPU compare path is a desktop Chromium regression target',
  )
  requireWebGPUFixture(testInfo, RAW_COMPARE_FIXTURE)
  test.skip(
    !existsSync(RAW_COMPARE_FIXTURE),
    `Missing RAW compare fixture: ${RAW_COMPARE_FIXTURE}`,
  )
  testInfo.setTimeout(180_000)

  await page.setViewportSize({ width: 1440, height: 900 })
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 })
  await installWebglCounters(page)
  await installCompareModeRecorder(page)
  await page.goto(rawPreviewUrl(testInfo, RAW_COMPARE_URL))
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page, RAW_COMPARE_FIXTURE)

  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible()

  await waitForCompareMode(page, 'dual-webgl')
  const mode: LayeredCompareMode = 'dual-webgl'
  const compareLayer = page.locator('[data-compare-mode="dual-webgl"]').first()
  await expect(compareLayer).toBeVisible()
  await expect(page.locator('.raw-preview-original-webgl-canvas')).toHaveCount(
    1,
  )
  await expectWebGPUPreview(page, testInfo)
  expect((await readWebglStats(page)).drawCalls).toBeGreaterThan(0)

  await waitForWebglStatsIdle(page)
  const stagedModeSamples = await readCompareModeSamples(page)
  expectNoProcessedOnlyAfterDualWebgl(stagedModeSamples)

  const split = await dragSlider(
    page,
    'Compare unprocessed RAW and final JPEG',
    0.82,
  )
  expect(split.after).toBeGreaterThan(split.before)
  const compareHandleCenterBeforeZoom = await readCompareHandleCenterX(page)
  await expect(compareLayer).toHaveAttribute('data-compare-mode', mode)
  const splitOnlyWebglStats = await expectNoSplitOnlyWebglRender(page)
  await resetWebglStats(page)

  const previewFrame = page.locator('[data-raw-preview-frame]')
  const previewBox = await previewFrame.boundingBox()

  expect(previewBox).toBeTruthy()

  await page.mouse.move(
    previewBox!.x + previewBox!.width * 0.35,
    previewBox!.y + previewBox!.height * 0.4,
  )
  await page.mouse.wheel(0, -1200)

  await expect
    .poll(async () => (await readPreviewViewport(page)).zoom)
    .toBeGreaterThan(1)
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(
    compareHandleCenterBeforeZoom,
    0,
  )

  const panBefore = await readPreviewViewport(page)

  await page.mouse.down()
  await page.mouse.move(
    previewBox!.x + previewBox!.width * 0.56,
    previewBox!.y + previewBox!.height * 0.62,
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
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(
    compareHandleCenterBeforeZoom,
    0,
  )
  await expect(compareLayer).toHaveAttribute('data-compare-mode', mode)
  const transforms = await readLayerTransforms(page)
  expect(transforms.surface).toBeTruthy()
  expect(transforms.surface).not.toBe('none')
  expect(transforms.processed).toBe(transforms.original)

  const viewportWebglStats = await readWebglStats(page)
  expect(viewportWebglStats.drawCalls).toBeLessThanOrEqual(2)
  expect(viewportWebglStats.finishCalls).toBe(0)

  await page.mouse.dblclick(
    previewBox!.x + previewBox!.width * 0.2,
    previewBox!.y + previewBox!.height * 0.5,
  )
  await expect
    .poll(async () => (await readPreviewViewport(page)).zoom)
    .toBeCloseTo(1)
  expectViewportClose(await readPreviewViewport(page), {
    zoom: 1,
    panX: 0,
    panY: 0,
  })
  await expectWebGPUPreview(page, testInfo)

  await testInfo.attach('raw-dual-layer-compare.json', {
    body: JSON.stringify(
      {
        fixture: RAW_COMPARE_FIXTURE,
        rendererBackend: await page
          .locator('.raw-preview-canvas')
          .getAttribute('data-render-backend'),
        mode,
        viewport: page.viewportSize(),
        split,
        splitOnlyWebglStats,
        viewportWebglStats,
        stagedModeSamples,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('keeps mobile-class JPEG fallback responsive through same-origin RAW drop and HQ upgrade', async ({
  browser,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'mobile-class fallback is exercised in a Chromium context with WebKit-class UA',
  )
  requireWebGPUFixture(testInfo, RAW_COMPARE_FIXTURE)
  test.skip(
    !existsSync(RAW_COMPARE_FIXTURE),
    `Missing RAW compare fixture: ${RAW_COMPARE_FIXTURE}`,
  )
  testInfo.setTimeout(240_000)

  const baseURL = rawPreviewUrl(testInfo, RAW_COMPARE_URL)
  const context = await browser.newContext({
    ...devices['iPhone 14 Pro'],
    baseURL,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  const fixtureName = fixtureFileName()
  const sameOriginFixtureUrl = `/__lumaforge-test-fixtures/${fixtureName}`

  try {
    await routeSameOriginFixture(page, sameOriginFixtureUrl)
    await installWebglCounters(page)
    await page.goto(baseURL)
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
    await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

    const dropResult = await loadRawFixtureViaSameOriginDrop(
      page,
      sameOriginFixtureUrl,
      fixtureName,
    )
    if (testInfo.project.name === 'chromium-webgpu') {
      expect(dropResult.ok, dropResult.reason).toBe(true)
    }
    test.skip(!dropResult.ok, dropResult.reason)

    await expect(
      page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
    ).toBeVisible({ timeout: 90_000 })
    await page.getByRole('tab', { name: /^compare$/i }).click()
    await page.getByRole('button', { name: /^split compare$/i }).click()
    await waitForCompareMode(page, 'jpeg-fallback')
    await expectWebGPUPreview(page, testInfo)
    expect((await readWebglStats(page)).drawCalls).toBeGreaterThan(0)

    const originalLayer = page.locator('.raw-preview-original-layer').first()
    await expect(originalLayer).toBeVisible()
    await expect(originalLayer).toHaveAttribute(
      'data-original-reference-source',
      /quick|bounded-hq/,
    )
    const initialSource = await originalLayer.getAttribute(
      'data-original-reference-source',
    )

    await waitForWebglStatsIdle(page)

    const split = await dragSlider(
      page,
      'Compare unprocessed RAW and final JPEG',
      0.72,
    )
    expect(split.after).toBeGreaterThan(split.before)
    const compareHandleCenterBeforeZoom = await readCompareHandleCenterX(page)
    const splitOnlyWebglStats = await expectNoSplitOnlyWebglRender(page)
    await resetWebglStats(page)

    const previewFrame = page.locator('[data-raw-preview-frame]')
    const previewBox = await previewFrame.boundingBox()
    expect(previewBox).toBeTruthy()

    await page.mouse.move(
      previewBox!.x + previewBox!.width * 0.45,
      previewBox!.y + previewBox!.height * 0.4,
    )
    await page.mouse.wheel(0, -1000)
    await expect
      .poll(async () => (await readPreviewViewport(page)).zoom)
      .toBeGreaterThan(1)
    expect(await readCompareHandleCenterX(page)).toBeCloseTo(
      compareHandleCenterBeforeZoom,
      0,
    )

    const scaledBounds = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>(
        '[data-raw-preview-frame]',
      )
      const track = document.querySelector<HTMLElement>(
        '[data-raw-compare-track="image"]',
      )
      const surface = document.querySelector<HTMLElement>(
        '[data-raw-preview-surface]',
      )
      const frameRect = frame?.getBoundingClientRect()
      const surfaceRect = surface?.getBoundingClientRect()

      return {
        frame: frameRect?.toJSON(),
        surface: surfaceRect?.toJSON(),
        surfaceLayoutWidth: surface?.offsetWidth ?? track?.offsetWidth ?? 0,
        surfaceLayoutHeight: surface?.offsetHeight ?? track?.offsetHeight ?? 0,
        frameOverflow: frame ? getComputedStyle(frame).overflow : '',
      }
    })
    expect(scaledBounds.frame).toBeTruthy()
    expect(scaledBounds.surface).toBeTruthy()
    expect(scaledBounds.frameOverflow).toBe('hidden')
    expect(scaledBounds.surface!.width).toBeGreaterThan(
      scaledBounds.surfaceLayoutWidth,
    )
    expect(scaledBounds.surface!.height).toBeGreaterThan(
      scaledBounds.surfaceLayoutHeight,
    )

    const panBefore = await readPreviewViewport(page)
    await page.mouse.down()
    await page.mouse.move(
      previewBox!.x + previewBox!.width * 0.62,
      previewBox!.y + previewBox!.height * 0.6,
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
    expect(await readCompareHandleCenterX(page)).toBeCloseTo(
      compareHandleCenterBeforeZoom,
      0,
    )

    const transforms = await readLayerTransforms(page)
    expect(transforms.surface).toBeTruthy()
    expect(transforms.surface).not.toBe('none')
    expect(transforms.processed).toBe(transforms.original)

    const splitAfterInteraction = await readCompareSplit(page)
    const viewportAfterInteraction = await readPreviewViewport(page)
    if (initialSource === 'quick') {
      await expect(originalLayer).toHaveAttribute(
        'data-original-reference-source',
        'bounded-hq',
        { timeout: 120_000 },
      )
    }
    const finalSource = await originalLayer.getAttribute(
      'data-original-reference-source',
    )
    expect(finalSource).toBe('bounded-hq')
    expect(await readCompareSplit(page)).toBe(splitAfterInteraction)
    expectViewportClose(
      await readPreviewViewport(page),
      viewportAfterInteraction,
    )

    const viewportWebglStats = await readWebglStats(page)
    expect(viewportWebglStats.drawCalls).toBeLessThanOrEqual(2)
    expect(viewportWebglStats.finishCalls).toBe(0)
    await expectWebGPUPreview(page, testInfo)

    await testInfo.attach('raw-mobile-jpeg-fallback-compare.json', {
      body: JSON.stringify(
        {
          fixture: RAW_COMPARE_FIXTURE,
          rendererBackend: await page
            .locator('.raw-preview-canvas')
            .getAttribute('data-render-backend'),
          mode: await readCompareMode(page),
          viewport: page.viewportSize(),
          initialSource,
          finalSource,
          splitAfterInteraction,
          viewportAfterInteraction,
          splitOnlyWebglStats,
          viewportWebglStats,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  } finally {
    await context.close()
  }
})

test('validates WebKit-class JPEG fallback compare when local WebKit is available', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'WebKit proxy validation runs only on the WebKit mobile project',
  )
  test.skip(
    !existsSync(RAW_COMPARE_FIXTURE),
    `Missing RAW compare fixture: ${RAW_COMPARE_FIXTURE}`,
  )
  testInfo.setTimeout(240_000)

  await page.setViewportSize({ width: 390, height: 844 })
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })

  const fixtureName = fixtureFileName()
  const sameOriginFixtureUrl = `/__lumaforge-test-fixtures/${fixtureName}`
  await routeSameOriginFixture(page, sameOriginFixtureUrl)
  await installWebglCounters(page)

  await page.goto(RAW_COMPARE_URL)
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  const dropResult = await loadRawFixtureViaSameOriginDrop(
    page,
    sameOriginFixtureUrl,
    fixtureName,
  )
  test.skip(
    !dropResult.ok,
    `BLOCKED: local Playwright WebKit RAW drop unavailable: ${dropResult.reason}`,
  )

  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
  await page.getByRole('tab', { name: /^compare$/i }).click()
  await page.getByRole('button', { name: /^split compare$/i }).click()
  await waitForCompareMode(page, 'jpeg-fallback')

  const originalLayer = page.locator('.raw-preview-original-layer').first()
  await expect(originalLayer).toBeVisible()
  await expect(originalLayer).toHaveAttribute(
    'data-original-reference-source',
    /quick|bounded-hq/,
  )

  await waitForWebglStatsIdle(page)

  const split = await dragSlider(
    page,
    'Compare unprocessed RAW and final JPEG',
    0.68,
  )
  expect(split.after).toBeGreaterThan(split.before)
  const splitOnlyWebglStats = await expectNoSplitOnlyWebglRender(page)

  const transforms = await readLayerTransforms(page)
  expect(transforms.surface).toBeTruthy()
  expect(transforms.processed).toBe(transforms.original)

  await testInfo.attach('raw-webkit-jpeg-fallback-compare.json', {
    body: JSON.stringify(
      {
        fixture: RAW_COMPARE_FIXTURE,
        mode: await readCompareMode(page),
        viewport: page.viewportSize(),
        source: await originalLayer.getAttribute(
          'data-original-reference-source',
        ),
        split,
        splitOnlyWebglStats,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})
