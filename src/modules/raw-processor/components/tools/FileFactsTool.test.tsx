import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FileFactsTool } from './FileFactsTool'

function valueForFact(label: string) {
  const term = screen.getByText(label, { selector: 'dt' })
  const value = term.nextElementSibling
  expect(value?.tagName).toBe('DD')
  return value as HTMLElement
}

describe('fileFactsTool', () => {
  it('shows support as not loaded before any RAW session facts exist', () => {
    render(
      <FileFactsTool
        supportLevel="experimental"
        metadata={null}
        stats={null}
      />,
    )

    const supportRow = screen.getByText('Support').closest('div')
    expect(supportRow).toHaveTextContent('Not loaded')
    expect(screen.queryByText('experimental')).not.toBeInTheDocument()
  })

  it('keeps the source size apart from the bounded preview size', () => {
    render(
      <FileFactsTool
        supportLevel="experimental"
        metadata={{ make: 'Sony', model: 'A7R', width: 6048, height: 4024 }}
        stats={{
          processTime: 18,
          inputSize: { width: 4000, height: 2666 },
          previewSize: { width: 4000, height: 2666 },
        }}
      />,
    )

    expect(valueForFact('Size')).toHaveTextContent('6048 x 4024')
    expect(valueForFact('Preview')).toHaveTextContent('4000 x 2666')
  })
})
