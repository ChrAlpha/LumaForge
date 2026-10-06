import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useLutContractSummary } from './useLutContractSummary'

describe('useLutContractSummary', () => {
  it('derives display output and recommended review state', () => {
    const recommendation = getLUTColorProfile('sony-sgamut3cine-slog3')
    const resolved = getLUTColorProfile('display-srgb')
    if (!recommendation || !resolved) throw new Error('Missing test profiles')

    const { result } = renderHook(() =>
      useLutContractSummary({
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

    expect(result.current.resolvedProfile?.id).toBe(resolved.id)
    expect(result.current.contractView).toEqual({
      status: 'confirmed',
      profile: resolved,
      output: { kind: 'display-implied' },
    })
    expect(result.current.needsUserSelection).toBe(true)
    expect(
      result.current.profileSuggestions.map((profile) => profile.id),
    ).toContain(recommendation.id)
  })
})
