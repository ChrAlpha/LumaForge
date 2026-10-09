import type { LumaRawSupportLevel } from '@lumaforge/luma-raw-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ImageSession, SupportLevel } from '../../../model/session'
import {
  createImageSession,
  createTransformState,
  toAppSupportLevel,
} from '../../../model/session-factory'
import { useRawSourceState } from './useRawSourceState'

function createSession(overrides: Partial<ImageSession> = {}): ImageSession {
  const sourceFile = new File(['raw'], 'fallback-name.dng')

  return {
    id: 'session-source',
    createdAt: 1,
    sourceFile: {
      file: sourceFile,
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: sourceFile.size,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'ready', objectUrl: 'blob:embedded' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'embedded',
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
      fullResCapability: { status: 'unknown' },
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState('session-source'),
    ...overrides,
  }
}

describe('useRawSourceState', () => {
  it('derives source facts from the current image session', () => {
    const session = createSession()

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'ready' }),
    )

    expect(result.current.hasImage).toBe(true)
    expect(result.current.loadedImage.file).toBe(session.sourceFile.file)
    expect(result.current.loadedImage.metadata).toBeNull()
    expect(result.current.sourceFileName).toBe('frame.dng')
    expect(result.current.supportLevel).toBe('experimental')
    expect(result.current.embeddedPreviewUrl).toBe('blob:embedded')
    expect(result.current.displaySource).toBe('embedded')
    expect(result.current.progressRecoveryHint).toBeUndefined()
  })

  it('falls back to file name and empty source defaults without a displayable session', () => {
    const sourceFile = new File(['raw'], 'file-fallback.dng')
    const session = createSession({
      sourceFile: {
        file: sourceFile,
        name: '',
        extension: 'dng',
        sizeBytes: sourceFile.size,
        supportLevel: 'experimental',
      },
      previewBundle: {
        embeddedPreview: { status: 'idle' },
        quickDecodePreview: { status: 'idle' },
        boundedHqPreview: { status: 'idle' },
        displaySource: 'none',
        boundedHqRequiredForExport: false,
      },
    })

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'loading' }),
    )

    expect(result.current.hasImage).toBe(false)
    expect(result.current.sourceFileName).toBe('file-fallback.dng')
    expect(result.current.supportLevel).toBe('experimental')
    expect(result.current.embeddedPreviewUrl).toBeNull()
    expect(result.current.displaySource).toBe('none')
    expect(result.current.progressRecoveryHint).toBeDefined()
  })

  it('passes an unsupported source through instead of calling it experimental', () => {
    const session = createSession()
    session.sourceFile.supportLevel = 'unsupported'

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'ready' }),
    )

    expect(result.current.supportLevel).toBe('unsupported')
  })

  it('states a legacy official level as experimental, never as certified', () => {
    const session = createSession()
    // Older runtimes can still report the published 'official' member.
    session.sourceFile.supportLevel = 'official' as LumaRawSupportLevel as never

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'ready' }),
    )

    expect(result.current.supportLevel).toBe('experimental')
  })

  it('starts a new or reset source as experimental', () => {
    const session = createImageSession(new File(['raw'], 'next.ARW'))

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'ready' }),
    )

    expect(result.current.supportLevel).toBe('experimental')
  })

  it('maps every published runtime support level onto the app levels', () => {
    const levels = {
      official: 'experimental',
      experimental: 'experimental',
      unsupported: 'unsupported',
    } satisfies Record<LumaRawSupportLevel, SupportLevel>

    for (const [runtimeLevel, appLevel] of Object.entries(levels)) {
      expect(toAppSupportLevel(runtimeLevel as LumaRawSupportLevel)).toBe(
        appLevel,
      )
    }
    expectTypeOf<SupportLevel>().toEqualTypeOf<'experimental' | 'unsupported'>()
    expectTypeOf<SupportLevel>().toExtend<LumaRawSupportLevel>()
  })

  it('uses neutral source defaults before a session exists', () => {
    const { result } = renderHook(() =>
      useRawSourceState({ session: null, status: 'idle' }),
    )

    expect(result.current.loadedImage).toEqual({ file: null, metadata: null })
    expect(result.current.hasImage).toBe(false)
    expect(result.current.sourceFileName).toBe('RAW photo')
    expect(result.current.supportLevel).toBe('experimental')
    expect(result.current.embeddedPreviewUrl).toBeNull()
    expect(result.current.displaySource).toBe('none')
  })
})
