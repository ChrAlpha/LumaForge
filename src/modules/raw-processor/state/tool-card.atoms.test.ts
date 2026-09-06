import { afterEach, describe, expect, it } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import {
  DEFAULT_OPEN_TOOL_CARDS,
  TOOL_CARD_IDS,
  toolCardOpenAtom,
} from './tool-card.atoms'

afterEach(() => {
  jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS)
  localStorage.clear()
})

describe('toolCardOpenAtom', () => {
  it('defaults to look and adjust open', () => {
    expect(jotaiStore.get(toolCardOpenAtom)).toEqual(['look', 'adjust'])
  })

  it('exposes the canonical card id set', () => {
    expect(TOOL_CARD_IDS).toEqual([
      'look',
      'adjust',
      'transform',
      'histogram',
      'compare',
      'fileFacts',
    ])
  })

  it('persists updates to localStorage under the raw key', () => {
    jotaiStore.set(toolCardOpenAtom, ['look'])
    expect(jotaiStore.get(toolCardOpenAtom)).toEqual(['look'])
    expect(localStorage.getItem('raw-tool-cards-open')).toContain('look')
  })
})
