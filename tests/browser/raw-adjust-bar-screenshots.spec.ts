/**
 * Ad-hoc visual evidence run for the mobile Adjust section bar fix.
 *
 * Loads the public RAW fixture in the iPhone 14 Pro webkit profile, opens
 * the Adjust dock on Tone (longest list = guaranteed scroll), and saves
 * two screenshots:
 *
 *   tmp/adjust-bar-rest.png    — at scrollTop=0 (chrome at natural position)
 *   tmp/adjust-bar-scrolled.png — after scrolling the dock by 200px
 *
 * The spec is itself a screenshot-only diagnostic; reviewing the PNGs
 * is the assertion. Keep around — re-runs cheaply produce fresh evidence
 * whenever the bar visuals are touched.
 */

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import {
  gateRawFixture,
  resolvePublicRawFixture,
} from '../../scripts/ci/raw-fixtures.mjs'

const RAW_FIXTURE = resolvePublicRawFixture()

const OUTPUT_DIR = path.resolve(process.cwd(), 'tmp')

async function loadRawFixtureMobile(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /browse raw files/i }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

test('adjust bar visual evidence', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'Visual evidence targets iOS WebKit only',
  )
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(180_000)

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadRawFixtureMobile(page, rawPath)

  await page.getByRole('tab', { name: 'Adjust' }).click()
  const dockPanel = page.locator('[data-mobile-dock-panel]')
  await expect(dockPanel).toBeVisible()

  // Tone alone (6 rows) fits in the dock max-h, so the scroll-pinned state
  // can't be visually proven there. Switch to HSL and expand a band — the
  // 8 band rows + 3 expanded axis rows = ~11 items, well past max-h.
  await dockPanel.getByRole('tab', { name: 'HSL' }).click()
  const hslSection = dockPanel.locator('[data-adjust-list-section="hsl"]')
  await expect(hslSection).toBeVisible()
  await hslSection
    .locator('[data-hsl-band-row="red"]')
    .getByRole('button')
    .first()
    .click()
  await expect(hslSection.locator('[data-hsl-band-row="red"]')).toHaveAttribute(
    'data-open',
    'true',
  )

  // Clip the screenshot to the dock area + a strip of photo above so the
  // chrome's interaction with the dock's gradient edge is visible.
  const dockBox = await dockPanel.boundingBox()
  if (!dockBox) throw new Error('dock panel has no bounding box')
  const clip = {
    x: 0,
    y: Math.max(0, dockBox.y - 60),
    width: dockBox.width,
    height: Math.min(dockBox.height + 80, 600),
  }

  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'adjust-bar-rest.png'),
    clip,
  })

  const scrollContainer = dockPanel.locator('[data-adjust-list-scroll]')
  await scrollContainer.evaluate((el) => el.scrollBy({ top: 200 }))
  await page.waitForTimeout(160)

  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'adjust-bar-scrolled.png'),
    clip,
  })
})
