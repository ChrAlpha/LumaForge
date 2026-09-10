import type { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import {
  expectWebGPUPreview,
  isDesktopChromiumProject,
  rawPreviewUrl,
  requireWebGPUFixture,
} from './raw-preview-backend'

const sonyRawPath =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

async function loadRawFixture(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
}

async function decodeJpegSize(page: Page, jpeg: Buffer) {
  return page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close?.()
    return size
  }, jpeg.toString('base64'))
}

test('exports an HQ preview JPEG from a real RAW upload without replacing full-resolution export', async ({
  page,
}, testInfo) => {
  test.skip(
    !isDesktopChromiumProject(testInfo),
    'HQ preview export acceptance uses desktop Chromium download APIs',
  )
  requireWebGPUFixture(testInfo, sonyRawPath)
  test.skip(
    !existsSync(sonyRawPath),
    `Missing Sony ARW fixture: ${sonyRawPath}`,
  )
  testInfo.setTimeout(240_000)

  await page.goto(rawPreviewUrl(testInfo))
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page, sonyRawPath)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
  await expectWebGPUPreview(page, testInfo)

  const exportRegion = page.getByRole('region', { name: 'Export' }).first()
  const fullResExportButton = exportRegion.getByRole('button', {
    name: /export full-resolution jpeg/i,
  })
  const hqPreviewExportButton = exportRegion.getByRole('button', {
    name: /export hq preview jpeg/i,
  })

  await expect(fullResExportButton).toBeVisible()
  await expect(hqPreviewExportButton).toBeEnabled({ timeout: 90_000 })
  await expect(
    exportRegion.getByText(/full-resolution processed-window path/i),
  ).toHaveCount(0)
  await expect(
    exportRegion.getByText(/smaller 8-12mp preview-rendered jpeg/i),
  ).toHaveCount(0)

  await hqPreviewExportButton.click()
  await expect(exportRegion.getByText('HQ preview JPEG ready')).toBeVisible({
    timeout: 90_000,
  })
  await expect(
    exportRegion.getByText(/use full-resolution export for archival output/i),
  ).toHaveCount(0)

  const downloadPromise = page.waitForEvent('download')
  await exportRegion.getByRole('button', { name: /^download$/i }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain('_hq-preview.jpg')

  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const jpeg = await readFile(downloadedPath!)
  const size = await decodeJpegSize(page, jpeg)
  const megapixels = size.width * size.height

  expect(megapixels).toBeGreaterThanOrEqual(8_000_000)
  expect(megapixels).toBeLessThanOrEqual(12_000_000)
  expect(size.width / size.height).toBeCloseTo(1.5, 1)
  await expectWebGPUPreview(page, testInfo)
})
