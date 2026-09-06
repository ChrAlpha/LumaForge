import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const RAW_FIXTURE = '/workspaces/LumaForge/test-images/SGL_1998.NEF'

function createIdentityCube(title: string) {
  return [
    `TITLE "${title}"`,
    'LUT_3D_SIZE 2',
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '1 1 0',
    '0 0 1',
    '1 0 1',
    '0 1 1',
    '1 1 1',
  ].join('\n')
}

async function loadRawFixture(page: Page) {
  const isMobileViewport = await page.evaluate(() => window.innerWidth <= 640)
  const trigger = isMobileViewport
    ? page.getByRole('button', { name: /browse raw files/i })
    : page.getByRole('button', { name: /finish a raw with a lut/i })

  await expect(trigger).toBeVisible()
  const fileChooserPromise = page.waitForEvent('filechooser')
  if (isMobileViewport) {
    await trigger.click()
  } else {
    await trigger.click({ position: { x: 24, y: 24 } })
  }
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(RAW_FIXTURE)
}

async function dragSlider(page: Page, sliderName: string, targetRatio: number) {
  const slider = page.getByRole('slider', { name: sliderName })
  await expect(slider).toBeVisible()
  const box = await slider.boundingBox()

  expect(box).toBeTruthy()

  const before = Number(await slider.getAttribute('aria-valuenow'))

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  if (sliderName === 'Compare unprocessed RAW and final JPEG') {
    const trackBox = await page
      .locator('[data-raw-compare-track="image"]')
      .boundingBox()
      .catch(() => null)
    const frameBox = await page
      .locator('[data-raw-preview-frame]')
      .boundingBox()
      .catch(() => null)
    const targetBox = trackBox ?? frameBox ?? box!

    await page.mouse.move(
      targetBox.x + targetBox.width * targetRatio,
      box!.y + box!.height / 2,
      { steps: 10 },
    )
  } else {
    await page.mouse.move(
      box!.x + box!.width * targetRatio,
      box!.y + box!.height / 2,
      { steps: 10 },
    )
  }
  await page.mouse.up()

  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .not.toBe(before)

  return {
    before,
    after: Number(await slider.getAttribute('aria-valuenow')),
  }
}

async function readCompareHandleCenterX(page: Page) {
  const slider = page.getByRole('slider', {
    name: 'Compare unprocessed RAW and final JPEG',
  })
  const box = await slider.boundingBox()

  expect(box).toBeTruthy()

  return box!.x + box!.width / 2
}

async function readPreviewViewport(page: Page) {
  return page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(
      '[data-raw-compare-track="image"]',
    )

    if (!track) {
      return { zoom: 1, panX: 0, panY: 0 }
    }

    const style = getComputedStyle(track)

    return {
      zoom: Number.parseFloat(style.getPropertyValue('--raw-preview-zoom')),
      panX: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-x')),
      panY: Number.parseFloat(style.getPropertyValue('--raw-preview-pan-y')),
    }
  })
}

test('keeps RAW Lab tool scrolling inside the viewport shell', async ({
  page,
}) => {
  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  const metrics = await page.evaluate(() => {
    const documentRoot = document.documentElement
    const rawShell = document.querySelector<HTMLElement>(
      '[data-raw-lab-shell="viewport"]',
    )
    const toolStack = document.querySelector<HTMLElement>('.raw-tool-stack')
    const mobileRail =
      document.querySelector<HTMLElement>('[data-mobile-dock]') ??
      document.querySelector<HTMLElement>(
        '[data-mobile-lab-chrome] [role="tablist"]',
      ) ??
      document.querySelector<HTMLElement>('.raw-mobile-tool-rail')
    const mobileRailTablist = mobileRail?.matches('[role="tablist"]')
      ? mobileRail
      : mobileRail?.querySelector<HTMLElement>('[role="tablist"]')
    const mobileSheet = document.querySelector<HTMLElement>(
      '.raw-mobile-tool-sheet',
    )

    return {
      documentScrollOverflow:
        documentRoot.scrollHeight - documentRoot.clientHeight,
      rawShellHeight: rawShell?.getBoundingClientRect().height ?? 0,
      rawShellScrollOverflow: rawShell
        ? rawShell.scrollHeight - rawShell.clientHeight
        : 0,
      toolStackScrollOverflow: toolStack
        ? toolStack.scrollHeight - toolStack.clientHeight
        : 0,
      toolStackOverflowY: toolStack
        ? getComputedStyle(toolStack).overflowY
        : '',
      isMobile: window.innerWidth <= 640,
      mobileRailVisible: mobileRail
        ? getComputedStyle(mobileRail).display !== 'none'
        : false,
      mobileRailBottomGap: mobileRailTablist
        ? window.innerHeight - mobileRailTablist.getBoundingClientRect().bottom
        : null,
      mobileSheetClosed: mobileSheet
        ? mobileSheet.hidden || getComputedStyle(mobileSheet).display === 'none'
        : true,
      viewportHeight: window.innerHeight,
    }
  })

  expect(metrics.rawShellHeight).toBe(metrics.viewportHeight)
  expect(metrics.rawShellScrollOverflow).toBe(0)
  expect(metrics.documentScrollOverflow).toBe(0)

  if (metrics.isMobile) {
    expect(metrics.mobileRailVisible).toBe(true)
    expect(metrics.mobileRailBottomGap).not.toBeNull()
    expect(metrics.mobileRailBottomGap).toBeLessThanOrEqual(10)
    expect(metrics.mobileSheetClosed).toBe(true)
  } else if (metrics.toolStackOverflowY === 'auto') {
    expect(metrics.toolStackScrollOverflow).toBeGreaterThan(0)
  }
})

test('keeps the loaded mobile export panel clear of the toolbar', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'mobile export dock regression',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page)

  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })

  const exportTab = page.getByRole('tab', { name: /^export$/i })
  await expect(exportTab).toBeVisible()
  await exportTab.click()

  await expect(
    page.getByRole('button', {
      name: /export full-resolution jpeg/i,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: /hq preview jpeg/i,
    }),
  ).toBeVisible()

  // The dock panel enters on a spring (DOCK_SPRING). Sampling mid-flight
  // reports the panel a fraction of a pixel below the toolbar, which is not
  // what this test is about; wait for the transform to settle first.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(
          '[data-mobile-dock] > *',
        )
        return panel ? getComputedStyle(panel).transform : 'missing'
      }),
    )
    .toBe('none')

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
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop preview dock regression',
  )

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
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop export action lane regression',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page)

  const exportButton = page
    .getByRole('region', { name: 'Export' })
    .first()
    .getByRole('button', { name: /export full-resolution jpeg/i })
    .first()
  await expect(exportButton).toBeEnabled({ timeout: 60_000 })

  const cubePath = testInfo.outputPath('toast-lane.cube')
  await writeFile(cubePath, createIdentityCube('Toast Lane'), 'utf8')
  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()

  const metrics = await page.evaluate(() => {
    const button = document
      .querySelector('[data-raw-export-block="persistent"] button')
      ?.getBoundingClientRect()
    const toast = document
      .querySelector('[data-sonner-toast]')
      ?.getBoundingClientRect()

    return {
      button: button?.toJSON(),
      toast: toast?.toJSON(),
    }
  })

  expect(metrics.button).toBeTruthy()
  expect(metrics.toast).toBeTruthy()
  expect(metrics.toast!.right).toBeLessThanOrEqual(metrics.button!.left)
})

test('keeps desktop tone, compare, zoom, and pan interactions live after RAW load', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop RAW interaction regression',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)

  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  await loadRawFixture(page)

  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible()

  const exposure = await dragSlider(page, 'Exposure', 0.75)
  expect(exposure.after).toBeGreaterThan(exposure.before)

  const compare = await dragSlider(
    page,
    'Compare unprocessed RAW and final JPEG',
    1,
  )
  expect(compare.after).toBeGreaterThan(compare.before)
  const compareHandleCenterBeforeZoom = await readCompareHandleCenterX(page)

  const previewFrame = page.locator('[data-raw-preview-frame]')
  const previewBox = await previewFrame.boundingBox()

  expect(previewBox).toBeTruthy()

  await page.mouse.move(
    previewBox!.x + previewBox!.width * 0.33,
    previewBox!.y + previewBox!.height * 0.44,
  )
  await page.mouse.wheel(0, -1200)

  await expect
    .poll(async () => (await readPreviewViewport(page)).zoom)
    .toBeGreaterThan(1)
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(
    compareHandleCenterBeforeZoom,
    0,
  )

  const scaledBounds = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(
      '[data-raw-preview-frame]',
    )
    const track = document.querySelector<HTMLElement>(
      '[data-raw-compare-track="image"]',
    )
    const surface = document.querySelector<HTMLElement>(
      '[data-raw-preview-surface]',
    )

    const frameRect = frame?.getBoundingClientRect()
    const surfaceRect = surface?.getBoundingClientRect()

    return {
      frame: frameRect?.toJSON(),
      surface: surfaceRect?.toJSON(),
      surfaceLayoutWidth: surface?.offsetWidth ?? track?.offsetWidth ?? 0,
      surfaceLayoutHeight: surface?.offsetHeight ?? track?.offsetHeight ?? 0,
      frameOverflow: frame ? getComputedStyle(frame).overflow : '',
    }
  })

  expect(scaledBounds.frame).toBeTruthy()
  expect(scaledBounds.surface).toBeTruthy()
  expect(scaledBounds.frameOverflow).toBe('hidden')
  expect(scaledBounds.surface!.width).toBeGreaterThan(
    scaledBounds.surfaceLayoutWidth,
  )
  expect(scaledBounds.surface!.height).toBeGreaterThan(
    scaledBounds.surfaceLayoutHeight,
  )

  const panBefore = await readPreviewViewport(page)

  await page.mouse.down()
  await page.mouse.move(
    previewBox!.x + previewBox!.width * 0.5,
    previewBox!.y + previewBox!.height * 0.6,
    { steps: 12 },
  )
  await page.mouse.up()

  await expect
    .poll(async () => {
      const next = await readPreviewViewport(page)

      return (
        Math.abs(next.panX - panBefore.panX) +
        Math.abs(next.panY - panBefore.panY)
      )
    })
    .toBeGreaterThan(0)
  expect(await readCompareHandleCenterX(page)).toBeCloseTo(
    compareHandleCenterBeforeZoom,
    0,
  )
})
