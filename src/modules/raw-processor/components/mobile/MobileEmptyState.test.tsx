import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'

import { getMobileEmptyFormats, MobileEmptyState } from './MobileEmptyState'

function renderEmpty(
  props: Partial<React.ComponentProps<typeof MobileEmptyState>> = {},
) {
  const onReplaceFile = vi.fn()
  const onPrepareRuntime = vi.fn()
  const result = render(
    <I18nProvider>
      <MobileEmptyState
        runtimeReadinessState="ready"
        onReplaceFile={onReplaceFile}
        onPrepareRuntime={onPrepareRuntime}
        {...props}
      />
    </I18nProvider>,
  )
  return { ...result, onReplaceFile, onPrepareRuntime }
}

describe('mobileEmptyState', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('reads top-down: eyebrow, headline, then three numbered steps', () => {
    const { container } = renderEmpty()
    const copy = container.querySelector<HTMLElement>(
      '[data-mobile-empty-copy]',
    )!
    expect(
      within(copy).getByText('One RAW · processed on this device'),
    ).toBeInTheDocument()
    expect(
      within(copy).getByRole('heading', {
        level: 1,
        name: 'Turn one RAW into a finished photo',
      }),
    ).toHaveClass('text-balance')

    const steps = within(copy).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(
      steps.map((step) => step.querySelector('strong')?.textContent),
    ).toEqual([
      'Choose a RAW',
      'Apply a look, fine-tune, compare',
      'Export a full-resolution JPEG',
    ])
    expect(steps[0]).toHaveTextContent('Decoded on this device, never uploaded')
    expect(steps[1]).toHaveTextContent(
      'LUT contracts are confirmed before they apply',
    )
    expect(steps[2]).toHaveTextContent(
      'Refused when it cannot be reproduced exactly',
    )
    // Numbers sit in amber circles and stay out of the accessible name.
    const number = steps[0].querySelector('[aria-hidden="true"]')!
    expect(number).toHaveTextContent('1')
    expect(number).toHaveClass('bg-lf-amber/15', 'text-lf-amber', 'size-[18px]')
  })

  it('is a left-aligned page, not a centred template stack', () => {
    const { container } = renderEmpty()
    const root = container.querySelector('[data-mobile-empty-state]')!
    const copy = container.querySelector('[data-mobile-empty-copy]')!
    expect(root.className).not.toMatch(/text-center|items-center|gradient/)
    expect(copy.className).not.toMatch(/text-center|justify-items-center/)
    // Starts 24px under the measured topbar with 16px side padding.
    expect(copy).toHaveClass(
      'px-4',
      'pt-[calc(var(--raw-topbar-height,56px)+24px)]',
    )
  })

  it('pins a full-width Lab Green action in the thumb zone', async () => {
    const { container, onReplaceFile, onPrepareRuntime } = renderEmpty()
    const cta = screen.getByRole('button', { name: 'Browse RAW files' })
    expect(cta).toHaveAttribute('data-mobile-empty-cta')
    expect(cta).toHaveClass('h-12', 'w-full', 'enabled:bg-lf-green')
    expect(cta.parentElement).toHaveClass('px-3', 'pb-safe-offset-4')
    // The action sits after the copy, in the bottom grid row.
    expect(
      container
        .querySelector('[data-mobile-empty-copy]')!
        .compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    fireEvent.pointerEnter(cta)
    expect(onPrepareRuntime).toHaveBeenCalledTimes(1)
    await userEvent.click(cta)
    expect(onReplaceFile).toHaveBeenCalledTimes(1)
    expect(onPrepareRuntime).toHaveBeenCalled()
  })

  it.each([
    ['ready', 'RAW engine ready', false],
    ['pending', 'Waking RAW engine', true],
    ['idle', 'RAW engine warms before processing', true],
    ['failed', 'RAW engine starts when needed', true],
  ] as const)(
    'names the %s engine state and gates the action on it',
    (state, label, disabled) => {
      const { container } = renderEmpty({ runtimeReadinessState: state })
      const readiness = container.querySelector<HTMLElement>(
        '[data-raw-runtime-readiness]',
      )!
      expect(readiness).toHaveAttribute('aria-live', 'polite')
      expect(readiness).toHaveAttribute('data-state', state)
      expect(readiness).toHaveTextContent(label)
      // Reserved height: a state change never shifts the formats line.
      expect(readiness).toHaveClass('min-h-[2.875rem]')
      const dot = readiness.querySelector('[data-mobile-empty-readiness-dot]')
      if (state === 'ready') expect(dot).toHaveClass('bg-lf-green')
      else expect(dot).not.toHaveClass('bg-lf-green')

      const cta = screen.getByRole('button', { name: 'Browse RAW files' })
      if (disabled) expect(cta).toBeDisabled()
      else expect(cta).toBeEnabled()
    },
  )

  it('keeps the action available when no readiness state is reported', () => {
    const { container } = renderEmpty({ runtimeReadinessState: undefined })
    expect(container.querySelector('[data-raw-runtime-readiness]')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Browse RAW files' }),
    ).toBeEnabled()
  })

  it('counts the formats from the decoder support set', () => {
    const formats = getMobileEmptyFormats()
    expect(formats.named).toEqual(['ARW', 'NEF', 'CR3', 'RAF', 'DNG', 'ORF'])
    for (const format of formats.named) {
      expect(SUPPORTED_RAW_EXTENSIONS.has(format.toLowerCase())).toBe(true)
    }
    expect(formats.total).toBe(SUPPORTED_RAW_EXTENSIONS.size)
    expect(formats.more).toBe(SUPPORTED_RAW_EXTENSIONS.size - 6)

    const { container } = renderEmpty()
    expect(
      container.querySelector('[data-mobile-empty-formats]'),
    ).toHaveTextContent(
      `ARW · NEF · CR3 · RAF · DNG · ORF and ${formats.more} more`,
    )
  })

  it('speaks Chinese with the total count and keeps the action name', () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    const { container } = renderEmpty()
    expect(
      screen.getByRole('heading', { level: 1, name: '把一张 RAW 做成成片' }),
    ).toBeInTheDocument()
    expect(screen.getByText('单张 RAW · 在本机处理')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '选择 RAW 文件' }),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-mobile-empty-formats]'),
    ).toHaveTextContent(
      `ARW · NEF · CR3 · RAF · DNG · ORF 等共 ${SUPPORTED_RAW_EXTENSIONS.size} 种`,
    )
  })

  it('enters on a plain fade, no choreography', () => {
    const { container } = renderEmpty()
    const root = container.querySelector<HTMLElement>(
      '[data-mobile-empty-state]',
    )!
    // Only opacity moves; nothing slides or scales in.
    expect(root.style.transform).toBe('')
    expect(root.querySelectorAll('[style*="transform"]')).toHaveLength(0)
  })
})
