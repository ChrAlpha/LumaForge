import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const rawPath = fileURLToPath(
  new URL(
    '../../packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
    import.meta.url,
  ),
)
const rawName = 'raw-pixls-iphone-se.dng'
const replacementName = 'replacement-iphone-se.dng'
const exportReason =
  'Transform changes support preview JPEG only. Reset Transform before exporting a standard JPEG.'

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
  await expect(
    transformTool(page).getByRole('button', {
      name: 'Save preview JPEG',
      exact: true,
    }),
  ).toBeEnabled({ timeout: 30_000 })
  await expect(transformTool(page).getByRole('alert')).toHaveCount(0)
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

async function expectStandardExports(
  page: Page,
  enabled: boolean,
  hqAvailable = true,
) {
  await openTool(page, 'Export')
  for (const name of [
    'Export full-resolution JPEG',
    'Export HQ preview JPEG',
  ]) {
    const button = page.getByRole('button', { name, exact: true })
    if (enabled && (hqAvailable || name === 'Export full-resolution JPEG')) {
      await expect(button).toBeEnabled({ timeout: 30_000 })
    } else {
      await expect(button).toBeDisabled()
    }
  }
  if (enabled) {
    await expect(page.getByText(exportReason, { exact: true })).toHaveCount(0)
  } else {
    await expect(page.getByText(exportReason, { exact: true })).toBeVisible()
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
    testInfo.setTimeout(360_000)
    expect(
      existsSync(rawPath),
      'Required public DNG is missing. Run pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public before browser validation.',
    ).toBe(true)
    await page.addInitScript(() => {
      localStorage.setItem('lumaforge.locale', 'en')
    })
    await page.goto(preview === 'cpu' ? '/raw?forcePreview=cpu' : '/raw')
    await loadRaw(page)
    if (preview === 'cpu') {
      await expect(page.getByText(/GPU preview unavailable/)).toBeVisible()
      await expect(page.getByTestId('cpu-preview-unavailable')).toHaveCount(0)
      await expect(page.locator('.raw-preview-canvas')).toHaveCount(0)
    } else {
      await expect(page.getByText(/GPU preview unavailable/)).toHaveCount(0)
      await expect(page.locator('[data-preview-track-ready]')).toHaveAttribute(
        'data-preview-track-ready',
        'true',
      )
      expect(
        await page.locator('.raw-preview-canvas').evaluate((element) => {
          const context = (element as HTMLCanvasElement).getContext('webgl2')
          return Boolean(
            context &&
            !context.isContextLost() &&
            context.drawingBufferWidth > 1,
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
    await expectStandardExports(page, true, hqAvailable)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await expect(transformTool(page).locator('input[type="file"]')).toHaveCount(
      0,
    )
    await expect(
      transformTool(page).getByRole('button', { name: 'Load test image' }),
    ).toHaveCount(0)

    await transformTool(page)
      .getByRole('button', { name: 'Auto', exact: true })
      .click()
    await waitForTransform(page)
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

    await transformTool(page)
      .getByRole('button', { name: 'Before transform' })
      .click()
    await expect(transformCanvas(page)).toHaveAttribute('data-view', 'original')
    const original = await snapshot(page)
    await transformTool(page)
      .getByRole('button', { name: 'After transform' })
      .click()
    await expect(transformCanvas(page)).toHaveAttribute(
      'data-view',
      'corrected',
    )
    expect((await snapshot(page)).hash).toBe(corrected.hash)
    expect(corrected.hash).not.toBe(original.hash)
    expect(corrected.width * corrected.height).toBeLessThan(
      original.width * original.height,
    )
    expect(corrected.width * corrected.height).toBeGreaterThan(
      original.width * original.height * 0.25,
    )

    await expectStandardExports(page, false)
    await openTool(page, 'Transform')
    await waitForTransform(page)
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
    await expect(rotate).toHaveAttribute('aria-valuenow', '1')
    await expect(
      transformTool(page).getByRole('button', { name: 'Auto', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    const toned = await snapshot(page)
    expect(
      await page
        .locator('[data-raw-transform-preview]')
        .getAttribute('data-transform-matrix'),
    ).toBe(geometry)
    expect(toned.meanLight).toBeGreaterThan(corrected.meanLight)
    await expectStandardExports(page, false)
    await openTool(page, 'Transform')
    await waitForTransform(page)

    const downloading = page.waitForEvent('download')
    await transformTool(page)
      .getByRole('button', { name: 'Save preview JPEG' })
      .click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(
      'raw-pixls-iphone-se-transform-preview.jpg',
    )
    const jpeg = await readFile((await download.path())!)
    expect(jpeg.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    const downloaded = await transformCanvas(page).evaluate(
      async (element, base64) => {
        const reference = element as HTMLCanvasElement
        const image = new Image()
        image.src = `data:image/jpeg;base64,${base64}`
        await image.decode()
        const decoded = document.createElement('canvas')
        decoded.width = image.naturalWidth
        decoded.height = image.naturalHeight
        const context = decoded.getContext('2d')!
        context.drawImage(image, 0, 0)
        if (
          decoded.width !== reference.width ||
          decoded.height !== reference.height
        ) {
          return {
            width: decoded.width,
            height: decoded.height,
            meanError: Infinity,
          }
        }
        const actual = context.getImageData(
          0,
          0,
          decoded.width,
          decoded.height,
        ).data
        const expected = reference
          .getContext('2d')!
          .getImageData(0, 0, reference.width, reference.height).data
        let difference = 0
        for (let offset = 0; offset < actual.length; offset += 4) {
          for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(
              actual[offset + channel] - expected[offset + channel],
            )
          }
        }
        return {
          width: decoded.width,
          height: decoded.height,
          meanError: difference / (decoded.width * decoded.height * 3),
        }
      },
      jpeg.toString('base64'),
    )
    expect(downloaded).toMatchObject({
      width: toned.width,
      height: toned.height,
    })
    expect(downloaded.meanError).toBeLessThan(5)

    await transformTool(page)
      .getByRole('button', { name: 'Reset', exact: true })
      .click()
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, true, hqAvailable)

    await openTool(page, 'Transform')
    await rotate.focus()
    await rotate.press('PageUp')
    await waitForTransform(page)
    await openTool(page, 'Adjust')
    await page.getByRole('button', { name: /reset exposure/i }).click()
    await expect(exposure).toHaveAttribute('aria-valuenow', '0')
    await replaceRaw(page)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await expect(
      transformTool(page).getByRole('button', { name: 'Off', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, true, hqAvailable)

    await openTool(page, 'Transform')
    await rotate.focus()
    await rotate.press('PageUp')
    await waitForTransform(page)
    const replacement = await snapshot(page)
    expect(replacement.hash).not.toBe(toned.hash)
    await transformTool(page)
      .getByRole('button', { name: 'Before transform' })
      .click()
    await expect(transformCanvas(page)).toHaveAttribute('data-view', 'original')
    expect(await snapshot(page)).toEqual(original)
    await resetSession(page)
    await loadRaw(page)
    await openTool(page, 'Transform')
    await waitForTransform(page)
    await expect(rotate).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('[data-raw-transform-preview]')).toHaveCount(0)
    await expectStandardExports(page, true, hqAvailable)
  })
}
