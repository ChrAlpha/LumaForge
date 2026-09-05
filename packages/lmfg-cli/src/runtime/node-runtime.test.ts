// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { detectCapabilities } from './capability'
import { createLmfgRuntime } from './node-runtime'

const hasArtifacts = detectCapabilities({ memoryProfile: 'desktop' })
  .render_tiers.cpu_wasm.available
const d = hasArtifacts ? describe : describe.skip

d('createLmfgRuntime', () => {
  it('lazily creates and disposes both runtimes', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const raw = await runtime.raw()
    expect(await raw.init()).toMatchObject({
      runtime: 'luma',
      memoryProfile: 'desktop',
    })
    expect(await runtime.raw()).toBe(raw)
    const jpeg = await runtime.jpeg()
    expect(typeof jpeg.createEncoder).toBe('function')
    runtime.dispose()
    runtime.dispose()
  }, 30_000)
})
