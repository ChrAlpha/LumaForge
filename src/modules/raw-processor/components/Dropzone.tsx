/**
 * Dropzone component for loading RAW files and LUTs via drag and drop.
 */

import { Upload, X } from 'lucide-react'
import { AnimatePresence, m } from 'motion/react'
import { useCallback, useId, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'
import { Spring } from '~/lib/spring'

/**
 * RAW pickers and drop targets accept exactly what the decoder accepts.
 * Raster images are not RAW input, so no `image/*` MIME wildcard.
 */
export const RAW_FILE_ACCEPT = Array.from(
  SUPPORTED_RAW_EXTENSIONS,
  (extension) => `.${extension}`,
)

export interface DropzoneProps {
  onFileDrop: (files: File[]) => void
  accept?: string[]
  multiple?: boolean
  className?: string
  children?:
    | React.ReactNode
    | ((controls: {
        openFilePicker: () => void
        disabled: boolean
      }) => React.ReactNode)
  disabled?: boolean
  clickToOpen?: boolean
  interactiveMotion?: boolean
  'aria-label'?: string
  'data-raw-lut'?: string
  variant?: 'default' | 'stage'
}

function filterAcceptedFiles(files: File[], accept?: string[]) {
  if (!accept) return files

  return files.filter((file) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    return ext && accept.some((a) => a.toLowerCase() === `.${ext}`)
  })
}

export function Dropzone({
  onFileDrop,
  accept,
  multiple = false,
  className,
  children,
  disabled = false,
  clickToOpen = true,
  interactiveMotion = true,
  'aria-label': ariaLabel,
  'data-raw-lut': dataRawLut,
  variant = 'default',
}: DropzoneProps) {
  const { t } = useI18n()
  const [isDragOver, setIsDragOver] = useState(false)
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const isClickTarget = clickToOpen && !disabled

  const handleFiles = useCallback(
    (files: File[]) => {
      const filteredFiles = filterAcceptedFiles(files, accept)

      if (filteredFiles.length > 0) {
        onFileDrop(multiple ? filteredFiles : [filteredFiles[0]])
      }
    },
    [onFileDrop, accept, multiple],
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) {
        setIsDragOver(true)
      }
    },
    [disabled],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      if (disabled) return

      const files = Array.from(e.dataTransfer.files)
      handleFiles(files)
    },
    [handleFiles, disabled],
  )

  const openFilePicker = useCallback(() => {
    if (disabled) return
    inputRef.current?.click()
  }, [disabled])

  const handleClick = useCallback(() => {
    if (!clickToOpen) return

    openFilePicker()
  }, [clickToOpen, openFilePicker])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!clickToOpen) return

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openFilePicker()
      }
    },
    [clickToOpen, openFilePicker],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.currentTarget.files || [])
      handleFiles(files)
      e.currentTarget.value = ''
    },
    [handleFiles],
  )

  const content = (
    <>
      {typeof children === 'function'
        ? children({ openFilePicker, disabled })
        : children}
      <AnimatePresence>
        {isDragOver && (
          <m.div
            key="drop-overlay"
            className={clsxm(
              'absolute inset-0 flex items-center justify-center',
              variant === 'stage'
                ? 'rounded-md bg-accent/20'
                : 'rounded-xl bg-accent/20',
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="text-accent font-medium">
              {t('raw.drop.toLoad')}
            </span>
          </m.div>
        )}
      </AnimatePresence>
    </>
  )

  const frameClassName = clsxm(
    'relative transition-colors',
    variant === 'stage'
      ? 'focus-within:outline-none focus-within:ring-0 focus-visible:outline-none focus-visible:ring-0'
      : 'focus-within:outline-none focus-within:ring-2 focus-within:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    clickToOpen ? 'cursor-pointer' : 'cursor-default',
    variant === 'stage'
      ? 'rounded-md border border-[var(--color-preview-border)] h-full w-full overflow-hidden bg-[var(--color-preview-mat)] bg-[image:linear-gradient(160deg,var(--color-preview-mat),var(--color-preview-mat-edge))]'
      : 'rounded-xl border-2 border-dashed',
    isDragOver
      ? variant === 'stage'
        ? 'border-accent bg-accent/20'
        : 'border-accent bg-accent/10'
      : variant === 'stage'
        ? clickToOpen && 'hover:border-accent/70'
        : 'border-border hover:border-accent/50 hover:bg-fill/50',
    disabled &&
      (variant === 'stage'
        ? 'cursor-not-allowed'
        : 'opacity-50 cursor-not-allowed'),
    className,
  )

  const motionProps =
    isClickTarget && interactiveMotion
      ? {
          whileHover: { scale: 1.01 },
          whileTap: { scale: 0.99 },
        }
      : {}

  if (clickToOpen) {
    return (
      <m.label
        htmlFor={inputId}
        aria-disabled={disabled ? true : undefined}
        data-raw-lut={dataRawLut}
        className={frameClassName}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        {...motionProps}
        transition={Spring.presets.snappy}
      >
        {content}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple={multiple}
          accept={accept?.join(',')}
          disabled={disabled}
          aria-label={ariaLabel}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          onChange={handleInputChange}
        />
      </m.label>
    )
  }

  return (
    <m.div
      data-raw-lut={dataRawLut}
      className={frameClassName}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...motionProps}
      transition={Spring.presets.snappy}
    >
      {content}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple={multiple}
        accept={accept?.join(',')}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={handleInputChange}
      />
    </m.div>
  )
}

/**
 * Empty state dropzone for initial file loading.
 */
export function FileDropzone({
  onFileDrop,
  disabled,
}: {
  onFileDrop: (files: File[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()

  return (
    <Dropzone
      onFileDrop={onFileDrop}
      accept={RAW_FILE_ACCEPT}
      disabled={disabled}
      className="min-h-[300px] flex flex-col items-center justify-center p-8"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="size-16 rounded-full bg-fill flex items-center justify-center">
          <i className="i-mingcute-image-2-line text-3xl text-text-secondary" />
        </div>
        <div>
          <h3 className="text-lg font-medium text-text">
            {t('raw.drop.fileTitle')}
          </h3>
          <p className="text-sm text-text-secondary mt-1">
            {t('raw.drop.browse')}
          </p>
        </div>
        <p className="text-xs text-text-tertiary max-w-md">
          {t('raw.drop.supported')}
        </p>
      </div>
    </Dropzone>
  )
}

/**
 * Small dropzone for LUT files.
 */
export function LutDropzone({
  onFileDrop,
  currentLut,
  onClear,
  disabled,
}: {
  onFileDrop: (files: File[]) => void
  currentLut?: string | null
  onClear?: () => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const label = currentLut
    ? t('raw.lut.selectedAria', { name: currentLut })
    : t('raw.lut.add')

  return (
    <div className="flex min-w-0 max-w-full items-stretch gap-2 overflow-hidden">
      <Dropzone
        onFileDrop={onFileDrop}
        accept={['.cube']}
        disabled={disabled}
        interactiveMotion={false}
        aria-label={label}
        data-raw-lut="dropzone"
        className="min-h-9 min-w-0 flex-1 rounded-md bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.04)] px-2 py-1.5 text-[0.78rem] font-semibold leading-tight text-lf-on-surface/75 shadow-none transition-colors duration-150 hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)] hover:text-lf-on-surface focus-within:ring-2 focus-within:ring-lf-green/30 disabled:opacity-50"
      >
        <div className="flex min-h-full min-w-0 items-center gap-2">
          <span
            className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)] text-lf-on-surface/65 [&_svg]:size-[13px] [&_svg]:stroke-[2]"
            aria-hidden="true"
          >
            <Upload aria-hidden="true" />
          </span>
          <span
            className="block min-w-0 max-w-full truncate"
            title={currentLut ?? undefined}
          >
            {currentLut || t('raw.lut.add')}
          </span>
        </div>
      </Dropzone>
      {currentLut && onClear && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
          className="relative inline-flex min-h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.04)] text-lf-on-surface/55 transition-colors duration-150 before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.08)] hover:text-lf-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green [&_svg]:size-[15px] [&_svg]:stroke-[1.75]"
          data-raw-lut="dropzone-clear"
          aria-label={t('raw.lut.clear')}
          title={t('raw.lut.clear')}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
