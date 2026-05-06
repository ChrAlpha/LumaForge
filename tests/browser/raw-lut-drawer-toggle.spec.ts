import { writeFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

function createIdentityCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)

  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(
            b * step
          ).toFixed(6)}`,
        )
      }
    }
  }

  return lines.join('\n')
}

async function openRawToolsIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) > 640) return

  const styleTab = page.getByRole('button', { name: 'Style' })
  const sheet = page.locator('[data-raw-mobile-sheet]')

  await expect(styleTab).toBeVisible()
  await styleTab.click()
  await expect(sheet).toBeVisible()
  await expect(page.locator('[data-raw-mobile-sheet] h2')).toHaveText('Style')
}

test('closes the online LUT resource browser when its trigger is clicked again', async ({
  page,
}) => {
  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/valid.cube')}`,
  )
  await openRawToolsIfNeeded(page)

  const trigger = page.getByRole('button', { name: 'Open valid.cube' })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'valid.cube LUTs' }),
  ).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'valid.cube LUTs' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('closes the online LUT resource browser after a rapid repeated trigger click', async ({
  page,
}) => {
  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/rapid.cube')}`,
  )
  await openRawToolsIfNeeded(page)

  const trigger = page.getByRole('button', { name: 'Open rapid.cube' })
  await expect(trigger).toBeVisible()

  await trigger.dblclick()

  await expect(
    page.getByRole('dialog', { name: 'rapid.cube LUTs' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('closes the LUT contract browser when its trigger is clicked again', async ({
  page,
}, testInfo) => {
  const cubePath = testInfo.outputPath('unknown-validation.cube')
  await writeFile(cubePath, createIdentityCube('Unknown Validation'), 'utf8')
  await page.goto('/raw')

  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)
  await openRawToolsIfNeeded(page)

  const trigger = page.getByRole('button', { name: 'Change LUT contract' })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'LUT contract browser' }),
  ).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'LUT contract browser' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})
