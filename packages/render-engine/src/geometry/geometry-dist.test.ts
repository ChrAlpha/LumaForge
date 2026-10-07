/// <reference types="node" />
// @vitest-environment node

// Built-consumer smoke for `@lumaforge/render-engine/geometry`. A separate
// Node process with no Vite, no source aliases and no test loader imports the
// subpath by package name, so it can only pass when package.json `exports`
// resolve to a built `dist` entry that works on its own. Missing build output
// is a failure here, never a skip: build the package before running it.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const distDir = join(packageDir, 'dist')
const DIST_GEOMETRY = join(distDir, 'geometry.js')

// Runs inside the child. Records every module the import resolves and every
// browser global it reads, then evaluates fixed cases against the built API.
const CONSUMER_SOURCE = String.raw`
import * as nodeModule from 'node:module'

if (typeof nodeModule.registerHooks !== 'function') {
  throw new Error(
    'module.registerHooks is unavailable in Node ' + process.version +
      '; this check needs Node >= 22.15 or >= 23.5',
  )
}

// Registered after this entry and node:module have loaded, so it records
// exactly the import graph of the geometry subpath below.
const resolved = []
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolved.push({ specifier, url: result.url })
    return result
  },
})

const BROWSER_GLOBALS = [
  'Worker',
  'document',
  'window',
  'navigator',
  'OffscreenCanvas',
  'createImageBitmap',
  'ImageData',
  'GPU',
]
const touchedGlobals = []
for (const name of BROWSER_GLOBALS) {
  const original = globalThis[name]
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      touchedGlobals.push(name)
      return original
    },
  })
}

const geometry = await import('@lumaforge/render-engine/geometry')
const { applyMatrix, invertMatrix, isMatrix3 } = geometry

const results = {
  exportNames: Object.keys(geometry).sort(),
  isMatrix3: [
    isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    isMatrix3([1, 0, 0, 0, 1, 0, 0, 0]),
    isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, Number.NaN]),
    isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, '1']),
  ],
  affineInverse: invertMatrix([2, 0, 3, 0, 4, 5, 0, 0, 1]),
  affineForward: applyMatrix([2, 0, 3, 0, 4, 5, 0, 0, 1], { x: 7, y: -2 }),
  affineBack: applyMatrix([0.5, 0, -1.5, 0, 0.25, -1.25, 0, 0, 1], {
    x: 17,
    y: -3,
  }),
  projectiveForward: applyMatrix([1, 0, 0, 0, 1, 0, 0.5, 0, 1], {
    x: 2,
    y: 4,
  }),
  projectiveInverse: invertMatrix([1, 0, 0, 0, 1, 0, 0.5, 0, 1]),
  singularInverse: invertMatrix([1, 2, 3, 2, 4, 6, 0, 0, 1]),
  tinyDeterminantInverse: invertMatrix([1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1e-4]),
  vanishingDenominator: applyMatrix([1, 0, 0, 0, 1, 0, 1, 0, 0], {
    x: 1e-9,
    y: 0,
  }),
}

process.stdout.write(JSON.stringify({ resolved, touchedGlobals, results }))
`

type ConsumerReport = {
  resolved: Array<{ specifier: string; url: string }>
  touchedGlobals: string[]
  results: Record<string, unknown>
}

// Below the vitest hook timeout, so a hung child fails with its own message.
const CONSUMER_TIMEOUT_MS = 5_000

let consumerDir: string | undefined

function runBuiltConsumer(): ConsumerReport {
  consumerDir = mkdtempSync(join(tmpdir(), 'render-engine-geometry-dist-'))
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'geometry-dist-consumer', type: 'module' }),
  )
  const scopeDir = join(consumerDir, 'node_modules', '@lumaforge')
  mkdirSync(scopeDir, { recursive: true })
  symlinkSync(packageDir, join(scopeDir, 'render-engine'), 'dir')
  const entry = join(consumerDir, 'consumer.mjs')
  writeFileSync(entry, CONSUMER_SOURCE)

  const child = spawnSync(process.execPath, [entry], {
    cwd: consumerDir,
    // No inherited NODE_OPTIONS, loaders or test-runner hooks.
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: CONSUMER_TIMEOUT_MS,
  })
  if (child.error) {
    throw new Error(
      `built geometry consumer did not finish: ${child.error.message}`,
    )
  }
  if (child.status !== 0) {
    throw new Error(
      `built geometry consumer exited with ${child.status}:\n${child.stderr}`,
    )
  }
  return JSON.parse(child.stdout) as ConsumerReport
}

describe('@lumaforge/render-engine/geometry built entry', () => {
  let report: ConsumerReport

  beforeAll(() => {
    expect(
      existsSync(DIST_GEOMETRY),
      `${DIST_GEOMETRY} is missing; build @lumaforge/render-engine first`,
    ).toBe(true)
    report = runBuiltConsumer()
  })

  afterAll(() => {
    if (consumerDir) rmSync(consumerDir, { recursive: true, force: true })
  })

  it('resolves the subpath through package exports to the built entry', () => {
    const subpath = report.resolved.find(
      (entry) => entry.specifier === '@lumaforge/render-engine/geometry',
    )
    expect(subpath?.url).toBe(pathToFileURL(realpathSync(DIST_GEOMETRY)).href)
  })

  it('loads only built geometry modules and reads no browser global', () => {
    const distPrefix = `${pathToFileURL(realpathSync(distDir)).href}/`
    const urls = report.resolved.map((entry) => entry.url)
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.startsWith(distPrefix), url).toBe(true)
      expect(url.endsWith('.js'), url).toBe(true)
    }
    expect(report.resolved.map((entry) => entry.specifier)).not.toContainEqual(
      expect.stringMatching(/^(?:@lumaforge\/luma-|node:)/),
    )
    expect(report.touchedGlobals).toEqual([])
  })

  it('exports exactly the projective kernel', () => {
    expect(report.results.exportNames).toEqual([
      'applyMatrix',
      'invertMatrix',
      'isMatrix3',
    ])
  })

  it('accepts only nine finite numbers as a matrix', () => {
    expect(report.results.isMatrix3).toEqual([true, false, false, false])
  })

  it('inverts and projects an affine matrix to the hand-computed values', () => {
    // [[2,0,3],[0,4,5],[0,0,1]] has determinant 8 and the inverse below.
    expect(report.results.affineInverse).toEqual([
      0.5, 0, -1.5, 0, 0.25, -1.25, 0, 0, 1,
    ])
    // (2*7 + 3, 4*-2 + 5)
    expect(report.results.affineForward).toEqual({ x: 17, y: -3 })
    expect(report.results.affineBack).toEqual({ x: 7, y: -2 })
  })

  it('divides by the projective denominator', () => {
    // w = 0.5*2 + 1 = 2, so (2, 4) maps to (1, 2).
    expect(report.results.projectiveForward).toEqual({ x: 1, y: 2 })
    expect(report.results.projectiveInverse).toEqual([
      1, 0, 0, 0, 1, 0, -0.5, 0, 1,
    ])
  })

  it('refuses singular matrices and vanishing denominators', () => {
    expect(report.results.singularInverse).toBeNull()
    // det = 1e-12, below the 1e-10 floor.
    expect(report.results.tinyDeterminantInverse).toBeNull()
    expect(report.results.vanishingDenominator).toBeNull()
  })
})
