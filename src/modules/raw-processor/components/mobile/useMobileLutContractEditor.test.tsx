import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useMobileLutContractEditor } from './useMobileLutContractEditor'

describe('useMobileLutContractEditor', () => {
  it('derives recommended contract profiles and output choices', () => {
    const recommendation = getLUTColorProfile('sony-sgamut3cine-slog3')
    const resolved = getLUTColorProfile('display-srgb')
    if (!recommendation || !resolved) throw new Error('Missing test profiles')

    const { result } = renderHook(() =>
      useMobileLutContractEditor({
        onLutProfileSelect: vi.fn(),
        onComplete: vi.fn(),
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'lut-test',
          profileId: resolved.id,
          confidence: 'user',
        },
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [recommendation],
        },
      }),
    )
    act(() => result.current.setContractQuery('sony'))

    expect(result.current.resolvedProfile?.id).toBe(resolved.id)
    expect(
      result.current.visibleSuggestions.map((profile) => profile.id),
    ).toContain(recommendation.id)
    expect(result.current.contractView).toEqual({
      status: 'confirmed',
      profile: resolved,
      output: { kind: 'display-implied' },
    })
    expect(result.current.activeOutputOptionId).toBeUndefined()
    expect(result.current.hasInputMatches).toBe(true)
    expect(result.current.hasOutputMatches).toBe(true)
  })

  it('keeps the active output option for a confirmed full output contract', () => {
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')
    if (!profile) throw new Error('Missing test profile')
    const confirmedProfile = {
      ...profile,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    const { result } = renderHook(() =>
      useMobileLutContractEditor({
        onLutProfileSelect: vi.fn(),
        onComplete: vi.fn(),
        lutProfileResolution: {
          kind: 'confirmed',
          profile: confirmedProfile,
          confidence: 'metadata',
        },
      }),
    )
    act(() => result.current.setContractQuery('sony'))

    expect(result.current.resolvedProfile?.id).toBe(profile.id)
    expect(result.current.contractView).toEqual({
      status: 'confirmed',
      profile: confirmedProfile,
      output: {
        kind: 'declared',
        gamut: 'srgb-rec709',
        transfer: 'srgb',
        range: 'full',
        displayLike: true,
      },
    })
    expect(result.current.activeOutputOptionId).toBe(
      `${profile.id}:declared-output`,
    )
    expect(result.current.hasOutputMatches).toBe(true)
  })
})
