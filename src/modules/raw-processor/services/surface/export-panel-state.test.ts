import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'

import type { ExportPanelInput } from './export-panel-state'
import {
  deriveExportPanelState,
  exportProgressPercent,
} from './export-panel-state'

const t = ((key: keyof typeof enMessages) => enMessages[key]) as Parameters<
  typeof deriveExportPanelState
>[1]

const note = { kind: 'interrupted' } as const

function derive(input: Partial<ExportPanelInput<typeof note>>) {
  return deriveExportPanelState(
    {
      canExport: true,
      canPreviewExport: true,
      isProcessing: false,
      isExporting: false,
      startedKind: 'full',
      ...input,
    },
    t,
  )
}

describe('deriveExportPanelState', () => {
  it('states no reason while both exports can run', () => {
    expect(derive({})).toEqual({
      runningKind: null,
      fullReason: null,
      previewReason: null,
      previewRepeatsFull: false,
      interruptionNote: null,
      resultKind: null,
    })
  })

  it('names a full-resolution refusal, and the loading copy when none is given', () => {
    expect(
      derive({
        canExport: false,
        disabledReason: { source: 'surface', code: 'transform-pending' },
      }).fullReason,
    ).toBe(enMessages['raw.transform.preparing'])
    expect(derive({ canExport: false }).fullReason).toBe(
      enMessages['raw.exportSourceLoading'],
    )
  })

  it('names an HQ refusal on its own terms while full resolution runs', () => {
    const state = derive({
      canPreviewExport: false,
      previewExportDisabledReason: {
        source: 'surface',
        code: 'transform-hq-export',
      },
    })
    expect(state.fullReason).toBeNull()
    expect(state.previewReason).toBe(enMessages['raw.transform.hqExportReason'])
    expect(state.previewRepeatsFull).toBe(false)
  })

  it('does not repeat an HQ refusal the full line already states', () => {
    const reason = { source: 'surface', code: 'transform-pending' } as const
    const state = derive({
      canExport: false,
      disabledReason: reason,
      canPreviewExport: false,
      previewExportDisabledReason: reason,
    })
    expect(state.fullReason).toBe(enMessages['raw.transform.preparing'])
    expect(state.previewReason).toBeNull()
    expect(state.previewRepeatsFull).toBe(true)
  })

  it('shows a running export on its button instead of either reason', () => {
    const state = derive({
      canExport: false,
      canPreviewExport: false,
      previewExportDisabledReason: {
        source: 'surface',
        code: 'export-running',
      },
      isProcessing: true,
      isExporting: true,
      startedKind: 'hq',
      interruptionNote: note,
    })
    expect(state.runningKind).toBe('hq')
    expect(state.fullReason).toBeNull()
    expect(state.previewReason).toBeNull()
    expect(state.interruptionNote).toBeNull()
  })

  it('holds the interruption hint back while anything is processing', () => {
    expect(derive({ interruptionNote: note }).interruptionNote).toBe(note)
    expect(
      derive({ interruptionNote: note, isProcessing: true }).interruptionNote,
    ).toBeNull()
  })

  it('passes the result kind through and names none for a result without one', () => {
    expect(derive({ resultKind: 'hq-preview' }).resultKind).toBe('hq-preview')
    expect(derive({ resultKind: undefined }).resultKind).toBeNull()
  })
})

describe('exportProgressPercent', () => {
  it('clamps to a whole percent and names an unknown progress null', () => {
    expect(exportProgressPercent(41.6)).toBe(42)
    expect(exportProgressPercent(-3)).toBe(0)
    expect(exportProgressPercent(140)).toBe(100)
    expect(exportProgressPercent(Number.NaN)).toBeNull()
    expect(exportProgressPercent(undefined)).toBeNull()
  })
})
