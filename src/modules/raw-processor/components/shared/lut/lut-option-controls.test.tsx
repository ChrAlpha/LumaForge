import { TIER1_LUT_COLOR_PROFILES } from '@lumaforge/luma-color-runtime'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { getProfileContractLabel } from '../../../services/look/lut-contract-labels'
import { toSearchOutputOption } from '../../../services/look/lut-output-options'
import { LUTOutputOptionButton } from './LUTOutputOptionButton'
import { LUTProfileButton } from './LUTProfileButton'

const [profile, otherProfile] = TIER1_LUT_COLOR_PROFILES

describe('lUTProfileButton', () => {
  it('names the contract, reports selection, and selects its profile', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <LUTProfileButton
        profile={profile}
        activeProfileId={otherProfile.id}
        onSelect={onSelect}
      />,
    )

    const button = screen.getByRole('button', {
      name: getProfileContractLabel(profile),
    })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('data-raw-lut', 'contract-option')
    expect(button).toHaveAttribute('data-raw-lut-size', 'comfortable')

    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith(profile)

    rerender(
      <LUTProfileButton
        profile={profile}
        activeProfileId={profile.id}
        onSelect={onSelect}
        label="Recommended"
        ariaLabel="Use recommended contract"
        size="touch"
        surface="on-photo"
      />,
    )
    const active = screen.getByRole('button', {
      name: 'Use recommended contract',
    })
    expect(active).toHaveAttribute('aria-pressed', 'true')
    expect(active).toHaveAttribute('data-raw-lut-size', 'touch')
    expect(active).toHaveTextContent('Recommended')
  })
})

describe('lUTOutputOptionButton', () => {
  it('names the output, reports selection, and selects its option', () => {
    const option = toSearchOutputOption(profile)
    const onSelect = vi.fn()
    const { rerender } = render(
      <LUTOutputOptionButton option={option} onSelect={onSelect} />,
    )

    const button = screen.getByRole('button', {
      name: `Use ${option.label} as LUT output`,
    })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent(option.label)

    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith(option)

    rerender(
      <LUTOutputOptionButton
        option={option}
        activeOptionId={option.id}
        onSelect={onSelect}
        size="touch"
        surface="on-photo"
      />,
    )
    expect(
      screen.getByRole('button', { name: `Use ${option.label} as LUT output` }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
