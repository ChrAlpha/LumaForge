import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

const rawPath = fileURLToPath(
  new URL(
    '../../packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
    import.meta.url,
  ),
)

test('Transform keeps RAW viewport fixed and lets replacement drops reach the stage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => localStorage.setItem('lumaforge.locale', 'en'))
  await page.goto('/raw')
  const choosing = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  await (await choosing).setFiles(rawPath)
  await expect(
    page.getByText('Loaded raw-pixls-iphone-se.dng', { exact: true }),
  ).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('[data-preview-track-ready]')).toHaveAttribute(
    'data-preview-track-ready',
    'true',
  )
  await page.locator('[data-tool-card-trigger="transform"]').click()
  const tool = page.locator('[data-raw-transform-tool]')
  const auto = tool.getByRole('button', { name: 'Auto', exact: true })
  await expect(auto).toBeEnabled({ timeout: 30_000 })
  await tool.getByRole('button', { name: 'Auto', exact: true }).click()
  const overlay = page.locator('[data-raw-transform-preview]')
  await expect(overlay).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await expect(overlay.locator('canvas')).toBeVisible()
  const track = page.locator('[data-raw-compare-track]')
  const zoom = await track.evaluate((node) =>
    getComputedStyle(node).getPropertyValue('--raw-preview-zoom'),
  )
  const box = (await overlay.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -300)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  expect(
    await track.evaluate((node) =>
      getComputedStyle(node).getPropertyValue('--raw-preview-zoom'),
    ),
  ).toBe(zoom)

  const prevented = await page.evaluate(
    ({ point, base64 }) => {
      const target = document.elementFromPoint(point.x, point.y)!
      if (target.closest('[data-raw-transform-preview]'))
        throw new Error('Transform intercepted the file drop')
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      )
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([bytes], 'dropped-raw.dng', { type: 'image/x-adobe-dng' }),
      )
      const events = ['dragover', 'drop'].map(
        (type) =>
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
          }),
      )
      for (const event of events) target.dispatchEvent(event)
      return events.map((event) => event.defaultPrevented)
    },
    { point, base64: (await readFile(rawPath)).toString('base64') },
  )
  expect(prevented).toEqual([true, true])
  await expect(
    page.getByRole('heading', { name: 'dropped-raw.dng', exact: true }),
  ).toBeVisible()
  await expect(overlay).toHaveCount(0)
})
