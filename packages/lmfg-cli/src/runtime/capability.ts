import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import { MAX_CANDIDATES_PER_SWEEP } from '../schemas/plan'
import type { CapabilitiesResult } from '../schemas/results'
import type { MemoryProfile } from './versions'
import { resolveNativeArtifacts, resolveRuntimeVersions } from './versions'

export type RenderTier = 'cpu' | 'browser'

export const CPU_TIER_SUPPORTS = [
  'inspect',
  'source-identity',
  'cpu-preview',
  'lut-contract',
  'manifest',
  'candidate-render',
  'contact-sheet',
  'metrics',
  'cpu-export',
] as const

export const BROWSER_TIER_SUPPORTS = [
  'webgl2-preview',
  'candidate-render',
  'contact-sheet',
  'full-res-export',
] as const

export const BROWSER_TIER_UNAVAILABLE_REASON =
  'The browser bridge tier is not included in this release; use --tier cpu.'

export function detectCapabilities(input: {
  memoryProfile: MemoryProfile
}): CapabilitiesResult {
  const artifacts = resolveNativeArtifacts(input.memoryProfile)
  const available = artifacts.raw_present && artifacts.jpeg_present
  return {
    render_tiers: {
      cpu_wasm: {
        available,
        memory_profile: input.memoryProfile,
        supports: [...CPU_TIER_SUPPORTS],
        artifacts: {
          raw_wasm: artifacts.raw_present,
          jpeg_wasm: artifacts.jpeg_present,
        },
        ...(available
          ? {}
          : {
              reason:
                'Native WASM artifacts are missing; install @lumaforge/luma-native-artifacts.',
            }),
      },
      browser_bridge: {
        available: false,
        supports: [...BROWSER_TIER_SUPPORTS],
        reason: BROWSER_TIER_UNAVAILABLE_REASON,
      },
    },
    active_tier: 'cpu_wasm',
    fallback_order: ['cpu_wasm'],
    runtime_versions: resolveRuntimeVersions(input.memoryProfile),
    limits: {
      max_candidates_per_sweep: MAX_CANDIDATES_PER_SWEEP,
      quick_preview_max_pixels: QUICK_PREVIEW_MAX_PIXELS,
      bounded_hq_max_pixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    },
  }
}

export function assertTierAvailable(tier: RenderTier): void {
  if (tier === 'cpu') return
  throw new LmfgError('tier.unavailable', {
    message: BROWSER_TIER_UNAVAILABLE_REASON,
    suggestedNextActions: ['lmfg capabilities'],
    details: { requested_tier: tier, active_tier: 'cpu_wasm' },
  })
}
