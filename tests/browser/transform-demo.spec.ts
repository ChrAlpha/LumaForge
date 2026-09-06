import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

async function waitForRender(page: Page, mode: string) {
  const status = page.getByTestId('transform-status')
  await expect(status).toHaveAttribute('data-mode', mode)
  await expect(status).toHaveAttribute('data-busy', 'false')
  await expect(
    page.getByRole('button', { name: 'Save preview JPEG' }),
  ).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
}

async function openDemo(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
  })
  await page.goto('/transform-demo', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('transform-canvas')).toBeVisible()
  await waitForRender(page, 'off')
}

async function snapshot(page: Page) {
  return page.getByTestId('transform-canvas').evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement
    const { width, height } = canvas
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data
    const digest = await crypto.subtle.digest('SHA-256', data)
    const light = (x: number, y: number) => {
      const offset = (y * width + x) * 4
      return (data[offset] + data[offset + 1] + data[offset + 2]) / 3
    }
    let across = 0
    let along = 0
    let edges = 0
    // Measure near-vertical edges directly, independently of the demo's detector.
    for (let y = Math.floor(height * 0.15); y < height * 0.85; y += 2) {
      for (let x = Math.floor(width * 0.15); x < width * 0.85; x += 2) {
        const gx = Math.abs(light(x + 2, y) - light(x - 2, y))
        const gy = Math.abs(light(x, y + 2) - light(x, y - 2))
        if (gx > 25 && gy < gx * 0.65) {
          across += gx
          along += gy
          edges++
        }
      }
    }
    return {
      width,
      height,
      png: canvas.toDataURL('image/png'),
      hash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      slope: along / across,
      edges,
    }
  })
}

async function sampleFile(page: Page) {
  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await expect(page.getByTestId('transform-canvas')).toHaveAttribute(
    'data-view',
    'original',
  )
  const original = await snapshot(page)
  await page.getByRole('button', { name: 'After', exact: true }).click()
  return {
    original,
    file: {
      name: 'facade-upload.png',
      mimeType: 'image/png',
      buffer: Buffer.from(original.png.split(',')[1], 'base64'),
    },
  }
}

test('uploaded pixels are corrected by Auto, crop is optional, and Reset is exact', async ({
  page,
}) => {
  await openDemo(page)
  const { original, file } = await sampleFile(page)
  await page.getByLabel('Open photo', { exact: true }).setInputFiles(file)
  await expect(page.getByTitle(file.name)).toBeVisible()
  await waitForRender(page, 'off')
  expect((await snapshot(page)).hash).toBe(original.hash)

  await page.getByTestId('mode-auto').click()
  await waitForRender(page, 'auto')
  const corrected = await snapshot(page)
  expect(corrected.hash).not.toBe(original.hash)
  expect(corrected.width).toBeLessThan(original.width)
  expect(corrected.height).toBeLessThan(original.height)
  expect(corrected.width).toBeGreaterThan(original.width / 2)
  expect(corrected.edges).toBeGreaterThan(1000)
  expect(corrected.slope).toBeLessThan(original.slope * 0.7)

  await page.getByRole('checkbox', { name: 'Constrain crop' }).uncheck()
  await waitForRender(page, 'auto')
  const uncropped = await snapshot(page)
  expect([uncropped.width, uncropped.height]).toEqual([
    original.width,
    original.height,
  ])
  expect(uncropped.hash).not.toBe(original.hash)

  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await waitForRender(page, 'off')
  const reset = await snapshot(page)
  expect([reset.width, reset.height, reset.hash]).toEqual([
    original.width,
    original.height,
    original.hash,
  ])
  await expect(
    page.getByRole('checkbox', { name: 'Constrain crop' }),
  ).toBeChecked()
})

test('an invalid JPEG clears stale output and a subsequent image upload recovers', async ({
  page,
}) => {
  await openDemo(page)
  const { original, file } = await sampleFile(page)
  const input = page.getByLabel('Open photo', { exact: true })
  await input.setInputFiles({
    name: 'broken.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('This is not JPEG image data.'),
  })
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByTestId('transform-canvas')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Save preview JPEG' }),
  ).toBeDisabled()
  await expect(page.getByTestId('mode-auto')).toBeDisabled()

  await input.setInputFiles(file)
  await expect(page.getByTitle(file.name)).toBeVisible()
  await waitForRender(page, 'off')
  expect((await snapshot(page)).hash).toBe(original.hash)
  await page.getByTestId('mode-auto').click()
  await waitForRender(page, 'auto')
  expect((await snapshot(page)).slope).toBeLessThan(original.slope * 0.7)
})

test('rapid mode changes finish with the latest mode pixels and manual edits render', async ({
  page,
}) => {
  await openDemo(page)
  await page.getByTestId('mode-full').click()
  await waitForRender(page, 'full')
  const full = await snapshot(page)
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await waitForRender(page, 'off')

  await page.evaluate(async () => {
    for (const mode of ['auto', 'level', 'vertical', 'full']) {
      document
        .querySelector<HTMLButtonElement>(`[data-testid="mode-${mode}"]`)!
        .click()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
    }
  })
  await waitForRender(page, 'full')
  await expect(page.getByTestId('mode-full')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect((await snapshot(page)).hash).toBe(full.hash)

  const rotate = page.getByRole('slider', { name: 'Rotate', exact: true })
  await rotate.focus()
  await rotate.press('ArrowRight')
  await expect(rotate).toHaveAttribute('aria-valuenow', '0.1')
  await waitForRender(page, 'full')
  expect((await snapshot(page)).hash).not.toBe(full.hash)
  await rotate.press('ArrowLeft')
  await waitForRender(page, 'full')
  expect((await snapshot(page)).hash).toBe(full.hash)
})

test('JPEG keeps corrected geometry and excludes overlays while Original is displayed', async ({
  page,
}) => {
  await openDemo(page)
  await page.getByTestId('mode-auto').click()
  await waitForRender(page, 'auto')
  const corrected = await snapshot(page)
  await page
    .getByRole('button', { name: 'Detected lines', exact: true })
    .click()
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  const overlaid = await snapshot(page)
  expect(overlaid.hash).not.toBe(corrected.hash)
  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await expect(page.getByTestId('transform-canvas')).toHaveAttribute(
    'data-view',
    'original',
  )
  expect((await snapshot(page)).width).toBeGreaterThan(corrected.width)

  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save preview JPEG' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/-transform-preview\.jpg$/)
  const bytes = await readFile((await download.path())!)
  expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff')

  const comparison = await page.evaluate(
    async ({ reference, overlay, jpeg }) => {
      async function decode(url: string) {
        const image = new Image()
        image.src = url
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        return {
          width: canvas.width,
          height: canvas.height,
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        }
      }
      const [expected, visible, actual] = await Promise.all([
        decode(reference),
        decode(overlay),
        decode(jpeg),
      ])
      if (
        actual.width !== expected.width ||
        actual.height !== expected.height
      ) {
        return { width: actual.width, height: actual.height }
      }
      let error = 0
      let badPixels = 0
      let overlayPixels = 0
      let overlayError = 0
      let visibleError = 0
      for (let offset = 0; offset < expected.data.length; offset += 4) {
        let pixelError = 0
        let overlayDifference = 0
        for (let channel = 0; channel < 3; channel++) {
          pixelError +=
            Math.abs(
              actual.data[offset + channel] - expected.data[offset + channel],
            ) / 3
          overlayDifference +=
            Math.abs(
              visible.data[offset + channel] - expected.data[offset + channel],
            ) / 3
        }
        error += pixelError
        if (pixelError > 16) badPixels++
        if (overlayDifference > 20) {
          overlayPixels++
          overlayError += pixelError
          visibleError += overlayDifference
        }
      }
      const shiftedErrors = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
      ].map(([dx, dy]) => {
        let difference = 0
        let samples = 0
        for (let y = 2; y < actual.height - 2; y += 2) {
          for (let x = 2; x < actual.width - 2; x += 2) {
            const a = (y * actual.width + x) * 4
            const b = ((y + dy) * actual.width + x + dx) * 4
            for (let channel = 0; channel < 3; channel++) {
              difference += Math.abs(
                actual.data[a + channel] - expected.data[b + channel],
              )
              samples++
            }
          }
        }
        return difference / samples
      })
      return {
        width: actual.width,
        height: actual.height,
        meanError: error / (actual.width * actual.height),
        badFraction: badPixels / (actual.width * actual.height),
        shiftedErrors,
        overlayPixels,
        overlayError: overlayError / overlayPixels,
        visibleError: visibleError / overlayPixels,
      }
    },
    {
      reference: corrected.png,
      overlay: overlaid.png,
      jpeg: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    },
  )
  expect([comparison.width, comparison.height]).toEqual([
    corrected.width,
    corrected.height,
  ])
  expect(comparison.meanError).toBeLessThan(2)
  expect(comparison.badFraction).toBeLessThan(0.02)
  for (const error of comparison.shiftedErrors!) {
    expect(error).toBeGreaterThan(comparison.meanError! * 2)
  }
  expect(comparison.overlayPixels).toBeGreaterThan(500)
  expect(comparison.overlayError).toBeLessThan(4)
  expect(comparison.overlayError).toBeLessThan(comparison.visibleError! / 5)
})

test('controls remain reachable without horizontal overflow at a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 660 })
  await openDemo(page)
  const save = page.getByRole('button', { name: 'Save preview JPEG' })
  for (const hover of [false, true]) {
    if (hover) await save.hover()
    const contrast = await save.evaluate((button) => {
      const style = getComputedStyle(button)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      const luminance = (color: string) => {
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        const channels = context.getImageData(0, 0, 1, 1).data.slice(0, 3)
        return Array.from(channels, (byte) => {
          const value = byte / 255
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4
        }).reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
          0,
        )
      }
      const foreground = luminance(style.color)
      const background = luminance(style.backgroundColor)
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      )
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  }
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - innerWidth,
    body: document.body.scrollWidth - innerWidth,
  }))
  expect(overflow.document).toBeLessThanOrEqual(1)
  expect(overflow.body).toBeLessThanOrEqual(1)

  for (const name of [
    'Open photo',
    'Reset',
    'Save preview JPEG',
    'Load test image',
  ]) {
    const control = page
      .getByRole('button', { name, exact: true })
      .and(page.locator('button'))
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport()
    const photo = page.getByTestId('transform-canvas')
    await expect(photo).toBeInViewport()
    const preview = (await photo.boundingBox())!
    expect(preview.width).toBeGreaterThanOrEqual(300)
    expect(preview.height).toBeGreaterThanOrEqual(200)
    const box = (await control.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(394)
  }
  await page.getByTestId('mode-auto').click()
  await waitForRender(page, 'auto')
  const corrected = await snapshot(page)
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await waitForRender(page, 'off')
  expect((await snapshot(page)).width).toBeGreaterThan(corrected.width)
})
