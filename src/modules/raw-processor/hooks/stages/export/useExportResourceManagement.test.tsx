import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import type { ExportResult } from '../../../model/export-result'
import { createMockExportResultIdentity } from '../../../model/export-result.fixture'
import { useExportResourceManagement } from './useExportResourceManagement'

function createFileBackedResult(cleanup: () => Promise<void>): ExportResult {
  return {
    kind: 'full-resolution',
    output: {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
      cleanup,
    },
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: 4,
    createdAt: 1,
    copyCapability: {
      mode: 'full-resolution',
    },
    identity: createMockExportResultIdentity(),
  }
}

describe('useExportResourceManagement', () => {
  it('registers export results and disposes their backing output cleanup', async () => {
    const registry = createResourceRegistry()
    const cleanup = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useExportResourceManagement({
        resourceRegistryRef: { current: registry },
      }),
    )

    result.current.registerExportResultResource(createFileBackedResult(cleanup))

    expect(registry.snapshot().live).toEqual([
      {
        id: 'export-result-1',
        owner: 'export-result',
        kind: 'blob',
        estimatedBytes: 4,
      },
    ])

    await result.current.disposeExportResultResources('reset-session')

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(registry.assertZeroLive(['export-result'])).toEqual({ ok: true })
  })
})
