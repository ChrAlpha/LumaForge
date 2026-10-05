/**
 * Focus has nowhere to be when it sits on the body or on an element that
 * has left the document: the panel holding the focused control was swapped
 * out from under it.
 */
export function isFocusLost(doc: Document = document) {
  const active = doc.activeElement
  return !active || active === doc.body || !active.isConnected
}

/**
 * Hands lost focus to `target`, the control that now stands for what the
 * user was doing. Focus that is still somewhere stays where it is.
 */
export function handLostFocusTo(target: HTMLElement | null | undefined) {
  if (!target || !isFocusLost(target.ownerDocument)) return false
  target.focus({ preventScroll: true })
  return true
}
