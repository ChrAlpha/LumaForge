import { atom } from 'jotai'

import { createAtomHooks } from '~/lib/jotai'
import type { PreviewView } from '~/lib/preview/preview-view'
import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

/**
 * The view of the sample shown before any source loads. Once a session
 * exists its `viewState` owns the view and this atom is not written; a new
 * session starts from the view in effect when it loads.
 */
const baseDetachedPreviewViewAtom = atom<PreviewView>(DEFAULT_PREVIEW_VIEW)

export const [
  ,
  ,
  useDetachedPreviewViewValue,
  useSetDetachedPreviewView,
  getDetachedPreviewView,
  setDetachedPreviewView,
] = createAtomHooks(baseDetachedPreviewViewAtom)

export function resetDetachedPreviewView(): void {
  setDetachedPreviewView(DEFAULT_PREVIEW_VIEW)
}
