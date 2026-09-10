import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  rawPreviewUrl,
  requireWebGPUFixture,
} from './raw-preview-backend'

const RAW_FIXTURE =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

const HSL_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const

async function loadRawFixture(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
}

async function scrollAndDragSliderToCenterPlusOffset(
  page: Page,
  slider: Locator,
  ratioFromCenter: number,
) {
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  expect(box).toBeTruthy()
  const startX = box!.x + box!.width / 2
  const startY = box!.y + box!.height / 2
  const targetX = box!.x + box!.width * (0.5 + ratioFromCenter)

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(targetX, startY, { steps: 10 })
  await page.mouse.up()
}

test('drives selective-color HSL through all 8 bands and resets cleanly', async ({
  page,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'HSL smoke targets desktop Chromium only',
  )
  requireWebGPUFixture(testInfo, RAW_FIXTURE)
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(240_000)

  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(rawPreviewUrl(testInfo))
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page, RAW_FIXTURE)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
  await expectWebGPUPreview(page, testInfo)

  // The HSL subpanel lives inside the Adjust tool aria-section.
  const hslSection = page.getByRole('region', { name: 'HSL' }).first()
  await hslSection.scrollIntoViewIfNeeded()
  await expect(hslSection).toBeVisible()

  // All 8 documented bands must mount as groups with `data-hsl-band="<id>"`.
  for (const band of HSL_BANDS) {
    const bandGroup = hslSection.locator(`[data-hsl-band="${band}"]`)
    await expect(bandGroup).toBeVisible()
    const hueSlider = bandGroup.getByRole('slider', { name: 'Hue' })
    await expect(hueSlider).toBeVisible()
    await expect(hueSlider).toBeEnabled()

    const before = Number(await hueSlider.getAttribute('aria-valuenow'))
    await scrollAndDragSliderToCenterPlusOffset(
      page,
      hueSlider,
      band === 'red' ? 0.18 : 0.12,
    )
    await expect
      .poll(async () => Number(await hueSlider.getAttribute('aria-valuenow')))
      .not.toBe(before)
  }

  // "Reset all" wipes every band on every axis back to neutral.
  const resetButton = hslSection.getByRole('button', { name: 'Reset all' })
  await expect(resetButton).toBeEnabled()
  await resetButton.click()

  // After reset, the Hue axis (active by default) shows every band at 0.
  for (const band of HSL_BANDS) {
    const slider = hslSection
      .locator(`[data-hsl-band="${band}"]`)
      .getByRole('slider', { name: 'Hue' })
    await expect(slider).toBeVisible()
    expect(Number(await slider.getAttribute('aria-valuenow'))).toBe(0)
  }
  await expect(resetButton).toBeDisabled()

  // Adjust red.Hue (default tab) so the export pipeline sees a non-trivial LUT.
  const redHue = hslSection
    .locator('[data-hsl-band="red"]')
    .getByRole('slider', { name: 'Hue' })
  await scrollAndDragSliderToCenterPlusOffset(page, redHue, 0.2)

  // Switch to the Saturation axis tab and adjust blue.Saturation.
  await hslSection.getByRole('tab', { name: 'Saturation' }).click()
  const blueSat = hslSection
    .locator('[data-hsl-band="blue"]')
    .getByRole('slider', { name: 'Saturation' })
  await scrollAndDragSliderToCenterPlusOffset(page, blueSat, -0.18)

  // Drive a HQ preview export — cheaper than full-resolution but exercises
  // the same color graph including the user-selective-color step.
  const exportRegion = page.getByRole('region', { name: 'Export' }).first()
  const hqPreviewExportButton = exportRegion.getByRole('button', {
    name: /export hq preview jpeg/i,
  })
  await expect(hqPreviewExportButton).toBeEnabled({ timeout: 90_000 })
  await hqPreviewExportButton.click()
  await expect(exportRegion.getByText('HQ preview JPEG ready')).toBeVisible({
    timeout: 90_000,
  })

  const downloadPromise = page.waitForEvent('download')
  await exportRegion.getByRole('button', { name: /^download$/i }).click()
  const download = await downloadPromise
  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const jpeg = await readFile(downloadedPath!)
  expect(jpeg.byteLength).toBeGreaterThan(64 * 1024)
  await expectWebGPUPreview(page, testInfo)

  expect(
    consoleErrors,
    `unexpected console errors:\n${consoleErrors.join('\n')}`,
  ).toEqual([])
})
