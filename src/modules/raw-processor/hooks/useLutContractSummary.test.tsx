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

  it('keeps a confirmed contract out of review', () => {
    const profile = getLUTColorProfile('display-srgb')
    if (!profile) throw new Error('Missing test profile')

    const { result } = renderHook(() =>
      useLutContractSummary({
        lutProfileSelection: null,
        lutProfileResolution: {
          kind: 'confirmed',
          confidence: 'metadata',
          profile,
        },
      }),
    )

    expect(result.current.resolvedProfile?.id).toBe(profile.id)
    expect(result.current.contractView).toEqual({
      status: 'confirmed',
      profile,
      output: { kind: 'display-implied' },
    })
    expect(result.current.needsUserSelection).toBe(false)
    expect(result.current.profileSuggestions).toEqual([])
  })

  it('asks for a contract while it is unconfirmed', () => {
    const recommendation = getLUTColorProfile('sony-sgamut3cine-slog3')
    if (!recommendation) throw new Error('Missing test profile')

    const { result } = renderHook(() =>
      useLutContractSummary({
        lutProfileSelection: null,
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [recommendation],
        },
      }),
    )

    expect(result.current.resolvedProfile).toBeUndefined()
    expect(result.current.contractView).toEqual({
      status: 'recommended',
      recommendation,
      recommendations: [recommendation],
      completesContract: false,
    })
    expect(result.current.needsUserSelection).toBe(true)
    expect(result.current.profileSuggestions).toEqual([recommendation])
  })

  it('reports an unsupported output and keeps its suggestions', () => {
    const recommendation = getLUTColorProfile('sony-sgamut3cine-slog3')
    if (!recommendation) throw new Error('Missing test profile')

    const { result } = renderHook(() =>
      useLutContractSummary({
        lutProfileSelection: null,
        lutProfileResolution: {
          kind: 'unsupported-output',
          recommendations: [recommendation],
        },
      }),
    )

    expect(result.current.resolvedProfile).toBeUndefined()
    expect(result.current.contractView).toEqual({
      status: 'unsupported-output',
      recommendations: [recommendation],
    })
    expect(result.current.needsUserSelection).toBe(true)
    expect(result.current.profileSuggestions).toEqual([recommendation])
  })

  it('needs no review before a resolution exists', () => {
    const { result } = renderHook(() =>
      useLutContractSummary({
        lutProfileSelection: null,
        lutProfileResolution: null,
      }),
    )

    expect(result.current.resolvedProfile).toBeUndefined()
    expect(result.current.contractView).toEqual({ status: 'unknown' })
    expect(result.current.needsUserSelection).toBe(false)
    expect(result.current.profileSuggestions).toEqual([])
  })
})
