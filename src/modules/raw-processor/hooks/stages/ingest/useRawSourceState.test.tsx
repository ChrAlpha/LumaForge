import type { LumaRawSupportLevel } from '@lumaforge/luma-raw-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ImageSession, SupportLevel } from '../../../model/session'
import { toAppSupportLevel } from '../../../model/session-factory'
import type { TestSessionOverrides } from '../../../test-support/builders'
import { createTestSession } from '../../../test-support/builders'
import { useRawSourceState } from './useRawSourceState'

function createSession(overrides: TestSessionOverrides = {}): ImageSession {
  return createTestSession({
    id: 'session-source',
    sourceFile: {
      file: new File(['raw'], 'fallback-name.dng'),
      name: 'frame.dng',
      extension: 'dng',
    },
    previewBundle: {
      embeddedPreview: { status: 'ready', objectUrl: 'blob:embedded' },
      displaySource: 'embedded',
    },
    ...overrides,
  })
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
      sourceFile: { file: sourceFile, name: '' },
      previewBundle: {
        embeddedPreview: { status: 'idle' },
        displaySource: 'none',
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

  it.each([
    ['unsupported', 'unsupported'],
    // Older runtimes can still report the published 'official' member.
    ['official', 'experimental'],
  ] as const)('states a %s source as %s', (runtimeLevel, appLevel) => {
    const session = createSession({
      sourceFile: { supportLevel: runtimeLevel as never },
    })

    const { result } = renderHook(() =>
      useRawSourceState({ session, status: 'ready' }),
    )

    expect(result.current.supportLevel).toBe(appLevel)
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
