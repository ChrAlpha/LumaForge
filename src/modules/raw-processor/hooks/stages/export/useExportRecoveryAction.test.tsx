import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { sourceFingerprintMatches } from '~/lib/export/source-fingerprint'

import type { ExportRecoveryState, ImageSession } from '../../../model/session'
import type { PendingRecoveryRetry } from './useExportRecoveryAction'
import { useExportRecoveryAction } from './useExportRecoveryAction'

vi.mock('~/lib/export/source-fingerprint', () => ({
  sourceFingerprintMatches: vi.fn(async () => true),
}))

type RecoveryActionInput = Parameters<typeof useExportRecoveryAction>[0]

function createFile(name = 'frame.dng') {
  return new File(['raw'], name, { lastModified: 123 })
}

function createManifest(file = createFile()): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-1',
    sourceFingerprint: {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      hashPrefixHex: 'unused-for-name-mismatch',
    },
    fileName: file.name,
    sourceSize: file.size,
    sourceLastModified: file.lastModified,
    outputWidth: 800,
    outputHeight: 600,
    graphFingerprint: 'graph',
    profile: 'desktop-fast',
    derivedLabel: 'cinema',
    attempt: 1,
    preferredRows: 256,
    totalRows: 600,
    recoveryMode: 'safe-retry',
    outputSink: 'blob-handoff',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 0,
    jpegState: 'restart-required',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

function createSession(
  file = createFile(),
  overrides: Partial<ImageSession> = {},
): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      file,
      name: file.name,
      extension: 'dng',
      sizeBytes: file.size,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'none',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'idle' },
    exportState: {
      status: 'idle',
      qualityPreset: 'standard',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'unknown' },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
    ...overrides,
  }
}

function createPendingRetry(file = createFile()): PendingRecoveryRetry {
  const manifest = createManifest(file)
  return {
    sourceExportId: manifest.exportId,
    manifest,
    sessionId: 'session-1',
    fileName: file.name,
    size: file.size,
    lastModified: file.lastModified,
  }
}

function createSourceRequiredRecovery(
  file = createFile(),
): ExportRecoveryState {
  const manifest = createManifest(file)
  return {
    status: 'source-required',
    exportId: manifest.exportId,
    expectedFileName: file.name,
    manifest,
    message: 'Reselect the RAW file.',
  }
}

/**
 * Renders the hook through a sequence of workflow states. Every export
 * callback handed to the hook records into one list, so a later step that
 * swaps the callback (a new look, graph or geometry) is still observed.
 */
function renderRecoveryAction(
  steps: Array<Partial<RecoveryActionInput> & { replaceExportImage?: true }>,
) {
  const file = createFile()
  const exportCalls: unknown[] = []
  const createExportImage = () =>
    vi.fn(async (options: unknown) => {
      exportCalls.push(options)
    })
  const loadFile = vi.fn(async () => undefined)
  const setPendingRecoveryRetry = vi.fn()
  const toastError = vi.fn()
  let exportImage = createExportImage()
  const sessionRef = { current: createSession(file) as ImageSession | null }
  const discoveredRecoveryRef = {
    current: createSourceRequiredRecovery(file),
  }
  const base: RecoveryActionInput = {
    pendingRecoveryRetry: createPendingRetry(file),
    setPendingRecoveryRetry,
    sessionRef,
    discoveredRecoveryRef,
    loadedFile: file,
    canExport: true,
    status: 'ready',
    loadFile,
    exportImage,
    scheduleToast: (notify) => notify(),
    toast: { error: toastError },
  }

  const inputFor = (
    step: Partial<RecoveryActionInput> & { replaceExportImage?: true },
  ): RecoveryActionInput => {
    const { replaceExportImage, ...overrides } = step
    if (replaceExportImage) exportImage = createExportImage()
    return { ...base, exportImage, ...overrides }
  }

  const [first = {}, ...rest] = steps
  const view = renderHook(
    (input: RecoveryActionInput) => useExportRecoveryAction(input),
    {
      initialProps: inputFor(first),
    },
  )
  for (const step of rest) {
    view.rerender(inputFor(step))
  }

  return {
    ...view,
    file,
    exportCalls,
    loadFile,
    setPendingRecoveryRetry,
    toastError,
    sessionRef,
  }
}

describe('useExportRecoveryAction', () => {
  it.each<
    [
      string,
      Array<Partial<RecoveryActionInput> & { replaceExportImage?: true }>,
    ]
  >([
    ['a ready matching source', [{}]],
    [
      'a matching source that becomes ready after loading',
      [{ status: 'decoding', canExport: false }, {}],
    ],
    [
      'a LUT or graph change once the matching source is ready',
      [{}, { replaceExportImage: true }],
    ],
    [
      'a geometry change on the matching session',
      [
        {},
        {
          replaceExportImage: true,
          sessionRef: {
            current: createSession(createFile(), {
              exportGeometry: {
                matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
                constrainCrop: true,
              },
            }),
          },
        },
      ],
    ],
    ['an unrelated loaded source', [{ loadedFile: createFile('other.dng') }]],
    ['a workflow error', [{ status: 'error', canExport: false }]],
    [
      'a cancelled export returning the workflow to ready',
      [{ status: 'exporting', canExport: false }, { status: 'ready' }],
    ],
  ])('never starts an export for %s', (_label, steps) => {
    const { exportCalls, loadFile, toastError } = renderRecoveryAction(steps)

    expect(exportCalls).toEqual([])
    expect(loadFile).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('never starts an export around unmount', () => {
    const view = renderRecoveryAction([
      { status: 'decoding', canExport: false },
    ])

    view.unmount()

    expect(view.exportCalls).toEqual([])
  })

  it('does not reselect, reload or arm a retry for a picked RAW file', async () => {
    const view = renderRecoveryAction([
      { pendingRecoveryRetry: null, status: 'idle', canExport: false },
    ])

    await act(async () => {
      await view.result.current.recoverInterruptedExport(view.file)
      await view.result.current.recoverInterruptedExport(
        createFile('wrong.dng'),
      )
    })

    expect(sourceFingerprintMatches).not.toHaveBeenCalled()
    expect(view.loadFile).not.toHaveBeenCalled()
    expect(view.setPendingRecoveryRetry).not.toHaveBeenCalled()
    expect(view.toastError).not.toHaveBeenCalled()
    expect(view.exportCalls).toEqual([])
  })

  it('does not export when unmounted while a picked RAW file is handled', async () => {
    const view = renderRecoveryAction([
      { pendingRecoveryRetry: null, status: 'idle', canExport: false },
    ])

    const recovering = view.result.current.recoverInterruptedExport(view.file)
    view.unmount()
    await act(async () => {
      await recovering
    })

    expect(view.loadFile).not.toHaveBeenCalled()
    expect(view.exportCalls).toEqual([])
  })
})
