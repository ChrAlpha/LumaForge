import { atom } from 'jotai'

import { createAtomHooks } from '~/lib/jotai'
import type { PreviewView } from '~/lib/preview/preview-view'
import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import { getCurrentSession } from './session.atoms'

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

/**
 * The view in effect now, read from the store: the session's once one
 * exists, the sample's before that. A load reads it when it starts, so a
 * split set in the same tick carries over to the new source.
 */
export function getCurrentView(): PreviewView {
  const session = getCurrentSession()
  return session
    ? {
        mode: session.viewState.mode,
        compareSplit: session.viewState.compareSplit,
      }
    : getDetachedPreviewView()
}
