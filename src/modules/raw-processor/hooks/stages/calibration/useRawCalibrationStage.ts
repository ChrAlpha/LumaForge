/**
 * Workflow stage hook owning per-RAW camera-calibration selection.
 *
 * Responsibilities:
 *
 * - Watch the session id and reset the selected profile when the RAW changes
 *   (per-RAW state, no persistence — see `state/calibration.atoms.ts`).
 *
 * - Expose the list of available profiles for the current RAW. The matching
 *   pipeline that ties body+lens to catalog entries is not in scope for this
 *   PR; the hook accepts a `getAvailableProfiles` callback that the caller
 *   can wire to a future matcher. When unset, the stage returns the "trivial
 *   no-matches" surface so the UI can render the empty calibration tool
 *   without crashing.
 *
 * - On selection: fetch the `dcp-params` sidecar (the CalibrationEntry shape
 *   carries the URL), then dispatch through
 *   `applySelectedCameraProfile`. The hook never reaches into LibRaw
 *   directly — the service owns the worker boundary.
 *
 * - WB-neutral source: bound through `getWhiteNeutral()` so Phase 1 can
 *   stopgap to AsShotNeutral while the WB-slider neutral lands. The hook
 *   does not couple to any specific neutral provider.
 *
 * UI surface (CalibrationTool) consumes the returned values; this stage does
 * not import any component.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo } from 'react'

import type { CalibrationEntry } from '~/lib/profiles/calibration-catalog'
import { fetchDcpParams as fetchDcpParamsDefault } from '~/lib/profiles/calibration-catalog'
import type { DcpParams } from '~/lib/profiles/dcp-params'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { CameraCalibrationApplyResult } from '../../../services/calibration'
import { applySelectedCameraProfile as applySelectedCameraProfileDefault } from '../../../services/calibration'
import {
  useSelectedCameraProfileId,
  useSetSelectedCameraProfileId,
} from '../../../state/calibration.atoms'

export type WhiteNeutralVec = readonly [number, number, number]

export interface UseRawCalibrationStageInput {
  /** Current session id, or null when no RAW is loaded. */
  sessionId: string | null
  /** Warm runtime session ref. The hook reads `.current` at call time. */
  runtimeSessionRef: MutableRefObject<RawRuntimeSession | null>
  /**
   * Per-RAW catalog matches. Wire to the body/lens matcher when it exists;
   * Phase 1 stub returns an empty array (trivial no-matches surface).
   */
  getAvailableProfiles?: () => readonly CalibrationEntry[]
  /**
   * Current WB camera-neutral. Phase 1 may stopgap to AsShotNeutral if a
   * current-WB-neutral source isn't wired. Returning `null` skips the apply
   * call (no neutral, no interpolation) — selection state still updates so
   * UX surfaces a chip; nothing reaches the runtime.
   */
  getWhiteNeutral: () => WhiteNeutralVec | null
  /** Indirection for tests; defaults to the real fetcher. */
  fetchDcpParams?: typeof fetchDcpParamsDefault
  /** Indirection for tests; defaults to the production service. */
  applyService?: typeof applySelectedCameraProfileDefault
  /**
   * Optional pre-fetched cache so repeated selection of the same profile
   * doesn't re-hit the network. The stage manages no cache itself in Phase 1.
   */
  getCachedDcpParams?: (entry: CalibrationEntry) => DcpParams | null | undefined
  /** Optional setter to populate a cache after a successful fetch. */
  setCachedDcpParams?: (entry: CalibrationEntry, params: DcpParams) => void
}

export type UseRawCalibrationStageReturn = {
  /** The available profiles for the current RAW. Empty array when no matches. */
  availableProfiles: readonly CalibrationEntry[]
  /** Currently selected profile id, or null when none is selected. */
  selectedCameraProfileId: string | null
  /** True when the currently selected profile is being resolved + applied. */
  isApplying: boolean
  /**
   * Select a profile by id. Pass `null` to clear. When the profile cannot be
   * resolved (no `dcp-params` asset) the selection is allowed but the runtime
   * call is skipped silently — matching the silent-by-default contract.
   */
  selectCameraProfile: (
    profileId: string | null,
  ) => Promise<
    CameraCalibrationApplyResult | { applied: false; reason: 'skipped' }
  >
}

const NO_MATCHES: readonly CalibrationEntry[] = Object.freeze([])

export function useRawCalibrationStage({
  sessionId,
  runtimeSessionRef,
  getAvailableProfiles,
  getWhiteNeutral,
  fetchDcpParams = fetchDcpParamsDefault,
  applyService = applySelectedCameraProfileDefault,
  getCachedDcpParams,
  setCachedDcpParams,
}: UseRawCalibrationStageInput): UseRawCalibrationStageReturn {
  const [selectedCameraProfileId, setSelectedCameraProfileId] =
    useSelectedCameraProfileId() as ReturnType<
      typeof useSelectedCameraProfileId
    >
  // useSelectedCameraProfileId returns [value, setter]; useSetSelectedCameraProfileId
  // exists for callers that don't need to read. We pull the setter out of the
  // useAtom tuple so reset effects don't subscribe to the value.
  const setSelectedProfileIdImperative = useSetSelectedCameraProfileId()

  // The atom is RAW-scoped; clear it whenever the session changes (incl. to
  // null on reset). The session-id key string is the lifecycle signal.
  useEffect(() => {
    setSelectedProfileIdImperative(null)
  }, [sessionId, setSelectedProfileIdImperative])

  const availableProfiles = useMemo<readonly CalibrationEntry[]>(
    () => getAvailableProfiles?.() ?? NO_MATCHES,
    [getAvailableProfiles],
  )

  // Tracks the in-flight selection so callers can disable the picker UI.
  // We intentionally do NOT race-cancel previous selections: the warm
  // session.applyCalibration is the synchronization point; the latest call
  // wins (mirrors the perf-calibration-fast-swap behavior in
  // orchestrate-raw-load.ts).
  const inflightRef = useMemo<{ current: number }>(() => ({ current: 0 }), [])

  const selectCameraProfile = useCallback<
    UseRawCalibrationStageReturn['selectCameraProfile']
  >(
    async (profileId) => {
      setSelectedCameraProfileId(profileId)
      if (profileId === null) {
        return { applied: false, reason: 'skipped' }
      }

      const entry = availableProfiles.find(
        (candidate) => candidate.id === profileId,
      )
      if (!entry) {
        return { applied: false, reason: 'skipped' }
      }

      // Silent-by-default: an entry without a dcp-params sidecar is
      // unselectable in the UI, but the runtime treats it as
      // unsupported. We still surface the apply call to the service so the
      // structured telemetry event fires consistently.
      const runtimeSession = runtimeSessionRef.current
      const whiteNeutral = getWhiteNeutral()
      if (!runtimeSession || !whiteNeutral) {
        return { applied: false, reason: 'skipped' }
      }

      let dcpParams: DcpParams | null = null
      const cached = getCachedDcpParams?.(entry)
      if (cached) {
        dcpParams = cached
      } else if (entry.dcpParamsAssetUrl) {
        try {
          inflightRef.current += 1
          dcpParams = await fetchDcpParams(entry.dcpParamsAssetUrl)
          setCachedDcpParams?.(entry, dcpParams)
        } catch {
          // Treat fetch/parse failures the same as missing params: silent
          // unsupported. The service will emit the structured event.
          dcpParams = null
        } finally {
          inflightRef.current = Math.max(0, inflightRef.current - 1)
        }
      }

      return applyService({
        session: runtimeSession,
        profileId,
        dcpParams,
        whiteNeutral,
      })
    },
    [
      applyService,
      availableProfiles,
      fetchDcpParams,
      getCachedDcpParams,
      getWhiteNeutral,
      inflightRef,
      runtimeSessionRef,
      setCachedDcpParams,
      setSelectedCameraProfileId,
    ],
  )

  return {
    availableProfiles,
    selectedCameraProfileId,
    isApplying: inflightRef.current > 0,
    selectCameraProfile,
  }
}

/** Internal helper: typed `Dispatch` for the `useState`-style atom hook. */
// (Used by tests; exported here for clarity.)
export type CalibrationStateSetter = Dispatch<SetStateAction<string | null>>
