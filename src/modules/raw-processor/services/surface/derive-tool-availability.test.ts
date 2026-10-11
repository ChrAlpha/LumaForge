import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import type { ProcessingStatus } from '../../model/workflow'
import type { TransformExportBlock } from '../transform/transform-state'
import type {
  ToolAction,
  ToolAvailability,
  ToolAvailabilityInput,
  TransformPreviewObservation,
} from './derive-tool-availability'
import { deriveToolAvailability } from './derive-tool-availability'
import type { RawReasonCode } from './raw-reason'
import { rawReasonMessageKey } from './raw-reason'

const STATUSES: ProcessingStatus[] = [
  'idle',
  'warming',
  'loading',
  'decoding',
  'processing',
  'exporting',
  'ready',
  'error',
]
const BUSY = new Set<ProcessingStatus>([
  'warming',
  'loading',
  'decoding',
  'processing',
  'exporting',
])
const EXPORT_BLOCKS: Array<TransformExportBlock | null> = [
  null,
  'pending',
  'invalid',
  'unavailable',
]
type TransformAction = Extract<ToolAction, `transform${string}`>
type SurfaceAction = Exclude<ToolAction, TransformAction>

const ACTIONS: SurfaceAction[] = [
  'edit',
  'strength',
  'lutApplication',
  'originalView',
  'split',
  'splitReset',
  'exportEntry',
  'fullExport',
  'hqExport',
  'delivery',
  'restorePreview',
]
const TRANSFORM_ACTIONS: TransformAction[] = [
  'transformGeometry',
  'transformOverlay',
  'transformReset',
]
function input(
  overrides: Partial<ToolAvailabilityInput> = {},
): ToolAvailabilityInput {
  return {
    surface: 'desktop',
    hasImage: true,
    status: 'ready',
    executor: 'webgpu',
    previewSuspended: false,
    transformActive: false,
    transformExportBlock: null,
    hasAppliedLut: true,
    canExport: true,
    lutContractBlocksExport: false,
    canPreviewExport: true,
    hasExportResult: false,
    ...overrides,
  }
}

/**
 * The rules the tool surfaces apply today, written out the way the desktop
 * rail, the mobile chrome and lens controller, the stages and the tool
 * provider state them. The selector has to agree with them on every input.
 */
function currentSurfaceRules(
  i: ToolAvailabilityInput,
): Record<SurfaceAction, boolean> {
  const busy = BUSY.has(i.status)
  const exporting = i.status === 'exporting'
  const released = i.previewSuspended
  const cpu = i.executor === 'cpu'
  const fullExport = i.canExport && !i.transformExportBlock && !busy
  const hqExport =
    i.canPreviewExport && !i.transformActive && !i.transformExportBlock && !busy
  const delivery = i.hasExportResult
  const restorePreview = i.hasImage && released && !busy

  if (i.surface === 'desktop') {
    const editorDisabled = !i.hasImage || exporting || released
    return {
      edit: !editorDisabled,
      strength: !editorDisabled && i.hasAppliedLut,
      lutApplication: !(exporting || released),
      // The CPU stage's own toggle, or the GPU stage's view mode; the
      // export-ready handoff replaces either while the preview is released.
      originalView: i.hasImage && !released && !i.transformActive,
      // Before a source the sample compare keeps its split, on either
      // executor: only a loaded photo moves to the CPU stage or the handoff.
      split:
        !exporting &&
        !i.transformActive &&
        (i.hasImage ? !cpu && !released : true),
      splitReset: !editorDisabled && !cpu && !i.transformActive,
      exportEntry: true,
      fullExport,
      hqExport,
      delivery,
      restorePreview,
    }
  }

  const exportEntry = i.hasImage && !(busy && !exporting)
  const mobileEditorDisabled = !i.hasImage || busy || released
  const handoffActive = i.hasImage && (busy || released)
  const lensVisible = i.hasImage && !handoffActive
  return {
    edit: !mobileEditorDisabled,
    strength: !mobileEditorDisabled && i.hasAppliedLut,
    // The Look deck only exists with a photo, and the browser is disabled
    // while busy or released.
    lutApplication: i.hasImage && !(busy || exporting || released),
    originalView: lensVisible && !i.transformActive,
    split: lensVisible && !i.transformActive && !cpu,
    splitReset: lensVisible && !i.transformActive && !cpu,
    exportEntry,
    // The export panel, and the result in it, is reached only through the
    // topbar action.
    fullExport: exportEntry && fullExport,
    hqExport: exportEntry && hqExport,
    delivery: exportEntry && delivery,
    restorePreview,
  }
}

/**
 * Every observation the Transform preview can report: a frame to capture
 * needs a loaded source and a preview that is not released, and a current
 * answer needs a frame that did not fail.
 */
function* everyTransformPreview(
  hasImage: boolean,
  previewSuspended: boolean,
): Generator<TransformPreviewObservation | undefined> {
  yield undefined
  for (const canCapture of hasImage && !previewSuspended
    ? [false, true]
    : [false])
    for (const workerReady of [false, true])
      for (const captureFailed of [false, true])
        for (const current of canCapture && !captureFailed
          ? [false, true]
          : [false])
          yield { canCapture, workerReady, captureFailed, current }
}

function* everyTransformInput(): Generator<ToolAvailabilityInput> {
  for (const surface of ['desktop', 'mobile'] as const)
    for (const hasImage of [false, true])
      for (const status of STATUSES)
        for (const executor of ['webgpu', 'cpu'] as const)
          for (const previewSuspended of [false, true])
            for (const transformActive of [false, true])
              for (const transformPreview of everyTransformPreview(
                hasImage,
                previewSuspended,
              ))
                yield input({
                  surface,
                  hasImage,
                  status,
                  executor,
                  previewSuspended,
                  transformActive,
                  transformExportBlock: transformActive ? null : 'pending',
                  transformPreview,
                })
}

function* everyInput(): Generator<ToolAvailabilityInput> {
  for (const surface of ['desktop', 'mobile'] as const)
    for (const hasImage of [false, true])
      for (const status of STATUSES)
        for (const executor of ['webgpu', 'cpu'] as const)
          for (const previewSuspended of [false, true])
            for (const transformActive of [false, true])
              for (const transformExportBlock of EXPORT_BLOCKS)
                for (const hasAppliedLut of [false, true])
                  for (const canExport of [false, true])
                    for (const lutContractBlocksExport of [false, true])
                      for (const canPreviewExport of [false, true])
                        for (const hasExportResult of [false, true])
                          yield {
                            surface,
                            hasImage,
                            status,
                            executor,
                            previewSuspended,
                            transformActive,
                            transformExportBlock,
                            hasAppliedLut,
                            canExport,
                            lutContractBlocksExport: canExport
                              ? false
                              : lutContractBlocksExport,
                            canPreviewExport,
                            hasExportResult,
                          }
}

function availableActions(result: ToolAvailability) {
  return ACTIONS.filter((action) => result[action].available)
}

describe('deriveToolAvailability', () => {
  it('agrees with the rules the current surfaces apply, on every input', () => {
    let checked = 0
    for (const i of everyInput()) {
      const result = deriveToolAvailability(i)
      const expected = currentSurfaceRules(i)
      for (const action of ACTIONS) {
        if (result[action].available !== expected[action]) {
          throw new Error(
            `${action} on ${JSON.stringify(i)}: expected ${expected[action]}`,
          )
        }
      }
      // Without a Transform preview there is no Transform tool to offer.
      for (const action of TRANSFORM_ACTIONS) {
        if (result[action].available) {
          throw new Error(`${action} on ${JSON.stringify(i)}: no preview`)
        }
      }
      checked++
    }
    expect(checked).toBe(2 * 2 * 8 * 2 * 2 * 2 * 4 * 2 * 2 * 2 * 2 * 2)
  })

  it('moves no other action with what the Transform preview observes', () => {
    let checked = 0
    for (const i of everyTransformInput()) {
      const result = deriveToolAvailability(i)
      const unobserved = deriveToolAvailability({
        ...i,
        transformPreview: undefined,
      })
      for (const action of ACTIONS) {
        expect(result[action]).toEqual(unobserved[action])
      }
      // Without a Transform preview there is no Transform tool to offer.
      for (const action of TRANSFORM_ACTIONS) {
        expect(unobserved[action]).toEqual({ available: false, reason: null })
      }
      checked++
    }
    // No preview, then 4 observations without a frame to capture or 10
    // with one: only a loaded photo whose preview is held has one.
    expect(checked).toBe(2 * 8 * 2 * 2 * (5 + 5 + 11 + 5))
  })

  it('answers each Transform state the panels render, on both surfaces alike', () => {
    const noFrame: TransformPreviewObservation = {
      canCapture: false,
      workerReady: false,
      captureFailed: false,
      current: false,
    }
    const ready: TransformPreviewObservation = {
      canCapture: true,
      workerReady: true,
      captureFailed: false,
      current: true,
    }
    const open = null
    // [state, facts, geometry, overlay, reset]; null is available.
    const cases: Array<
      [
        string,
        Partial<ToolAvailabilityInput>,
        RawReasonCode | null,
        RawReasonCode | null,
        RawReasonCode | null,
      ]
    > = [
      ['ready', { transformPreview: ready }, open, open, open],
      [
        'no source',
        { hasImage: false, status: 'idle', transformPreview: noFrame },
        'no-source',
        'no-source',
        open,
      ],
      [
        'no frame to capture',
        { transformPreview: noFrame },
        'transform-unavailable',
        'transform-unavailable',
        open,
      ],
      [
        'worker not ready',
        { transformPreview: { ...noFrame, canCapture: true } },
        'transform-pending',
        'transform-pending',
        open,
      ],
      [
        'capture failed',
        {
          transformPreview: { ...ready, captureFailed: true, current: false },
        },
        'transform-unavailable',
        'transform-unavailable',
        open,
      ],
      [
        'loading',
        { status: 'loading', transformPreview: ready },
        'source-loading',
        'source-loading',
        'source-loading',
      ],
      [
        'decoding',
        { status: 'decoding', transformPreview: ready },
        'preview-decoding',
        'preview-decoding',
        'preview-decoding',
      ],
      [
        'exporting',
        { status: 'exporting', transformPreview: ready },
        'export-running',
        'export-running',
        'export-running',
      ],
      [
        'released',
        {
          previewSuspended: true,
          transformPreview: { ...noFrame, workerReady: true },
        },
        'preview-released',
        'preview-released',
        'preview-released',
      ],
      [
        'warming',
        { status: 'warming', transformPreview: ready },
        open,
        open,
        open,
      ],
      [
        'processing',
        { status: 'processing', transformPreview: ready },
        open,
        open,
        open,
      ],
    ]
    const answer = (reason: RawReasonCode | null) =>
      reason ? { available: false, reason } : { available: true, reason: null }
    for (const surface of ['desktop', 'mobile'] as const) {
      for (const [state, facts, geometry, overlay, reset] of cases) {
        const result = deriveToolAvailability(input({ surface, ...facts }))
        expect(
          {
            state,
            geometry: result.transformGeometry,
            overlay: result.transformOverlay,
            reset: result.transformReset,
          },
          `${surface} ${state}`,
        ).toEqual({
          state,
          geometry: answer(geometry),
          overlay: answer(overlay),
          reset: answer(reset),
        })
      }
    }
  })

  it('keeps Transform open on mobile while the deck that holds it waits for edit', () => {
    const ready: TransformPreviewObservation = {
      canCapture: true,
      workerReady: true,
      captureFailed: false,
      current: true,
    }
    for (const status of ['warming', 'processing'] as const) {
      const result = deriveToolAvailability(
        input({ surface: 'mobile', status, transformPreview: ready }),
      )
      // The mobile deck opens only where edit is available, so the panel is
      // out of reach here even though its own actions are not refused.
      expect(result.edit.available).toBe(false)
      for (const action of TRANSFORM_ACTIONS) {
        expect(result[action]).toEqual({ available: true, reason: null })
      }
    }
  })

  it('never names a reason for an available action', () => {
    for (const i of [...everyInput(), ...everyTransformInput()]) {
      const result = deriveToolAvailability(i)
      for (const action of [...ACTIONS, ...TRANSFORM_ACTIONS]) {
        const { available, reason } = result[action]
        if (available && reason !== null) {
          throw new Error(`${action} on ${JSON.stringify(i)}: ${reason}`)
        }
      }
    }
  })

  it('keeps the decode-time difference: desktop edits while the preview decodes, mobile waits', () => {
    const decoding = { status: 'decoding' as const }
    const desktop = deriveToolAvailability(input(decoding))
    const mobile = deriveToolAvailability(
      input({ ...decoding, surface: 'mobile' }),
    )

    expect(desktop.edit).toEqual({ available: true, reason: null })
    expect(desktop.strength).toEqual({ available: true, reason: null })
    expect(desktop.lutApplication).toEqual({ available: true, reason: null })
    expect(desktop.split).toEqual({ available: true, reason: null })
    expect(desktop.originalView).toEqual({ available: true, reason: null })

    for (const action of [
      'edit',
      'strength',
      'lutApplication',
      'originalView',
      'split',
      'splitReset',
      'exportEntry',
    ] as const) {
      expect(mobile[action]).toEqual({
        available: false,
        reason: 'preview-decoding',
      })
    }
  })

  it('names the running stage as the reason a busy mobile surface waits', () => {
    expect(
      deriveToolAvailability(input({ surface: 'mobile', status: 'warming' }))
        .edit.reason,
    ).toBe('runtime-warming')
    expect(
      deriveToolAvailability(input({ surface: 'mobile', status: 'loading' }))
        .edit.reason,
    ).toBe('source-loading')
    expect(
      deriveToolAvailability(input({ surface: 'mobile', status: 'processing' }))
        .edit.reason,
    ).toBe('look-processing')
    expect(
      deriveToolAvailability(input({ surface: 'mobile', status: 'exporting' }))
        .edit.reason,
    ).toBe('export-running')
  })

  it('lets the CPU preview show the original but never the split', () => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const gpu = deriveToolAvailability(input({ surface }))
      const cpu = deriveToolAvailability(input({ surface, executor: 'cpu' }))

      expect(gpu.originalView.available).toBe(true)
      expect(gpu.split.available).toBe(true)
      expect(gpu.splitReset.available).toBe(true)
      expect(cpu.originalView).toEqual({ available: true, reason: null })
      expect(cpu.split).toEqual({ available: false, reason: 'cpu-preview' })
      expect(cpu.splitReset).toEqual({
        available: false,
        reason: 'cpu-preview',
      })
      // The CPU preview changes nothing an edit or an export depends on.
      expect(availableActions(cpu)).toEqual(
        availableActions(gpu).filter(
          (action) => action !== 'split' && action !== 'splitReset',
        ),
      )
    }
  })

  it('keeps the sample compare split before a source on desktop only', () => {
    for (const executor of ['webgpu', 'cpu'] as const) {
      const desktop = deriveToolAvailability(
        input({ hasImage: false, status: 'idle', executor }),
      )
      expect(desktop.split).toEqual({ available: true, reason: null })
      expect(desktop.splitReset).toEqual({
        available: false,
        reason: 'no-source',
      })
      expect(desktop.originalView).toEqual({
        available: false,
        reason: 'no-source',
      })
    }
    const mobile = deriveToolAvailability(
      input({ surface: 'mobile', hasImage: false, status: 'idle' }),
    )
    expect(mobile.split).toEqual({ available: false, reason: 'no-source' })
  })

  it('stages a LUT before a source on desktop, while mobile has no deck to take it', () => {
    const empty = { hasImage: false, status: 'idle' as const }
    expect(deriveToolAvailability(input(empty)).lutApplication).toEqual({
      available: true,
      reason: null,
    })
    expect(deriveToolAvailability(input(empty)).edit).toEqual({
      available: false,
      reason: 'no-source',
    })
    const mobile = deriveToolAvailability(
      input({ ...empty, surface: 'mobile' }),
    )
    expect(mobile.lutApplication).toEqual({
      available: false,
      reason: 'no-source',
    })
    expect(mobile.exportEntry).toEqual({
      available: false,
      reason: 'no-source',
    })
  })

  it('locks every edit while the preview is released, but keeps Export, delivery and Restore', () => {
    for (const surface of ['desktop', 'mobile'] as const) {
      for (const executor of ['webgpu', 'cpu'] as const) {
        const released = deriveToolAvailability(
          input({
            surface,
            executor,
            previewSuspended: true,
            hasExportResult: true,
            canPreviewExport: false,
          }),
        )
        for (const action of [
          'edit',
          'strength',
          'lutApplication',
          'originalView',
          'split',
          'splitReset',
        ] as const) {
          expect(released[action]).toEqual({
            available: false,
            reason: 'preview-released',
          })
        }
        expect(released.exportEntry.available).toBe(true)
        expect(released.fullExport.available).toBe(true)
        expect(released.delivery.available).toBe(true)
        expect(released.restorePreview.available).toBe(true)
        // The workflow names why the HQ preview needs the preview back.
        expect(released.hqExport).toEqual({ available: false, reason: null })
      }
    }
  })

  it('keeps the export entry and the result while a released export still runs, and Restore waits', () => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const running = deriveToolAvailability(
        input({
          surface,
          status: 'exporting',
          previewSuspended: true,
          canExport: false,
        }),
      )
      expect(running.exportEntry.available).toBe(true)
      expect(running.fullExport).toEqual({
        available: false,
        reason: 'export-running',
      })
      expect(running.restorePreview).toEqual({
        available: false,
        reason: 'export-running',
      })
      expect(running.edit).toEqual({
        available: false,
        reason: 'preview-released',
      })
    }
  })

  it('offers Restore only while the preview is released', () => {
    const live = deriveToolAvailability(input({ hasExportResult: true }))
    expect(live.restorePreview).toEqual({ available: false, reason: null })
    expect(live.delivery).toEqual({ available: true, reason: null })
    expect(deriveToolAvailability(input()).delivery).toEqual({
      available: false,
      reason: null,
    })
  })

  it('shows a committed Transform alone, and keeps full resolution while the HQ preview refuses', () => {
    for (const surface of ['desktop', 'mobile'] as const) {
      const committed = deriveToolAvailability(
        input({ surface, transformActive: true }),
      )
      expect(committed.originalView).toEqual({
        available: false,
        reason: 'transform-compare',
      })
      expect(committed.split).toEqual({
        available: false,
        reason: 'transform-compare',
      })
      expect(committed.splitReset).toEqual({
        available: false,
        reason: 'transform-compare',
      })
      expect(committed.edit.available).toBe(true)
      expect(committed.fullExport).toEqual({ available: true, reason: null })
      expect(committed.hqExport).toEqual({
        available: false,
        reason: 'transform-hq-export',
      })
    }
  })

  it('refuses both exports while Transform blocks export, naming the block', () => {
    const cases: Array<[TransformExportBlock, string]> = [
      ['pending', 'transform-pending'],
      ['invalid', 'transform-invalid'],
      ['unavailable', 'transform-unavailable'],
    ]
    for (const [block, reason] of cases) {
      const blocked = deriveToolAvailability(
        input({ transformExportBlock: block }),
      )
      expect(blocked.fullExport).toEqual({ available: false, reason })
      expect(blocked.hqExport).toEqual({
        available: false,
        reason: 'transform-hq-export',
      })
      expect(blocked.exportEntry.available).toBe(true)
      expect(blocked.edit.available).toBe(true)
    }
  })

  it('lets Transform name an export block only where the workflow has nothing earlier to say', () => {
    expect(
      deriveToolAvailability(
        input({
          transformExportBlock: 'pending',
          canExport: false,
          lutContractBlocksExport: true,
        }),
      ).fullExport,
    ).toEqual({ available: false, reason: 'transform-pending' })
    expect(
      deriveToolAvailability(
        input({ transformExportBlock: 'pending', canExport: false }),
      ).fullExport,
    ).toEqual({ available: false, reason: null })
    expect(
      deriveToolAvailability(input({ canExport: false })).fullExport,
    ).toEqual({ available: false, reason: null })
    expect(
      deriveToolAvailability(input({ canPreviewExport: false })).hqExport,
    ).toEqual({ available: false, reason: null })
  })

  it('says why strength is off without a LUT, after any edit lock', () => {
    for (const surface of ['desktop', 'mobile'] as const) {
      expect(
        deriveToolAvailability(input({ surface, hasAppliedLut: false }))
          .strength,
      ).toEqual({ available: false, reason: 'no-lut' })
      expect(
        deriveToolAvailability(
          input({ surface, hasAppliedLut: false, previewSuspended: true }),
        ).strength,
      ).toEqual({ available: false, reason: 'preview-released' })
      expect(
        deriveToolAvailability(
          input({ surface, hasAppliedLut: false, hasImage: false }),
        ).strength,
      ).toEqual({ available: false, reason: 'no-source' })
    }
  })

  it('opens the Transform tool once its frame is captured and the worker holds it', () => {
    const ready: TransformPreviewObservation = {
      canCapture: true,
      workerReady: true,
      captureFailed: false,
      current: true,
    }
    for (const surface of ['desktop', 'mobile'] as const) {
      for (const executor of ['webgpu', 'cpu'] as const) {
        const open = deriveToolAvailability(
          input({ surface, executor, transformPreview: ready }),
        )
        for (const action of TRANSFORM_ACTIONS) {
          expect(open[action]).toEqual({ available: true, reason: null })
        }
      }
    }
  })

  it('waits for a frame to capture: the current CPU frame, or the WebGPU pipeline', () => {
    for (const executor of ['webgpu', 'cpu'] as const) {
      const noFrame = deriveToolAvailability(
        input({
          executor,
          transformPreview: {
            canCapture: false,
            workerReady: false,
            captureFailed: false,
            current: false,
          },
        }),
      )
      expect(noFrame.transformGeometry).toEqual({
        available: false,
        reason: 'transform-unavailable',
      })
      expect(noFrame.transformOverlay).toEqual({
        available: false,
        reason: 'transform-unavailable',
      })
      // Reset needs no frame: it only clears the intent.
      expect(noFrame.transformReset).toEqual({ available: true, reason: null })
    }
    const noSource = deriveToolAvailability(
      input({
        hasImage: false,
        status: 'idle',
        transformPreview: {
          canCapture: false,
          workerReady: false,
          captureFailed: false,
          current: false,
        },
      }),
    )
    expect(noSource.transformGeometry).toEqual({
      available: false,
      reason: 'no-source',
    })
  })

  it('waits for the worker to hold the frame, and keeps Reset when the capture fails', () => {
    const pending = deriveToolAvailability(
      input({
        transformPreview: {
          canCapture: true,
          workerReady: false,
          captureFailed: false,
          current: false,
        },
      }),
    )
    expect(pending.transformGeometry).toEqual({
      available: false,
      reason: 'transform-pending',
    })
    expect(pending.transformOverlay).toEqual({
      available: false,
      reason: 'transform-pending',
    })
    const failed = deriveToolAvailability(
      input({
        transformActive: true,
        transformPreview: {
          canCapture: true,
          workerReady: true,
          captureFailed: true,
          current: false,
        },
      }),
    )
    expect(failed.transformGeometry).toEqual({
      available: false,
      reason: 'transform-unavailable',
    })
    expect(failed.transformOverlay).toEqual({
      available: false,
      reason: 'transform-unavailable',
    })
    expect(failed.transformReset).toEqual({ available: true, reason: null })
  })

  it('locks Transform for a stage that replaces its frame, on both surfaces alike', () => {
    const ready: TransformPreviewObservation = {
      canCapture: true,
      workerReady: true,
      captureFailed: false,
      current: true,
    }
    const cases: Array<[ProcessingStatus, RawReasonCode | null]> = [
      ['loading', 'source-loading'],
      ['decoding', 'preview-decoding'],
      ['exporting', 'export-running'],
      ['warming', null],
      ['processing', null],
    ]
    for (const surface of ['desktop', 'mobile'] as const) {
      for (const [status, reason] of cases) {
        const result = deriveToolAvailability(
          input({ surface, status, transformPreview: ready }),
        )
        for (const action of TRANSFORM_ACTIONS) {
          expect(result[action]).toEqual(
            reason
              ? { available: false, reason }
              : { available: true, reason: null },
          )
        }
      }
    }
  })

  it('refuses Transform edits while the preview is released, view aids included', () => {
    const released = deriveToolAvailability(
      input({
        previewSuspended: true,
        transformPreview: {
          canCapture: false,
          workerReady: true,
          captureFailed: false,
          current: false,
        },
      }),
    )
    for (const action of TRANSFORM_ACTIONS) {
      expect(released[action]).toEqual({
        available: false,
        reason: 'preview-released',
      })
    }
  })

  it('names every reason it returns in both locales', () => {
    const reasons = new Set<RawReasonCode>()
    for (const i of [...everyInput(), ...everyTransformInput()]) {
      const result = deriveToolAvailability(i)
      for (const action of [...ACTIONS, ...TRANSFORM_ACTIONS]) {
        const { reason } = result[action]
        if (reason) reasons.add(reason)
      }
    }
    for (const reason of reasons) {
      const key = rawReasonMessageKey(reason)
      expect(enMessages[key]).toBeTruthy()
      expect(zhMessages[key]).toBeTruthy()
    }
  })
})
