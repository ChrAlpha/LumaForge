import { useRef, useState } from 'react'

export interface AdjustRowHandlers {
  onChange: (value: number) => void
  onScrubChange: (scrubbing: boolean) => void
}

/**
 * The row handlers for a field id, made once per id and kept for the list's
 * lifetime. Each calls what the list's latest render handed in when it
 * runs, so a list that renders on every scrub step still hands its rows the
 * same handlers, and a memoized row renders only when what it shows moves.
 */
export function useAdjustRowHandlers<Id extends string>(latest: {
  onChange: (id: Id, value: number) => void
  onScrubChange: (id: Id, scrubbing: boolean) => void
}): (id: Id) => AdjustRowHandlers {
  const latestRef = useRef(latest)
  latestRef.current = latest
  const [handlersFor] = useState(() => {
    const made = new Map<Id, AdjustRowHandlers>()
    return (id: Id) => {
      let handlers = made.get(id)
      if (!handlers) {
        handlers = {
          onChange: (value) => latestRef.current.onChange(id, value),
          onScrubChange: (scrubbing) =>
            latestRef.current.onScrubChange(id, scrubbing),
        }
        made.set(id, handlers)
      }
      return handlers
    }
  })
  return handlersFor
}
