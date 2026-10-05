import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import {
  expectWebGPUPreview,
  NO_WEBGPU_SKIP_REASON,
  projectHasWebGPU,
  rawPreviewUrl,
} from './raw-preview-backend'

const rawPath = fileURLToPath(
  new URL(
    '../../packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
    import.meta.url,
  ),
)
const rawName = 'raw-pixls-iphone-se.dng'
const replacementName = 'replacement-iphone-se.dng'
const hqExportReason =
  'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.'

function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 1280) <= 640
}

function transformTool(page: Page) {
  return page.locator('[data-raw-transform-tool]')
}

function transformCanvas(page: Page) {
  return page.locator('[data-raw-transform-preview] canvas')
}

async function openTool(page: Page, name: 'Transform' | 'Adjust' | 'Export') {
  if (isMobile(page)) {
    const tab = page.getByRole('tab', { name, exact: true })
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click()
    }
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

async function waitForRaw(page: Page, name: string) {
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({
    timeout: 120_000,
  })
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible()
  // Ingest emits this success only after bounded HQ, including CPU mode.
  await expect(page.getByText(`Loaded ${name}`, { exact: true })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
}

async function loadRaw(page: Page) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: /browse raw files/i }).click()
  } else {
    await page
      .getByRole('button', { name: /finish a raw with a lut/i })
      .click({ position: { x: 24, y: 24 } })
  }
  await (await choosing).setFiles(rawPath)
  await waitForRaw(page, rawName)
}

async function waitForTransform(page: Page) {
  const tool = transformTool(page)
  await expect(tool).toBeVisible()
  await expect(
    tool.locator('[data-testid="mode-auto"], [role="slider"]').first(),
  ).toBeEnabled({ timeout: 30_000 })
  const overlay = page.locator('[data-raw-transform-preview]')
  if (await overlay.count()) {
    await expect(overlay).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    })
  }
  await expect(tool.getByRole('alert')).toHaveCount(0)
}

async function selectTransformSection(
  page: Page,
  name: 'Upright' | 'Perspective' | 'Frame',
) {
  if (!isMobile(page)) return
  await transformTool(page).getByRole('tab', { name, exact: true }).click()
  await expect(
    transformTool(page).locator(
      `[data-transform-list-section="${name.toLowerCase()}"]`,
    ),
  ).toBeVisible()
}

async function showGrid(page: Page) {
  await selectTransformSection(page, 'Upright')
  const grid = transformTool(page).getByRole('button', {
    name: 'Grid',
    exact: true,
  })
  await expect(grid).toBeEnabled({ timeout: 30_000 })
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click()
  await waitForTransform(page)
}

async function expectCpuNoticeBelowHeader(page: Page) {
  if (!isMobile(page)) return
  const header = page.getByRole('banner')
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  await expect(header).toBeVisible()
  await expect(dismiss).toBeVisible()
  await expect
    .poll(async () => {
      const topbar = (await header.boundingBox())!
      const notice = (await dismiss.boundingBox())!
      return notice.y - topbar.y - topbar.height
    })
    .toBeGreaterThanOrEqual(0)
  // On the photo it keeps clear of the compare lens: beside it or below it.
  const lens = page.locator('[data-mobile-compare-lens]')
  if (await lens.count()) {
    await expect
      .poll(async () => {
        const notice = (await page
          .locator('[data-cpu-preview-banner]')
          .boundingBox())!
        const circle = (await lens.boundingBox())!
        const beside = notice.x + notice.width <= circle.x + 1
        const below = notice.y >= circle.y + circle.height - 1
        return beside || below
      })
      .toBe(true)
  }
}

/**
 * Mobile CPU preview: no toggle row under the photo; the compare lens
 * toggles the original instead (aria-pressed while it shows).
 */
async function expectMobileCpuLensToggle(page: Page) {
  if (!isMobile(page)) return
  await expect(
    page
      .locator('.raw-lab-stage')
      .getByRole('button', { name: 'Original', exact: true }),
  ).toHaveCount(0)
  const lens = page.locator('[data-mobile-compare-lens]')
  await expect(lens).toHaveAttribute('data-lens-mode', 'original')
  await expect(lens).toHaveAccessibleName('Show original')
  await expect(lens).toHaveAttribute('aria-pressed', 'false')
  await lens.click()
  await expect(lens).toHaveAttribute('aria-pressed', 'true')
  await lens.click()
  await expect(lens).toHaveAttribute('aria-pressed', 'false')
}

async function snapshot(page: Page) {
  await expect(page.locator('[data-raw-transform-preview]')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  )
  await expect(transformCanvas(page)).toBeVisible()
  return transformCanvas(page).evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement
    const { width, height } = canvas
    const context = canvas.getContext('2d')!
    const pixels = context.getImageData(0, 0, width, height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    let light = 0
    let samples = 0
    const colors = new Set<number>()
    for (let offset = 0; offset < pixels.length; offset += 64) {
      light += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
      colors.add(
        (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2],
      )
      samples++
    }
    return {
      width,
      height,
      hash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      meanLight: light / samples,
      colors: colors.size,
    }
  })
}

/**
 * Full-resolution export reproduces the geometry, so it stays enabled whether
 * or not a Transform is committed. Only the bounded HQ preview refuses, and it
 * has to say why rather than going quietly dark.
 */
async function expectStandardExports(
  page: Page,
  geometryActive: boolean,
  hqAvailable = true,
) {
  await openTool(page, 'Export')
  await expect(
    page.getByRole('button', {
      name: 'Export full-resolution JPEG',
      exact: true,
    }),
  ).toBeEnabled({ timeout: 30_000 })

  const hqButton = page.getByRole('button', {
    name: 'Export HQ preview JPEG',
    exact: true,
  })
  if (geometryActive) {
    await expect(hqButton).toBeDisabled()
    // Both surfaces name the refusal next to the button it blocks; a disabled
    // control alone does not say why.
    await expect(page.getByText(hqExportReason, { exact: true })).toBeVisible()
  } else {
    await expect(page.getByText(hqExportReason, { exact: true })).toHaveCount(0)
    if (hqAvailable) {
      await expect(hqButton).toBeEnabled({ timeout: 30_000 })
    } else {
      await expect(hqButton).toBeDisabled()
    }
  }
}

async function replaceRaw(page: Page) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Replace RAW' }).click()
  } else {
    await page.locator('[data-raw-header-action="replace"]').click()
  }
  await (
    await choosing
  ).setFiles({
    name: replacementName,
    mimeType: 'image/x-adobe-dng',
    buffer: await readFile(rawPath),
  })
  await waitForRaw(page, replacementName)
}

async function resetSession(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Reset session' }).click()
  } else {
    await page.locator('[data-raw-header-action="reset"]').click()
  }
  await page
    .getByRole('alertdialog', { name: 'Reset session' })
    .getByRole('button', { name: 'Reset session', exact: true })
    .click()
  await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: replacementName, exact: true }),
  ).toHaveCount(0)
}

for (const preview of ['gpu', 'cpu'] as const) {
  test(`${preview}: RAW Transform preserves geometry across tabs and tone edits, guards exports, and clears with the RAW session`, async ({
    page,
  }, testInfo) => {
    test.skip(
      preview === 'gpu' && !projectHasWebGPU(testInfo),
      NO_WEBGPU_SKIP_REASON,
    )
    testInfo.setTimeout(360_000)
    expect(
      existsSync(rawPath),
      'Required public DNG is missing. Run pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public before browser validation.',
    ).toBe(true)
    await page.addInitScript(() => {
      localStorage.setItem('lumaforge.locale', 'en')
    })
    await page.goto(
      rawPreviewUrl(
        testInfo,
        preview === 'cpu' ? '/raw?forcePreview=cpu' : '/raw',
      ),
    )
    if (preview === 'cpu') await expectCpuNoticeBelowHeader(page)
    await loadRaw(page)
    if (preview === 'cpu') {
      await expectCpuNoticeBelowHeader(page)
      await expectMobileCpuLensToggle(page)
      await expect(page.getByText(/GPU preview unavailable/)).toBeVisible()
      await expect(page.getByTestId('cpu-preview-unavailable')).toHaveCount(0)
      await expect(page.locator('.raw-preview-canvas')).toHaveCount(0)
    } else {
      await expectWebGPUPreview(page, testInfo)
      await expect(page.getByText(/GPU preview unavailable/)).toHaveCount(0)
      await expect(page.locator('[data-preview-track-ready]')).toHaveAttribute(
        'data-preview-track-ready',
        'true',
      )
      expect(
        await page.locator('.raw-preview-canvas').evaluate((element) => {
          const canvas = element as HTMLCanvasElement
          const context = canvas.getContext('webgpu')
          return Boolean(
            canvas.dataset.renderBackend === 'webgpu' &&
            context?.getConfiguration() &&
            canvas.width > 1 &&
            canvas.height > 1,
          )
        }),
      ).toBe(true)
    }
    await openTool(page, 'Export')
    await expect(
      page.getByRole('button', {
        name: 'Export full-resolution JPEG',
        exact: true,
      }),
    ).toBeEnabled({ timeout: 30_000 })
    const hqAvailable =
      preview === 'gpu' ||
      (await page
        .getByRole('button', { name: 'Export HQ preview JPEG', exact: true })
        .isEnabled())
    await expectStandardExports(page, false, hqAvailable)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await expect(transformTool(page).locator('input[type="file"]')).toHaveCount(
      0,
    )
    await expect(
      transformTool(page).getByRole('button', { name: 'Load test image' }),
    ).toHaveCount(0)

    await expect(
      transformTool(page).getByRole('button', {
        name: /before transform|after transform|save preview/i,
      }),
    ).toHaveCount(0)
    await expect(transformTool(page)).not.toContainText(/preview JPEG|1600 px/i)
    await showGrid(page)
    const original = await snapshot(page)

    await transformTool(page)
      .getByRole('button', { name: 'Auto', exact: true })
      .click()
    await waitForTransform(page)
    await selectTransformSection(page, 'Perspective')
    const rotate = transformTool(page).getByRole('slider', {
      name: 'Rotate',
      exact: true,
    })
    await rotate.focus()
    await rotate.press('PageUp')
    await expect(rotate).toHaveAttribute('aria-valuenow', '1')
    await waitForTransform(page)
    const corrected = await snapshot(page)
    const geometry = await page
      .locator('[data-raw-transform-preview]')
      .getAttribute('data-transform-matrix')
    expect(geometry).toBeTruthy()
    expect(corrected.colors).toBeGreaterThan(1000)
    expect(Math.max(corrected.width, corrected.height)).toBeLessThanOrEqual(
      1600,
    )

    expect(corrected.hash).not.toBe(original.hash)
    expect(corrected.width * corrected.height).toBeLessThan(
      original.width * original.height,
    )
    expect(corrected.width * corrected.height).toBeGreaterThan(
      original.width * original.height * 0.25,
    )

    await expectStandardExports(page, true)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectTransformSection(page, 'Perspective')
    await expect(rotate).toHaveAttribute('aria-valuenow', '1')
    expect((await snapshot(page)).hash).toBe(corrected.hash)

    await openTool(page, 'Adjust')
    const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
    await exposure.focus()
    for (let increment = 0; increment < 5; increment++) {
      await exposure.press('PageUp')
    }
    await expect(exposure).not.toHaveAttribute('aria-valuenow', '0')
    await expect
      .poll(async () => (await snapshot(page)).hash, {
        timeout: 30_000,
      })
      .not.toBe(corrected.hash)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectTransformSection(page, 'Upright')
    await expect(
      transformTool(page).getByRole('button', { name: 'Auto', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await selectTransformSection(page, 'Perspective')
    await expect(rotate).toHaveAttribute('aria-valuenow', '1')
    const toned = await snapshot(page)
    expect(
      await page
        .locator('[data-raw-transform-preview]')
        .getAttribute('data-transform-matrix'),
    ).toBe(geometry)
    expect(toned.meanLight).toBeGreaterThan(corrected.meanLight)
    await expectStandardExports(page, true)
    await openTool(page, 'Transform')
    await waitForTransform(page)

    await selectTransformSection(page, 'Upright')
    await transformTool(page)
      .getByRole('button', {
        name: isMobile(page) ? 'Reset Upright' : 'Reset',
        exact: true,
      })
      .click()
    await selectTransformSection(page, 'Perspective')
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, false, hqAvailable)

    await openTool(page, 'Transform')
    await selectTransformSection(page, 'Perspective')
    await rotate.focus()
    await rotate.press('PageUp')
    await waitForTransform(page)
    await openTool(page, 'Adjust')
    await page.getByRole('button', { name: /reset exposure/i }).click()
    await expect(exposure).toHaveAttribute('aria-valuenow', '0')
    await replaceRaw(page)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectTransformSection(page, 'Perspective')
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await selectTransformSection(page, 'Upright')
    await expect(
      transformTool(page).getByRole('button', { name: 'Off', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, false, hqAvailable)

    await openTool(page, 'Transform')
    await selectTransformSection(page, 'Perspective')
    await rotate.focus()
    await rotate.press('PageUp')
    await waitForTransform(page)
    const replacement = await snapshot(page)
    expect(replacement.hash).not.toBe(toned.hash)
    await selectTransformSection(page, 'Upright')
    await transformTool(page)
      .getByRole('button', {
        name: isMobile(page) ? 'Reset Upright' : 'Reset',
        exact: true,
      })
      .click()
    await showGrid(page)
    expect(await snapshot(page)).toEqual(original)
    await resetSession(page)
    await loadRaw(page)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await selectTransformSection(page, 'Perspective')
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, false, hqAvailable)
  })
}

test('full-resolution export delivers the committed geometry, not a crop of the original', async ({
  page,
}, testInfo) => {
  test.skip(!projectHasWebGPU(testInfo), NO_WEBGPU_SKIP_REASON)
  testInfo.setTimeout(360_000)
  expect(
    existsSync(rawPath),
    'Required public DNG is missing. Run pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public before browser validation.',
  ).toBe(true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => localStorage.setItem('lumaforge.locale', 'en'))
  await page.goto(rawPreviewUrl(testInfo))
  await loadRaw(page)
  await expectWebGPUPreview(page, testInfo)

  // A WebGPU canvas's drawing buffer may be recycled after presentation.
  // Capture the visible, untransformed photo before the Transform overlay can
  // cover it, rather than treating an empty drawImage readback as a reference.
  const originalPng = await page.locator('.raw-preview-canvas').screenshot({
    animations: 'disabled',
    style:
      '.raw-lab-compare-handle, .raw-lab-compare-label { visibility: hidden !important; }',
  })

  await openTool(page, 'Transform')
  await waitForTransform(page)
  await transformTool(page)
    .getByRole('button', { name: 'Full', exact: true })
    .click()
  await waitForTransform(page)

  const preview = await page
    .locator('[data-raw-transform-preview] canvas')
    .evaluate((canvas) => ({
      width: (canvas as HTMLCanvasElement).width,
      height: (canvas as HTMLCanvasElement).height,
    }))

  // Fingerprint what the photographer approved, and the untransformed frame
  // it came from, so the delivered file can be told apart from a plain crop.
  const signatures = await page.evaluate(async (originalBase64) => {
    const sample = (source: CanvasImageSource) => {
      const off = document.createElement('canvas')
      off.width = 32
      off.height = 24
      const context = off.getContext('2d')!
      context.drawImage(source, 0, 0, 32, 24)
      const pixels = context.getImageData(0, 0, 32, 24).data
      const values: number[] = []
      for (let index = 0; index < 32 * 24; index += 1) {
        values.push(
          (pixels[index * 4]! +
            pixels[index * 4 + 1]! +
            pixels[index * 4 + 2]!) /
            3,
        )
      }
      return values
    }
    const bitmap = await createImageBitmap(
      new Blob(
        [
          Uint8Array.from(atob(originalBase64), (character) =>
            character.charCodeAt(0),
          ),
        ],
        { type: 'image/png' },
      ),
    )
    const signatures = {
      transformed: sample(
        document.querySelector(
          '[data-raw-transform-preview] canvas',
        ) as HTMLCanvasElement,
      ),
      original: sample(bitmap),
    }
    bitmap.close()
    return signatures
  }, originalPng.toString('base64'))
  for (const [name, values] of Object.entries(signatures)) {
    expect(
      Math.max(...values) - Math.min(...values),
      `${name} must contain photo detail`,
    ).toBeGreaterThan(1)
  }

  await openTool(page, 'Export')
  const exportButton = page.getByRole('button', {
    name: 'Export full-resolution JPEG',
    exact: true,
  })
  await expect(exportButton).toBeEnabled({ timeout: 30_000 })
  await exportButton.click()

  const downloadButton = page.getByRole('button', {
    name: 'Download',
    exact: true,
  })
  await downloadButton.waitFor({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await downloadButton.click()
  const delivered = await downloading
  const deliveredPath = await delivered.path()

  const measured = await page.evaluate(
    async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)
      const off = document.createElement('canvas')
      off.width = 32
      off.height = 24
      const context = off.getContext('2d')!
      context.drawImage(bitmap, 0, 0, 32, 24)
      const pixels = context.getImageData(0, 0, 32, 24).data
      const values: number[] = []
      for (let index = 0; index < 32 * 24; index += 1) {
        values.push(
          (pixels[index * 4]! +
            pixels[index * 4 + 1]! +
            pixels[index * 4 + 2]!) /
            3,
        )
      }
      return { width: bitmap.width, height: bitmap.height, values }
    },
    Array.from(await readFile(deliveredPath!)),
  )

  const correlate = (left: number[], right: number[]) => {
    const count = left.length
    const meanLeft = left.reduce((a, b) => a + b, 0) / count
    const meanRight = right.reduce((a, b) => a + b, 0) / count
    let numerator = 0
    let leftSq = 0
    let rightSq = 0
    for (let index = 0; index < count; index += 1) {
      const dl = left[index]! - meanLeft
      const dr = right[index]! - meanRight
      numerator += dl * dr
      leftSq += dl * dl
      rightSq += dr * dr
    }
    return numerator / Math.sqrt(leftSq * rightSq)
  }

  // Full resolution, and framed like the preview rather than the sensor.
  expect(measured.width).toBeGreaterThan(preview.width * 2)
  expect(measured.width / measured.height).toBeCloseTo(
    preview.width / preview.height,
    1,
  )
  // The pixels carry the geometry. A crop of the untransformed frame at the
  // same size would fail this pair of comparisons.
  expect(correlate(measured.values, signatures.transformed)).toBeGreaterThan(
    0.85,
  )
  expect(correlate(measured.values, signatures.transformed)).toBeGreaterThan(
    correlate(measured.values, signatures.original) + 0.3,
  )
})
