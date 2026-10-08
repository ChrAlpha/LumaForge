import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'

import { useRawWorkflowRefs } from './useRawWorkflowRefs'

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}
const view: PreviewView = { mode: 'compare', compareSplit: 0.5 }

describe('useRawWorkflowRefs', () => {
  it('keeps one RAW host and one resource registry across renders', () => {
    const { result, rerender } = renderHook(() =>
      useRawWorkflowRefs({ initialParams: params, initialView: view }),
    )
    const refs = result.current
    const host = refs.rawRuntimeHost
    const registry = refs.resourceRegistryRef.current

    expect(host).toBeDefined()
    expect(registry).toBeTruthy()
    expect(refs.paramsRef.current).toBe(params)
    expect(refs.viewRef.current).toBe(view)

    rerender()

    expect(result.current).toBe(refs)
    expect(result.current.rawRuntimeHost).toBe(host)
    expect(result.current.resourceRegistryRef.current).toBe(registry)
  })

  it('keeps export cancellation apart from the RAW host', () => {
    const { result } = renderHook(() =>
      useRawWorkflowRefs({ initialParams: params, initialView: view }),
    )

    expect(result.current.exportAbortControllerRef.current).toBeNull()
    expect(result.current.exportGraphVersionRef.current).toBe(0)
    expect(result.current.runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('holds no copy of the image session', () => {
    const { result } = renderHook(() =>
      useRawWorkflowRefs({ initialParams: params, initialView: view }),
    )

    expect(Object.keys(result.current)).not.toContain('sessionRef')
    expect(
      Object.keys(result.current).filter((key) => /^session/i.test(key)),
    ).toEqual([])
  })
})
