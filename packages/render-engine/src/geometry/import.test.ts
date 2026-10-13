// @vitest-environment node

// Which modules the subpath entry may import is the `geometry-kernel` lint
// boundary. These tests observe what loading it does at run time.

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

describe('geometry kernel thresholds', () => {
  const { applyMatrix, invertMatrix } = matrixModule
  type Matrix3 = matrixModule.Matrix3

  it('inverts down to a 1e-10 determinant and refuses below it', () => {
    // det = 1e-9: still invertible; det = 1e-12: refused.
    expect(invertMatrix([1e-3, 0, 0, 0, 1e-3, 0, 0, 0, 1e-3])).not.toBeNull()
    expect(invertMatrix([1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1e-4])).toBeNull()
    expect(
      invertMatrix([Number.POSITIVE_INFINITY, 0, 0, 0, 1, 0, 0, 0, 1]),
    ).toBeNull()
  })

  it('projects down to a 1e-8 denominator and refuses a non-finite point', () => {
    const projective: Matrix3 = [1, 0, 0, 0, 1, 0, 1, 0, 0]
    expect(applyMatrix(projective, { x: 1e-9, y: 0 })).toBeNull()
    expect(applyMatrix(projective, { x: -1e-9, y: 0 })).toBeNull()
    expect(applyMatrix(projective, { x: 2e-8, y: 3 })).toEqual({
      x: 1,
      y: 3 / 2e-8,
    })
    expect(
      applyMatrix([Number.MAX_VALUE, 0, 0, 0, 1, 0, 0, 0, 1], { x: 10, y: 0 }),
    ).toBeNull()
  })
})
