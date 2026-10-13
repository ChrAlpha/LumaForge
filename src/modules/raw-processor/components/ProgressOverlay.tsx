/**
 * Progress overlay component for loading/processing states.
 */

import { useAtomValue } from 'jotai'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { memo } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { Spring } from '~/lib/spring'

import { currentSessionAtom } from '../state/session.atoms'

export interface ProgressOverlayProps {
  visible: boolean
  phase: 'warming' | 'loading' | 'decoding' | 'processing' | 'exporting'
  progress?: number // 0-100
  recoveryHint?: string
  variant?: 'flat-handoff'
}

export const ProgressOverlay = memo(
  ({
    visible,
    phase,
    progress,
    recoveryHint,
    variant,
  }: ProgressOverlayProps) => {
    const { t } = useI18n()
    const reduced = useReducedMotion() ?? false
    const session = useAtomValue(currentSessionAtom)
    const phaseLabels: Record<ProgressOverlayProps['phase'], string> = {
      warming: t('raw.progress.warming'),
      loading: t('raw.progress.loading'),
      decoding: t('raw.progress.decoding'),
      processing: t('raw.progress.processing'),
      exporting: t('raw.progress.exporting'),
    }
    const formatWorkerCount = (count: number) =>
      count === 1
        ? t('raw.progress.workerOne')
        : t('raw.progress.workerMany', { count })
    const stripProgress =
      phase === 'exporting' ? session?.exportState.lastProgress : undefined
    const activePlan =
      phase === 'exporting' ? session?.exportState.activePlan : undefined
    const isExportHandoff = phase === 'exporting'
    const isFlatHandoff = isExportHandoff || variant === 'flat-handoff'
    const exportProfileCopy =
      activePlan?.runtimeMemoryProfile === 'low-memory'
        ? t('raw.progress.safeExport', {
            rows: activePlan.preferredRows,
            workers: formatWorkerCount(activePlan.concurrency),
          })
        : activePlan
          ? t('raw.progress.fastExport', {
              rows: activePlan.preferredRows,
              workers: formatWorkerCount(activePlan.concurrency),
            })
          : undefined
    const normalizedProgress =
      typeof progress === 'number' && Number.isFinite(progress)
        ? Math.min(100, Math.max(0, progress))
        : null
    const ringProgress =
      normalizedProgress === null ? 32 : Math.max(8, normalizedProgress)
    const progressTitle = isExportHandoff
      ? t('raw.progress.previewReleased')
      : phaseLabels[phase]
    const renderProgressRing = (
      frameClassName: string,
      showPercent: boolean,
    ) => (
      <div className={frameClassName}>
        <m.svg
          data-progress-indicator
          data-indeterminate={normalizedProgress === null || undefined}
          className="raw-progress-ring size-full -rotate-90"
          viewBox="0 0 64 64"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          animate={reduced ? { rotate: 0 } : { rotate: 360 }}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: normalizedProgress === null ? 0.9 : 1.6,
                  ease: 'linear',
                  repeat: Infinity,
                }
          }
          style={{ transformOrigin: '50% 50%' }}
        >
          <circle
            cx="32"
            cy="32"
            r="28"
            stroke="var(--color-progress-track)"
            strokeWidth="5"
          />
          <circle
            data-progress-arc
            cx="32"
            cy="32"
            r="28"
            stroke="var(--color-progress)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="100"
            strokeDashoffset={
              normalizedProgress === null ? 72 : 100 - ringProgress
            }
            pathLength="100"
          />
        </m.svg>

        {normalizedProgress !== null && showPercent && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs font-semibold tabular-nums text-[var(--color-on-stage)]">
              {`${Math.round(normalizedProgress)}%`}
            </span>
          </div>
        )}
      </div>
    )

    const overlay = (
      <AnimatePresence>
        {visible && (
          <m.div
            className="raw-progress-overlay absolute inset-0 z-50 flex items-center justify-center"
            role="status"
            aria-live="polite"
            aria-label={progressTitle}
            data-progress-overlay={phase}
            data-progress-variant={isFlatHandoff ? 'flat-handoff' : undefined}
            initial={{ opacity: isFlatHandoff ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={Spring.presets.smooth}
          >
            {isFlatHandoff ? (
              <>
                <div className="raw-progress-darkroom-field" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <m.div
                  data-progress-flat-handoff
                  className="raw-progress-flat-handoff grid w-full max-w-[24rem] justify-items-center gap-4 px-6 text-center"
                  initial={{ y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 8, opacity: 0 }}
                  transition={Spring.smooth(0.32)}
                >
                  {renderProgressRing(
                    'raw-progress-ring-frame relative size-14',
                    false,
                  )}

                  <div className="raw-progress-copy grid justify-items-center gap-2">
                    <h3 className="raw-progress-title text-[0.92rem] font-semibold leading-snug text-[var(--color-on-stage)]">
                      {progressTitle}
                    </h3>
                    {isExportHandoff ? (
                      <p className="raw-progress-detail max-w-[18rem] text-xs leading-relaxed text-[var(--color-on-stage-soft)]">
                        {t('raw.progress.previewReleasedDetail')}
                      </p>
                    ) : recoveryHint ? (
                      <p className="raw-progress-detail max-w-[18rem] text-xs leading-relaxed text-[var(--color-on-stage-soft)]">
                        {recoveryHint}
                      </p>
                    ) : null}
                  </div>

                  <div className="raw-progress-readout grid gap-1.5 text-xs tabular-nums text-[var(--color-on-stage-soft)]">
                    {normalizedProgress !== null && (
                      <p className="raw-progress-detail">
                        <span>{t('raw.progress.exporting')}</span>
                        <em>{`${Math.round(normalizedProgress)}%`}</em>
                      </p>
                    )}

                    {stripProgress && (
                      <p className="raw-progress-detail">
                        {t('raw.progress.strip', {
                          completed: stripProgress.completedStrips,
                          total: stripProgress.totalStrips,
                        })}
                      </p>
                    )}

                    {exportProfileCopy && (
                      <p className="raw-progress-detail">{exportProfileCopy}</p>
                    )}
                  </div>
                </m.div>
              </>
            ) : (
              <m.div
                data-progress-panel
                className="raw-progress-panel flex flex-col items-center gap-4 rounded-md border border-[var(--color-stage-hairline)] px-7 py-6"
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={Spring.smooth(0.32)}
              >
                {renderProgressRing('relative size-[4.5rem]', true)}

                <div className="text-center">
                  <p className="text-sm font-medium text-[var(--color-on-stage)]">
                    {progressTitle}
                  </p>

                  {recoveryHint && (
                    <p className="mt-2 max-w-xs text-center text-xs text-[var(--color-on-stage-soft)]">
                      {recoveryHint}
                    </p>
                  )}

                  {stripProgress && (
                    <p className="mt-2 text-xs tabular-nums text-[var(--color-on-stage-soft)]">
                      {t('raw.progress.strip', {
                        completed: stripProgress.completedStrips,
                        total: stripProgress.totalStrips,
                      })}
                    </p>
                  )}

                  {exportProfileCopy && (
                    <p className="mt-2 text-xs tabular-nums text-[var(--color-on-stage-soft)]">
                      {exportProfileCopy}
                    </p>
                  )}

                  {normalizedProgress !== null && (
                    <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-[var(--color-progress-track)]">
                      <m.div
                        className="h-full rounded-full bg-[var(--color-progress)]"
                        initial={{ width: 0 }}
                        animate={{ width: `${normalizedProgress}%` }}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                      />
                    </div>
                  )}
                </div>
              </m.div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    )

    return overlay
  },
)

/**
 * Error overlay component.
 */
export function ErrorOverlay({
  visible,
  message,
  onDismiss,
  className,
}: {
  visible: boolean
  message: string
  onDismiss: () => void
  className?: string
}) {
  const { t } = useI18n()

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          className={clsxm(
            'absolute inset-0 z-50 flex items-center justify-center bg-[var(--color-stage-scrim)]',
            className,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={Spring.presets.smooth}
        >
          <m.div
            className="flex flex-col items-center gap-4 p-8 max-w-md text-center"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={Spring.presets.snappy}
          >
            <div className="size-16 rounded-full bg-red/10 flex items-center justify-center">
              <i className="i-mingcute-warning-line text-3xl text-red" />
            </div>

            <div>
              <h3 className="text-lg font-medium text-text">
                {t('raw.error.title')}
              </h3>
              <p className="text-sm text-text-secondary mt-1">{message}</p>
            </div>

            <button
              type="button"
              onClick={onDismiss}
              className="px-4 py-2 rounded-lg bg-fill hover:bg-fill-secondary text-sm font-medium text-text transition-colors"
            >
              {t('raw.error.dismiss')}
            </button>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
