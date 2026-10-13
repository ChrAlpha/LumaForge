import { writeFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { AUDIT_CATALOG_URL, serveAuditCatalog } from './support/catalog'
import { createCube } from './support/files'
import { gateRawFixture, PUBLIC_DNG, RAW_FIXTURE } from './support/fixtures'
import { nextCpuFrame, settledCpuFrame } from './support/frames'
import {
  chooseRaw,
  expectWebGPUPreview,
  gpuCanvas,
  loadedLab,
  loadRaw,
  openLab,
  stage,
} from './support/lab'
import { readTrace } from './support/trace'

// The desktop command rail on the Chromium project: the Adjust scrub, the
// CPU stage's original row, and the LUT popovers anchored beside the rail.

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'The desktop command rail runs on Chromium',
)

test('desktop: a press anywhere on an Adjust row grabs the value, Shift halves the speed', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(300_000)

  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })
  // The blocking progress overlay is up through decode and the bounded HQ;
  // a press before it lifts lands on the overlay.
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  await expectWebGPUPreview(page, testInfo)

  const row = page.locator('[data-tone-field="userExposureEv"]')
  await row.scrollIntoViewIfNeeded()
  const slider = row.getByRole('slider')
  const track = await row.locator('[data-slot="slider-track"]').boundingBox()
  if (!track) throw new Error('exposure track has no box')
  const y = track.y + track.height / 2

  // Press well away from the thumb: the value must jump to the pointer.
  await page.mouse.move(track.x + track.width * 0.75, y)
  await page.mouse.down()
  await expect(row).toHaveAttribute('data-scrubbing', 'true')
  const pressed = Number(await slider.getAttribute('aria-valuenow'))
  expect(pressed).toBeGreaterThan(1)

  // 40px of travel, then the same 40px with Shift held.
  await page.mouse.move(track.x + track.width * 0.75 + 40, y, { steps: 8 })
  const coarse = Number(await slider.getAttribute('aria-valuenow'))
  await page.keyboard.down('Shift')
  await page.mouse.move(track.x + track.width * 0.75 + 80, y, { steps: 8 })
  const fine = Number(await slider.getAttribute('aria-valuenow'))
  await page.keyboard.up('Shift')
  await page.mouse.up()

  const coarseStep = coarse - pressed
  const fineStep = fine - coarse
  expect(coarseStep).toBeGreaterThan(0)
  expect(fineStep).toBeGreaterThan(0)
  // One tenth, with room for step quantisation at 0.01 EV.
  expect(fineStep).toBeLessThan(coarseStep / 5)
  await expect(row).not.toHaveAttribute('data-scrubbing', 'true')

  // The amber readout is the per-field reset.
  const reset = row.getByRole('button')
  await expect(reset).toHaveAttribute('aria-label', /reset exposure/i)
  await reset.click()
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBe(0)
})

test('desktop forced CPU: Reset compare view is off and the original row switches executors', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  await openLab(page, testInfo, {
    surface: 'desktop',
    path: '/raw?forcePreview=cpu',
  })
  await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  await loadRaw(page, rawPath)
  await expect(gpuCanvas(page)).toHaveCount(0)

  // The CPU stage has no split, so the reset that returns to one is off.
  const compare = page.locator('[data-tool-card-trigger="compare"]')
  if ((await compare.getAttribute('aria-expanded')) !== 'true') {
    await compare.click()
  }
  const resetCompare = page.getByRole('button', { name: 'Reset compare view' })
  await expect(resetCompare).toBeVisible()
  await expect(resetCompare).toBeDisabled()

  // The CPU stage's own original / processed row, on the same executor
  // switch: after a visible edit each choice shows its own frame, the second
  // original included, which comes from the cache.
  const adjust = page.locator('[data-tool-card-trigger="adjust"]')
  if ((await adjust.getAttribute('aria-expanded')) !== 'true') {
    await adjust.click()
  }
  const unedited = await settledCpuFrame(page)
  const exposure = page.getByRole('slider', { name: 'Exposure', exact: true })
  await exposure.focus()
  for (let step = 0; step < 10; step++) await exposure.press('PageUp')
  const processed = await nextCpuFrame(page, unedited)
  const showOriginal = stage(page).getByRole('button', {
    name: 'Original',
    exact: true,
  })
  const showProcessed = stage(page).getByRole('button', {
    name: 'Processed',
    exact: true,
  })
  await showOriginal.click()
  const neutral = await nextCpuFrame(page, processed)
  expect(neutral.meanLight).toBeLessThan(processed.meanLight - 4)
  await showProcessed.click()
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  await showOriginal.click()
  expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
  await showProcessed.click()
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  expect((await readTrace(page)).cpuRenders.at(-1)?.variant).toBe('processed')
})

/** A popover beside the rail: wide, anchored left of it, with its own scroll. */
async function readSidecar(page: Page, kind: 'contract' | 'source') {
  return page.evaluate((kind) => {
    const box = (element: Element | null | undefined) =>
      element?.getBoundingClientRect().toJSON() as DOMRect | undefined
    const dialog = document.querySelector<HTMLElement>(
      `[data-raw-lut-browser-dialog="${kind}"]`,
    )
    const list = document.querySelector<HTMLElement>(
      `[data-raw-lut="${kind}-browser-list"]`,
    )
    return {
      dialog: box(dialog),
      list: box(list),
      entry: box(list?.querySelector('[data-raw-lut="catalog-entry"]')),
      listOverflowY: list ? getComputedStyle(list).overflowY : '',
      listAlignContent: list ? getComputedStyle(list).alignContent : '',
      placement: dialog?.getAttribute('data-lut-source-placement'),
      rail: box(document.querySelector('.raw-tool-surface')),
    }
  }, kind)
}

test('closes the online LUT resource browser when its trigger is clicked again', async ({
  page,
}) => {
  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/valid.cube')}`,
  )
  const trigger = page.getByRole('button', { name: 'Open valid.cube' })
  const browser = page.getByRole('dialog', { name: 'valid.cube LUTs' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(browser).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await trigger.click()
  await expect(browser).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  // A rapid repeated click leaves it closed as well.
  await trigger.dblclick()
  await expect(browser).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('closes the LUT contract browser on a second click and keeps its options inside its scroll frame', async ({
  page,
}, testInfo) => {
  const cubePath = testInfo.outputPath('unknown-contract.cube')
  await writeFile(cubePath, createCube('Unknown Contract'), 'utf8')
  await page.goto('/raw')
  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)

  const trigger = page.getByRole('button', { name: 'Change LUT contract' })
  const browser = page.getByRole('dialog', { name: 'LUT contract browser' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(browser).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  const metrics = await readSidecar(page, 'contract')
  expect(metrics.placement).toBe('sidecar')
  expect(metrics.dialog!.width).toBeGreaterThanOrEqual(500)
  expect(metrics.dialog!.right).toBeLessThanOrEqual(metrics.rail!.left - 8)
  expect(metrics.listOverflowY).toBe('auto')
  expect(metrics.list!.bottom).toBeLessThanOrEqual(metrics.dialog!.bottom + 1)

  await trigger.click()
  await expect(browser).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('keeps sparse online LUT resource entries compact on desktop', async ({
  page,
}) => {
  await serveAuditCatalog(page)
  await page.goto(`/raw?luts=${encodeURIComponent(AUDIT_CATALOG_URL)}`)
  await page
    .getByRole('button', { name: 'Open Catalog from example.com' })
    .click()
  const browser = page.getByRole('dialog', {
    name: 'Catalog from example.com LUTs',
  })
  await expect(browser).toBeVisible()

  const metrics = await readSidecar(page, 'source')
  expect(metrics.entry).toBeTruthy()
  expect(metrics.placement).toBe('sidecar')
  expect(metrics.dialog!.width).toBeGreaterThanOrEqual(500)
  expect(metrics.dialog!.right).toBeLessThanOrEqual(metrics.rail!.left - 8)
  expect(['start', 'flex-start']).toContain(metrics.listAlignContent)
  expect(metrics.dialog!.height).toBeLessThanOrEqual(280)
  expect(metrics.entry!.height).toBeLessThanOrEqual(56)

  // Loading the entry applies its declared contract.
  await browser
    .getByRole('button', { name: 'Load Audit Rec.709 Print' })
    .click()
  await expect(browser).toHaveCount(0)
  await expect(page.getByText('LUT input:')).toBeVisible()
  await expect(page.getByText('Sony S-Gamut3.Cine / S-Log3')).toBeVisible()
  await expect(page.getByText('LUT output:')).toBeVisible()
  await expect(page.getByText('Rec.709 display')).toBeVisible()
  await expect(page.getByText('LUT intent is unsupported')).toHaveCount(0)
})
