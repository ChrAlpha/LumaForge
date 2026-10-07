/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as matrixModule from '../export/geometry/matrix'

const loadedRuntimes = vi.hoisted(() => new Set<string>())

vi.mock('@lumaforge/luma-raw-runtime', () => {
  loadedRuntimes.add('@lumaforge/luma-raw-runtime')
  return {}
})
vi.mock('@lumaforge/luma-jpeg-runtime', () => {
  loadedRuntimes.add('@lumaforge/luma-jpeg-runtime')
  return {}
})
vi.mock('@lumaforge/luma-color-runtime', () => {
  loadedRuntimes.add('@lumaforge/luma-color-runtime')
  return {}
})

// Browser-only objects. `URL` and `Blob` are left out: Node ships them and the
// test runner's module loader reads them.
const BROWSER_GLOBALS = [
  'Worker',
  'document',
  'window',
  'navigator',
  'OffscreenCanvas',
  'createImageBitmap',
  'ImageData',
  'GPU',
] as const

const geometryEntry = fileURLToPath(new URL('./index.ts', import.meta.url))

function relativeImportClosure(entry: string): {
  files: string[]
  bareSpecifiers: string[]
} {
  const files: string[] = []
  const bareSpecifiers: string[] = []
  const pending = [entry]
  // `from '...'`, side-effect `import '...'` and dynamic `import('...')`.
  const importPattern = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.includes(file)) continue
    files.push(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), `${specifier}.ts`))
      } else {
        bareSpecifiers.push(specifier)
      }
    }
  }
  return { files, bareSpecifiers }
}

describe('@lumaforge/render-engine/geometry import purity', () => {
  const touchedGlobals = new Set<string>()
  const originals = new Map<string, PropertyDescriptor | undefined>()

  beforeEach(() => {
    vi.resetModules()
    loadedRuntimes.clear()
    touchedGlobals.clear()
    for (const name of BROWSER_GLOBALS) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      const original = (globalThis as Record<string, unknown>)[name]
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          touchedGlobals.add(name)
          return original
        },
      })
    }
  })

  afterEach(() => {
    for (const name of BROWSER_GLOBALS) {
      const descriptor = originals.get(name)
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        delete (globalThis as Record<string, unknown>)[name]
      }
    }
  })

  it('initializes no runtime package and reads no browser global', async () => {
    const mod = await import('./index')
    expect(typeof mod.applyMatrix).toBe('function')
    expect([...loadedRuntimes]).toEqual([])
    expect([...touchedGlobals]).toEqual([])
  })

  it('imports nothing outside its own relative module graph', () => {
    const { files, bareSpecifiers } = relativeImportClosure(geometryEntry)
    expect(bareSpecifiers).toEqual([])
    expect(files.map((file) => file.slice(file.indexOf('src/')))).toEqual([
      'src/geometry/index.ts',
      'src/export/geometry/matrix.ts',
    ])
  })

  it('re-exports the export-stage kernel instead of a copy', async () => {
    const mod = await import('./index')
    // vi.resetModules gives the dynamic import a fresh module record, so
    // compare against a fresh copy of the kernel from the same registry.
    const kernel = await import('../export/geometry/matrix')
    expect(mod.applyMatrix).toBe(kernel.applyMatrix)
    expect(mod.invertMatrix).toBe(kernel.invertMatrix)
    expect(mod.isMatrix3).toBe(kernel.isMatrix3)
    expect(Object.keys(mod).sort()).toEqual(
      ['applyMatrix', 'invertMatrix', 'isMatrix3'].sort(),
    )
  })
})

describe('geometry kernel behavior', () => {
  const { applyMatrix, invertMatrix, isMatrix3 } = matrixModule
  type Matrix3 = matrixModule.Matrix3

  it('accepts only nine finite numbers as a matrix', () => {
    expect(isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(true)
    expect(isMatrix3([1, 0, 0, 0, 1, 0, 0, 0])).toBe(false)
    expect(isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, Number.NaN])).toBe(false)
    expect(isMatrix3([1, 0, 0, 0, 1, 0, 0, 0, '1'])).toBe(false)
  })

  it('inverts a matrix whose determinant clears 1e-10', () => {
    const scale: Matrix3 = [2, 0, 3, 0, 4, 5, 0, 0, 1]
    const inverse = invertMatrix(scale)!
    expect(inverse).not.toBeNull()
    const point = applyMatrix(inverse, applyMatrix(scale, { x: 7, y: -2 })!)!
    expect(point.x).toBeCloseTo(7, 12)
    expect(point.y).toBeCloseTo(-2, 12)
    // det = 1e-9: still invertible.
    expect(invertMatrix([1e-3, 0, 0, 0, 1e-3, 0, 0, 0, 1e-3])).not.toBeNull()
  })

  it('refuses a determinant below 1e-10 or a non-finite one', () => {
    // det = 1e-12.
    expect(invertMatrix([1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1e-4])).toBeNull()
    expect(invertMatrix([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull()
    expect(
      invertMatrix([Number.POSITIVE_INFINITY, 0, 0, 0, 1, 0, 0, 0, 1]),
    ).toBeNull()
  })

  it('refuses a projective denominator below 1e-8', () => {
    const projective: Matrix3 = [1, 0, 0, 0, 1, 0, 1, 0, 0]
    expect(applyMatrix(projective, { x: 1e-9, y: 0 })).toBeNull()
    expect(applyMatrix(projective, { x: -1e-9, y: 0 })).toBeNull()
    expect(applyMatrix(projective, { x: 2e-8, y: 3 })).toEqual({
      x: 1,
      y: 3 / 2e-8,
    })
  })

  it('refuses a non-finite projected point', () => {
    const projective: Matrix3 = [Number.MAX_VALUE, 0, 0, 0, 1, 0, 0, 0, 1]
    expect(applyMatrix(projective, { x: 10, y: 0 })).toBeNull()
  })
})
