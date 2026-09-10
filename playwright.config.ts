import process from 'node:process'

import { defineConfig, devices } from '@playwright/test'

delete process.env.NO_COLOR

export default defineConfig({
  testDir: './tests/browser',
  timeout: 120_000,
  workers: 1,
  expect: { timeout: 15_000 },
  webServer: {
    command: 'pnpm build && pnpm serve --host 127.0.0.1 --port 4178',
    url: 'http://127.0.0.1:4178/raw',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'webkit-ios-safe',
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'webkit',
        baseURL: 'http://127.0.0.1:4178',
      },
    },
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        baseURL: 'http://127.0.0.1:4178',
      },
    },
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        baseURL: 'http://127.0.0.1:4178',
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-unsafe-swiftshader',
            '--no-sandbox',
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
            '--disable-vulkan-surface',
            '--use-angle=swiftshader',
          ],
        },
      },
    },
  ],
})
