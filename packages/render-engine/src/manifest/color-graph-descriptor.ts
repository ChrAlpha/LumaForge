// Color-graph descriptor v2 — the JSON-safe, hashable projection of a resolved
// `SupportedExportColorGraphDescriptor` recorded in `RenderManifest.color_graph`.
//
// Only render-relevant facts are kept: typed arrays become plain arrays, the
// 3D LUT table is replaced by its SHA-256 and length, and the LUT profile is
// reduced to the effective color contract (labels, aliases, and optional-field
// presence would otherwise leak into the fingerprint).

import type {
  ExportColorGraphStep,
  LUTColorProfile,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'

import { canonicalizeJson } from './canonicalize'
import type { ColorGraphIdentity } from './render-manifest'
import { sha256Hex } from './streaming-sha256'

export const COLOR_GRAPH_DESCRIPTOR_VERSION = 2 as const

export type ColorGraphLutProfileDescriptor = {
  role: string
  input: { gamut: string; transfer: string; range: string }
  output: { gamut: string; transfer: string; range: string }
}

export type ColorGraphDescriptor = {
  descriptor_version: typeof COLOR_GRAPH_DESCRIPTOR_VERSION
  output_gamut: string
  output_transfer: string
  lut_profile: ColorGraphLutProfileDescriptor | null
  steps: unknown[]
}

function toJsonSafe(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonSafe(item),
      ]),
    )
  }
  return value
}

function describeStep(step: ExportColorGraphStep): unknown {
  if (step.kind === 'lut3d') {
    const bytes = new Uint8Array(
      step.data.buffer,
      step.data.byteOffset,
      step.data.byteLength,
    )
    return {
      kind: 'lut3d',
      size: step.size,
      domain_min: [...step.domainMin],
      domain_max: [...step.domainMax],
      data_length: step.data.length,
      data_sha256: sha256Hex(bytes),
      data_encoding: 'float32-le',
    }
  }
  return toJsonSafe(step)
}

export function describeLutProfile(
  profile: LUTColorProfile | null,
): ColorGraphLutProfileDescriptor | null {
  if (!profile) return null
  const outputTransfer =
    profile.outputTransfer ??
    (profile.role === 'display-look' ? profile.inputTransfer : 'unknown')
  return {
    role: profile.role,
    input: {
      gamut: profile.inputGamut,
      transfer: profile.inputTransfer,
      // The row processor only special-cases 'legal'; unspecified or unknown
      // input ranges render as full, so the descriptor records that value.
      range: profile.inputRange === 'legal' ? 'legal' : 'full',
    },
    output: {
      gamut: profile.outputGamut ?? profile.inputGamut,
      transfer: outputTransfer,
      range: profile.outputRange ?? 'full',
    },
  }
}

export function describeColorGraph(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphDescriptor {
  return {
    descriptor_version: COLOR_GRAPH_DESCRIPTOR_VERSION,
    output_gamut: graph.outputGamut,
    output_transfer: graph.outputTransfer,
    lut_profile: describeLutProfile(graph.lutProfile),
    steps: graph.steps.map(describeStep),
  }
}

const TEXT_ENCODER = new TextEncoder()

export function fingerprintColorGraph(
  descriptor: ColorGraphDescriptor,
): string {
  return sha256Hex(TEXT_ENCODER.encode(canonicalizeJson(descriptor)))
}

export function colorGraphIdentity(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphIdentity {
  const descriptor = describeColorGraph(graph)
  return { fingerprint: fingerprintColorGraph(descriptor), descriptor }
}
