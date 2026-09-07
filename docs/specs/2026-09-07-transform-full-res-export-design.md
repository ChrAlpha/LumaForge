# Full-resolution export for Transform geometry

**Date:** 2026-09-07
**Status:** design for implementation
**Applies to:** `packages/render-engine/src/export`, `src/lib/export`,
`src/modules/raw-processor/services/export`, `src/modules/raw-processor/model`.

## Problem

Transform ships today as a preview-only tool. While a geometry is active the
session sets `previewTransformActive`, `deriveUnsupportedExportPipelineReason`
returns "Reset Transform to export this photo", and both the full-resolution
and HQ preview export paths are blocked. The user can straighten a building and
then cannot deliver the photograph.

Export is the authoritative path. Making Transform exportable means applying the
same geometry at full resolution inside the export pipeline, not blessing the
1600 px preview as an output.

## Why this is not a one-line change

The export pipeline is row-band oriented so a 100 MP file can be delivered
inside a browser memory budget:

1. `planExportStrips` cuts the output into full-width horizontal bands.
2. Each band is read from LibRAW with `readProcessedWindow` as linear ProPhoto
   RGB uint16.
3. `createRowBandProcessor` applies the color graph per pixel.
4. `JpegRowWriter` consumes rows strictly top to bottom.

A projective transform is not row-separable. An output row samples along a line
in the source, so the preimage of a full-width output band is a quadrilateral
whose row extent grows with image width. At 30 degrees of rotation on a 12000 px
wide source, one 512-row output band needs roughly 6000 source rows, about
430 MB as uint16 RGB. Reading full-width bands would break the memory contract
that the rest of the export path exists to honour.

## Approach: tile the band, keep the rows sequential

Keep the strip loop and the sequential JPEG writer. Split each output strip into
**column tiles** and read each tile's own preimage.

The preimage of a 2048x512 output tile at 30 degrees has a bounding box of about
2029x1467, roughly 18 MB as uint16 RGB. Both the per-tile source window and the
strip accumulator stay bounded and independent of image size, and the tile count
for a 100 MP export (about 96 windows) stays the same order as today's strip
count.

Per output strip:

1. For each column tile, map the tile's four output corners through the inverse
   matrix to source pixels, take the bounding box, clamp to the source, expand
   by a 2 px halo for bilinear taps.
2. `readProcessedWindow` that rect.
3. Bilinear resample into the strip's uint16 accumulator, recording a coverage
   byte per output pixel.
4. Run the row-band color processor over the accumulator.
5. Paint the matte into uncovered pixels, in output space.
6. Write the rows.

### Geometry runs before color

The resample sits between `processedWindowToRgb16Rows` and
`rowBandProcessor.processUint16Rows`, so interpolation happens in linear
ProPhoto light rather than in gamma-encoded output space. That is the correct
place to blend pixels, and it composes with the existing per-pixel color stage
without reordering the color contract.

The preview resamples after color because it transforms an already-rendered
canvas. Preview and export therefore differ by sub-pixel interpolation, which is
consistent with the standing rule that the preview is not the authoritative
executor. Framing is identical: both derive the output size from the same
resolution-independent crop scale.

### Coverage and the matte

Out-of-source output pixels cannot be given a linear matte value before color,
because a LUT could map it anywhere. The resampler records coverage instead, and
the matte is painted after the color graph using the same `PREVIEW_MATTE`
(18, 20, 25) the preview uses, so an unconstrained crop exports the border the
user saw.

### Framing parity

`cropScale` operates on the unit square and the inverse matrix only, so it is
resolution independent. Full-res output dimensions are
`round(sourceWidth * scale)` by `round(sourceHeight * scale)`, the same
expression `renderTransformedPreview` applies to the preview frame. The preview
and the export frame the same photograph.

## Module boundary

- `packages/render-engine/src/export/geometry/matrix.ts` — Matrix3 multiply,
  invert, apply. Ported, not imported: the engine cannot depend on `src/`.
- `packages/render-engine/src/export/geometry/export-geometry.ts` —
  `planExportGeometry` (validate matrix, derive crop scale and output size),
  `preimageRect` (output rect to source rect), `resampleGeometryTile`
  (bilinear into an accumulator plus coverage).
- `packages/render-engine/src/export/full-res-export.ts` — optional `geometry`
  input; when present, plans strips over output dimensions and runs the tiled
  path.
- `src/lib/export/full-res-export-client.ts` — `geometry` on the worker start
  message (matrix plus constrainCrop, structured-clone safe).
- `src/modules/raw-processor/model` — session records the committed geometry
  instead of only a boolean; export is no longer blocked by it.
- `packages/render-engine/src/manifest` — `RenderParams.geometry` declares the
  matrix, crop mode and output size so the render stays reproducible.

## Observable interface

```ts
export type ExportGeometry = {
  /** Source-normalized to output-normalized, row-major 3x3. */
  matrix: readonly number[]
  constrainCrop: boolean
}

export type PlannedExportGeometry = {
  outputWidth: number
  outputHeight: number
  inverse: Matrix3
  scale: number
  retainedArea: number
}
```

`runFullResolutionJpegExport` accepts `geometry?: ExportGeometry`. Absent, the
existing path runs byte-for-byte unchanged.

## Failure modes

Geometry that cannot be exported must fail closed with a stable code, never a
degraded output:

- `FULL_RES_EXPORT_INVALID_GEOMETRY` — singular matrix, a projective horizon
  crossing the frame, or a retained area under 8 percent. These are the same
  rejections `transform-render` already surfaces in the preview, so a geometry
  the preview refused cannot reach export.
- Resource exhaustion keeps the existing strip-reduction retry. Reducing strip
  rows shrinks the accumulator and each tile's preimage, so the existing ladder
  still helps under geometry.

## Test strategy

Engine (`packages/render-engine`):

- Identity geometry reproduces the ungeometried export path.
- A 90 degree rotation maps a known corner pixel to its expected output corner.
- Framing parity: `planExportGeometry` output dimensions equal the preview's
  `renderTransformedPreview` dimensions for the same matrix and source ratio.
- Tiling invariance: the same geometry exported with different tile widths and
  strip heights produces identical bytes. This is the property that proves the
  bounded path is not an approximation.
- Uncovered pixels receive the matte; covered pixels never do.
- Invalid geometry throws `FULL_RES_EXPORT_INVALID_GEOMETRY`.

App:

- Export readiness allows export while a geometry is active.
- The worker request carries the geometry; the manifest records it.
- Export result dimensions equal the planned geometry output.

Browser: export a real DNG with an active Transform and confirm the delivered
JPEG carries the corrected geometry at full resolution.

## Complexity budget

New engine code stays under roughly 400 lines including the ported matrix
helpers. The existing non-geometry path keeps its current shape; geometry is an
additional branch in strip preparation, not a rewrite. No new worker, no new
storage tier, no second pass over the image.

## Out of scope

- HQ preview export under geometry. It stays blocked with its own reason; the
  bounded HQ preview is a different executor and the full-resolution path is the
  promise worth keeping.
- CLI (`lmfg`) geometry flags. The engine gains the capability and the manifest
  gains the field; exposing it through the CLI protocol is a separate change.
