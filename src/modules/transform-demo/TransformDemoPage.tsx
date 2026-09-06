import {
  Aperture,
  ArrowLeft,
  Download,
  Grid2X2,
  ImageUp,
  ScanLine,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'

import { Button } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import type { MessageKey } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'
import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'

import { TransformCanvas } from './TransformCanvas'
import { TransformControls } from './TransformControls'
import { usePreviewDownload } from './usePreviewDownload'
import { useTransformDemo } from './useTransformDemo'

const ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  ...Array.from(SUPPORTED_RAW_EXTENSIONS, (ext) => `.${ext}`),
].join(',')
const NO_LINES: [] = []

export function TransformDemoPage() {
  const { t, locale, toggleLocale } = useI18n()
  const demo = useTransformDemo()
  const input = useRef<HTMLInputElement>(null)
  const [original, setOriginal] = useState(false)
  const [showLines, setShowLines] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const frame = demo.result?.frame

  const { download, downloading, downloadError } = usePreviewDownload(
    frame,
    demo.source?.name,
  )

  const status: MessageKey = demo.loading
    ? 'transform.analyzing'
    : demo.rendering
      ? 'transform.rendering'
      : demo.solution.status === 'insufficient'
        ? 'transform.insufficient'
        : demo.mode === 'off'
          ? 'transform.ready'
          : demo.solution.status === 'unchanged'
            ? 'transform.unchanged'
            : 'transform.applied'
  return (
    <main
      className="flex h-dvh flex-col overflow-hidden bg-lf-surface text-lf-on-surface selection:bg-lf-green/30"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) void demo.loadSource(file)
      }}
    >
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-lf-on-surface/10 px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <Aperture size={23} aria-hidden />
          <h1 className="text-base font-semibold tracking-tight">
            {t('transform.title')}
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" className="h-11">
            <Link to="/raw">
              <ArrowLeft size={15} aria-hidden />
              {t('transform.rawLab')}
            </Link>
          </Button>
          <Button variant="ghost" className="h-11 px-3" onClick={toggleLocale}>
            {locale === 'en' ? '中文' : 'EN'}
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-1">
        <section
          className="flex min-h-0 min-w-0 flex-col bg-lf-surface-sunk"
          aria-label={t('transform.workspace')}
        >
          <div className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
            <div className="min-w-0 flex-1">
              <p
                className="max-w-[50vw] truncate text-sm font-medium"
                title={demo.source?.name}
              >
                {demo.source?.kind === 'sample'
                  ? t('transform.sampleName')
                  : (demo.source?.name ?? t('transform.openHint'))}
              </p>
              <p className="mt-1 truncate text-xs text-lf-on-surface/65">
                {demo.source?.kind === 'sample'
                  ? t('transform.synthetic')
                  : t('transform.local')}
              </p>
            </div>
            <Button
              variant="secondary"
              className="h-11"
              onClick={() => input.current?.click()}
            >
              <ImageUp size={16} aria-hidden />
              {t('transform.open')}
            </Button>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              aria-label={t('transform.open')}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void demo.loadSource(file)
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 sm:px-6">
            <div
              role="group"
              aria-label={t('transform.compare')}
              className="flex gap-1 rounded-md bg-lf-on-surface/5 p-1"
            >
              <Button
                variant={original ? 'ghost' : 'secondary'}
                className="h-10 text-xs"
                aria-pressed={!original}
                disabled={!demo.source}
                onClick={() => setOriginal(false)}
              >
                {t('transform.corrected')}
              </Button>
              <Button
                variant={original ? 'secondary' : 'ghost'}
                className="h-10 text-xs"
                aria-pressed={original}
                disabled={!demo.source}
                onClick={() => setOriginal(true)}
              >
                {t('transform.original')}
              </Button>
            </div>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                className="h-11 text-xs"
                aria-pressed={showLines}
                disabled={!demo.ready}
                onClick={() => setShowLines(!showLines)}
              >
                <ScanLine size={15} aria-hidden />
                <span className="sr-only sm:not-sr-only">
                  {t('transform.lines')}
                </span>
              </Button>
              <Button
                variant="ghost"
                className="h-11 text-xs"
                aria-pressed={showGrid}
                disabled={!demo.source}
                onClick={() => setShowGrid(!showGrid)}
              >
                <Grid2X2 size={15} aria-hidden />
                <span className="sr-only sm:not-sr-only">
                  {t('transform.grid')}
                </span>
              </Button>
            </div>
          </div>
          <div
            className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 pb-3 sm:px-6 sm:pb-6"
            aria-busy={demo.loading || demo.rendering}
          >
            {demo.source ? (
              <TransformCanvas
                source={demo.source.frame}
                result={demo.result}
                lines={demo.analysis?.lines ?? NO_LINES}
                original={original}
                showLines={showLines}
                showGrid={showGrid}
              />
            ) : (
              <p className="max-w-sm px-6 text-center text-sm leading-relaxed text-lf-on-surface/75">
                {t(demo.loading ? 'transform.loading' : 'transform.openHint')}
              </p>
            )}
          </div>
          <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-lf-on-surface/10 px-4 py-3 text-xs text-lf-on-surface/75 sm:px-6">
            <output
              role={demo.error ? 'alert' : 'status'}
              data-testid="transform-status"
              data-mode={demo.mode}
              data-busy={demo.loading || demo.rendering}
              className={clsxm(
                demo.solution.status === 'insufficient' && 'text-lf-on-surface',
              )}
            >
              {demo.error
                ? t(`transform.error.${demo.error}` as MessageKey)
                : t(status)}
            </output>
            <span className="tabular-nums">
              {frame ? `${frame.width} × ${frame.height}` : ''}
              {demo.analysis
                ? ` · ${t('transform.lineCount', { count: demo.analysis.lines.length })}`
                : ''}
            </span>
          </div>
        </section>
        <aside className="min-h-0 overflow-y-auto overscroll-contain border-t border-lf-on-surface/10 px-5 py-4 lg:border-t-0 lg:border-l">
          <TransformControls
            mode={demo.mode}
            onModeChange={(mode) => {
              setOriginal(false)
              demo.setMode(mode)
            }}
            manual={demo.manual}
            onManualChange={(manual) => {
              setOriginal(false)
              demo.setManual(manual)
            }}
            constrainCrop={demo.constrainCrop}
            onCropChange={demo.setConstrainCrop}
            onReset={() => {
              setOriginal(false)
              demo.reset()
            }}
            disabled={!demo.ready}
          />
          <div className="mt-6 border-t border-lf-on-surface/10 pt-5">
            {/* lf-surface on green: 5.3:1 contrast; hover: 7.0:1. */}
            <Button
              className="h-11 w-full text-lf-surface"
              onClick={() => void download()}
              disabled={
                !frame || demo.loading || demo.rendering || Boolean(demo.error)
              }
              isLoading={downloading}
            >
              <Download size={16} aria-hidden />
              {t('transform.download')}
            </Button>
            <p className="mt-3 text-xs leading-relaxed text-lf-on-surface/65">
              {t('transform.previewLimit')}
            </p>
            <Button
              variant="ghost"
              className="mt-3 h-11 w-full"
              onClick={() => void demo.loadSource()}
            >
              {t('transform.loadSample')}
            </Button>
          </div>
          {demo.analysis ? (
            <details className="mt-4 border-t border-lf-on-surface/10 pt-4 text-xs text-lf-on-surface/70">
              <summary className="cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-lf-green">
                {t('transform.details')}
              </summary>
              <p className="mt-2 tabular-nums">
                {t('transform.timing', { ms: Math.round(demo.analysisMs) })}
              </p>
              <p className="mt-2">{t('transform.algorithm')}</p>
              <pre
                className="mt-3 overflow-x-auto text-[11px] tabular-nums"
                data-testid="transform-matrix"
              >
                {demo.solution.matrix
                  .map(
                    (value, index) =>
                      `${value.toFixed(4)}${index % 3 === 2 ? '\n' : '  '}`,
                  )
                  .join('')}
              </pre>
            </details>
          ) : null}
          {downloadError ? (
            <p
              role="alert"
              className="mt-4 rounded-md bg-lf-rose/10 p-3 text-sm leading-relaxed text-lf-on-surface"
            >
              {t('transform.error.download')}
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  )
}
