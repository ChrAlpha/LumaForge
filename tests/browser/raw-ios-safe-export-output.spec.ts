import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { devices, expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'

type ExportDebugEvent = {
  type: string
  payload: Record<string, unknown>
}

const iPhone = devices['iPhone 14 Pro']
const sonyRawPath =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

test.use({
  viewport: iPhone.viewport,
  userAgent: iPhone.userAgent,
  deviceScaleFactor: iPhone.deviceScaleFactor,
  isMobile: iPhone.isMobile,
  hasTouch: iPhone.hasTouch,
})

async function collectExportEvents(page: Page) {
  return (await page.evaluate(() => {
    return (
      (window as unknown as { __LUMAFORGE_EXPORT_EVENTS__?: unknown[] })
        .__LUMAFORGE_EXPORT_EVENTS__ ?? []
    )
  })) as ExportDebugEvent[]
}

async function loadRawFixture(page: Page) {
  const mobileBrowseButton = page.getByRole('button', {
    name: /browse raw files/i,
  })

  await expect(mobileBrowseButton).toBeVisible()
  const fileChooserPromise = page.waitForEvent('filechooser')
  await mobileBrowseButton.click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(sonyRawPath)
}

async function openExportControls(page: Page) {
  const mobileExportTab = page.getByRole('tab', { name: /^export$/i })
  await expect(mobileExportTab).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(
      async () => (await mobileExportTab.getAttribute('aria-disabled')) ?? '',
      { timeout: 120_000 },
    )
    .not.toBe('true')
  await mobileExportTab.click()
}

async function hasUnsupportedBrowserBuildMessage(page: Page) {
  return /not available in this browser build/i.test(
    (await page.locator('body').textContent()) ?? '',
  )
}

async function hasFailClosedLargeExportMessage(page: Page) {
  return /cannot safely complete this large local full-resolution export/i.test(
    (await page.locator('body').textContent()) ?? '',
  )
}

async function decodeJpegBottomStats(page: Page, jpeg: Buffer) {
  return page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const blob = new Blob([bytes], { type: 'image/jpeg' })
    const bitmap = await createImageBitmap(blob)
    const sourceWidth = bitmap.width
    const sourceHeight = bitmap.height
    const width = Math.min(1024, sourceWidth)
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width))
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height })
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('CANVAS_CONTEXT_UNAVAILABLE')
    }

    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const sampledRows = Math.min(96, height)
    const pixels = context.getImageData(
      0,
      height - sampledRows,
      width,
      sampledRows,
    )
    const means: Array<[number, number, number]> = []

    for (let row = 0; row < sampledRows; row += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let x = 0; x < width; x += 1) {
        const offset = (row * width + x) * 4
        r += pixels.data[offset] ?? 0
        g += pixels.data[offset + 1] ?? 0
        b += pixels.data[offset + 2] ?? 0
      }
      means.push([r / width, g / width, b / width])
    }

    function rowDelta(
      left: [number, number, number],
      right: [number, number, number],
    ) {
      return Math.max(
        Math.abs(left[0] - right[0]),
        Math.abs(left[1] - right[1]),
        Math.abs(left[2] - right[2]),
      )
    }

    function averageRows(start: number, end: number): [number, number, number] {
      let r = 0
      let g = 0
      let b = 0
      const count = end - start
      for (let row = start; row < end; row += 1) {
        r += means[row]?.[0] ?? 0
        g += means[row]?.[1] ?? 0
        b += means[row]?.[2] ?? 0
      }
      return [r / count, g / count, b / count]
    }

    let maxAdjacentDelta = 0
    for (let row = 1; row < means.length; row += 1) {
      maxAdjacentDelta = Math.max(
        maxAdjacentDelta,
        rowDelta(means[row - 1]!, means[row]!),
      )
    }

    const terminalRows = Math.min(12, Math.floor(sampledRows / 4))
    const terminalMean = averageRows(sampledRows - terminalRows, sampledRows)
    const priorMean = averageRows(
      sampledRows - terminalRows * 2,
      sampledRows - terminalRows,
    )

    return {
      sourceWidth,
      sourceHeight,
      sampledWidth: width,
      sampledHeight: height,
      sampledRows,
      maxAdjacentDelta,
      terminalDelta: rowDelta(priorMean, terminalMean),
      terminalMean,
      priorMean,
    }
  }, jpeg.toString('base64'))
}

test('low-memory WebKit export decodes without a bottom color band for the Sony ARW', async ({
  page,
}, testInfo) => {
  test.skip(
    !existsSync(sonyRawPath),
    `Missing Sony ARW fixture: ${sonyRawPath}`,
  )
  testInfo.setTimeout(600_000)

  await page.addInitScript(() => {
    window.addEventListener('lumaforge-export-debug', (event) => {
      const custom = event as CustomEvent
      ;(
        window as unknown as { __LUMAFORGE_EXPORT_EVENTS__: unknown[] }
      ).__LUMAFORGE_EXPORT_EVENTS__ ??= []
      ;(
        window as unknown as { __LUMAFORGE_EXPORT_EVENTS__: unknown[] }
      ).__LUMAFORGE_EXPORT_EVENTS__.push(custom.detail)
    })
  })

  await page.goto('/raw')
  await loadRawFixture(page)
  await openExportControls(page)

  const exportButton = page
    .getByRole('button', { name: /export full-resolution jpeg/i })
    .first()
  await expect
    .poll(
      async () => {
        if (await hasUnsupportedBrowserBuildMessage(page)) return 'unsupported'
        if (await hasFailClosedLargeExportMessage(page)) return 'fail-closed'
        if (
          (await exportButton.isVisible()) &&
          (await exportButton.isEnabled())
        ) {
          return 'ready'
        }
        return 'waiting'
      },
      { timeout: 180_000 },
    )
    .toMatch(/ready|unsupported|fail-closed/)

  if (await hasUnsupportedBrowserBuildMessage(page)) {
    testInfo.skip(
      true,
      'Processed-window export is unavailable in this browser build.',
    )
  }
  if (await hasFailClosedLargeExportMessage(page)) {
    testInfo.skip(
      true,
      'This browser correctly failed closed for a large local full-resolution export without durable file storage.',
    )
  }

  await exportButton.click()

  await expect
    .poll(
      async () => {
        const plan = (await collectExportEvents(page)).find(
          (event) => event.type === 'export-plan-selected',
        )?.payload
        return {
          runtimeMemoryProfile: plan?.runtimeMemoryProfile,
          outputSink: plan?.outputSink,
          checkpointMode: plan?.checkpointMode,
          derivedLabel: plan?.derivedLabel,
          workerMemoryProfile: (
            plan?.policyVector as { workerMemoryProfile?: unknown } | undefined
          )?.workerMemoryProfile,
        }
      },
      { timeout: 60_000 },
    )
    .toMatchObject({
      runtimeMemoryProfile: 'low-memory',
      outputSink: 'opfs-file',
      checkpointMode: 'safe-retry',
      derivedLabel: expect.stringContaining('wkwebkit-mobile'),
      workerMemoryProfile: 'low-memory',
    })

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  await expect(downloadButton).toBeVisible({ timeout: 420_000 })
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.click()
  const download = await downloadPromise
  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const jpeg = await readFile(downloadedPath!)

  const stats = await decodeJpegBottomStats(page, jpeg)
  await testInfo.attach('sony-low-memory-webkit-bottom-stats.json', {
    body: JSON.stringify(stats, null, 2),
    contentType: 'application/json',
  })

  expect(stats).toMatchObject({
    sourceWidth: 9566,
    sourceHeight: 6374,
  })
  expect(stats.maxAdjacentDelta).toBeLessThan(48)
  expect(stats.terminalDelta).toBeLessThan(18)

  // OPFS-backed output is hashed by the worker as it is written, so the
  // manifest must identify the downloaded JPEG without reopening the file.
  const manifestButton = page.getByRole('button', { name: /manifest/i })
  await expect(manifestButton).toBeVisible({ timeout: 180_000 })
  const manifestDownloadPromise = page.waitForEvent('download')
  await manifestButton.click()
  const manifestDownload = await manifestDownloadPromise
  const manifestPath = await manifestDownload.path()
  expect(manifestPath).toBeTruthy()
  const manifest = JSON.parse(await readFile(manifestPath!, 'utf8')) as {
    kind: string
    output: { sha256: string }
    environment: { native_artifacts: { variant: string } }
  }
  await testInfo.attach('sony-low-memory-webkit-manifest.json', {
    body: JSON.stringify(manifest, null, 2),
    contentType: 'application/json',
  })
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  expect(manifest.output.sha256).toBe(
    createHash('sha256').update(jpeg).digest('hex'),
  )
  expect(manifest.environment.native_artifacts.variant).toBe('low-memory')
})
