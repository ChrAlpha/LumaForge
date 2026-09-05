// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { assertTierAvailable, detectCapabilities } from './capability'

describe('capabilities', () => {
  it('reports cpu_wasm as the active tier and the browser bridge as unavailable', () => {
    const caps = detectCapabilities({ memoryProfile: 'desktop' })
    expect(caps.active_tier).toBe('cpu_wasm')
    expect(caps.fallback_order).toEqual(['cpu_wasm'])
    expect(caps.render_tiers.browser_bridge.available).toBe(false)
    expect(caps.render_tiers.browser_bridge.reason).toMatch(/--tier cpu/)
    expect(caps.render_tiers.cpu_wasm.supports).toContain('cpu-export')
    expect(caps.limits.max_candidates_per_sweep).toBe(64)
  })

  it('rejects the browser tier', () => {
    expect(() => assertTierAvailable('cpu')).not.toThrow()
    expect(() => assertTierAvailable('browser')).toThrow(
      expect.objectContaining({ code: 'tier.unavailable', exitCode: 3 }),
    )
  })
})
