import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    output: { type: 'string' },
    iterations: { type: 'string', default: '30' },
    hardware: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})
if (values.help) {
  process.stdout.write(
    `${JSON.stringify({ usage: 'node scripts/webgpu/validate.mjs [--root checkout] [--output report.json] [--iterations 1..60] [--hardware]', default: 'Chromium SwiftShader, 1024x768, five warmups, thirty edits per backend', scope: 'Synthetic GPU pipeline parity and software performance; no RAW decoder or authoritative export claim' }, null, 2)}\n`,
  )
  process.exit(0)
}
const root = resolve(values.root)
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(
  values.output ?? `/tmp/lumaforge-webgpu-validation-${Date.now()}.json`,
)
const iterations = Number(values.iterations)
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 60)
  throw new Error('ITERATIONS_MUST_BE_1_TO_60')
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
async function fingerprintSource() {
  const paths = git(
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'src/lib/gl',
    'src/lib/webgpu',
    'packages/luma-color-runtime',
  )
    .split('\n')
    .filter(
      (path) =>
        path && !path.split('/').some((part) => part.startsWith('.env')),
    )
    .sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path)
    hash.update(
      await readFile(resolve(root, path)).catch((error) => {
        if (error.code === 'ENOENT') return '<source removed during validation>'
        throw error
      }),
    )
  }
  return hash.digest('hex')
}
const harnessHash = createHash('sha256')
for (const name of [
  'validate.mjs',
  'browser-suite.mjs',
  'fixtures.mjs',
  'performance.mjs',
]) {
  harnessHash.update(name)
  harnessHash.update(await readFile(resolve(ownRoot, 'scripts/webgpu', name)))
}
const report = {
  schemaVersion: 1,
  scope:
    'Synthetic GPU pipeline acceptance; excludes RAW decoding and authoritative full-resolution export',
  startedAt: new Date().toISOString(),
  root,
  revision: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current'),
  status: git('status', '--porcelain=v1'),
  sourceSha256: await fingerprintSource(),
  harnessSha256: harnessHash.digest('hex'),
  softwareRequested: !values.hardware,
  iterations,
  errors: [],
  passed: false,
}
let server, browser, timeout, page
try {
  server = await createServer({
    configFile: false,
    envDir: false,
    root,
    logLevel: 'silent',
    resolve: {
      alias: [
        {
          find: '@lumaforge/luma-color-runtime/wgsl',
          replacement: resolve(root, 'packages/luma-color-runtime/src/wgsl.ts'),
        },
        {
          find: '@lumaforge/luma-color-runtime/glsl',
          replacement: resolve(root, 'packages/luma-color-runtime/src/glsl.ts'),
        },
        {
          find: '@lumaforge/luma-color-runtime',
          replacement: resolve(
            root,
            'packages/luma-color-runtime/src/index.ts',
          ),
        },
        { find: '~/', replacement: `${root}/src/` },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: { allow: [root, ownRoot] },
    },
    plugins: [
      {
        name: 'webgpu-validation-host',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/__validation') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end('<!doctype html><html><body></body></html>')
          })
        },
      },
    ],
  })
  await server.listen()
  browser = await chromium.launch({
    headless: true,
    args: values.hardware
      ? []
      : [
          '--enable-unsafe-webgpu',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--enable-features=Vulkan',
          '--use-vulkan=swiftshader',
          '--disable-vulkan-surface',
        ],
  })
  report.browser = browser.version()
  report.presentationMechanism = 'Playwright canvas compositor screenshot'
  page = await browser.newPage()
  await page.exposeFunction('__captureValidationCanvas', async (id) => {
    const canvas = page.locator(`[data-validation-id="${id}"]`)
    const png = await canvas.screenshot({
      animations: 'disabled',
      scale: 'css',
    })
    return png.toString('base64')
  })
  page.on('pageerror', (error) =>
    report.errors.push({
      type: 'pageerror',
      message: error.message,
      stack: error.stack,
    }),
  )
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.errors.push({ type: 'console', message: message.text() })
  })
  timeout = setTimeout(() => {
    report.errors.push({
      type: 'timeout',
      message: 'Validation exceeded 180 seconds',
    })
    void browser.close()
  }, 180_000)
  const address = server.httpServer.address()
  await page.goto(`http://127.0.0.1:${address.port}/__validation`)
  const suiteUrl = `/@fs/${resolve(ownRoot, 'scripts/webgpu/browser-suite.mjs')}`
  report.result = await page.evaluate(
    async ({ suiteUrl, iterations }) => {
      const { runAcceptance } = await import(suiteUrl)
      return runAcceptance({ iterations })
    },
    { suiteUrl, iterations },
  )
  if (values.hardware && report.result.performance.software)
    report.errors.push({
      type: 'adapter',
      message: 'Hardware required but adapter identifies as software',
    })
  report.passed =
    report.errors.length === 0 &&
    report.result.tests.length > 0 &&
    report.result.tests.every((test) => test.passed)
} catch (error) {
  if (page && !page.isClosed())
    report.result = await page
      .evaluate(() => window.__webgpuValidationReport)
      .catch(() => undefined)
  report.errors.push({
    type: 'exception',
    message: error.message,
    stack: error.stack,
  })
} finally {
  clearTimeout(timeout)
  await browser?.close()
  await server?.close()
  report.finishedAt = new Date().toISOString()
  report.finalRevision = git('rev-parse', 'HEAD')
  report.finalSourceSha256 = await fingerprintSource()
  report.sourceStable = report.sourceSha256 === report.finalSourceSha256
  if (!report.sourceStable) {
    report.passed = false
    report.errors.push({
      type: 'source-drift',
      message: 'Relevant source changed while validation was running',
    })
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify({ artifact: output, passed: report.passed, errors: report.errors, tests: report.result?.tests.length, failures: report.result?.tests.filter((test) => !test.passed), performance: report.result?.performance }, null, 2)}\n`,
  )
  if (!report.passed) process.exitCode = 1
}
