import { useAtomValue } from 'jotai'
import { useMemo, useSyncExternalStore } from 'react'

import { jotaiStore } from '~/lib/jotai'
import { isHdrDisplay, subscribeHdrDisplay } from '~/lib/preview/hdr-display'
import type { PreviewHdrOutput } from '~/lib/preview/preview-view'

import type { HdrPreviewChoice } from '../../services/preview/hdr-preview-output'
import {
  hdrPreviewChoices,
  resolveHdrPreviewChoice,
  resolvePreviewHdrOutput,
} from '../../services/preview/hdr-preview-output'
import { useHdrExportValue } from '../../state/export-options.atoms'
import {
  hdrRenditionAtom,
  useHdrPreviewChoiceValue,
  usePreviewExtendedRangeValue,
} from '../../state/hdr-preview.atoms'

export interface HdrPreviewState {
  /** The gain map is on and the look has the HDR rendition it writes. */
  offered: boolean
  /** The choices the preview offers, its default first. */
  choices: readonly HdrPreviewChoice[]
  /** The choice in effect. */
  choice: HdrPreviewChoice
  /** What the processed preview draws in place of the SDR picture. */
  output: PreviewHdrOutput | undefined
}

const storeOptions = { store: jotaiStore }

function sdrOnServer() {
  return false
}

/**
 * The HDR preview as the store and the display now stand: the HDR rendition
 * is offered only where the published GPU canvas shows values above SDR
 * white and the screen still reports high dynamic range. The stage passes
 * whether a Transform overlay covers the photo, since it draws the output;
 * the tool surfaces read only the choices.
 */
export function useHdrPreview({
  transformOverlayShown = false,
}: { transformOverlayShown?: boolean } = {}): HdrPreviewState {
  const hdrExport = useHdrExportValue()
  const made = useHdrPreviewChoiceValue()
  const extendedRange = usePreviewExtendedRangeValue()
  const hdrDisplay = useSyncExternalStore(
    subscribeHdrDisplay,
    isHdrDisplay,
    sdrOnServer,
  )
  const hdrRendition = useAtomValue(hdrRenditionAtom, storeOptions)
  const choices = useMemo(
    () => hdrPreviewChoices(extendedRange && hdrDisplay),
    [extendedRange, hdrDisplay],
  )
  const choice = resolveHdrPreviewChoice(made, choices)
  const output = resolvePreviewHdrOutput({
    hdrExport,
    hdrRendition,
    choice,
    transformOverlayShown,
  })
  const offered = hdrExport && hdrRendition
  return useMemo(
    () => ({ offered, choices, choice, output }),
    [choice, choices, offered, output],
  )
}
