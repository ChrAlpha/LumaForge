import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'

import { createImageSession } from '../model/session-factory'
import { setCurrentSession } from '../state/session.atoms'
import {
  getProcessingParams,
  setProcessingParams,
} from '../state/workflow.atoms'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'

const view: PreviewView = { mode: 'compare', compareSplit: 0.5 }

describe('useRawWorkflowRefs', () => {
  const storedIntent = getProcessingParams()

  afterEach(() => {
    setCurrentSession(null)
    setProcessingParams(storedIntent)
  })

  it('keeps one RAW host and one resource registry across renders', () => {
    const { result, rerender } = renderHook(() =>
      useRawWorkflowRefs({ initialView: view }),
    )
    const refs = result.current
    const host = refs.rawRuntimeHost
    const registry = refs.resourceRegistryRef.current

    expect(host).toBeDefined()
    expect(registry).toBeTruthy()
    expect(refs.viewRef.current).toBe(view)

    rerender()

    expect(result.current).toBe(refs)
    expect(result.current.rawRuntimeHost).toBe(host)
    expect(result.current.resourceRegistryRef.current).toBe(registry)
  })

  it('keeps export cancellation apart from the RAW host', () => {
    const { result } = renderHook(() =>
      useRawWorkflowRefs({ initialView: view }),
    )

    expect(result.current.exportAbortControllerRef.current).toBeNull()
    expect(result.current.exportGraphVersionRef.current).toBe(0)
    expect(result.current.runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('holds no copy of the image session or the color intent', () => {
    // The view is the only state the refs start from.
    expectTypeOf<Parameters<typeof useRawWorkflowRefs>[0]>().toEqualTypeOf<{
      initialView: PreviewView
    }>()
    const { result, rerender } = renderHook(() =>
      useRawWorkflowRefs({ initialView: view }),
    )
    const held = () =>
      Object.values(result.current).map((value) =>
        value && typeof value === 'object' && 'current' in value
          ? value.current
          : value,
      )
    const before = held()

    // A session and a color edit landing in the store, then a rerender,
    // leave every ref holding what it held: none follows either.
    const session = createImageSession(new File(['raw'], 'frame.dng'))
    const intent = { ...getProcessingParams(), userContrast: 25 }
    setCurrentSession(session)
    setProcessingParams(intent)
    rerender()

    expect(held()).toEqual(before)
    expect(held()).not.toContain(session)
    expect(held()).not.toContain(intent)
    expect(result.current).not.toHaveProperty('sessionRef')
    expect(result.current).not.toHaveProperty('paramsRef')
    expect(result.current.viewRef.current).toBe(view)
  })
})
