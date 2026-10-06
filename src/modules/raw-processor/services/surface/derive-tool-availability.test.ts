import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import type { TransformExportBlock } from '../../hooks/useRawTransformFeature'
import type { ProcessingStatus } from '../../model/workflow'
import type {
  ToolAction,
  ToolAvailability,
  ToolAvailabilityInput,
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
const ACTIONS: ToolAction[] = [
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
): Record<ToolAction, boolean> {
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
      checked++
    }
    expect(checked).toBe(2 * 2 * 8 * 2 * 2 * 2 * 4 * 2 * 2 * 2 * 2 * 2)
  })

  it('never names a reason for an available action', () => {
    for (const i of everyInput()) {
      const result = deriveToolAvailability(i)
      for (const action of ACTIONS) {
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

  it('names every reason it returns in both locales', () => {
    const reasons = new Set<RawReasonCode>()
    for (const i of everyInput()) {
      const result = deriveToolAvailability(i)
      for (const action of ACTIONS) {
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
