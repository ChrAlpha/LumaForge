import { existsSync } from 'node:fs'

import type { Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

/** The Chromium project runs the WebGPU preview on a software adapter. */
export function isDesktopChromiumProject(testInfo: TestInfo) {
  return testInfo.project.name === 'chromium-desktop'
}

export function rawPreviewUrl(testInfo: TestInfo, path = '/raw') {
  return new URL(path, testInfo.project.use.baseURL ?? 'http://127.0.0.1:4178')
    .href
}

/**
 * Whether the project's browser exposes a WebGPU adapter. Playwright's WebKit
 * build has none (Safari 26 does), so WebKit runs the CPU preview here.
 */
export function projectHasWebGPU(testInfo: TestInfo) {
  return isDesktopChromiumProject(testInfo)
}

export const NO_WEBGPU_SKIP_REASON =
  'Needs the GPU preview; this browser build has no WebGPU adapter and runs the CPU preview'

/** The WebGPU project must not silently skip its RAW fixtures. */
export function requireWebGPUFixture(testInfo: TestInfo, path: string) {
  if (isDesktopChromiumProject(testInfo)) {
    expect(
      existsSync(path),
      `Required WebGPU RAW fixture is missing: ${path}`,
    ).toBe(true)
  }
}

export async function expectWebGPUPreview(page: Page, testInfo: TestInfo) {
  if (!isDesktopChromiumProject(testInfo)) return
  await expect(page.locator('.raw-preview-canvas')).toHaveAttribute(
    'data-render-backend',
    'webgpu',
  )
  const original = page.locator('.raw-preview-original-gpu-canvas')
  if (await original.count()) {
    await expect(original).toHaveAttribute('data-render-backend', 'webgpu')
  }
}
