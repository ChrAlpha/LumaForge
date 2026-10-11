import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import type { ComparePreviewStageProps } from './ComparePreviewStage'
import { ComparePreviewStage } from './ComparePreviewStage'
import type { PreviewCanvasProps } from './PreviewCanvas'

const stageProps = vi.hoisted(() => ({
  canvas: [] as Array<Record<string, unknown>>,
  splitHandle: [] as Array<Record<string, unknown>>,
}))

vi.mock('./PreviewCanvas', () => ({
  PreviewCanvas: (props: Record<string, unknown>) => {
    stageProps.canvas.push(props)
    return <div data-testid="gpu-preview-canvas" />
  },
}))
vi.mock('./CompareSplitHandle', () => ({
  CompareSplitHandle: (props: Record<string, unknown>) => {
    stageProps.splitHandle.push(props)
    return <div data-testid="split-handle" />
  },
}))

const acceptedFrame: DecodedPreviewFrame = {
  sessionId: 'session-1',
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: 400,
  height: 300,
  exposure: {
    kind: 'unpinned',
    value: { ev: 0, multiplier: 1, source: 'identity' },
  },
  quickPredecessorFrameId: null,
}

function stage(
  overrides: Partial<ComponentProps<typeof ComparePreviewStage>> = {},
) {
  return (
    <ComparePreviewStage
      hasImage
      imageRef={{ current: null }}
      imageVersion={1}
      decodedFrame={null}
      color={{
        styleKind: 'none',
        builtinPreset: null,
        intensity: 0.7,
        ...NEUTRAL_USER_COLOR_INTENT,
      }}
      viewMode="compare"
      lutDataRef={{ current: null }}
      lutDataVersion={0}
      displaySource="quick"
      split={0.4}
      isProcessing={false}
      phase="processing"
      progress={0}
      onRawDrop={vi.fn()}
      onSplitChange={vi.fn()}
      {...overrides}
    />
  )
}

describe('comparePreviewStage', () => {
  afterEach(() => {
    cleanup()
    stageProps.canvas.length = 0
    stageProps.splitHandle.length = 0
  })

  it('requires every composition to name the accepted frame, null included', () => {
    expectTypeOf<
      Pick<ComparePreviewStageProps, 'decodedFrame'>
    >().toEqualTypeOf<{ decodedFrame: DecodedPreviewFrame | null }>()
    expectTypeOf<Pick<PreviewCanvasProps, 'decodedFrame'>>().toEqualTypeOf<{
      decodedFrame: DecodedPreviewFrame | null
    }>()
  })

  it('hands the canvas the descriptor it received, not a copy', () => {
    render(stage({ decodedFrame: acceptedFrame }))

    expect(stageProps.canvas.at(-1)!.decodedFrame).toBe(acceptedFrame)
  })

  it('follows a newly accepted frame on rerender', () => {
    const { rerender } = render(stage({ decodedFrame: acceptedFrame }))
    const successor: DecodedPreviewFrame = {
      ...acceptedFrame,
      frameId: 'decoded-frame-2',
      stage: 'bounded-hq',
      quickPredecessorFrameId: acceptedFrame.frameId,
    }

    rerender(stage({ decodedFrame: successor, imageVersion: 2 }))

    expect(stageProps.canvas.at(-1)!.decodedFrame).toBe(successor)
  })

  it('hands the canvas no descriptor while none is accepted', () => {
    render(stage({ displaySource: 'embedded', decodedFrame: null }))
    expect(stageProps.canvas.at(-1)!.decodedFrame).toBeNull()
  })

  it('keeps the empty sample and the split handle without a canvas before a source loads', () => {
    const onSplitChange = vi.fn()
    const { container } = render(
      stage({ hasImage: false, decodedFrame: null, onSplitChange }),
    )

    expect(stageProps.canvas).toHaveLength(0)
    expect(container.querySelector('.raw-lab-sample')).not.toBeNull()
    expect(container.querySelector('[data-raw-upload-dock]')).not.toBeNull()
    const handle = stageProps.splitHandle.at(-1)!
    expect(handle.value).toBe(0.4)
    expect(handle.onChange).toBe(onSplitChange)
  })

  it('mounts no canvas and no split handle once export released the preview', () => {
    const { container } = render(
      stage({ previewSuspended: true, decodedFrame: null }),
    )

    expect(stageProps.canvas).toHaveLength(0)
    expect(stageProps.splitHandle).toHaveLength(0)
    expect(
      container.querySelector('[data-raw-export-ready-handoff]'),
    ).not.toBeNull()
  })

  it('leaves the split handle with the committed split while a frame is live', () => {
    const onSplitChange = vi.fn()
    const onSplitReset = vi.fn()
    render(stage({ decodedFrame: acceptedFrame, onSplitChange, onSplitReset }))

    expect(screen.getByTestId('split-handle')).toBeInTheDocument()
    const handle = stageProps.splitHandle.at(-1)!
    expect(handle.value).toBe(0.4)
    expect(handle.onChange).toBe(onSplitChange)
    expect(handle.onReset).toBe(onSplitReset)
    expect(handle.onPreviewChange).toBeUndefined()
  })
})
