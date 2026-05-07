/**
 * Dropzone component for loading RAW files and LUTs via drag and drop.
 */

import { Upload, X } from 'lucide-react'
import { m } from 'motion/react'
import { useCallback, useId, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { Spring } from '~/lib/spring'

export const RAW_FILE_EXTENSIONS = [
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.rw2',
  '.orf',
  '.dng',
  '.pef',
  '.srw',
  '.3fr',
  '.fff',
  '.iiq',
  '.raw',
]

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
    if (inputRef.current) {
      inputRef.current.click()
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    if (accept) {
      input.accept = accept.join(',')
    }

    input.onchange = () => {
      const files = Array.from(input.files || [])
      handleFiles(files)
    }

    input.click()
  }, [handleFiles, accept, multiple, disabled])

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
      {isDragOver && (
        <m.div
          className={clsxm(
            'absolute inset-0 flex items-center justify-center',
            variant === 'stage'
              ? 'rounded-lg bg-[oklch(0.59_0.15_153_/_0.18)]'
              : 'rounded-xl bg-accent/20',
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <span className="text-accent font-medium">
            {t('raw.drop.toLoad')}
          </span>
        </m.div>
      )}
    </>
  )

  const frameClassName = clsxm(
    'relative transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    clickToOpen ? 'cursor-pointer' : 'cursor-default',
    variant === 'stage'
      ? 'rounded-lg border border-[oklch(0.96_0.012_86_/_0.36)]'
      : 'rounded-xl border-2 border-dashed',
    isDragOver
      ? variant === 'stage'
        ? 'border-[oklch(0.59_0.15_153)] bg-[oklch(0.59_0.15_153_/_0.16)]'
        : 'border-accent bg-accent/10'
      : variant === 'stage'
        ? clickToOpen && 'hover:border-[oklch(0.59_0.15_153_/_0.72)]'
        : 'border-border hover:border-accent/50 hover:bg-fill/50',
    disabled && 'opacity-50 cursor-not-allowed',
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
      accept={RAW_FILE_EXTENSIONS}
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
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
      <Dropzone
        onFileDrop={onFileDrop}
        accept={['.cube']}
        disabled={disabled}
        interactiveMotion={false}
        aria-label={label}
        className="min-w-0 flex-1 min-h-[38px] rounded-lg border border-[color:oklch(0.68_0.042_78_/_0.72)] bg-[color:oklch(0.902_0.034_82_/_0.76)] p-1.5 text-[color:--color-raw-ink-soft] shadow-[inset_0_1px_0_oklch(0.98_0.012_86_/_0.45)] transition-all duration-150 hover:not-aria-disabled:border-[color:oklch(0.56_0.12_153_/_0.4)] hover:not-aria-disabled:bg-[color:oklch(0.882_0.046_82)] hover:not-aria-disabled:text-[color:--color-raw-green-deep] focus-within:outline-2 focus-within:outline-[color:--color-raw-green] focus-within:outline-offset-2"
      >
        <div className="flex min-w-0 items-center gap-3 h-full">
          <span
            className="grid size-6 shrink-0 place-items-center rounded-[5px] border border-[color:oklch(0.68_0.042_78_/_0.56)] bg-[color:oklch(0.86_0.03_80_/_0.56)] text-[color:--color-raw-ink-soft]"
            aria-hidden="true"
          >
            <Upload />
          </span>
          <span
            className="block min-w-0 max-w-full truncate text-[0.76rem] font-semibold leading-tight"
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
          className="shrink-0 inline-flex size-[38px] items-center justify-center rounded-lg border border-[color:oklch(0.68_0.042_78_/_0.66)] bg-[color:oklch(0.902_0.034_82_/_0.9)] p-0 text-[color:--color-raw-ink-soft] hover:border-[color:oklch(0.56_0.12_153_/_0.38)] hover:bg-[color:oklch(0.882_0.046_82)] hover:text-[color:--color-raw-green-deep] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2"
          aria-label={t('raw.lut.clear')}
          title={t('raw.lut.clear')}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
