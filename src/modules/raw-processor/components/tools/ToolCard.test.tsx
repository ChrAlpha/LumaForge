import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../../state/tool-card.atoms'
import { ToolCard, ToolCardStack } from './ToolCard'

afterEach(() => {
  // Unmount before the reset write, so the store change reaches no card.
  cleanup()
  jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS)
})

function setup() {
  return render(
    <ToolCardStack ariaLabel="RAW finishing controls">
      <ToolCard id="adjust" title="Adjust">
        <p>adjust body</p>
      </ToolCard>
      <ToolCard id="histogram" title="Histogram" meta={<span>Clip 3</span>}>
        <p>hist body</p>
      </ToolCard>
    </ToolCardStack>,
  )
}

describe('toolCard', () => {
  it('renders an open card as a region named only by its title', () => {
    setup()
    const adjust = screen.getByRole('region', { name: 'Adjust' })
    expect(adjust).toBeInTheDocument()
    expect(screen.getByText('adjust body')).toBeInTheDocument()
  })

  it('keeps a collapsed card body hidden and out of the accessibility tree', () => {
    setup()
    expect(screen.queryByRole('region', { name: 'Histogram' })).toBeNull()
    expect(screen.getByText('hist body')).not.toBeVisible()
    const trigger = screen.getByRole('button', { name: 'Histogram' })
    const region = document.getElementById(
      trigger.getAttribute('aria-controls') ?? '',
    )
    expect(region).toHaveAttribute('hidden')
    expect(region).toHaveAttribute('aria-labelledby', trigger.id)
  })

  it('keeps a card body mounted across a fold, with its effects only while shown', async () => {
    const user = userEvent.setup()
    const effects: string[] = []
    function Counter() {
      const [count, setCount] = useState(0)
      useEffect(() => {
        effects.push('mount')
        return () => {
          effects.push('unmount')
        }
      }, [])
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          count {count}
        </button>
      )
    }
    render(
      <ToolCardStack ariaLabel="RAW finishing controls">
        <ToolCard id="adjust" title="Adjust">
          <Counter />
        </ToolCard>
      </ToolCardStack>,
    )

    await user.click(screen.getByRole('button', { name: 'count 0' }))
    const trigger = screen.getByRole('button', { name: 'Adjust' })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // The fold plays before the body hides and its effects stop.
    await waitFor(() => expect(screen.getByText('count 1')).not.toBeVisible())
    expect(effects).toEqual(['mount', 'unmount'])

    await user.click(trigger)
    expect(screen.getByRole('button', { name: 'count 1' })).toBeVisible()
    expect(effects).toEqual(['mount', 'unmount', 'mount'])
  })

  it('toggles open state and aria-expanded on trigger click', async () => {
    const user = userEvent.setup()
    setup()
    const trigger = screen.getByRole('button', { name: 'Histogram' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('hist body')).toBeInTheDocument()
  })

  it('renders a stable leading state indicator for open and closed cards', async () => {
    const user = userEvent.setup()
    setup()

    const adjustTrigger = screen.getByRole('button', { name: 'Adjust' })
    const histogramTrigger = screen.getByRole('button', { name: 'Histogram' })

    expect(
      adjustTrigger.querySelector('[data-tool-card-state-indicator]'),
    ).toHaveClass(
      'bg-lf-on-photo-ink/28',
      'group-data-[state=open]/tool-trigger:bg-lf-amber',
    )
    expect(
      histogramTrigger.querySelector('[data-tool-card-state-indicator]'),
    ).toHaveClass(
      'bg-lf-on-photo-ink/28',
      'group-data-[state=open]/tool-trigger:bg-lf-amber',
    )

    await user.click(histogramTrigger)

    expect(
      histogramTrigger.querySelector('[data-tool-card-state-indicator]'),
    ).toHaveClass('group-data-[state=open]/tool-trigger:bg-lf-amber')
  })

  it('persists open state to the shared atom', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'Histogram' }))
    expect(jotaiStore.get(toolCardOpenAtom)).toEqual(
      expect.arrayContaining(['adjust', 'histogram']),
    )
  })

  it('exposes the stack container with the finishing aria label', () => {
    setup()
    expect(
      screen.getByRole('group', { name: 'RAW finishing controls' }),
    ).toBeInTheDocument()
  })
})
