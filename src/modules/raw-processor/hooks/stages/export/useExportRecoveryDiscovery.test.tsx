import { renderHook, waitFor } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import {
  createSourceFingerprint,
  sourceFingerprintMatches,
} from '~/lib/export/source-fingerprint'

import type { ExportRecoveryState, ImageSession } from '../../../model/session'
import { useExportRecoveryDiscovery } from './useExportRecoveryDiscovery'

vi.mock('~/lib/export/source-fingerprint', () => ({
  createSourceFingerprint: vi.fn(),
  sourceFingerprintMatches: vi.fn(),
}))

const INTERRUPTION_HINT =
  'The browser interrupted the previous export. Your next export will use a safer low-memory setting.'

function createManifest(
  overrides: Partial<ExportCheckpointManifest> = {},
): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-1',
    sourceFingerprint: {
      name: 'frame.dng',
      size: 3,
      lastModified: 123,
      hashPrefixHex: 'hash',
    },
    fileName: 'frame.dng',
    sourceSize: 3,
    sourceLastModified: 123,
    outputWidth: 800,
    outputHeight: 600,
    graphFingerprint: 'graph',
    profile: 'desktop-fast',
    attempt: 1,
    preferredRows: 256,
    totalRows: 600,
    recoveryMode: 'safe-retry',
    outputSink: 'blob-handoff',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 0,
    jpegState: 'restart-required',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function createSession(): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      supportLevel: 'official',
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
  }
}

function renderDiscovery(
  manifests: ExportCheckpointManifest[],
  initialSession: ImageSession | null,
) {
  const state: {
    session: ImageSession | null
    discovered: ExportRecoveryState
  } = { session: initialSession, discovered: { status: 'none' } }
  const setSession: Dispatch<SetStateAction<ImageSession | null>> = vi.fn(
    (updater) => {
      state.session =
        typeof updater === 'function' ? updater(state.session) : updater
    },
  )
  const setDiscoveredRecoveryState = vi.fn((next: ExportRecoveryState) => {
    state.discovered = next
  })

  renderHook(() =>
    useExportRecoveryDiscovery({
      setDiscoveredRecoveryState,
      setSession,
      createRecoveryStore: () => ({
        listSafeRetryCandidates: async () => manifests,
      }),
    }),
  )

  return { state, setDiscoveredRecoveryState }
}

describe('useExportRecoveryDiscovery', () => {
  it('discovers a safe-retry checkpoint as an interruption hint on the active session', async () => {
    const manifest = createManifest()
    const { state, setDiscoveredRecoveryState } = renderDiscovery(
      [manifest],
      createSession(),
    )

    await waitFor(() => {
      expect(setDiscoveredRecoveryState).toHaveBeenCalledTimes(1)
    })

    expect(state.discovered).toEqual({
      status: 'ready-to-retry',
      exportId: manifest.exportId,
      message: INTERRUPTION_HINT,
    })
    expect(state.session?.exportState.recovery).toEqual(state.discovered)
  })

  it('reports a transformed old journal without reselect or dimension prerequisites', async () => {
    // A geometry export journals its delivered crop, not the sensor frame.
    const manifest = createManifest({
      exportId: 'export-transformed',
      outputWidth: 640,
      outputHeight: 360,
      totalRows: 360,
    })
    const { state, setDiscoveredRecoveryState } = renderDiscovery(
      [manifest],
      null,
    )

    await waitFor(() => {
      expect(setDiscoveredRecoveryState).toHaveBeenCalledTimes(1)
    })

    expect(state.discovered).toEqual({
      status: 'ready-to-retry',
      exportId: 'export-transformed',
      message: INTERRUPTION_HINT,
    })
    expect(state.discovered).not.toHaveProperty('manifest')
    expect(state.discovered).not.toHaveProperty('expectedFileName')
    expect(state.session).toBeNull()
    expect(sourceFingerprintMatches).not.toHaveBeenCalled()
    expect(createSourceFingerprint).not.toHaveBeenCalled()
  })
})
