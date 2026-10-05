import {
  createOriginalReferenceSnapshotKey,
  getOriginalReferenceSnapshotMaxPixels,
  releaseOriginalReferenceSnapshot,
} from './original-reference-snapshot'

describe('original reference snapshot policy', () => {
  it('keys the snapshot by source facts and technical-base facts only', () => {
    const base = createOriginalReferenceSnapshotKey({
      sessionId: 'session-a',
      displaySource: 'quick',
      imageVersion: 3,
      width: 2000,
      height: 1250,
      renderExposureEv: 0.5,
      policyVersion: 1,
    })

    const styleChange = createOriginalReferenceSnapshotKey({
      sessionId: 'session-a',
      displaySource: 'quick',
      imageVersion: 3,
      width: 2000,
      height: 1250,
      renderExposureEv: 0.5,
      policyVersion: 1,
      ignored: {
        split: 0.82,
        zoom: 4,
        panX: 120,
        panY: -30,
        styleFingerprint: 'classic-709',
        lutFingerprint: 'lut-a',
        intensity: 0.25,
        userExposureEv: 1,
      },
    })

    expect(styleChange).toBe(base)
  })

  it('changes the key for bounded HQ upgrade and render exposure change', () => {
    const quick = createOriginalReferenceSnapshotKey({
      sessionId: 'session-a',
      displaySource: 'quick',
      imageVersion: 3,
      width: 2000,
      height: 1250,
      renderExposureEv: 0.5,
      policyVersion: 1,
    })

    expect(
      createOriginalReferenceSnapshotKey({
        sessionId: 'session-a',
        displaySource: 'bounded-hq',
        imageVersion: 4,
        width: 4000,
        height: 3000,
        renderExposureEv: 0.5,
        policyVersion: 1,
      }),
    ).not.toBe(quick)

    expect(
      createOriginalReferenceSnapshotKey({
        sessionId: 'session-a',
        displaySource: 'quick',
        imageVersion: 3,
        width: 2000,
        height: 1250,
        renderExposureEv: 0.75,
        policyVersion: 1,
      }),
    ).not.toBe(quick)
  })

  it('caps snapshot pixels by capability policy and active preview dimensions', () => {
    expect(
      getOriginalReferenceSnapshotMaxPixels({
        displaySourcePixels: 12_000_000,
        webKitClass: 'webkit-mobile',
        pthread: false,
      }),
    ).toBe(2_500_000)

    expect(
      getOriginalReferenceSnapshotMaxPixels({
        displaySourcePixels: 2_000_000,
        webKitClass: 'chromium',
        pthread: true,
      }),
    ).toBe(2_000_000)
  })

  it('uses GPU preview budget before falling back to the pthread snapshot floor', () => {
    expect(
      getOriginalReferenceSnapshotMaxPixels({
        displaySourcePixels: 12_000_000,
        webKitClass: 'webkit-mobile',
        pthread: false,
        previewGpuBudgetMaxPixels: 12_000_000,
      }),
    ).toBe(12_000_000)

    expect(
      getOriginalReferenceSnapshotMaxPixels({
        displaySourcePixels: 8_000_000,
        webKitClass: 'webkit-mobile',
        pthread: false,
        previewGpuBudgetMaxPixels: 12_000_000,
      }),
    ).toBe(8_000_000)
  })

  it('revokes the snapshot URL without keeping a history of released URLs', () => {
    const revokeObjectURL = vi.fn()
    const snapshot = {
      key: 'snapshot-a',
      objectUrl: 'blob:original-a',
      width: 100,
      height: 50,
      source: 'quick' as const,
      mimeType: 'image/jpeg' as const,
      estimatedBytes: 1234,
    }

    releaseOriginalReferenceSnapshot(snapshot, { revokeObjectURL })
    releaseOriginalReferenceSnapshot(snapshot, { revokeObjectURL })

    // Release-once belongs to the snapshot's lifecycle owner, not to a
    // module-wide record of every URL ever released.
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'blob:original-a')
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:original-a')
  })

  it('ignores missing snapshots before resolving the default URL revoker', () => {
    expect(() => releaseOriginalReferenceSnapshot(null)).not.toThrow()
    expect(() => releaseOriginalReferenceSnapshot(undefined)).not.toThrow()
  })
})
