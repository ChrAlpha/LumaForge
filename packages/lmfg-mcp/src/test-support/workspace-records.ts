// Workspace records in the shapes the lmfg CLI writes, for MCP readers
// that consume them. Params predate selective_color, as lmfg 0.1.0 wrote
// them; manifests omit every field the v1 shape marks optional.

import { computeManifestSha256 } from '@lumaforge/render-engine'

type Dimensions = { width: number; height: number }

export function sessionRecord(
  id: string,
  source: { sha256: string; byte_size: number },
) {
  return {
    schema: 'lmfg.session.v1',
    id,
    created_at: '2026-09-05T04:12:19.000Z',
    updated_at: '2026-09-05T04:13:02.512Z',
    workspace_root: '/work/.lmfg',
    source: {
      path: '/work/DSC00001.ARW',
      filename: 'DSC00001.ARW',
      ...source,
    },
    decoded_dimensions: { width: 6000, height: 4000 },
    counters: { previews: 1, iterations: 1, exports: 1 },
    status: 'inspected',
  }
}

const params010 = {
  exposure_ev: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  intensity: 1,
  raw_render_exposure: 'auto',
  lut: null,
}

export function iterationRecord(
  id: string,
  sessionId: string,
  candidates: Array<{ id: string; tag: string | null }>,
) {
  return {
    schema: 'lmfg.iteration.v1',
    id,
    session_id: sessionId,
    created_at: '2026-09-05T04:13:02.500Z',
    kind: 'sweep',
    base: params010,
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      params: { ...params010, contrast: index * 10 },
    })),
    options: {
      max_pixels: 2_500_000,
      quality: 85,
      contact_sheet: { cols: candidates.length, tile_width: 1, gap: 0 },
    },
  }
}

export function contactSheetMap(
  iterationId: string,
  size: Dimensions,
  tiles: Array<
    { candidate_id: string } & Dimensions & { x: number; y: number }
  >,
) {
  return {
    schema: 'lmfg.contact-sheet-map.v1',
    iteration_id: iterationId,
    cols: tiles.length,
    rows: 1,
    tile_width: tiles[0].width,
    tile_height: tiles[0].height,
    gap: 0,
    ...size,
    tiles: tiles.map((tile, index) => ({ ...tile, index })),
  }
}

export function seal<T extends object>(manifest: T) {
  return { ...manifest, manifest_sha256: computeManifestSha256(manifest) }
}

export function renderManifest(input: {
  kind: 'preview' | 'candidate' | 'export'
  source: { sha256: string; byte_size: number }
  decoded: Dimensions
  output: { filename: string; sha256: string } & Dimensions
  parent?: string | null
}) {
  const { width, height, ...file } = input.output
  return {
    manifest_version: 1,
    kind: input.kind,
    produced_at: '2026-09-05T04:13:02.512Z',
    parent_manifest_sha256: input.parent ?? null,
    source_raw: {
      ...input.source,
      filename: 'DSC00001.ARW',
      decoded_dimensions: input.decoded,
    },
    calibration: null,
    lut: null,
    color_graph: { fingerprint: 'd'.repeat(64), descriptor: {} },
    render_params: { exposure_ev: 0 },
    policy: {
      kind:
        input.kind === 'export'
          ? 'export-full'
          : input.kind === 'candidate'
            ? 'candidate'
            : 'preview-quick',
      row_slice: 512,
      concurrency: 1,
    },
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.1',
      luma_raw_runtime: '0.1.2',
      luma_jpeg_runtime: '0.1.1',
      native_artifacts: { build_id: 'unknown', variant: 'desktop' },
    },
    output: {
      format: 'jpeg',
      dimensions: { width, height },
      color_space: 'srgb',
      quality: 85,
      ...file,
    },
  }
}
