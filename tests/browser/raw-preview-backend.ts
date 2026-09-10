import { existsSync } from 'node:fs'

import type { Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

export function isDesktopChromiumProject(testInfo: TestInfo) {
  return ['chromium-desktop', 'chromium-webgpu'].includes(testInfo.project.name)
}

export function rawPreviewUrl(testInfo: TestInfo, path = '/raw') {
  const url = new URL(
    path,
    testInfo.project.use.baseURL ?? 'http://127.0.0.1:4178',
  )
  if (
    testInfo.project.name === 'chromium-webgpu' &&
    url.searchParams.get('forcePreview') !== 'cpu'
  ) {
    url.searchParams.set('forcePreview', 'webgpu')
  }
  return url.href
}

export function requireWebGPUFixture(testInfo: TestInfo, path: string) {
  if (testInfo.project.name === 'chromium-webgpu') {
    expect(
      existsSync(path),
      `Required WebGPU RAW fixture is missing: ${path}`,
    ).toBe(true)
  }
}

export async function expectWebGPUPreview(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name !== 'chromium-webgpu') return
  await expect(page.locator('.raw-preview-canvas')).toHaveAttribute(
    'data-render-backend',
    'webgpu',
  )
  const original = page.locator('.raw-preview-original-webgl-canvas')
  if (await original.count()) {
    await expect(original).toHaveAttribute('data-render-backend', 'webgpu')
  }
}
