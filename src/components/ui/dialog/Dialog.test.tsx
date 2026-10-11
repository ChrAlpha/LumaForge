import * as DialogPrimitive from '@radix-ui/react-dialog'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogDescription, DialogTitle } from './index'

function ControlledDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger>Open</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content>
          <DialogTitle>Reset session</DialogTitle>
          <DialogDescription>Clears the loaded RAW.</DialogDescription>
          <DialogPrimitive.Close>Close</DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}

describe('dialog', () => {
  it('renders nothing while closed and reports an open request', () => {
    const onOpenChange = vi.fn()
    render(<ControlledDialog open={false} onOpenChange={onOpenChange} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('labels the open dialog with its title and description and reports a close request', () => {
    const onOpenChange = vi.fn()
    render(<ControlledDialog open onOpenChange={onOpenChange} />)

    const dialog = screen.getByRole('dialog', { name: 'Reset session' })
    expect(dialog).toHaveAccessibleDescription('Clears the loaded RAW.')
    expect(screen.getByText('Reset session').className).toContain(
      'font-semibold',
    )
    expect(screen.getByText('Clears the loaded RAW.').className).toContain(
      'text-sm',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens an uncontrolled dialog from its trigger', () => {
    render(
      <Dialog>
        <DialogPrimitive.Trigger>Open</DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content aria-describedby={undefined}>
            <DialogTitle>Sources</DialogTitle>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </Dialog>,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('dialog', { name: 'Sources' })).toBeTruthy()
  })
})
