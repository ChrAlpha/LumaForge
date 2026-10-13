import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { OnlineLUTSourceIssue } from '../../../services/look/online-lut-sources'
import { LutSourceWarning } from './LutSourceWarning'

function issue(overrides: Partial<OnlineLUTSourceIssue>): OnlineLUTSourceIssue {
  return {
    code: 'network',
    message: 'Failed to fetch https://example.com/catalog.json',
    ...overrides,
  }
}

describe('lutSourceWarning', () => {
  it('renders nothing for a source without issues', () => {
    const { container } = render(<LutSourceWarning issues={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('leads with the first issue in translated copy and counts the rest', () => {
    render(
      <LutSourceWarning
        issues={[
          issue({ code: 'network' }),
          issue({ code: 'invalid-entry' }),
          issue({ code: 'unsupported-entry' }),
        ]}
      />,
    )

    const warning = screen.getByRole('status')
    expect(warning).toHaveAttribute('data-raw-lut', 'source-warning')
    expect(warning).toHaveAttribute('aria-live', 'polite')
    expect(warning).toHaveTextContent('This source could not be reached.')
    expect(warning).toHaveTextContent('+2 more')
    expect(warning).not.toHaveTextContent(/https:\/\//)
  })

  it('omits the count for a single issue', () => {
    render(<LutSourceWarning issues={[issue({ code: 'unsupported-entry' })]} />)
    const warning = screen.getByRole('status')
    expect(warning).toHaveTextContent("Some entries aren't supported LUTs.")
    expect(warning).not.toHaveTextContent(/more/)
  })

  it('states a source problem in amber by default and neutral ink on request', () => {
    const { rerender } = render(
      <LutSourceWarning issues={[issue({})]} className="pt-1.5" />,
    )
    const warning = screen.getByRole('status')
    expect(warning.innerHTML).toMatch(/amber/)

    rerender(
      <LutSourceWarning
        issues={[issue({})]}
        tone="neutral"
        surface="on-photo"
      />,
    )
    expect(screen.getByRole('status').innerHTML).not.toMatch(/amber/)
  })

  it('owns the warning and its copy without importing a tool surface', () => {
    for (const file of ['LutSourceWarning.tsx', 'lut-issue-copy.ts']) {
      const source = readFileSync(
        resolve(
          process.cwd(),
          'src/modules/raw-processor/components/shared/lut',
          file,
        ),
        'utf8',
      )
      expect(source).not.toMatch(/from '(?:\.\.\/)+(?:tools|mobile)\//)
      expect(source).not.toMatch(/from '\.\/(?!lut-issue-copy')/)
    }
  })
})
