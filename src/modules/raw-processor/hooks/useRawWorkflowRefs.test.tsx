import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'

import type { ImageSession } from '../model/session'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}
const view: PreviewView = { mode: 'compare', compareSplit: 0.5 }

function createSession(id: string): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 1,
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
      fullResCapability: { status: 'unknown' },
      retryRecommended: false,
    },
  }
}

describe('useRawWorkflowRefs', () => {
  it('creates stable workflow refs and mirrors the latest session', () => {
    const firstSession = createSession('first')
    const secondSession = createSession('second')
    const { result, rerender } = renderHook(
      ({ session }) =>
        useRawWorkflowRefs({
          session,
          initialParams: params,
          initialView: view,
        }),
      { initialProps: { session: firstSession as ImageSession | null } },
    )
    const refs = result.current

    expect(refs.resourceRegistryRef.current).toBeTruthy()
    expect(refs.sessionRef.current).toBe(firstSession)
    expect(refs.paramsRef.current).toBe(params)
    expect(refs.viewRef.current).toBe(view)

    rerender({ session: secondSession })

    expect(result.current).toBe(refs)
    expect(result.current.sessionRef.current).toBe(secondSession)
  })
})
