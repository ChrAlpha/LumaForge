import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'

import {
  Dropzone,
  FileDropzone,
  LutDropzone,
  RAW_FILE_ACCEPT,
} from './Dropzone'

const DECODER_EXTENSIONS = Array.from(SUPPORTED_RAW_EXTENSIONS)
const DOTTED_DECODER_EXTENSIONS = new Set(
  DECODER_EXTENSIONS.map((extension) => `.${extension}`),
)

function rawFile(name: string) {
  return new File(['raw'], name, { type: 'application/octet-stream' })
}

// File objects deep-equal each other regardless of name, so compare the
// forwarded names per call instead of the File instances.
function forwardedNames(onFileDrop: ReturnType<typeof vi.fn>) {
  return onFileDrop.mock.calls.map(([files]) =>
    (files as File[]).map((file) => file.name),
  )
}

function acceptTokens(input: HTMLInputElement) {
  return new Set(input.accept.split(','))
}

function renderFileDropzone(props: { disabled?: boolean } = {}) {
  const onFileDrop = vi.fn()
  const { container } = render(
    <FileDropzone onFileDrop={onFileDrop} {...props} />,
  )
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  const frame = input?.closest('label')
  expect(input).toBeTruthy()
  expect(frame).toBeTruthy()
  return { onFileDrop, input: input!, frame: frame! }
}

function renderStageDropzone() {
  const onFileDrop = vi.fn()
  const { container } = render(
    <Dropzone
      variant="stage"
      accept={RAW_FILE_ACCEPT}
      clickToOpen={false}
      onFileDrop={onFileDrop}
      className="stage-frame"
    >
      <span>stage</span>
    </Dropzone>,
  )
  const frame = container.querySelector<HTMLElement>('.stage-frame')
  const input = frame?.querySelector<HTMLInputElement>('input[type="file"]')
  expect(frame).toBeTruthy()
  expect(input).toBeTruthy()
  return { onFileDrop, input: input!, frame: frame! }
}

function drop(target: HTMLElement, files: File[]) {
  fireEvent.drop(target, { dataTransfer: { files } })
}

describe('raw file acceptance', () => {
  it('advertises exactly the decoder extension set', () => {
    expect(new Set(RAW_FILE_ACCEPT)).toEqual(DOTTED_DECODER_EXTENSIONS)
    expect(RAW_FILE_ACCEPT).toHaveLength(SUPPORTED_RAW_EXTENSIONS.size)
  })

  it('does not advertise raster images as RAW input', () => {
    expect(RAW_FILE_ACCEPT).not.toContain('image/*')
    expect(RAW_FILE_ACCEPT.every((token) => token.startsWith('.'))).toBe(true)
    expect(RAW_FILE_ACCEPT).not.toContain('.jpg')
    expect(RAW_FILE_ACCEPT).not.toContain('.png')
  })

  it('sets the decoder extension set on the empty-state and stage inputs', () => {
    const empty = renderFileDropzone()
    const stage = renderStageDropzone()

    expect(acceptTokens(empty.input)).toEqual(DOTTED_DECODER_EXTENSIONS)
    expect(acceptTokens(stage.input)).toEqual(DOTTED_DECODER_EXTENSIONS)
  })

  it.each(DECODER_EXTENSIONS)('accepts dropped .%s files', (extension) => {
    const { onFileDrop, frame } = renderFileDropzone()

    drop(frame, [rawFile(`frame.${extension}`)])

    expect(forwardedNames(onFileDrop)).toEqual([[`frame.${extension}`]])
  })

  it.each(DECODER_EXTENSIONS)(
    'accepts dropped uppercase .%s files',
    (extension) => {
      const { onFileDrop, frame } = renderFileDropzone()
      const name = `FRAME.${extension.toUpperCase()}`

      drop(frame, [rawFile(name)])

      expect(forwardedNames(onFileDrop)).toEqual([[name]])
    },
  )

  it.each(['old-canon.crw', 'nikon-compact.NRW', 'sigma.x3f'])(
    'accepts %s through drop and the file input on both dropzone variants',
    (name) => {
      for (const { onFileDrop, frame, input } of [
        renderFileDropzone(),
        renderStageDropzone(),
      ]) {
        drop(frame, [rawFile(name)])
        fireEvent.change(input, { target: { files: [rawFile(name)] } })

        expect(forwardedNames(onFileDrop)).toEqual([[name], [name]])
      }
    },
  )

  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg'],
    ['screenshot.png', 'image/png'],
    ['look.cube', 'application/octet-stream'],
  ])('rejects %s through drop and the file input', (name, type) => {
    for (const { onFileDrop, frame, input } of [
      renderFileDropzone(),
      renderStageDropzone(),
    ]) {
      drop(frame, [new File(['x'], name, { type })])
      fireEvent.change(input, {
        target: { files: [new File(['x'], name, { type })] },
      })

      expect(onFileDrop).not.toHaveBeenCalled()
    }
  })

  it('forwards only the first accepted file from a mixed drop', () => {
    const { onFileDrop, frame } = renderFileDropzone()

    drop(frame, [
      new File(['x'], 'photo.jpg', { type: 'image/jpeg' }),
      rawFile('first.crw'),
      rawFile('second.NEF'),
    ])

    expect(forwardedNames(onFileDrop)).toEqual([['first.crw']])
  })

  it('ignores drops and disables the input while disabled', () => {
    const { onFileDrop, frame, input } = renderFileDropzone({ disabled: true })

    drop(frame, [rawFile('frame.dng')])

    expect(onFileDrop).not.toHaveBeenCalled()
    expect(input).toBeDisabled()
    expect(acceptTokens(input)).toEqual(DOTTED_DECODER_EXTENSIONS)
  })
})

describe('lut file acceptance', () => {
  it('keeps the LUT dropzone on .cube only', () => {
    const onFileDrop = vi.fn()
    const { container } = render(<LutDropzone onFileDrop={onFileDrop} />)
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!
    const frame = input.closest('label')!

    expect(input).toHaveAttribute('accept', '.cube')

    drop(frame, [rawFile('frame.dng'), rawFile('photo.jpg')])
    expect(onFileDrop).not.toHaveBeenCalled()

    drop(frame, [rawFile('look.CUBE')])
    expect(forwardedNames(onFileDrop)).toEqual([['look.CUBE']])
  })
})
