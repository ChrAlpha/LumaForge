import type { ExportGeometry } from '@lumaforge/render-engine/export'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession, TransformState } from '../model/session'
import {
  createImageSession,
  createTransformState,
} from '../model/session-factory'
import type {
  TransformEvent,
  TransformStatus,
} from '../services/transform/transform-state'
import {
  deriveTransformStatus,
  reduceTransformState,
} from '../services/transform/transform-state'

export type TestSessionOverrides = Omit<
  Partial<ImageSession>,
  'sourceFile' | 'previewBundle' | 'viewState' | 'exportState'
> & {
  sourceFile?: Partial<ImageSession['sourceFile']>
  previewBundle?: Partial<ImageSession['previewBundle']>
  viewState?: Partial<ImageSession['viewState']>
  exportState?: Partial<ImageSession['exportState']>
}

/**
 * A session as a load creates it, with a fixed id and creation time a test
 * can name. The source file, preview bundle, view and export records merge
 * their overrides over the fresh session's; the Transform belongs to the id.
 */
export function createTestSession({
  id = 'session-1',
  sourceFile,
  previewBundle,
  viewState,
  exportState,
  ...overrides
}: TestSessionOverrides = {}): ImageSession {
  const fresh = createImageSession(new File(['raw'], 'frame.ARW'))
  return {
    ...fresh,
    id,
    createdAt: 1,
    transform: createTransformState(id),
    ...overrides,
    sourceFile: { ...fresh.sourceFile, ...sourceFile },
    previewBundle: { ...fresh.previewBundle, ...previewBundle },
    viewState: { ...fresh.viewState, ...viewState },
    exportState: { ...fresh.exportState, ...exportState },
  }
}

/**
 * A session whose quick and bounded-HQ previews landed, shown at bounded HQ,
 * with the export probe answered for the full frame. Overrides merge into the
 * same records as `createTestSession`'s.
 */
export function createLoadedTestSession({
  previewBundle,
  exportState,
  ...overrides
}: TestSessionOverrides = {}): ImageSession {
  return createTestSession({
    ...overrides,
    previewBundle: {
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 1600, height: 1200 },
      displaySource: 'bounded-hq',
      ...previewBundle,
    },
    exportState: {
      fullResCapability: { status: 'supported', width: 1600, height: 1200 },
      ...exportState,
    },
  })
}

/**
 * A decoded quick frame in the one layout a decode produces, RGB16 linear
 * ProPhoto, with zeroed pixels sized to the frame unless `data` is given.
 */
export function createTestDecodedImage(
  overrides: Partial<DecodedImage> = {},
): DecodedImage {
  const width = overrides.width ?? 400
  const height = overrides.height ?? 300
  return {
    width,
    height,
    data: new Uint16Array(width * height * 3),
    source: 'quick',
    metadata: { width, height },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    ...overrides,
  }
}

const SAMPLE_GEOMETRY: ExportGeometry = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

/**
 * A source's Transform driven to `status` through the events the preview
 * raises: an edit and its frame capture, then the request, its answer, its
 * failure, or a capture failure.
 */
export function transformAt(
  status: TransformStatus,
  sourceId = 'session-1',
  geometry: ExportGeometry = SAMPLE_GEOMETRY,
): TransformState {
  const neutral = createTransformState(sourceId)
  const frame = { sourceId, captureKey: 'k', clientEpoch: 1 }
  const request = { ...frame, requestId: 1, geometry }
  const events: TransformEvent[] = []
  if (status !== 'neutral') {
    events.push(
      {
        type: 'edit',
        sourceId,
        intent: { manual: { ...neutral.intent.manual, rotate: 2 } },
      },
      { type: 'capture', ...frame },
    )
  }
  if (status === 'pending' || status === 'accepted' || status === 'invalid') {
    events.push({ type: 'request', ...request })
  }
  if (status === 'accepted') {
    events.push({
      type: 'rendered',
      ...request,
      frame: { width: 800, height: 600 },
    })
  }
  if (status === 'invalid') {
    events.push({
      type: 'render-failed',
      ...frame,
      requestId: 1,
      failure: 'transform',
    })
  }
  if (status === 'unavailable')
    events.push({ type: 'capture-failed', ...frame })
  const state = events.reduce(reduceTransformState, neutral)
  if (deriveTransformStatus(state) !== status) {
    throw new Error(`expected a ${status} Transform`)
  }
  return state
}

/** An identity `.cube` of `size` points per axis, titled `title`. */
export function createTestCube(title: string, size = 17): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r * step} ${g * step} ${b * step}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * A `.cube` file of `createTestCube`; jsdom's File cannot read text, so the
 * file answers `text()` itself.
 */
export function createTestCubeFile(title: string, name: string, size = 17) {
  const content = createTestCube(title, size)
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

/** A `.cube` file whose bytes arrive only when the test calls `finishRead`. */
export function createDeferredTestCubeFile(title: string, name: string) {
  const bytes = new TextEncoder().encode(createTestCube(title))
  let finishRead!: () => void
  const read = new Promise<ArrayBuffer>((resolve) => {
    finishRead = () => resolve(bytes.buffer)
  })
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', { value: () => read })
  return { file, finishRead }
}
