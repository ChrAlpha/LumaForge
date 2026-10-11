// Executability of the geometry a structurally verified manifest records.
//
// `parseRenderManifest` proves a manifest has the shape the current writers
// record; it does not prove the export it describes can be produced. This
// reader answers that from the manifest alone, with the same planner the
// full-resolution export runs:
//   - Only full-resolution exports apply a geometry. A preview or candidate
//     manifest that records one is refused; without one it has no export
//     frame to check.
//   - With a geometry, the planner run on the recorded decoded source frame
//     must accept it and plan exactly the recorded geometry output, and the
//     recorded output must be that frame.
//   - Without a geometry, the recorded output must be the decoded source
//     frame.
// Nothing is decoded, read or written here, and the manifest is not changed.

import type { ExportGeometry } from '../export/geometry/export-geometry'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '../export/geometry/export-geometry'
import type { RenderManifest, RenderManifestKind } from './render-manifest'

export type RecordedDimensions = {
  readonly width: number
  readonly height: number
}

/** What an export manifest says its export reads, applies, and delivers. */
export type RecordedExportFrame = {
  /** The decoded source frame the export reads. */
  readonly source: RecordedDimensions
  /** The frame the export delivers: the source, or the planned geometry output. */
  readonly output: RecordedDimensions
  /** The recorded geometry in the planner's form; null when none was applied. */
  readonly geometry: ExportGeometry | null
}

export type RecordedGeometryRefusal =
  | {
      /** A preview or candidate manifest records a geometry it never applied. */
      readonly reason: 'non-export-geometry'
      readonly kind: Exclude<RenderManifestKind, 'export'>
    }
  | {
      /** The planner refuses the geometry on the recorded source frame. */
      readonly reason: 'unplannable-geometry'
      readonly source: RecordedDimensions
      /** The planner's own refusal. */
      readonly cause: Error
    }
  | {
      /** The recorded geometry output is not the frame the planner plans. */
      readonly reason: 'geometry-output-mismatch'
      readonly source: RecordedDimensions
      readonly recorded: RecordedDimensions
      readonly planned: RecordedDimensions
    }
  | {
      /** The recorded output is not the frame the source or geometry delivers. */
      readonly reason: 'output-mismatch'
      readonly deliveredBy: 'geometry' | 'source'
      readonly recorded: RecordedDimensions
      readonly delivered: RecordedDimensions
    }

export type RecordedGeometryCheck =
  | {
      readonly ok: true
      /** Null for a preview or candidate manifest, which records no geometry. */
      readonly frame: RecordedExportFrame | null
    }
  | { readonly ok: false; readonly refusal: RecordedGeometryRefusal }

function dimensionsOf(value: RecordedDimensions): RecordedDimensions {
  return { width: value.width, height: value.height }
}

function sameDimensions(a: RecordedDimensions, b: RecordedDimensions): boolean {
  return a.width === b.width && a.height === b.height
}

/**
 * Checks, from a manifest `parseRenderManifest` accepted, that the recorded
 * geometry and output dimensions describe an export the engine can produce.
 * A planner refusal is returned with the planner's error as its cause; any
 * other error the planner throws is not a refusal and propagates.
 */
export function checkRecordedExportGeometry(
  manifest: RenderManifest,
): RecordedGeometryCheck {
  const recorded = manifest.render_params.geometry
  if (manifest.kind !== 'export') {
    if (recorded === undefined) return { ok: true, frame: null }
    return {
      ok: false,
      refusal: { reason: 'non-export-geometry', kind: manifest.kind },
    }
  }

  const source = dimensionsOf(manifest.source_raw.decoded_dimensions)
  const output = dimensionsOf(manifest.output.dimensions)
  let geometry: ExportGeometry | null = null
  let delivered = source
  if (recorded) {
    geometry = {
      matrix: [...recorded.matrix],
      constrainCrop: recorded.constrain_crop,
    }
    try {
      const planned = planExportGeometry(geometry, source)
      delivered = { width: planned.outputWidth, height: planned.outputHeight }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== INVALID_EXPORT_GEOMETRY
      )
        throw error
      return {
        ok: false,
        refusal: { reason: 'unplannable-geometry', source, cause: error },
      }
    }
    if (!sameDimensions(recorded.output, delivered)) {
      return {
        ok: false,
        refusal: {
          reason: 'geometry-output-mismatch',
          source,
          recorded: dimensionsOf(recorded.output),
          planned: delivered,
        },
      }
    }
  }

  if (!sameDimensions(output, delivered)) {
    return {
      ok: false,
      refusal: {
        reason: 'output-mismatch',
        deliveredBy: geometry ? 'geometry' : 'source',
        recorded: output,
        delivered,
      },
    }
  }
  return { ok: true, frame: { source, output, geometry } }
}
