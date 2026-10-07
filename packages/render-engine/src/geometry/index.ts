// `@lumaforge/render-engine/geometry` subpath entry.
//
// The pure 3x3 projective kernel the export geometry stage runs. This entry
// re-exports that kernel rather than copying it, and must stay free of RAW,
// JPEG and color runtime imports and of browser globals so any consumer can
// load it without initializing a renderer.

export {
  applyMatrix,
  invertMatrix,
  isMatrix3,
  type Matrix3,
  type Point,
} from '../export/geometry/matrix'
