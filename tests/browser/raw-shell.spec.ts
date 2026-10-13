import { writeFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createCube } from './support/files'
import { gateRawFixture, RAW_FIXTURE } from './support/fixtures'
import {
  chooseRaw,
  deck,
  exportAction,
  isChromium,
  loadedLab,
} from './support/lab'

// The /raw shell as a fixed frame: what stays in the viewport, what scrolls,
// and where notices and toasts land around the photo. The tests that load no
// RAW are the RAW Lab smoke CI runs by name.

test('keeps RAW Lab tool scrolling inside the viewport shell', async ({
  page,
}) => {
  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  const metrics = await page.evaluate(() => {
    const documentRoot = document.documentElement
    const rawShell = document.querySelector<HTMLElement>(
      '[data-raw-lab-shell="viewport"]',
    )!
    const rail = document.querySelector<HTMLElement>('.raw-tool-surface')
    const railScroll = document.querySelector<HTMLElement>(
      '[data-raw-tool-scroll]',
    )
    // The empty mobile lab has no dock: its one action is pinned in the
    // thumb zone instead.
    const mobileCta = document.querySelector<HTMLElement>(
      '[data-mobile-empty-cta]',
    )
    // Only the rail's inner region scrolls. Scrolling every frame as far as
    // it goes, the way a browser bringing a control into view would, moves
    // nothing but that region.
    railScroll?.scrollTo({ top: railScroll.scrollHeight })
    for (const frame of [documentRoot, rawShell, rail]) {
      if (frame) frame.scrollTop = frame.scrollHeight
    }
    return {
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      isMobile: window.innerWidth <= 640,
      documentScrollOverflow:
        documentRoot.scrollHeight - documentRoot.clientHeight,
      documentScrollTop: documentRoot.scrollTop,
      rawShellHeight: rawShell.getBoundingClientRect().height,
      rawShellScrollTop: rawShell.scrollTop,
      railOverflowY: rail ? getComputedStyle(rail).overflowY : null,
      railBottom: rail?.getBoundingClientRect().bottom ?? null,
      railScrollTop: rail?.scrollTop ?? null,
      railScrollOverflowY: railScroll
        ? getComputedStyle(railScroll).overflowY
        : null,
      railScrollBottom: railScroll?.getBoundingClientRect().bottom ?? null,
      railScrollOverflow: railScroll
        ? railScroll.scrollHeight - railScroll.clientHeight
        : null,
      railScrollTopAfter: railScroll?.scrollTop ?? null,
      mobileDockPresent: Boolean(document.querySelector('[data-mobile-dock]')),
      mobileCtaVisible: mobileCta
        ? getComputedStyle(mobileCta).display !== 'none'
        : false,
      mobileCtaBottomGap: mobileCta
        ? window.innerHeight - mobileCta.getBoundingClientRect().bottom
        : null,
      mobileCtaWidth: mobileCta?.getBoundingClientRect().width ?? 0,
    }
  })

  expect(metrics.rawShellHeight).toBe(metrics.viewportHeight)
  expect(metrics.documentScrollOverflow).toBe(0)
  expect(metrics.documentScrollTop).toBe(0)
  expect(metrics.rawShellScrollTop).toBe(0)

  if (metrics.isMobile) {
    expect(metrics.mobileDockPresent).toBe(false)
    expect(metrics.mobileCtaVisible).toBe(true)
    // 16px plus the bottom safe area, full width less 12px a side.
    expect(metrics.mobileCtaBottomGap).not.toBeNull()
    expect(metrics.mobileCtaBottomGap).toBeGreaterThanOrEqual(16)
    expect(metrics.mobileCtaBottomGap).toBeLessThanOrEqual(64)
    expect(metrics.mobileCtaWidth).toBeGreaterThanOrEqual(
      metrics.viewportWidth - 24 - 1,
    )
    return
  }
  // The rail is a fixed frame inside the viewport that clips, so nothing can
  // scroll it; its inner region owns the scrolling and ends on screen.
  expect(metrics.railOverflowY).toBe('clip')
  expect(metrics.railScrollTop).toBe(0)
  expect(metrics.railBottom).toBeLessThanOrEqual(metrics.viewportHeight)
  expect(metrics.railScrollOverflowY).toBe('auto')
  expect(metrics.railScrollBottom).toBeLessThanOrEqual(metrics.viewportHeight)
  if (metrics.railScrollOverflow! > 0) {
    expect(metrics.railScrollTopAfter).toBeGreaterThan(0)
  }
})

test('keeps the CPU preview notice visible without taking the stage', async ({
  page,
}) => {
  await page.goto('/raw?forcePreview=cpu')
  const banner = page.locator('[data-cpu-preview-banner]')
  await expect(banner).toBeVisible()

  const layout = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom } : null
    }
    const root = document.querySelector<HTMLElement>(
      '[data-raw-lab-shell="viewport"]',
    )!
    return {
      isMobile: window.innerWidth <= 640,
      viewportHeight: window.innerHeight,
      rootScrollOverflow: root.scrollHeight - root.clientHeight,
      banner: box('[data-cpu-preview-banner]')!,
      stageTools: box('[data-raw-lab-layout="stage-tools"]')!,
      topbar: box('[data-mobile-topbar]'),
    }
  })

  expect(layout.rootScrollOverflow).toBe(0)
  if (layout.isMobile) {
    // The stage keeps the full viewport; the notice floats below the topbar.
    expect(layout.stageTools.top).toBe(0)
    expect(layout.stageTools.bottom).toBe(layout.viewportHeight)
    expect(layout.banner.top).toBeGreaterThanOrEqual(layout.topbar!.bottom)
  } else {
    // The notice sits in flow above the stage instead of underneath it.
    expect(layout.banner.bottom).toBeLessThanOrEqual(layout.stageTools.top)
  }

  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(banner).toHaveCount(0)
})

test('keeps the loaded mobile export panel clear of the toolbar', async ({
  page,
}, testInfo) => {
  test.skip(isChromium(testInfo), 'The mobile export deck runs on WebKit')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)

  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 120_000 })

  // Export opens from the topbar action into the deck above the tab bar.
  await expect(exportAction(page)).toBeEnabled({ timeout: 120_000 })
  await exportAction(page).click()
  await expect(exportAction(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-mobile-export-panel]')).toBeVisible()
  await expect(
    page.getByRole('button', { name: /export full-resolution jpeg/i }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /hq preview jpeg/i }),
  ).toBeVisible()

  // The dock panel enters on a spring (DOCK_SPRING) and its height moves on
  // a 240ms curve as the layout hands it the export panel's height, so the
  // first frames can still clip the content. A clip that persists fails
  // these polls; a settling one does not.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(
          '[data-mobile-dock] > *',
        )
        if (!panel) return 'missing'
        const moving = panel
          .getAnimations()
          .some((animation) => animation.playState === 'running')
        return moving ? 'moving' : getComputedStyle(panel).transform
      }),
    )
    .toBe('none')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(
          '[data-mobile-dock] > *',
        )
        return panel ? panel.scrollHeight - panel.clientHeight : null
      }),
    )
    .toBeLessThanOrEqual(1)

  const metrics = await page.evaluate(() => {
    const documentRoot = document.documentElement
    const dock = document.querySelector<HTMLElement>('[data-mobile-dock]')
    const panel = dock?.firstElementChild as HTMLElement | null
    const panelContent = panel?.firstElementChild as HTMLElement | null
    const tablist = dock?.querySelector<HTMLElement>('[role="tablist"]')
    const panelRect = panel?.getBoundingClientRect()
    const contentRect = panelContent?.getBoundingClientRect()
    const tablistRect = tablist?.getBoundingClientRect()
    return {
      documentScrollOverflow:
        documentRoot.scrollHeight - documentRoot.clientHeight,
      dockBottomGap: dock
        ? window.innerHeight - dock.getBoundingClientRect().bottom
        : null,
      panelScrollOverflow: panel
        ? panel.scrollHeight - panel.clientHeight
        : null,
      contentToToolbarGap:
        contentRect && tablistRect
          ? tablistRect.top - contentRect.bottom
          : null,
      panelBottomToToolbarGap:
        panelRect && tablistRect ? tablistRect.top - panelRect.bottom : null,
    }
  })

  expect(metrics.documentScrollOverflow).toBe(0)
  expect(metrics.dockBottomGap).not.toBeNull()
  expect(metrics.dockBottomGap).toBeLessThanOrEqual(10)
  expect(metrics.panelScrollOverflow).not.toBeNull()
  expect(metrics.panelScrollOverflow).toBeLessThanOrEqual(1)
  expect(metrics.contentToToolbarGap).not.toBeNull()
  expect(metrics.contentToToolbarGap).toBeGreaterThanOrEqual(8)
  expect(metrics.panelBottomToToolbarGap).toBe(0)
})

test('opens the RAW picker from the empty desktop preview dock', async ({
  page,
}, testInfo) => {
  test.skip(!isChromium(testInfo), 'The desktop preview dock runs on Chromium')

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
  const uploadDock = page.getByRole('button', {
    name: /Finish a RAW with a LUT/,
  })
  await expect(uploadDock).toBeVisible()
  await expect(
    page.getByRole('slider', {
      name: 'Compare unprocessed RAW and final JPEG',
    }),
  ).toBeVisible()

  const fileChooserPromise = page.waitForEvent('filechooser')
  await uploadDock.click({ timeout: 3_000 })
  const fileChooser = await fileChooserPromise
  expect(fileChooser.isMultiple()).toBe(false)
})

test('keeps desktop RAW load toasts out of the persistent export action lane', async ({
  page,
}, testInfo) => {
  test.skip(!isChromium(testInfo), 'The desktop export lane runs on Chromium')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)

  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(
    page
      .locator('[data-raw-export-block="persistent"]')
      .getByRole('button', { name: /export full-resolution jpeg/i }),
  ).toBeEnabled({ timeout: 60_000 })

  const cubePath = testInfo.outputPath('toast-lane.cube')
  await writeFile(cubePath, createCube('Toast Lane'), 'utf8')
  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

  const metrics = await page.evaluate(() => ({
    button: document
      .querySelector('[data-raw-export-block="persistent"] button')
      ?.getBoundingClientRect()
      .toJSON(),
    toast: document
      .querySelector('[data-sonner-toast]')
      ?.getBoundingClientRect()
      .toJSON(),
  }))
  expect(metrics.button).toBeTruthy()
  expect(metrics.toast).toBeTruthy()
  expect(metrics.toast!.right).toBeLessThanOrEqual(metrics.button!.left)
})

test('keeps mobile /raw toasts below the topbar and its Export action', async ({
  page,
}, testInfo) => {
  test.skip(isChromium(testInfo), 'The mobile toast lane runs on WebKit')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(180_000)

  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })

  // The Look strip's Import .cube input: loading a LUT announces itself.
  const cubePath = testInfo.outputPath('mobile-toast-lane.cube')
  await writeFile(cubePath, createCube('Mobile Toast Lane'), 'utf8')
  await page.locator('[data-mobile-lut-import-input]').setInputFiles(cubePath)
  const toast = page.locator('[data-sonner-toast]').first()
  await expect(toast).toBeVisible()

  // A toast slides in from a full toast height above its slot. Mid-flight
  // its box crosses the topbar, but the toaster clips everything above the
  // topbar's bottom edge, so what shows (and takes taps) stays below it.
  const clip = await page.evaluate(() => {
    const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]')
    const topbar = document.querySelector('[data-mobile-topbar]')
    if (!toaster || !topbar) return null
    return {
      clipPath: getComputedStyle(toaster).clipPath,
      toasterTop: toaster.getBoundingClientRect().top,
      topbarBottom: topbar.getBoundingClientRect().bottom,
    }
  })
  expect(clip).toBeTruthy()
  // The clip opens 8px above the toaster's top edge: the topbar's bottom.
  expect(clip!.clipPath).toMatch(/^inset\(-8px /)
  expect(clip!.toasterTop - 8).toBeGreaterThanOrEqual(clip!.topbarBottom - 1)

  // At rest the toast's own slot is below the topbar and its Export action.
  await expect
    .poll(() =>
      toast.evaluate((element) => {
        const { transform } = getComputedStyle(element)
        return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)'
      }),
    )
    .toBe(true)
  const metrics = await page.evaluate(() => ({
    topbar: document
      .querySelector('[data-mobile-topbar]')
      ?.getBoundingClientRect()
      .toJSON(),
    exportAction: document
      .querySelector('[data-mobile-export-action]')
      ?.getBoundingClientRect()
      .toJSON(),
    toast: document
      .querySelector('[data-sonner-toast]')
      ?.getBoundingClientRect()
      .toJSON(),
  }))
  expect(metrics.topbar).toBeTruthy()
  expect(metrics.exportAction).toBeTruthy()
  expect(metrics.toast).toBeTruthy()
  expect(metrics.toast!.top).toBeGreaterThanOrEqual(metrics.topbar!.bottom)
  expect(metrics.toast!.top).toBeGreaterThanOrEqual(
    metrics.exportAction!.bottom,
  )
})

test('keeps the mobile photo clear of the chrome and returns it in immersive', async ({
  browser,
}, testInfo) => {
  // A touch phone context on the WebGPU browser measures the GPU stage.
  test.skip(!isChromium(testInfo), 'The GPU stage needs a WebGPU adapter')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(300_000)

  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const page = await context.newPage()
    await page.goto('/raw')
    await chooseRaw(page, rawPath)
    await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
      timeout: 120_000,
    })

    const readGeometry = async () =>
      page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect()
        const topbar = box('[data-mobile-topbar]')
        const dockPanel = box('[data-mobile-dock-panel]')
        const photo = box('[data-raw-compare-track="image"]')
        return {
          topbarBottom: topbar ? Math.round(topbar.bottom) : null,
          dockTop: dockPanel ? Math.round(dockPanel.top) : null,
          photoTop: photo ? Math.round(photo.top) : null,
          photoBottom: photo ? Math.round(photo.bottom) : null,
          photoWidth: photo ? Math.round(photo.width) : null,
        }
      })

    await page.getByRole('tab', { name: 'Adjust' }).click()
    await expect(deck(page)).toBeVisible()
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
      const style = getComputedStyle(
        document.querySelector('[data-raw-lab-shell]')!,
      )
      return {
        top: style.getPropertyValue('--raw-stage-inset-top').trim(),
        bottom: style.getPropertyValue('--raw-stage-inset-bottom').trim(),
      }
    })
    expect(insets).toEqual({ top: '0px', bottom: '0px' })
  } finally {
    await context.close()
  }
})
