import { useAtomValue } from 'jotai'
import { FolderOpen, MoreHorizontal, RotateCcw } from 'lucide-react'
import { memo } from 'react'

import { LocaleToggle } from '~/components/common/LocaleToggle'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu/DropdownMenu'
import { useI18n } from '~/lib/i18n'

import type { SupportLevel } from '../model/session'
import { currentSessionAtom } from '../state/session.atoms'
import { SupportBadge } from './SupportBadge'

const appIcon = '/favicon.png'

export const WorkspaceHeader = memo(
  ({
    fileName,
    hasImage,
    supportLevel,
    onReplaceFile,
    onResetSession,
  }: {
    fileName?: string
    hasImage: boolean
    supportLevel: SupportLevel
    onReplaceFile: () => void
    onResetSession: () => void
  }) => {
    const { t } = useI18n()
    const session = useAtomValue(currentSessionAtom)
    const isExporting = session?.exportState.status === 'exporting'

    return (
      <header
        data-raw-desktop-chrome="on-photo-topbar"
        data-raw-desktop-density="compact-command"
        className="flex min-h-[52px] min-w-0 items-center justify-between gap-4 border-b border-lf-on-photo-bord-soft pb-2 pt-safe-offset-2 px-safe-offset-3 text-lf-on-photo-ink sm:px-safe-offset-3 [@media(max-height:480px)]:pb-1.5 [@media(max-height:480px)]:pt-[calc(6px+env(safe-area-inset-top))]"
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              className="size-6 shrink-0 rounded-[5px] object-cover ring-1 ring-inset ring-lf-on-photo-bord-soft"
              src={appIcon}
              alt=""
              aria-hidden="true"
            />
            <h1 className="truncate text-[0.875rem] font-semibold leading-tight tracking-tight text-lf-on-photo-ink">
              {hasImage ? fileName : t('raw.header.title')}
            </h1>
            {hasImage && (
              <span className="inline-flex max-[640px]:hidden">
                <SupportBadge level={supportLevel} />
              </span>
            )}
          </div>
          <div className="ps-[34px]">
            <p className="mt-0.5 truncate text-[0.685rem] font-medium leading-snug text-lf-on-photo-ink/52 [@media(max-height:480px)]:hidden">
              {hasImage
                ? t('raw.header.subtitleLoaded')
                : t('raw.header.subtitleEmpty')}
            </p>
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-1"
          data-raw-desktop-actions="command-cluster"
        >
          <LocaleToggle className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[0.72rem] font-medium text-lf-on-photo-ink/68 shadow-none transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80 max-[640px]:hidden" />
          <span
            aria-hidden="true"
            className="mx-1 h-4 w-px bg-lf-on-photo-bord-soft max-[640px]:hidden"
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onReplaceFile}
            disabled={isExporting}
            data-raw-header-action="replace"
            className="h-7 gap-1.5 rounded-md border-0 bg-transparent px-2 text-[0.72rem] font-medium text-lf-on-photo-ink/78 shadow-none transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80 max-[640px]:hidden [&_svg]:size-[13px] [&_svg]:stroke-[1.85]"
          >
            <FolderOpen aria-hidden="true" />
            {hasImage ? t('raw.header.replace') : t('raw.header.chooseRaw')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onResetSession}
            disabled={!hasImage || isExporting}
            data-raw-header-action="reset"
            className="h-7 gap-1.5 rounded-md border-0 bg-transparent px-2 text-[0.72rem] font-medium text-lf-on-photo-ink/78 shadow-none transition-colors hover:bg-lf-rose/14 hover:text-lf-rose focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-rose/70 max-[640px]:hidden [&_svg]:size-[13px] [&_svg]:stroke-[1.85]"
          >
            <RotateCcw aria-hidden="true" />
            {t('raw.header.reset')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                className="hidden gap-1.5 max-[640px]:inline-flex"
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
                {t('raw.header.more')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="gap-2"
                disabled={isExporting}
                onSelect={onReplaceFile}
              >
                <FolderOpen aria-hidden="true" className="size-[15px]" />
                {hasImage ? t('raw.header.replace') : t('raw.header.chooseRaw')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2"
                disabled={!hasImage || isExporting}
                onSelect={onResetSession}
              >
                <RotateCcw aria-hidden="true" className="size-[15px]" />
                {t('raw.header.reset')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    )
  },
)
