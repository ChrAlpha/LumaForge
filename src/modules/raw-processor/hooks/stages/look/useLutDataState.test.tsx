import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  parseCubeLUT,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useLutDataState } from './useLutDataState'

function createParsedLut(title: string): ParsedLUT {
  const profile = getLUTColorProfile('display-srgb')
  if (!profile) throw new Error('Missing display-srgb profile')

  const cube = `TITLE "${title}"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`
  return {
    ...parseCubeLUT(cube),
    fingerprint: `${title}-fingerprint`,
    profileResolution: {
      kind: 'confirmed',
      confidence: 'metadata',
      profile,
    },
  }
}

describe('useLutDataState', () => {
  it('keeps LUT pipeline data and version in sync with the parsed LUT', async () => {
    const { result, rerender } = renderHook(
      ({ lut }: { lut: ParsedLUT | null }) => useLutDataState(lut),
      {
        initialProps: {
          lut: createParsedLut('Kodak 2383'),
        } as { lut: ParsedLUT | null },
      },
    )

    await waitFor(() => expect(result.current.lutDataVersion).toBe(1))
    expect(result.current.lutDataRef.current?.title).toBe('Kodak 2383')

    rerender({ lut: null })

    await waitFor(() => expect(result.current.lutDataVersion).toBe(2))
    expect(result.current.lutDataRef.current).toBeNull()
  })

  it('allows LUT services to replace data through the shared setter', () => {
    const parsedLut = createParsedLut('Manual')
    const { result } = renderHook(() => useLutDataState(null))
    const versionBeforeManualUpdate = result.current.lutDataVersion

    act(() => {
      result.current.setLutDataRef(toLUTData(parsedLut))
    })

    expect(result.current.lutDataRef.current?.title).toBe('Manual')
    expect(result.current.lutDataVersion).toBe(versionBeforeManualUpdate + 1)
  })
})
