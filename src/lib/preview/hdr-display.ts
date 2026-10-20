/**
 * Whether the screen the page is on shows more than SDR, as the CSS
 * `dynamic-range` media feature reports it. It is a fact about the display,
 * not about the photo, and it changes when the window moves to another
 * screen or the system HDR setting flips.
 */
const HDR_DISPLAY_QUERY = '(dynamic-range: high)'

function hdrQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia(HDR_DISPLAY_QUERY)
    : null
}

export function isHdrDisplay(): boolean {
  return hdrQuery()?.matches === true
}

/** Calls `onChange` whenever the answer may have changed. */
export function subscribeHdrDisplay(onChange: () => void): () => void {
  const query = hdrQuery()
  if (!query) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
