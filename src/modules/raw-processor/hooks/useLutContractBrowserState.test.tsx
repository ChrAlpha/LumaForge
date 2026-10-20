import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useLutContractBrowserState } from './useLutContractBrowserState'

describe('useLutContractBrowserState', () => {
  it('derives shared contract profile and output browser state', () => {
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')
    if (!profile) throw new Error('Missing test profile')
    const currentProfile = {
      ...profile,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    const { result } = renderHook(() =>
      useLutContractBrowserState({
        query: 'sony',
        suggestions: [profile],
        currentProfile,
      }),
    )

    expect(result.current.searchResults.map((profile) => profile.id)).toContain(
      profile.id,
    )
    expect(
      result.current.visibleSuggestions.map((profile) => profile.id),
    ).toContain(profile.id)
    expect(result.current.activeOutputOptionId).toBe(
      `${currentProfile.id}:declared-output`,
    )
    expect(result.current.hasInputMatches).toBe(true)
    expect(result.current.hasOutputMatches).toBe(true)
  })
  it('lists Rec.2100 HDR carriers as inputs but never offers them as outputs', () => {
    const { result } = renderHook(() =>
      useLutContractBrowserState({ query: 'Rec.2100', suggestions: [] }),
    )
    const inputIds = result.current.groupedInputProfiles.flatMap((group) =>
      group.items.map((profile) => profile.id),
    )
    const outputIds = result.current.groupedOutputOptions.flatMap((group) =>
      group.items.map((option) => option.sourceProfile.id),
    )

    expect(inputIds).toEqual(
      expect.arrayContaining(['rec2100-pq', 'rec2100-hlg']),
    )
    expect(outputIds).not.toContain('rec2100-pq')
    expect(outputIds).not.toContain('rec2100-hlg')
  })
})
