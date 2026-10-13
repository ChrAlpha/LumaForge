import type { SetStateAction } from 'jotai'
import { atom } from 'jotai'

import { createAtomHooks, jotaiStore } from '~/lib/jotai'

import type { ImageSession } from '../model/session'

const baseCurrentSessionAtom = atom<ImageSession | null>(null)

/**
 * The current image session, bound to the production store the root
 * providers mount. The hook and the imperative accessors read and write that
 * one store, so a write is visible to `getCurrentSession` in the same tick,
 * before any rerender.
 */
export const [currentSessionAtom, useCurrentSession, , , getCurrentSession] =
  createAtomHooks(baseCurrentSessionAtom)

export type SetImageSession = (
  update: SetStateAction<ImageSession | null>,
) => void

/** Writes the current session; an updater receives the store's latest value. */
export const setCurrentSession: SetImageSession = (update) => {
  jotaiStore.set(currentSessionAtom, update)
}
