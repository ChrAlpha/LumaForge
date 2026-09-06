import { atomWithStorage } from 'jotai/utils'

export const TOOL_CARD_IDS = [
  'look',
  'adjust',
  'transform',
  'histogram',
  'compare',
  'fileFacts',
] as const

export type ToolCardId = (typeof TOOL_CARD_IDS)[number]

export const DEFAULT_OPEN_TOOL_CARDS: ToolCardId[] = ['look', 'adjust']

export const toolCardOpenAtom = atomWithStorage<ToolCardId[]>(
  'raw-tool-cards-open',
  DEFAULT_OPEN_TOOL_CARDS,
  undefined,
  { getOnInit: true },
)
