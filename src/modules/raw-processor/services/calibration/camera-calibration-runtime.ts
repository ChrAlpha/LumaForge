/**
 * Camera-calibration runtime service.
 *
 * Given a warm RAW session, a selected profile, and its parsed `dcp-params`
 * sidecar, the service:
 *
 *   1. Resolves the iterative DNG dual-illuminant interpolation in
 *      `luma-color-runtime/solveDcpInterpolation`. The current white-balance
 *      camera-neutral is supplied by the caller — Phase 1 may stopgap to
 *      AsShotNeutral if the WB-slider neutral isn't wired yet; the service
 *      API accepts `whiteNeutral` so the future swap is forward-compatible.
 *
 *   2. Decodes the producer-baked tone-curve LUT (when present) into a
 *      Float32Array for the worker payload. The producer is the source
 *      of truth for the curve shape — runtime never re-evaluates the spline.
 *
 *   3. Forwards the structured calibration profile across the worker boundary
 *      via `session.applyCalibration`. This reuses the warm runtime — no
 *      re-open, no re-unpack — matching the established perf contract.
 *
 * Outcomes are reported through a small return envelope plus structured
 * telemetry events so silent UX does not mean silent code (rollouts can audit
 * what the runtime actually did). See `./telemetry.ts` for the event grammar.
 */

import { solveDcpInterpolation } from '@lumaforge/luma-color-runtime'
import type { LumaRawCameraCalibrationProfile } from '@lumaforge/luma-raw-runtime'

import type { FetchDcpParamsOptions } from '~/lib/profiles/calibration-catalog'
import { decodeToneCurveLut as decodeToneCurveLutDefault } from '~/lib/profiles/calibration-catalog'
import type { DcpParams } from '~/lib/profiles/dcp-params'

import type { CameraProfileTelemetrySink } from './telemetry'
import { emitCameraProfileEvent } from './telemetry'

export type CameraCalibrationApplyReason =
  | 'unsupported'
  | 'rejected'
  | 'interpolation_capped'

export interface CameraCalibrationApplyResult {
  applied: boolean
  alpha?: number
  reason?: CameraCalibrationApplyReason
}

/**
 * Minimum slice of `RawRuntimeSession` the service needs. Kept narrow on
 * purpose so test doubles do not have to re-implement the whole adapter.
 */
export interface CameraCalibrationRuntimeSession {
  applyCalibration: (
    profile: LumaRawCameraCalibrationProfile,
    signal?: AbortSignal,
  ) => Promise<{ applied: true }>
}

export interface ApplySelectedCameraProfileInput {
  session: CameraCalibrationRuntimeSession
  profileId: string
  /**
   * Parsed `dcp-params` sidecar. `null` means the producer did not ship
   * sidecar params for this profile yet — the service treats it as
   * "unsupported on this client" silently.
   */
  dcpParams: DcpParams | null
  /** Current WB camera-neutral (length 3). Phase 1 may bind to AsShotNeutral. */
  whiteNeutral: readonly [number, number, number]
  signal?: AbortSignal
  /** Override the global telemetry sink for this call only. */
  telemetry?: CameraProfileTelemetrySink
  /** Indirection seam for tests; defaults to the catalog decoder. */
  decodeToneCurve?: typeof decodeToneCurveLutDefault
}

function emit(
  event: Parameters<typeof emitCameraProfileEvent>[0],
  telemetry?: CameraProfileTelemetrySink,
): void {
  if (telemetry) {
    telemetry(event)
    return
  }
  emitCameraProfileEvent(event)
}

/**
 * Resolve a selected camera profile through the iterative interpolation +
 * tone-curve decode, then forward the structured payload to the warm session.
 *
 * Outcome semantics:
 *
 * - `dcpParams === null` → `{ applied: false, reason: 'unsupported' }`.
 *   Silent at the UX layer; emits `camera_profile.unsupported`.
 * - Solver convergence fails (singular matrix / non-finite input) →
 *   `{ applied: false, reason: 'rejected' }` + `camera_profile.rejected`.
 * - Solver exhausts `maxIterations` without converging →
 *   `camera_profile.interpolation_capped` is emitted but the profile is still
 *   applied (capping is an audit event, not a rejection); the
 *   returned envelope still reflects `applied: true` with `reason:
 *   'interpolation_capped'` so the caller can surface diagnostic chrome
 *   later if needed.
 * - The native session call rejecting → `{ applied: false, reason: 'rejected' }`
 *   with `camera_profile.rejected { reason: 'runtime_error' }`. The original
 *   error is rethrown after telemetry so the caller's existing error chrome
 *   continues to work; service callers that prefer a silent envelope can
 *   wrap with `.catch(...)`.
 */
export async function applySelectedCameraProfile(
  input: ApplySelectedCameraProfileInput,
): Promise<CameraCalibrationApplyResult> {
  const {
    session,
    profileId,
    dcpParams,
    whiteNeutral,
    signal,
    telemetry,
    decodeToneCurve = decodeToneCurveLutDefault,
  } = input

  if (dcpParams === null) {
    emit(
      {
        type: 'camera_profile.unsupported',
        profileId,
        reason: 'missing_dcp_params',
      },
      telemetry,
    )
    return { applied: false, reason: 'unsupported' }
  }

  let solveResult: ReturnType<typeof solveDcpInterpolation>
  try {
    solveResult = solveDcpInterpolation({
      matrices: {
        m1: dcpParams.colorMatrix1,
        m2: dcpParams.colorMatrix2,
      },
      illuminants: {
        i1: { cct: dcpParams.illuminant1.cct, xy: dcpParams.illuminant1.xy },
        i2: dcpParams.illuminant2
          ? {
              cct: dcpParams.illuminant2.cct,
              xy: dcpParams.illuminant2.xy,
            }
          : null,
      },
      whiteNeutral,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emit(
      {
        type: 'camera_profile.rejected',
        profileId,
        reason: 'matrix_singular',
        detail,
      },
      telemetry,
    )
    return { applied: false, reason: 'rejected' }
  }

  if (!solveResult.converged) {
    // Spec event: `camera_profile.interpolation_capped` with the iteration
    // count. The DCP interpolation is still applied — capping is an audit
    // event for the rollout, not a rejection signal.
    emit(
      {
        type: 'camera_profile.interpolation_capped',
        profileId,
        iterations: solveResult.iterationsUsed,
      },
      telemetry,
    )
  }

  let toneCurveLut: Float32Array | undefined
  if (dcpParams.toneCurve) {
    try {
      toneCurveLut = decodeToneCurve(dcpParams.toneCurve)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      emit(
        {
          type: 'camera_profile.rejected',
          profileId,
          reason: 'schema_invalid',
          detail,
        },
        telemetry,
      )
      return { applied: false, reason: 'rejected' }
    }
  }

  const profile: LumaRawCameraCalibrationProfile = {
    profileId,
    profileName: dcpParams.profileName,
    xyzToCamera: solveResult.xyzToCamera,
    ...(toneCurveLut ? { toneCurveLut } : {}),
  }

  try {
    await session.applyCalibration(profile, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    emit(
      {
        type: 'camera_profile.rejected',
        profileId,
        reason: 'runtime_error',
        detail,
      },
      telemetry,
    )
    throw error
  }

  emit(
    {
      type: 'camera_profile.applied',
      profileId,
      schemaVersion: dcpParams.schemaVersion,
      alpha: solveResult.alpha,
    },
    telemetry,
  )

  return {
    applied: true,
    alpha: solveResult.alpha,
    ...(solveResult.converged
      ? {}
      : { reason: 'interpolation_capped' as const }),
  }
}

// Re-export so callers don't have to reach into ~/lib/profiles for the
// matching signature when constructing fetch options.
export type { FetchDcpParamsOptions }
