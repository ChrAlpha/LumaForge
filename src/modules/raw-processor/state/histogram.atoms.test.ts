import { describe, expect, it } from 'vitest'

import { isPreviewHistogramShown } from './histogram.atoms'

const desktop = {
  mobileSurface: false,
  mobileHistogramShown: false,
  cpuPreview: false,
  transformActive: false,
}

describe('isPreviewHistogramShown', () => {
  it('runs on desktop, where the rail always shows it', () => {
    expect(isPreviewHistogramShown(desktop)).toBe(true)
  })

  it('runs on a phone only while the histogram is turned on', () => {
    const phone = { ...desktop, mobileSurface: true }
    expect(isPreviewHistogramShown(phone)).toBe(false)
    expect(
      isPreviewHistogramShown({ ...phone, mobileHistogramShown: true }),
    ).toBe(true)
  })

  it('never runs in the CPU preview or over an applied Transform', () => {
    expect(isPreviewHistogramShown({ ...desktop, cpuPreview: true })).toBe(
      false,
    )
    expect(isPreviewHistogramShown({ ...desktop, transformActive: true })).toBe(
      false,
    )
  })
})
