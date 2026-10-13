import { basename } from 'node:path'

import type { Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

import { BACKING_STORE_SETTLE_MS } from '../../../src/modules/raw-processor/hooks/preview/backing-store-resize'
import type { RawFile } from './fixtures'
import {
  installDeliveryStandIns,
  installPageTrace,
  RAW_RUNTIME_IDLE_MS,
} from './trace'

export const MOBILE_VIEWPORT = { width: 393, height: 852 }
export const DESKTOP_VIEWPORT = { width: 1440, height: 1000 }

/**
 * The Chromium project: a desktop browser with a software WebGPU adapter and
 * origin-private storage. Playwright's WebKit build has no WebGPU adapter
 * (Safari 26 does), so the WebKit project, an iPhone, runs the CPU preview.
 */
export function isChromium(testInfo: TestInfo) {
  return testInfo.project.name === 'chromium-desktop'
}

export function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 1280) <= 640
}

/** English copy, and the first-run lens hint already seen. */
export async function prepareLab(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
    localStorage.setItem('lumaforge.raw.mobile.lensHintSeen.v1', '1')
  })
}

/**
 * Opens a page of the app with the page trace installed. On the Chromium
 * project `surface` sets a phone or a desktop viewport; the WebKit project is
 * always the phone. `project` keeps the project's own viewport.
 * `deliveryStandIns` records shares and copies instead of making them.
 */
export async function openLab(
  page: Page,
  testInfo: TestInfo,
  {
    surface = 'project',
    path = '/raw',
    deliveryStandIns = false,
  }: {
    surface?: 'mobile' | 'desktop' | 'project'
    path?: string
    deliveryStandIns?: boolean
  } = {},
) {
  await prepareLab(page)
  await page.addInitScript(installPageTrace, {
    idleMs: RAW_RUNTIME_IDLE_MS,
    settleMs: BACKING_STORE_SETTLE_MS,
  })
  if (deliveryStandIns) await page.addInitScript(installDeliveryStandIns)
  if (isChromium(testInfo) && surface !== 'project') {
    await page.setViewportSize(
      surface === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    )
  }
  await page.goto(path)
  if (surface === 'mobile') expect(isMobile(page)).toBe(true)
  if (surface === 'desktop') expect(isMobile(page)).toBe(false)
}

export function uploadDock(page: Page) {
  return page.getByRole('button', { name: /finish a raw with a lut/i })
}

/** Picks a RAW from the empty lab: Browse on mobile, the upload dock on desktop. */
export async function chooseRaw(page: Page, file: string | RawFile) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Browse RAW files' }).click()
  } else {
    await uploadDock(page).click({ position: { x: 24, y: 24 } })
  }
  await (await choosing).setFiles(file)
}

/** Replaces the open RAW: More on mobile, the header action on desktop. */
export async function chooseReplacement(page: Page, file: RawFile) {
  const choosing = page.waitForEvent('filechooser')
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Replace RAW' }).click()
  } else {
    await page.locator('[data-raw-header-action="replace"]').click()
  }
  await (await choosing).setFiles(file)
}

export function loadedLab(page: Page) {
  return page.locator('.raw-lab[data-raw-lab-state="loaded"]')
}

export function emptyLab(page: Page) {
  return page.locator('.raw-lab[data-raw-lab-state="empty"]')
}

/**
 * The toast sits over the top of the photo, where the lens is. A pointer
 * left over it holds it open, so it moves away first.
 */
export async function moveAwayFromToasts(page: Page) {
  const viewport = page.viewportSize()!
  await page.mouse.move(viewport.width / 2, viewport.height - 4)
}

/** Ingest reports success only after the bounded HQ decode. */
export async function waitForLoaded(page: Page, name: string) {
  await expect(loadedLab(page)).toBeVisible({ timeout: 120_000 })
  const loaded = page.getByText(`Loaded ${name}`, { exact: true })
  await expect(loaded).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.raw-progress-overlay')).toHaveCount(0, {
    timeout: 120_000,
  })
  await moveAwayFromToasts(page)
  await expect(loaded).toBeHidden({ timeout: 30_000 })
}

/** Picks a RAW from the empty lab and waits until its load reports. */
export async function loadRaw(page: Page, file: string | RawFile) {
  await chooseRaw(page, file)
  await waitForLoaded(
    page,
    typeof file === 'string' ? basename(file) : file.name,
  )
}

export function stage(page: Page) {
  return page.getByRole('region', { name: 'RAW preview comparison' })
}

export function cpuCanvas(page: Page) {
  return stage(page).locator('canvas[aria-label="Embedded RAW preview"]')
}

export function gpuCanvas(page: Page) {
  return page.locator('canvas.raw-preview-canvas')
}

export function previewFrame(page: Page) {
  return page.locator('[data-raw-preview-frame]')
}

export function lens(page: Page) {
  return page.locator('[data-mobile-compare-lens]')
}

export function splitSlider(page: Page) {
  return page.getByRole('slider', {
    name: 'Compare unprocessed RAW and final JPEG',
  })
}

export function dockTabs(page: Page) {
  return page.getByRole('tablist', { name: 'Lab modes' }).getByRole('tab')
}

export function dockTab(page: Page, name: 'Look' | 'Adjust' | 'Transform') {
  return page
    .getByRole('tablist', { name: 'Lab modes' })
    .getByRole('tab', { name, exact: true })
}

export function deck(page: Page) {
  return page.locator('[data-mobile-dock-panel]')
}

export function exportAction(page: Page) {
  return page.getByRole('banner').locator('[data-mobile-export-action]')
}

/** Where the export actions and their reasons live on each surface. */
export function exportSurface(page: Page) {
  return isMobile(page)
    ? deck(page).locator('[data-mobile-export-panel]')
    : page.locator('[data-raw-export-block="persistent"]')
}

export function exportButton(page: Page, name: string) {
  return exportSurface(page).getByRole('button', { name, exact: true })
}

export function fullExportButton(page: Page) {
  return exportButton(page, 'Export full-resolution JPEG')
}

export function hqExportButton(page: Page) {
  return exportButton(page, 'Export HQ preview JPEG')
}

export function downloadButton(page: Page) {
  return exportButton(page, 'Download')
}

export function restoreButton(page: Page) {
  return page.getByRole('button', { name: 'Restore preview' })
}

export function lookStrip(page: Page) {
  return page.getByRole('group', { name: 'Looks' })
}

export function strengthSlider(page: Page) {
  return page
    .locator('[data-mobile-look-strength]')
    .getByRole('slider', { name: 'Strength' })
}

export function transformTool(page: Page) {
  return page.locator('[data-raw-transform-tool]')
}

export function transformOverlay(page: Page) {
  return page.locator('[data-raw-transform-preview]')
}

export function rotateSlider(page: Page) {
  return transformTool(page).getByRole('slider', {
    name: 'Rotate',
    exact: true,
  })
}

/**
 * Opens a tool: the topbar Export or a dock tab on mobile, a rail card on
 * desktop (where Export is always on screen). Opening the dock tool already
 * open would collapse it, so an open one is left as it is.
 */
export async function openTool(
  page: Page,
  name: 'Look' | 'Transform' | 'Adjust' | 'Export',
) {
  if (isMobile(page)) {
    if (name === 'Export') {
      if ((await exportAction(page).getAttribute('aria-expanded')) !== 'true') {
        await exportAction(page).click()
      }
      await expect(exportSurface(page)).toBeVisible()
      return
    }
    const tab = dockTab(page, name)
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    return
  }
  const transform = page.locator('[data-tool-card-trigger="transform"]')
  if (
    name !== 'Transform' &&
    (await transform.getAttribute('aria-expanded')) === 'true'
  ) {
    await transform.click()
    await expect(transformTool(page)).not.toBeVisible()
  }
  if (name === 'Export') return
  const trigger = page.locator(
    `[data-tool-card-trigger="${name.toLowerCase()}"]`,
  )
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click()
  }
}

/** Starts the full-resolution export and waits until its file is ready. */
export async function exportFullResolution(page: Page) {
  await openTool(page, 'Export')
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 60_000 })
  await fullExportButton(page).click()
  await expect(downloadButton(page)).toBeVisible({ timeout: 300_000 })
}

/** Raises Exposure from the Adjust tool by `steps` pages. */
export async function nudgeExposure(page: Page, steps: number) {
  await openTool(page, 'Adjust')
  const exposure = (isMobile(page) ? deck(page) : page).getByRole('slider', {
    name: 'Exposure',
    exact: true,
  })
  await expect(exposure).toBeEnabled()
  const before = Number(await exposure.getAttribute('aria-valuenow'))
  await exposure.focus()
  for (let step = 0; step < steps; step++) await exposure.press('PageUp')
  await expect
    .poll(async () => Number(await exposure.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before)
  return exposure
}

/** The Chromium project draws the preview, and its original, on WebGPU. */
export async function expectWebGPUPreview(page: Page, testInfo: TestInfo) {
  if (!isChromium(testInfo)) return
  await expect(gpuCanvas(page)).toHaveAttribute('data-render-backend', 'webgpu')
  const original = page.locator('.raw-preview-original-gpu-canvas')
  if (await original.count()) {
    await expect(original).toHaveAttribute('data-render-backend', 'webgpu')
  }
}

export async function waitForTransform(page: Page) {
  const tool = transformTool(page)
  await expect(tool).toBeVisible()
  await expect(
    tool.locator('[data-testid="mode-auto"], [role="slider"]').first(),
  ).toBeEnabled({ timeout: 30_000 })
  if (await transformOverlay(page).count()) {
    await expect(transformOverlay(page)).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    })
  }
  await expect(tool.getByRole('alert')).toHaveCount(0)
}

/** Mobile splits the Transform panel into sections; desktop shows them all. */
export async function selectTransformSection(
  page: Page,
  name: 'Upright' | 'Perspective' | 'Frame',
) {
  if (!isMobile(page)) return
  await transformTool(page).getByRole('tab', { name, exact: true }).click()
  await expect(
    transformTool(page).locator(
      `[data-transform-list-section="${name.toLowerCase()}"]`,
    ),
  ).toBeVisible()
}

/** The geometry the Transform overlay names, or null with no overlay. */
export function transformMatrix(page: Page) {
  return transformOverlay(page).getAttribute('data-transform-matrix')
}
