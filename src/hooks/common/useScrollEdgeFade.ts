import { useEffect } from 'react'

type Edge = 'top' | 'bottom' | 'both' | 'none'

/**
 * Sets `data-raw-scroll="fade"` and `data-raw-scroll-edge` on the target
 * element so raw-lab.surface.css can render an edge gradient mask matching
 * the current scroll position. The companion CSS lives under the
 * `[data-raw-scroll="fade"]` selectors.
 *
 * The edge is measured only where layout is already clean: on scroll, and in
 * the ResizeObserver callback that follows the target or one of its direct
 * children changing size. Text and attribute changes deeper in the tree (a
 * slider readout moving under a scrub) never force a layout read here, and
 * the attribute is written only when the edge actually changes.
 */
export function useScrollEdgeFade(
  target: HTMLElement | null | undefined,
  options?: { threshold?: number; enabled?: boolean },
) {
  const enabled = options?.enabled ?? true
  const threshold = options?.threshold ?? 2

  useEffect(() => {
    if (!target || !enabled) return

    target.dataset.rawScroll = 'fade'
    let current: Edge = 'none'

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = target
      const atTop = scrollTop <= threshold
      const atBottom = scrollTop + clientHeight >= scrollHeight - threshold
      const overflows = scrollHeight - clientHeight > threshold

      let edge: Edge
      if (!overflows) edge = 'none'
      else if (atTop && atBottom) edge = 'none'
      else if (atTop) edge = 'bottom'
      else if (atBottom) edge = 'top'
      else edge = 'both'

      if (edge === current) return
      current = edge
      if (edge === 'none') {
        delete target.dataset.rawScrollEdge
      } else {
        target.dataset.rawScrollEdge = edge
      }
    }

    let frame = 0
    const scheduleUpdate = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }

    target.addEventListener('scroll', update, { passive: true })

    // A newly observed element reports its size once, so observing the
    // target and each direct child also takes the first measurement.
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resizeObserver?.observe(target)
    for (const child of Array.from(target.children)) {
      resizeObserver?.observe(child)
    }
    if (!resizeObserver) scheduleUpdate()

    // Direct children only: a list that gains rows reports them through the
    // observer above; one that loses rows can shrink without any remaining
    // element resizing, so it gets a measurement on the next frame.
    const childObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) resizeObserver?.observe(node)
        }
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof Element) resizeObserver?.unobserve(node)
        }
      }
      scheduleUpdate()
    })
    childObserver.observe(target, { childList: true })

    return () => {
      if (frame) cancelAnimationFrame(frame)
      target.removeEventListener('scroll', update)
      resizeObserver?.disconnect()
      childObserver.disconnect()
      delete target.dataset.rawScroll
      delete target.dataset.rawScrollEdge
    }
  }, [enabled, target, threshold])
}
