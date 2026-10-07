import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyMatrix } from '@lumaforge/render-engine/geometry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix, rotationMatrix } from '~/lib/transform/geometry/matrix'
import {
  composeManualTransform,
  renderTransformedPreview,
} from '~/lib/transform/transform-render'
import {
  NEUTRAL_TRANSFORM,
  PREVIEW_MATTE,
} from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

function frame(width = 100, height = 80) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([80 + x, 90 + y, 180, 255], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

describe('transform preview resampling', () => {
  it('preserves every opaque pixel and dimensions at identity', () => {
    const input = frame()
    const rendered = renderTransformedPreview(input, identityMatrix(), false)
    expect(rendered.frame).toEqual(input)
    expect(rendered.retainedArea).toBe(1)
  })

  it('uses inverse mapping and rotates a square by ninety degrees', () => {
    const input = frame(80, 80)
    const rendered = renderTransformedPreview(input, rotationMatrix(90), false)
    expect(Array.from(rendered.frame.data.slice(0, 4))).toEqual([
      80, 169, 180, 255,
    ])
  })

  it('crops tilted blank corners while preserving the image aspect', () => {
    const input = frame()
    const matrix = rotationMatrix(12, input.width / input.height)
    const uncropped = renderTransformedPreview(input, matrix, false)
    expect(Array.from(uncropped.frame.data.slice(0, 3))).toEqual(PREVIEW_MATTE)
    const cropped = renderTransformedPreview(input, matrix, true)
    expect(cropped.frame.width).toBeLessThan(input.width)
    expect(cropped.frame.width / cropped.frame.height).toBeCloseTo(1.25, 1)
    expect(cropped.retainedArea).toBeLessThan(1)
    for (let i = 0; i < cropped.frame.data.length; i += 4) {
      expect(cropped.frame.data[i]).toBeGreaterThanOrEqual(80)
      expect(cropped.frame.data[i + 3]).toBe(255)
    }
  })

  it('composites translucent source pixels over the preview matte', () => {
    const input = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        200, 100, 50, 0, 200, 100, 50, 0, 200, 100, 50, 0, 200, 100, 50, 0,
      ]),
    }
    const rendered = renderTransformedPreview(input, identityMatrix(), false)
    for (let i = 0; i < rendered.frame.data.length; i += 4) {
      expect(Array.from(rendered.frame.data.slice(i, i + 4))).toEqual([
        ...PREVIEW_MATTE,
        255,
      ])
    }
  })

  it('composes offsets and physical rotation without moving the neutral center', () => {
    const neutral = composeManualTransform(
      identityMatrix(),
      NEUTRAL_TRANSFORM,
      1.5,
    )
    expect(applyMatrix(neutral, { x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 })
    const shifted = composeManualTransform(
      identityMatrix(),
      { ...NEUTRAL_TRANSFORM, offsetX: 10 },
      1.5,
    )
    expect(applyMatrix(shifted, { x: 0.5, y: 0.5 })?.x).toBeCloseTo(0.6)
  })

  it('rejects a projection that folds inside the frame it would render', () => {
    // The forward denominator keeps one sign across the source, so the old
    // guard passed this; the inverse still changes sign across the output.
    // Rendering past that line is not a projection of the photograph, and the
    // full-resolution export refuses it, so the preview must not show it.
    const folding = [
      0.8928, -0.0402, 0.0737, 0.7931, 0.5803, -0.1867, 0.9196, 0.2946, 0.3929,
    ] as const

    expect(() =>
      renderTransformedPreview(
        { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) },
        folding,
        false,
      ),
    ).toThrow('invalid-transform')
  })

  it('rejects a singular transform and a projective horizon through the image', () => {
    expect(() =>
      renderTransformedPreview(frame(), [0, 0, 0, 0, 0, 0, 0, 0, 1], true),
    ).toThrow('invalid-transform')
    expect(() =>
      renderTransformedPreview(frame(), [1, 0, 0, 0, 1, 0, 0, 2, -1], true),
    ).toThrow('invalid-transform')
  })

  it('rejects a constrained crop below the minimum retained edge', () => {
    const shrinkAboutCenter = (scale: number) =>
      [scale, 0, (1 - scale) / 2, 0, scale, (1 - scale) / 2, 0, 0, 1] as const
    const kept = renderTransformedPreview(frame(), shrinkAboutCenter(0.5), true)
    expect(kept.retainedArea).toBeCloseTo(0.25, 6)
    expect(kept.frame.width).toBe(50)
    expect(kept.frame.height).toBe(40)
    expect(() =>
      renderTransformedPreview(frame(), shrinkAboutCenter(0.05), true),
    ).toThrow('invalid-transform')
    expect(
      renderTransformedPreview(frame(), shrinkAboutCenter(0.05), false)
        .retainedArea,
    ).toBe(1)
  })

  it('rejects a frame whose pixel buffer does not match its dimensions', () => {
    expect(() =>
      renderTransformedPreview(
        { width: 4, height: 4, data: new Uint8ClampedArray(4) },
        identityMatrix(),
        false,
      ),
    ).toThrow('invalid-image')
  })
})

describe('transform worker protocol', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function bootWorker() {
    const postMessage = vi.fn()
    const workerScope: {
      postMessage: typeof postMessage
      onmessage?: (event: MessageEvent<TransformWorkerRequest>) => void
    } = { postMessage }
    vi.stubGlobal('self', workerScope)
    vi.resetModules()
    await import('~/lib/transform/transform.worker')
    const send = (data: TransformWorkerRequest) =>
      workerScope.onmessage!({ data } as MessageEvent<TransformWorkerRequest>)
    return { postMessage, send }
  }

  it('acknowledges analysis and renders only the current source', async () => {
    const { postMessage, send } = await bootWorker()
    const input = frame(4, 4)
    send({ type: 'analyze', sourceId: 1, frame: input })
    const analyzed = postMessage.mock.lastCall?.[0] as TransformWorkerResponse
    expect(analyzed).toMatchObject({ type: 'analyzed', sourceId: 1 })
    expect(Object.keys(analyzed).sort()).toEqual([
      'analysis',
      'elapsedMs',
      'sourceId',
      'type',
    ])

    postMessage.mockClear()
    send({ type: 'clear', sourceId: 2 })
    send({
      type: 'render',
      sourceId: 1,
      requestId: 1,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    send({
      type: 'render',
      sourceId: 2,
      requestId: 2,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    expect(postMessage).not.toHaveBeenCalled()

    send({ type: 'analyze', sourceId: 3, frame: input })
    send({
      type: 'render',
      sourceId: 3,
      requestId: 3,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    const [rendered, options] = postMessage.mock.lastCall as [
      Extract<TransformWorkerResponse, { type: 'rendered' }>,
      { transfer: ArrayBuffer[] },
    ]
    expect(rendered).toMatchObject({
      type: 'rendered',
      sourceId: 3,
      requestId: 3,
    })
    expect(rendered.result.frame).toEqual(input)
    expect(rendered.result.retainedArea).toBe(1)
    expect(options.transfer).toEqual([rendered.result.frame.data.buffer])
  })

  it('reports a rejected render with its request id', async () => {
    const { postMessage, send } = await bootWorker()
    send({ type: 'analyze', sourceId: 5, frame: frame(4, 4) })
    send({
      type: 'render',
      sourceId: 5,
      requestId: 9,
      matrix: [0, 0, 0, 0, 0, 0, 0, 0, 1],
      constrainCrop: false,
    })
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      sourceId: 5,
      requestId: 9,
      message: 'invalid-transform',
    } satisfies TransformWorkerResponse)
  })
})

describe('production transform renderer ownership', () => {
  const sources = [
    'src/lib/transform/transform-render.ts',
    'src/lib/transform/worker-protocol.ts',
    'src/lib/transform/transform.worker.ts',
    'src/lib/transform/preview-dimensions.ts',
    'src/modules/raw-processor/components/TransformCanvas.tsx',
  ]

  it('imports no demo implementation', () => {
    for (const file of sources) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/transform-demo/)
    }
  })

  it('keeps React out of the worker-side modules', () => {
    for (const file of sources.filter((path) => path.endsWith('.ts'))) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/from\s+['"](?:react|react-dom)[/'"]/)
    }
  })

  it('keeps the only renderer, worker, and canvas outside the demo module', () => {
    for (const file of [
      'transform-render.ts',
      'transform-render.test.ts',
      'transform-types.ts',
      'preview-types.ts',
      'worker-protocol.ts',
      'transform.worker.ts',
      'TransformCanvas.tsx',
    ]) {
      expect(
        existsSync(resolve(process.cwd(), 'src/modules/transform-demo', file)),
        file,
      ).toBe(false)
    }
  })
})
