// @vitest-environment node
import {
  generateIdentityLUT,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  colorGraphIdentity,
  describeColorGraph,
  fingerprintColorGraph,
} from './color-graph-descriptor'

const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }

function graphFor(input: { contrast?: number; lut?: boolean }) {
  const graph = resolveExportColorGraph({
    styleKind: input.lut ? 'custom' : 'none',
    intensity: 1,
    builtinPreset: null,
    lut: input.lut ? toLUTData(generateIdentityLUT(17)) : null,
    rawRenderExposure: exposure,
    userContrast: input.contrast ?? 0,
  })
  if (!graph.supported) throw new Error(graph.message)
  return graph
}

describe('color-graph descriptor', () => {
  it('is stable for equal graphs and differs when a step changes', () => {
    const a = fingerprintColorGraph(
      describeColorGraph(graphFor({ contrast: 10 })),
    )
    const b = fingerprintColorGraph(
      describeColorGraph(graphFor({ contrast: 10 })),
    )
    const c = fingerprintColorGraph(
      describeColorGraph(graphFor({ contrast: 11 })),
    )
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replaces LUT tables with a hash, converts typed arrays, and normalizes the profile', () => {
    const descriptor = describeColorGraph(graphFor({ lut: true }))
    expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
    const lutStep = descriptor.steps.find(
      (step) => (step as { kind: string }).kind === 'lut3d',
    ) as Record<string, unknown>
    expect(lutStep.data).toBeUndefined()
    expect(lutStep.data_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lutStep.data_length).toBe(17 * 17 * 17 * 3)
    const matrixStep = descriptor.steps.find(
      (step) => (step as { kind: string }).kind === 'gamut-to-lut-input',
    ) as Record<string, unknown>
    expect(Array.isArray(matrixStep.matrix)).toBe(true)
    expect(descriptor.lut_profile).toEqual({
      role: 'display-look',
      input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
      output: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
    })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
  })

  it('produces a ColorGraphIdentity whose fingerprint matches its descriptor', () => {
    const identity = colorGraphIdentity(graphFor({}))
    expect(identity.fingerprint).toBe(
      fingerprintColorGraph(
        identity.descriptor as ReturnType<typeof describeColorGraph>,
      ),
    )
  })
})
