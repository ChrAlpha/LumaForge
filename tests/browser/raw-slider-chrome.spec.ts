/**
 * Browser validation for the /raw slider chrome contract:
 *   • Directional gradient tracks (HSL three axes, Temperature, Tint)
 *   • Bipolar Range overlay (LrC-style "offset from neutral")
 *   • Cool-lift HSL axis tabs (segmented-chrome family) — desktop only
 *   • Mobile parity: Color / HSL list panels carry the same gradient
 *     tracks and bipolar overlay on iOS WebKit.
 *   • Dirty data-attribute hook on tool rows
 *
 * The HSL smoke spec exercises the end-to-end data path through the same
 * components. This spec narrowly asserts the visual contract introduced
 * by the slider-tracks helper + Slider primitive upgrade, so a future
 * refactor that drops the gradient or the bipolar overlay fails CI on
 * both surfaces.
 */

import { existsSync } from 'node:fs'
import process from 'node:process'

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const RAW_FIXTURE =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

async function loadRawFixtureDesktop(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

async function loadRawFixtureMobile(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /browse raw files/i }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

async function dragSlider(
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

test('directional sliders carry gradient tracks and a bipolar Range overlay', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Slider chrome contract targets desktop Chromium only',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(180_000)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadRawFixtureDesktop(page, RAW_FIXTURE)

  // ----- Color tool: Temperature has a gradient track + bipolar overlay -----
  const colorRegion = page.getByRole('region', { name: 'Color' }).first()
  await colorRegion.scrollIntoViewIfNeeded()
  await expect(colorRegion).toBeVisible()
  const tempRow = colorRegion.locator('[data-color-field="userTemperature"]')
  await expect(tempRow).toBeVisible()

  // Drag temperature to a non-zero value so dirty + bipolar overlay light up.
  const tempSlider = tempRow.getByRole('slider')
  await dragSlider(page, tempSlider, 0.18)
  await expect
    .poll(async () => Number(await tempSlider.getAttribute('aria-valuenow')))
    .not.toBe(0)
  await expect(tempRow).toHaveAttribute('data-dirty', '')

  // Track must carry a linear-gradient inline background (directional cue).
  const tempTrack = tempRow.locator('[data-slot="slider-track"]')
  await expect(tempTrack).toHaveAttribute('style', /linear-gradient/i)

  // Bipolar overlay must render as the data-bipolar slider-range slot.
  const tempBipolar = tempRow.locator(
    '[data-slot="slider-range"][data-bipolar]',
  )
  await expect(tempBipolar).toBeAttached()
  const tempOverlayWidth = await tempBipolar.evaluate(
    (el) => (el as HTMLElement).style.width,
  )
  expect(tempOverlayWidth).not.toBe('0%')

  // ----- HSL tool: axis tabs use the cool-lift idiom -----
  const hslRegion = page.getByRole('region', { name: 'HSL' }).first()
  await hslRegion.scrollIntoViewIfNeeded()
  const hueTab = hslRegion.getByRole('tab', { name: 'Hue' })
  await expect(hueTab).toHaveAttribute('aria-selected', 'true')
  // The selected axis tab paints itself with the cool near-white wash and an
  // inset top highlight — the segmented-chrome lift idiom.
  const hueTabClass = (await hueTab.getAttribute('class')) ?? ''
  expect(hueTabClass).toContain('bg-[oklch(0.96_0.006_255/0.10)]')
  expect(hueTabClass).toContain(
    'shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.14)]',
  )

  // ----- HSL: each band's Hue slider has a gradient track and bipolar overlay -----
  const redRow = hslRegion.locator('[data-hsl-band="red"]')
  const redTrack = redRow.locator('[data-slot="slider-track"]')
  await expect(redTrack).toHaveAttribute('style', /linear-gradient/i)
  await expect(
    redRow.locator('[data-slot="slider-range"][data-bipolar]'),
  ).toBeAttached()

  // Switching the active axis swaps the underlying gradient. Saturation
  // builds its gradient from `l 0 h` (gray) → band; lightness from
  // `0.30 c h` (dark band) → `0.88 c h` (light band). Both signatures
  // are stable identifiers we can grep for in the inline style.
  await hslRegion.getByRole('tab', { name: 'Saturation' }).click()
  await expect(redTrack).toHaveAttribute('style', /l 0 h/i)

  await hslRegion.getByRole('tab', { name: 'Lightness' }).click()
  await expect(redTrack).toHaveAttribute('style', /0\.30 c h/i)
  await expect(redTrack).toHaveAttribute('style', /0\.88 c h/i)
})

test('mobile Adjust list panels carry directional tracks and bipolar overlay', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'Mobile slider chrome contract targets iOS WebKit only',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(180_000)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  await loadRawFixtureMobile(page, RAW_FIXTURE)

  // Open the Adjust dock — same code-path as a thumb-tap on the bottom rail.
  await page.getByRole('tab', { name: 'Adjust' }).click()
  const dockPanel = page.locator('[data-mobile-dock-panel]')
  await expect(dockPanel).toBeVisible()

  // ----- Color list: Temperature row carries a directional gradient track -----
  await dockPanel.getByRole('tab', { name: 'Color' }).click()
  const colorSection = dockPanel.locator('[data-adjust-list-section="color"]')
  await expect(colorSection).toBeVisible()
  const tempSlider = colorSection.getByRole('slider', { name: 'Temperature' })
  await expect(tempSlider).toBeVisible()
  await dragSlider(page, tempSlider, 0.22)
  await expect
    .poll(async () => Number(await tempSlider.getAttribute('aria-valuenow')))
    .not.toBe(0)

  const tempRoot = tempSlider.locator(
    'xpath=ancestor::*[@data-slot="slider-root"][1]',
  )
  await expect(tempRoot.locator('[data-slot="slider-track"]')).toHaveAttribute(
    'style',
    /linear-gradient/i,
  )
  const tempBipolar = tempRoot.locator(
    '[data-slot="slider-range"][data-bipolar]',
  )
  await expect(tempBipolar).toBeAttached()
  const tempBipolarWidth = await tempBipolar.evaluate(
    (el) => (el as HTMLElement).style.width,
  )
  expect(tempBipolarWidth).not.toBe('0%')

  // Tint row also has a directional gradient (the magenta/green pair).
  const tintSlider = colorSection.getByRole('slider', { name: 'Tint' })
  const tintRoot = tintSlider.locator(
    'xpath=ancestor::*[@data-slot="slider-root"][1]',
  )
  await expect(tintRoot.locator('[data-slot="slider-track"]')).toHaveAttribute(
    'style',
    /linear-gradient/i,
  )

  // ----- HSL list: expand the red band, assert each axis row has a gradient -----
  await dockPanel.getByRole('tab', { name: 'HSL' }).click()
  const hslSection = dockPanel.locator('[data-adjust-list-section="hsl"]')
  await expect(hslSection).toBeVisible()

  const redRow = hslSection.locator('[data-hsl-band-row="red"]')
  await redRow.getByRole('button').first().click()
  // JSX `data-open={isOpen || undefined}` serializes the boolean as "true".
  await expect(redRow).toHaveAttribute('data-open', 'true')

  // After expansion the row reveals Hue / Saturation / Lightness sliders.
  // Each must carry a non-empty gradient track and a bipolar overlay slot.
  for (const axisLabel of ['Hue', 'Saturation', 'Lightness'] as const) {
    const slider = redRow.getByRole('slider', { name: axisLabel })
    await expect(slider).toBeVisible()
    const root = slider.locator(
      'xpath=ancestor::*[@data-slot="slider-root"][1]',
    )
    await expect(root.locator('[data-slot="slider-track"]')).toHaveAttribute(
      'style',
      /linear-gradient/i,
    )
    await expect(
      root.locator('[data-slot="slider-range"][data-bipolar]'),
    ).toBeAttached()
  }

  // Saturation axis track must contain the `l 0 h` (forced-gray) endpoint;
  // lightness axis track must contain both `0.30 c h` and `0.88 c h`.
  const satTrack = redRow
    .getByRole('slider', { name: 'Saturation' })
    .locator('xpath=ancestor::*[@data-slot="slider-root"][1]')
    .locator('[data-slot="slider-track"]')
  await expect(satTrack).toHaveAttribute('style', /l 0 h/i)

  const lightTrack = redRow
    .getByRole('slider', { name: 'Lightness' })
    .locator('xpath=ancestor::*[@data-slot="slider-root"][1]')
    .locator('[data-slot="slider-track"]')
  await expect(lightTrack).toHaveAttribute('style', /0\.30 c h/i)
  await expect(lightTrack).toHaveAttribute('style', /0\.88 c h/i)

  // ----- Section chrome stays pinned when the slider list overscrolls -----
  // The Adjust panel runs an internal flex-column layout: the chrome is a
  // non-scrolling header above an independent `[data-adjust-list-scroll]`
  // region that owns slider-list overflow. Scrolling that region must NOT
  // move the chrome. With the HSL Red band expanded the list overflows
  // (8 collapsed + 3 expanded axis rows > 360px dock max).
  const sectionChrome = dockPanel.locator('[data-adjust-section-chrome]')
  const chromeTopBefore = await sectionChrome.evaluate(
    (el) => el.getBoundingClientRect().top,
  )

  const scrollContainer = dockPanel.locator('[data-adjust-list-scroll]')
  await scrollContainer.evaluate((el) => el.scrollBy({ top: 160 }))
  await page.waitForTimeout(120)

  const chromeTopAfter = await sectionChrome.evaluate(
    (el) => el.getBoundingClientRect().top,
  )
  // Chrome lives outside the scroll region, so its viewport position is
  // invariant to inner scroll. Without the flex-column split it would
  // shift by ~160px upward as the dock itself scrolled.
  expect(Math.abs(chromeTopAfter - chromeTopBefore)).toBeLessThanOrEqual(4)
})
