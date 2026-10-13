import {
  createOriginalReferenceSnapshotKey,
  getOriginalReferenceSnapshotMaxPixels,
  releaseOriginalReferenceSnapshot,
} from './original-reference-snapshot'

describe('original reference snapshot policy', () => {
  it('keys the snapshot by the accepted frame and the technical-base policy only', () => {
    const frame = { sessionId: 'session-a', frameId: 'decoded-frame-3' }
    const base = createOriginalReferenceSnapshotKey({
      frame,
      displaySource: 'quick',
      policyVersion: 1,
    })

    // The same accepted frame keys the same snapshot, whatever object
    // carries its identity.
    expect(
      createOriginalReferenceSnapshotKey({
        frame: { ...frame },
        displaySource: 'quick',
        policyVersion: 1,
      }),
    ).toBe(base)
  })

  it('changes the key for another accepted frame, however alike its pixels', () => {
    const quick = createOriginalReferenceSnapshotKey({
      frame: { sessionId: 'session-a', frameId: 'decoded-frame-3' },
      displaySource: 'quick',
      policyVersion: 1,
    })

    // A frame decoded again for the same source, a restored frame included.
    expect(
      createOriginalReferenceSnapshotKey({
        frame: { sessionId: 'session-a', frameId: 'decoded-frame-4' },
        displaySource: 'quick',
        policyVersion: 1,
      }),
    ).not.toBe(quick)
    // A replaced source never shares a key, even with an equal frame id.
    expect(
      createOriginalReferenceSnapshotKey({
        frame: { sessionId: 'session-b', frameId: 'decoded-frame-3' },
        displaySource: 'quick',
        policyVersion: 1,
      }),
    ).not.toBe(quick)
    expect(
      createOriginalReferenceSnapshotKey({
        frame: { sessionId: 'session-a', frameId: 'decoded-frame-4' },
        displaySource: 'bounded-hq',
        policyVersion: 1,
      }),
    ).toContain('source:bounded-hq')
    expect(
      createOriginalReferenceSnapshotKey({
        frame: { sessionId: 'session-a', frameId: 'decoded-frame-3' },
        displaySource: 'quick',
        policyVersion: 2,
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
