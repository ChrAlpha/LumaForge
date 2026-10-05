import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowLeft, X } from 'lucide-react'
import { AnimatePresence, m, useDragControls } from 'motion/react'

import { IconButton } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { useI18n } from '~/lib/i18n'
import { sheetSpring } from '~/lib/spring'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { LUTContractSelectionState } from '../../model/session'
import { useToolMotion } from '../../motion'
import type { StrengthLevel } from '../tools/StrengthControl'
import { MobileLutCatalogView } from './MobileLutCatalogView'
import { MobileLutCurrentSections } from './MobileLutCurrentSections'
import { MobileLutOnlineSourcesSection } from './MobileLutOnlineSourcesSection'
import { useMobileLutBrowserController } from './useMobileLutBrowserController'

export interface MobileLutBrowserProps {
  open: boolean
  onClose: () => void
  currentLutName?: string | null
  disabled: boolean
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onlineLutSources?: UseOnlineLutSourcesResult
  activeIntensity?: StrengthLevel
  onIntensitySelect?: (level: StrengthLevel) => void
  strengthDisabled?: boolean
}

type OnlineResource = UseOnlineLutSourcesResult['state']['resources'][number]

function resourceLabel(resource: OnlineResource) {
  return resource.label || resource.url
}

export function MobileLutBrowser(props: MobileLutBrowserProps) {
  const { t } = useI18n()
  const { prefersReduced } = useToolMotion()
  const dragControls = useDragControls()
  const activeIntensity = props.activeIntensity ?? 'standard'
  const strengthDisabled = props.strengthDisabled ?? true

  const {
    view,
    onlineSourceInputId,
    overviewBodyRef,
    catalogBodyRef,
    entriesByResourceId,
    issuesByResourceId,
    selectedResource,
    selectedEntries,
    selectedIssues,
    selectedResourceLoading,
    selectedEntryGroups,
    returnToOverview,
    openCatalogResource,
  } = useMobileLutBrowserController({
    open: props.open,
    onlineLutSources: props.onlineLutSources,
  })

  const handleOpenChange = (open: boolean) => {
    if (!open) props.onClose()
  }

  const viewMotion = prefersReduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        initial: { opacity: 0, y: 12 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -8 },
      }

  const renderOverview = () => (
    <m.div
      key="overview"
      ref={overviewBodyRef}
      className="grid min-h-0 content-start gap-3 overflow-y-auto px-4 pb-5 pt-1"
      {...viewMotion}
      transition={sheetSpring}
    >
      <MobileLutCurrentSections
        currentLutName={props.currentLutName}
        disabled={props.disabled}
        onLutLoad={props.onLutLoad}
        onLutClear={props.onLutClear}
        activeIntensity={activeIntensity}
        onIntensitySelect={props.onIntensitySelect}
        strengthDisabled={strengthDisabled}
      />
      <MobileLutOnlineSourcesSection
        onlineLutSources={props.onlineLutSources}
        sourceInputId={onlineSourceInputId}
        entriesByResourceId={entriesByResourceId}
        issuesByResourceId={issuesByResourceId}
        onBrowseResource={openCatalogResource}
      />
    </m.div>
  )

  const renderCatalog = () => (
    <MobileLutCatalogView
      bodyRef={catalogBodyRef}
      viewMotion={viewMotion}
      selectedResource={selectedResource}
      selectedEntries={selectedEntries}
      selectedIssues={selectedIssues}
      selectedResourceLoading={selectedResourceLoading}
      selectedEntryGroups={selectedEntryGroups}
      disabled={props.disabled}
      lutSources={props.onlineLutSources}
      entryLoadProgress={props.onlineLutSources?.entryLoadProgress ?? null}
      onCancelEntryLoad={props.onlineLutSources?.cancelEntryLoad}
      onEntryLoaded={returnToOverview}
    />
  )

  const title =
    view === 'catalog' && selectedResource
      ? resourceLabel(selectedResource)
      : t('raw.mobile.lut.title')
  const canGoBack = view !== 'overview'

  return (
    <Dialog modal={false} open={props.open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {props.open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Content
              asChild
              forceMount
              aria-label={t('raw.mobile.lut.title')}
              aria-describedby={undefined}
              onPointerDownOutside={(event) => event.preventDefault()}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <m.aside
                key="lut-browser"
                data-mobile-substrate="ink-sheet"
                data-mobile-lut-view={view}
                className="absolute inset-x-0 bottom-0 z-[46] grid max-h-[82%] grid-rows-[auto_minmax(0,1fr)] rounded-t-xl border-t border-lf-on-photo-bord-soft bg-gradient-to-t from-[oklch(0.092_0.006_255/0.96)] via-[oklch(0.118_0.006_255/0.94)] to-[oklch(0.16_0.007_255/0.88)] pb-safe-offset-3 text-lf-on-photo-ink shadow-[0_-18px_42px_oklch(0.04_0.006_255/0.58),inset_0_1px_0_oklch(0.96_0.006_255/0.06)] backdrop-blur-background"
                initial={prefersReduced ? { opacity: 0 } : { y: '100%' }}
                animate={prefersReduced ? { opacity: 1 } : { y: '0%' }}
                exit={prefersReduced ? { opacity: 0 } : { y: '100%' }}
                transition={sheetSpring}
                drag={prefersReduced ? false : 'y'}
                dragControls={dragControls}
                dragListener={false}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.4 }}
                onDragEnd={(_, info) => {
                  if (info.offset.y > 80 || info.velocity.y > 500)
                    props.onClose()
                }}
              >
                <div
                  className="grid gap-2 px-3.5 pb-3 pt-2.5"
                  onPointerDown={(event) => dragControls.start(event)}
                >
                  <div
                    aria-hidden="true"
                    className="mx-auto h-1 w-9 rounded-lf-pill bg-lf-on-photo-ink/28"
                  />
                  <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2.5">
                    {canGoBack ? (
                      <IconButton
                        icon={ArrowLeft}
                        size="md"
                        aria-label={t('raw.mobile.lut.back')}
                        onClick={returnToOverview}
                        className="size-[44px] rounded-md bg-transparent text-lf-on-photo-ink/55 transition-colors hover:bg-lf-on-photo-bg-strong hover:text-lf-on-photo-ink [&_svg]:size-5 [&_svg]:stroke-current"
                      />
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <DialogPrimitive.Title asChild>
                      <h2 className="m-0 min-w-0 truncate text-center text-lf-body font-semibold text-lf-on-photo-ink">
                        {title}
                      </h2>
                    </DialogPrimitive.Title>
                    <IconButton
                      icon={X}
                      size="md"
                      aria-label={t('raw.mobile.lut.close')}
                      onClick={props.onClose}
                      className="size-[44px] rounded-md bg-transparent text-lf-on-photo-ink/55 transition-colors hover:bg-lf-on-photo-bg-strong hover:text-lf-on-photo-ink [&_svg]:size-5 [&_svg]:stroke-current"
                    />
                  </div>
                </div>

                <AnimatePresence mode="popLayout" initial={false}>
                  {view === 'overview' ? renderOverview() : renderCatalog()}
                </AnimatePresence>
              </m.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </Dialog>
  )
}
