/**
 * Browser contract for the /raw Adjust scrub gesture and the compare
 * geometry that follows the photograph.
 *
 * The pointer model itself is unit-tested exhaustively in
 * `slider-scrub-model.test.ts` and `useSliderScrub.test.tsx`. This spec pins
 * the parts only a real browser can prove:
 *
 *   • pressing anywhere on an Adjust row grabs the value (no thumb hunting),
 *     and the row reports `data-scrubbing` for the duration;
 *   • Shift drags at one tenth speed on desktop;
 *   • the mobile stage keeps the photograph between the topbar and the dock,
 *     and hands the full bleed back in immersive;
 *   • the compare split line and its labels hug the letterboxed photo box
 *     instead of running through the mat.
 */

import { existsSync } from 'node:fs'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const RAW_FIXTURE =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

/**
 * The stage keeps a blocking progress overlay up through decode and the
 * bounded HQ preview. Interacting before it lifts presses on the overlay, not
 * on the control underneath.
 */
async function waitForStageReady(page: Page) {
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  await page.waitForTimeout(400)
}

async function loadDesktop(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  await (await chooser).setFiles(RAW_FIXTURE)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

async function loadMobile(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /browse raw files/i }).click()
  await (await chooser).setFiles(RAW_FIXTURE)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

test('desktop: a press anywhere on an Adjust row grabs the value, Shift halves the speed', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Desktop scrub contract targets desktop Chromium only',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(300_000)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadDesktop(page)
  await waitForStageReady(page)

  const row = page.locator('[data-tone-field="userExposureEv"]')
  await row.scrollIntoViewIfNeeded()
  const slider = row.getByRole('slider')
  const track = await row.locator('[data-slot="slider-track"]').boundingBox()
  if (!track) throw new Error('exposure track has no box')
  const y = track.y + track.height / 2

  // Press well away from the thumb: the value must jump to the pointer.
  await page.mouse.move(track.x + track.width * 0.75, y)
  await page.mouse.down()
  // React serialises a boolean data attribute as the string "true".
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

  // The amber readout is the per-field reset on both surfaces.
  const reset = row.getByRole('button')
  await expect(reset).toHaveAttribute('aria-label', /reset exposure/i)
  await reset.click()
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBe(0)
})

test('mobile: the stage keeps the photo clear of the chrome and returns it in immersive', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'Stage inset contract targets iOS WebKit only',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(300_000)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadMobile(page)
  await waitForStageReady(page)

  const readGeometry = async () =>
    page.evaluate(() => {
      const topbar = document
        .querySelector('[data-mobile-topbar]')
        ?.getBoundingClientRect()
      const dockPanel = document
        .querySelector('[data-mobile-dock-panel]')
        ?.getBoundingClientRect()
      const photo = document
        .querySelector('[data-raw-compare-track="image"]')
        ?.getBoundingClientRect()
      return {
        topbarBottom: topbar ? Math.round(topbar.bottom) : null,
        dockTop: dockPanel ? Math.round(dockPanel.top) : null,
        photoTop: photo ? Math.round(photo.top) : null,
        photoBottom: photo ? Math.round(photo.bottom) : null,
        photoWidth: photo ? Math.round(photo.width) : null,
      }
    })

  await page.getByRole('tab', { name: 'Adjust' }).click()
  await expect(page.locator('[data-mobile-dock-panel]')).toBeVisible()
  await page.waitForTimeout(600)

  const open = await readGeometry()
  expect(open.photoTop).not.toBeNull()
  // The photograph is fully judged, not rendered behind the panel.
  expect(open.photoTop!).toBeGreaterThanOrEqual(open.topbarBottom! - 1)
  expect(open.photoBottom!).toBeLessThanOrEqual(open.dockTop! + 1)

  // Collapsing the dock hands the space back.
  await page.getByRole('tab', { name: 'Adjust' }).click()
  await page.waitForTimeout(600)
  const collapsed = await readGeometry()
  expect(collapsed.photoWidth!).toBeGreaterThanOrEqual(open.photoWidth!)

  // Immersive drops both insets to zero for a true full-bleed stage.
  const frame = await page.locator('[data-raw-preview-frame]').boundingBox()
  if (!frame) throw new Error('preview frame has no box')
  await page.touchscreen.tap(
    frame.x + frame.width / 2,
    frame.y + frame.height / 2,
  )
  await page.waitForTimeout(900)
  const insets = await page.evaluate(() => {
    const shell = document.querySelector('[data-raw-lab-shell]')!
    const style = getComputedStyle(shell)
    return {
      top: style.getPropertyValue('--raw-stage-inset-top').trim(),
      bottom: style.getPropertyValue('--raw-stage-inset-bottom').trim(),
    }
  })
  expect(insets.top).toBe('0px')
  expect(insets.bottom).toBe('0px')
})

test('compare: the split line and its labels hug the photograph', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Compare geometry is asserted once, on desktop Chromium',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(300_000)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadDesktop(page)
  await waitForStageReady(page)

  const handle = page.locator('.raw-lab-compare-handle')
  await expect(handle).toBeVisible()

  // The preview upgrades from the quick decode to the bounded HQ frame after
  // load, which re-fits the photo and moves the handle with it. Wait for the
  // box to stop moving before measuring, or the press lands on bare stage.
  await expect
    .poll(
      async () => {
        const first = await handle.boundingBox()
        await page.waitForTimeout(250)
        const second = await handle.boundingBox()
        return first && second && Math.abs(first.x - second.x) < 1
          ? 'stable'
          : 'moving'
      },
      { timeout: 30_000 },
    )
    .toBe('stable')

  const geometry = await page.evaluate(() => {
    const el = document.querySelector('.raw-lab-compare-handle') as HTMLElement
    const line = getComputedStyle(el, '::before')
    const photo = document
      .querySelector('[data-raw-compare-track="image"]')!
      .getBoundingClientRect()
    const frame = document
      .querySelector('[data-raw-preview-frame]')!
      .getBoundingClientRect()
    const label = document
      .querySelector('.raw-lab-compare-label')!
      .getBoundingClientRect()
    return {
      lineHeight: Number.parseFloat(line.height),
      lineTop: Number.parseFloat(line.top),
      photoHeight: photo.height,
      photoTopInFrame: photo.top - frame.top,
      photoBottom: photo.bottom,
      labelBottom: label.bottom,
      frameHeight: frame.height,
    }
  })

  // The line spans the photo, not the frame.
  expect(Math.abs(geometry.lineHeight - geometry.photoHeight)).toBeLessThan(2)
  expect(Math.abs(geometry.lineTop - geometry.photoTopInFrame)).toBeLessThan(2)
  // The frame is at least as tall as the photo; when the aspect ratios match
  // exactly there is no mat, and the line simply spans both.
  expect(geometry.photoHeight).toBeLessThanOrEqual(geometry.frameHeight + 1)
  // The labels sit on the photograph rather than in the mat below it.
  expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.photoBottom + 1)

  // Dragging commits the accent on both viewports through one shared rule.
  const box = await handle.boundingBox()
  if (!box) throw new Error('compare handle has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, {
    steps: 8,
  })
  const dragging = await page.evaluate(() => {
    const knob = document.querySelector('.raw-lab-compare-handle span')!
    return {
      flagged: Boolean(document.querySelector('[data-raw-compare-dragging]')),
      transform: getComputedStyle(knob).transform,
    }
  })
  await page.mouse.up()
  expect(dragging.flagged).toBe(true)
  // The knob springs to 1.06 over 180ms; assert it left rest rather than
  // pinning the exact frame the probe caught.
  const scale = Number.parseFloat(
    dragging.transform.replace('matrix(', '').split(',')[0] ?? '1',
  )
  expect(scale).toBeGreaterThan(1.03)
})
