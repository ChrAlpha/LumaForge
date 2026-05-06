import { useAtomValue } from 'jotai'
import { FolderOpen, MoreHorizontal, RotateCcw } from 'lucide-react'

import { LocaleToggle } from '~/components/common/LocaleToggle'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu/DropdownMenu'
import { localizeRawReason, useI18n } from '~/lib/i18n'

import {
  currentSessionAtom,
  exportDisabledReasonAtom,
} from '../state/session.atoms'
import { SupportBadge } from './SupportBadge'

const appIcon = '/favicon.png'

export function WorkspaceHeader({
  fileName,
  hasImage,
  supportLevel,
  canExport,
  disabledReason,
  onReplaceFile,
  onResetSession,
  onOpenExport,
}: {
  fileName?: string
  hasImage: boolean
  supportLevel: 'official' | 'experimental'
  canExport: boolean
  disabledReason?: string
  onReplaceFile: () => void
  onResetSession: () => void
  onOpenExport: () => void
}) {
  const { t } = useI18n()
  const session = useAtomValue(currentSessionAtom)
  const sessionDisabledReason = useAtomValue(exportDisabledReasonAtom)
  const isExporting = session?.exportState.status === 'exporting'
  const rawExportDisabledReason = !canExport
    ? (disabledReason ?? sessionDisabledReason ?? t('raw.exportSourceLoading'))
    : undefined
  const exportDisabledReason = localizeRawReason(rawExportDisabledReason, t)

  return (
    <header
      className="flex items-center justify-between gap-4 max-w-full min-w-0 border-b border-[color:--color-raw-hairline] px-[clamp(12px,2vw,22px)] py-3 bg-[color:oklch(0.952_0.018_86)]"
      role="banner"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <img
            className="block size-7 shrink-0 rounded-[5px] object-cover shadow-[0_8px_22px_oklch(0.1_0.02_78_/_0.12)]"
            src={appIcon}
            alt=""
            aria-hidden="true"
          />
          <h1 className="truncate text-base font-semibold text-[oklch(0.18_0.018_76)]">
            {hasImage ? fileName : t('raw.header.title')}
          </h1>
          {hasImage && (
            <span className="inline-flex">
              <SupportBadge level={supportLevel} />
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-xs text-[oklch(0.38_0.032_75)]">
          {hasImage
            ? t('raw.header.subtitleLoaded')
            : t('raw.header.subtitleEmpty')}
        </p>
        {exportDisabledReason && (
          <p className="mt-1 truncate text-xs text-[oklch(0.38_0.032_75)]">
            {t('raw.header.unavailablePrefix', {
              reason: exportDisabledReason,
            })}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <LocaleToggle className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[color:--color-raw-hairline] bg-[color:--color-raw-paper] px-[11px] py-2 text-[0.8rem] font-bold text-[color:--color-raw-ink] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:--color-raw-green] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-w-[70px]" />
        <button
          type="button"
          onClick={onReplaceFile}
          disabled={isExporting}
          className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[color:--color-raw-hairline] bg-[color:--color-raw-paper] px-[11px] py-2 text-[0.8rem] font-bold text-[color:--color-raw-ink] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:--color-raw-green] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {hasImage ? t('raw.header.replace') : t('raw.header.chooseRaw')}
        </button>
        <button
          type="button"
          onClick={onResetSession}
          disabled={!hasImage || isExporting}
          className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[color:--color-raw-hairline] bg-[color:--color-raw-paper] px-[11px] py-2 text-[0.8rem] font-bold text-[color:--color-raw-ink] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:--color-raw-green] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('raw.header.reset')}
        </button>
        <button
          type="button"
          onClick={onOpenExport}
          disabled={!canExport}
          className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.74_0.15_152)] bg-[color:--color-raw-green] px-[11px] py-2 text-[0.8rem] font-bold text-[color:--color-raw-ink] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:--color-raw-green] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('raw.header.fullRes')}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[color:--color-raw-hairline] bg-[color:--color-raw-paper] px-[11px] py-2 text-[0.8rem] font-bold text-[color:--color-raw-ink] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:--color-raw-green] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 hidden @[640px]:inline-flex"
            >
              <MoreHorizontal aria-hidden="true" />
              {t('raw.header.more')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="z-60 min-w-[168px] rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.72)] bg-gradient-to-b from-[color:oklch(0.962_0.018_86)] to-[color:oklch(0.922_0.026_86)] p-1 text-[color:--color-raw-ink] shadow-[0_16px_42px_oklch(0.18_0.018_76_/_0.18)]"
          >
            <DropdownMenuItem
              className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-[0.82rem] font-semibold text-[color:--color-raw-ink] focus:bg-[color:oklch(0.86_0.065_145)] data-[highlighted]:bg-[color:oklch(0.86_0.065_145)] data-[disabled]:opacity-50"
              disabled={isExporting}
              onSelect={onReplaceFile}
            >
              <FolderOpen aria-hidden="true" />
              {hasImage ? t('raw.header.replace') : t('raw.header.chooseRaw')}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-[0.82rem] font-semibold text-[color:--color-raw-ink] focus:bg-[color:oklch(0.86_0.065_145)] data-[highlighted]:bg-[color:oklch(0.86_0.065_145)] data-[disabled]:opacity-50"
              disabled={!hasImage || isExporting}
              onSelect={onResetSession}
            >
              <RotateCcw aria-hidden="true" />
              {t('raw.header.reset')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
