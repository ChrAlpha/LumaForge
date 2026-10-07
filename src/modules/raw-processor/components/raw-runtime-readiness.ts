import type { Translate } from '~/lib/i18n'
import type { RawRuntimeHostSnapshot } from '~/lib/raw/raw-runtime-host'

export type RawRuntimeReadinessState = 'idle' | 'pending' | 'ready' | 'failed'

/**
 * Readiness is the host's runtime as it is now: `ready` needs an initialized
 * worker on the live generation, so a warmup that succeeded before an idle or
 * explicit termination reads as `idle` again. A failed warmup stays `failed`
 * until a later attempt starts or a runtime comes up.
 */
export function deriveRawRuntimeReadiness(
  snapshot: RawRuntimeHostSnapshot,
): RawRuntimeReadinessState {
  if (snapshot.runtime.initialized) return 'ready'
  if (snapshot.initialization === 'pending') return 'pending'
  if (snapshot.initialization === 'failed') return 'failed'
  return 'idle'
}

export function getRawRuntimeReadinessCopy(
  t: Translate,
  state: RawRuntimeReadinessState,
) {
  if (state === 'ready') {
    return {
      label: t('raw.runtime.ready'),
      detail: t('raw.runtime.readyDetail'),
    }
  }

  if (state === 'failed') {
    return {
      label: t('raw.runtime.retry'),
      detail: t('raw.runtime.retryDetail'),
    }
  }

  if (state === 'pending') {
    return {
      label: t('raw.runtime.pending'),
      detail: t('raw.runtime.pendingDetail'),
    }
  }

  return {
    label: t('raw.runtime.idle'),
    detail: t('raw.runtime.idleDetail'),
  }
}
