import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCapabilityVectorSnapshot } from './capability-vector'
import { snapshotExportRuntimeResources } from './export-runtime-resources'

vi.mock('./capability-vector', () => ({
  getCapabilityVectorSnapshot: vi.fn(() => null),
}))

afterEach(() => {
  vi.mocked(getCapabilityVectorSnapshot).mockReturnValue(null)
  vi.unstubAllGlobals()
})

describe('snapshotExportRuntimeResources', () => {
  it('computes available MB from quota minus usage', async () => {
    vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
      coi: true,
      pthread: true,
      deviceMemoryGB: 16,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: true,
    })
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn(async () => ({
          quota: 1_000_000_000,
          usage: 200_000_000,
        })),
        getDirectory: vi.fn(async () => ({})),
      },
    } as never)

    const snap = await snapshotExportRuntimeResources()

    expect(snap.opfsSinkAvailable).toBe(true)
    expect(snap.opfsAvailableMB).toBe(800)
  })

  it('marks opfs unavailable when capability vector says so', async () => {
    vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
      coi: true,
      pthread: true,
      deviceMemoryGB: 16,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: false,
    })

    const snap = await snapshotExportRuntimeResources()

    expect(snap.opfsSinkAvailable).toBe(false)
    expect(snap.opfsAvailableMB).toBeNull()
  })

  it('reports no OPFS sink before the capability vector is detected', async () => {
    const estimate = vi.fn(async () => ({ quota: 1_000_000_000, usage: 0 }))
    vi.stubGlobal('navigator', {
      storage: { estimate, getDirectory: vi.fn(async () => ({})) },
    } as never)

    const snap = await snapshotExportRuntimeResources()

    expect(snap).toEqual({
      opfsSinkAvailable: false,
      opfsAvailableMB: null,
    })
    expect(Object.isFrozen(snap)).toBe(true)
    expect(estimate).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a zero quota never probes the directory',
      { quota: 0, usage: 0 },
      'resolves',
      { opfsSinkAvailable: false, opfsAvailableMB: null },
      false,
    ],
    [
      'usage above quota leaves zero MB',
      { quota: 100_000_000, usage: 300_000_000 },
      'resolves',
      { opfsSinkAvailable: true, opfsAvailableMB: 0 },
      true,
    ],
    [
      'available bytes floor to whole MB',
      { quota: 1_999_999, usage: 0 },
      'resolves',
      { opfsSinkAvailable: true, opfsAvailableMB: 1 },
      true,
    ],
    [
      'an unreachable directory keeps the MB estimate',
      { quota: 1_000_000_000, usage: 0 },
      'rejects',
      { opfsSinkAvailable: false, opfsAvailableMB: 1000 },
      true,
    ],
    [
      'a missing directory accessor keeps the MB estimate',
      { quota: 1_000_000_000, usage: 0 },
      'missing',
      { opfsSinkAvailable: false, opfsAvailableMB: 1000 },
      false,
    ],
    [
      'a missing estimate counts as zero quota',
      {},
      'resolves',
      { opfsSinkAvailable: false, opfsAvailableMB: null },
      false,
    ],
  ] as const)(
    'keeps the OPFS resource table: %s',
    async (_label, estimateResult, directory, expected, probed) => {
      vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
        coi: true,
        pthread: true,
        deviceMemoryGB: 16,
        hwConcurrency: 8,
        webKitClass: 'chromium',
        deviceFormFactor: 'desktop',
        maybeOpfsSupported: true,
      })
      const getDirectory =
        directory === 'rejects'
          ? vi.fn(async () => {
              throw new DOMException('denied', 'SecurityError')
            })
          : vi.fn(async () => ({}))
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn(async () => estimateResult),
          ...(directory === 'missing' ? {} : { getDirectory }),
        },
      } as never)

      const snap = await snapshotExportRuntimeResources()

      expect(snap).toEqual(expected)
      expect(Object.isFrozen(snap)).toBe(true)
      expect(getDirectory).toHaveBeenCalledTimes(probed ? 1 : 0)
    },
  )

  it('fails closed when the storage estimate throws', async () => {
    vi.mocked(getCapabilityVectorSnapshot).mockReturnValue({
      coi: true,
      pthread: true,
      deviceMemoryGB: 16,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
      maybeOpfsSupported: true,
    })
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn(async () => {
          throw new Error('estimate unavailable')
        }),
        getDirectory: vi.fn(async () => ({})),
      },
    } as never)

    const snap = await snapshotExportRuntimeResources()

    expect(snap).toEqual({
      opfsSinkAvailable: false,
      opfsAvailableMB: null,
    })
    expect(Object.isFrozen(snap)).toBe(true)
  })
})
