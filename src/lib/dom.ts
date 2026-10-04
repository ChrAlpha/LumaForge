import type { ReactEventHandler } from 'react'

export const stopPropagation: ReactEventHandler<any> = (e) =>
  e.stopPropagation()

export const preventDefault: ReactEventHandler<any> = (e) => e.preventDefault()

export const nextFrame = (fn: (...args: any[]) => any) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fn()
    })
  })
}

/**
 * Promise-flavoured single-frame yield. Resolves after the next animation
 * frame has fired — used as the paint boundary for `/raw` heavy
 * interactions, which acknowledge input before starting work.
 *
 * In jsdom (vitest) requestAnimationFrame is shimmed via setTimeout, so this
 * still resolves; tests that need to observe the boundary should spy on the
 * orchestrator's injected `yieldToPaint` rather than this module-level export.
 */
export const yieldToPaint = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    requestAnimationFrame(() => resolve())
  })

export const getElementTop = (element: HTMLElement) => {
  let actualTop = element.offsetTop
  let current = element.offsetParent as HTMLElement
  while (current !== null) {
    actualTop += current.offsetTop
    current = current.offsetParent as HTMLElement
  }
  return actualTop
}
