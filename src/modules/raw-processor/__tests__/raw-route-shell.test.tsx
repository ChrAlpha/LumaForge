import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getLut,
  getProcessingParams,
  resetToDefaults,
} from '~/atoms/raw-processor'
import { sha256Hex } from '~/lib/profiles/fetch'

import { Component as RawRoute } from '../../../pages/(main)/raw'
import { FileFactsTool } from '../components/tools/FileFactsTool'
import { RawProcessorView } from '../RawProcessorView'
import { classifySupportLevel } from '../services/support-matrix'

const fetchMock = vi.fn<typeof fetch>()
const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
const mockedToastInfo = vi.mocked(toast.info)
const originalNavigatorDescriptors = {
  clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
  share: Object.getOwnPropertyDescriptor(navigator, 'share'),
}

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

const mockedUseCapabilityGate = vi.mocked(
  (await import('../hooks/useCapabilityGate')).useCapabilityGate,
)

function disableShareCapabilities() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: undefined,
  })
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: undefined,
  })

  return writeText
}

function createCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, '']
  const step = 1 / (size - 1)

  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(`${r * step} ${g * step} ${b * step}`)
      }
    }
  }

  return lines.join('\n')
}

function encodeCube(title: string) {
  return new TextEncoder().encode(createCube(title))
}

function restoreNavigatorProperty(property: 'clipboard' | 'share') {
  const descriptor = originalNavigatorDescriptors[property]

  if (descriptor) {
    Object.defineProperty(navigator, property, descriptor)
    return
  }

  Reflect.deleteProperty(navigator, property)
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function pendingFetch(
  _input?: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return

    if (signal.aborted) {
      reject(abortError())
      return
    }

    signal.addEventListener('abort', () => reject(abortError()), {
      once: true,
    })
  })
}

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function bytesResponse(bytes: Uint8Array) {
  return Promise.resolve(
    new Response(bytes.slice().buffer, {
      headers: { 'Content-Length': String(bytes.byteLength) },
    }),
  )
}

function fetchUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href

  return input.url
}

function fetchUrls() {
  return fetchMock.mock.calls.map(([input]) => fetchUrl(input))
}

function renderRawRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RawProcessorView />
    </MemoryRouter>,
  )
}

async function openLutSourceBrowser(
  user: ReturnType<typeof userEvent.setup>,
  sourceLabel: string,
) {
  const openButton = await screen.findByRole('button', {
    name: `Open ${sourceLabel}`,
  })
  expect(openButton).toHaveAttribute('aria-haspopup', 'dialog')
  expect(openButton).toHaveAttribute('aria-expanded', 'false')
  expect(
    screen.queryByRole('dialog', { name: `${sourceLabel} LUTs` }),
  ).not.toBeInTheDocument()

  await user.click(openButton)

  const browser = await screen.findByRole('dialog', {
    name: `${sourceLabel} LUTs`,
  })
  expect(openButton).toHaveAttribute('aria-expanded', 'true')

  return browser
}

beforeEach(() => {
  resetToDefaults()
  localStorage.clear()
  disableShareCapabilities()
  mockedToastSuccess.mockClear()
  mockedToastError.mockClear()
  mockedToastInfo.mockClear()

  fetchMock.mockReset()
  fetchMock.mockImplementation(pendingFetch)
  vi.stubGlobal('fetch', fetchMock)

  mockedUseCapabilityGate.mockReset()
  mockedUseCapabilityGate.mockReturnValue({
    ready: true,
    supportStatus: 'supported',
    reason: null,
  })
})

afterEach(() => {
  act(() => {
    resetToDefaults()
  })
  localStorage.clear()
  vi.unstubAllGlobals()
  restoreNavigatorProperty('clipboard')
  restoreNavigatorProperty('share')
  fetchMock.mockReset()
})

describe('rawProcessorView', () => {
  it('renders the image-first empty RAW Lab workspace', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      reason: null,
    })

    render(<RawProcessorView />)

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByText('RAW Lab')).toBeInTheDocument()
    expect(screen.getByText('Drop one RAW here')).toBeInTheDocument()
    expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
    expect(screen.getByText('Final JPEG')).toBeInTheDocument()
    expect(
      screen.queryByText('Browser-local RAW styling'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Drop your RAW file here'),
    ).not.toBeInTheDocument()
  })

  it('exposes the viewport app shell contract for the empty workspace', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      reason: null,
    })

    const { container } = render(<RawProcessorView />)
    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )
    const stageToolsLayout = container.querySelector(
      '[data-raw-lab-layout="stage-tools"]',
    )

    expect(viewportShell).not.toBeNull()
    expect(viewportShell).toHaveClass('grid')
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'empty')
    expect(stageToolsLayout).not.toBeNull()
    expect(stageToolsLayout).toHaveClass('grid')
  })

  it('lets the raw route hand viewport ownership directly to the shell', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      reason: null,
    })

    const { container } = render(<RawRoute />)
    const routeRoot = container.firstElementChild

    expect(routeRoot).not.toBeNull()
    expect(routeRoot).toHaveAttribute('data-raw-lab-shell', 'viewport')
    expect(routeRoot).toHaveClass('grid')
    expect(routeRoot).not.toHaveClass('h-screen')
    expect(
      container.querySelector('[data-raw-lab-shell="viewport"]')?.parentElement,
    ).toBe(container)
    expect(
      container.querySelector('[data-raw-tool-surface="raw-finishing"]'),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-raw-panel="controls"]'),
    ).not.toBeInTheDocument()
  })

  it('keeps export disabled copy visible before a RAW is loaded', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      reason: null,
    })

    render(<RawProcessorView />)

    expect(
      screen.getByText('Full-resolution export source is still loading.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /export full-resolution jpeg/i }),
    ).toBeDisabled()
  })
})

describe('rawProcessorView shell states', () => {
  it('keeps unsupported WebGL2 state inside the raw route shell contract', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'unsupported',
      reason: 'WebGL2 is required',
    })

    const { container } = render(<RawProcessorView />)
    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )

    expect(viewportShell).not.toBeNull()
    expect(viewportShell).toHaveClass('grid')
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'unsupported')
    expect(
      screen.getByText('This browser cannot run the RAW Lab'),
    ).toBeInTheDocument()
  })

  it('keeps unsupported isolation state inside the raw route shell contract', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'unsupported',
      reason: 'Cross-origin isolation is required for pthread RAW decode',
    })

    const { container } = render(<RawProcessorView />)
    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )

    expect(viewportShell).not.toBeNull()
    expect(viewportShell).toHaveClass('grid')
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'unsupported')
    expect(
      screen.getByText('This browser cannot run the RAW Lab'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Cross-origin isolation is required for pthread RAW decode',
      ),
    ).toBeInTheDocument()
  })
})

describe('rawProcessorView online LUT route sources', () => {
  it('imports a query catalog resource into the source manager', async () => {
    renderRawRoute(
      `/raw?luts=${encodeURIComponent(
        'https://example.com/lumaforge-profiles.json',
      )}`,
    )

    expect(
      await screen.findByText('Catalog from example.com'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/lumaforge-profiles.json',
        expect.objectContaining({ credentials: 'omit' }),
      ),
    )
  })

  it('keeps a valid CUBE query resource and surfaces one rejected source issue', async () => {
    renderRawRoute(
      `/raw?luts=${encodeURIComponent(
        'javascript:alert(1)',
      )}&luts=${encodeURIComponent('https://example.com/valid.cube')}`,
    )

    await waitFor(() =>
      expect(screen.getByText('valid.cube')).toBeInTheDocument(),
    )

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(
      'Source URL must use HTTPS, or HTTP on localhost for local development.',
    )
    expect(status.querySelectorAll('p')).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('copies a canonical LUT source link without unrelated RAW Lab params', async () => {
    const user = userEvent.setup()
    const writeText = installClipboard()
    const validResource = 'https://example.com/shareable.cube'

    renderRawRoute(
      `/raw?viewMode=original&image=local&luts=${encodeURIComponent(
        validResource,
      )}`,
    )

    const shareButton = screen.getByRole('button', {
      name: 'Copy LUT source link',
    })
    await waitFor(() => expect(shareButton).toBeEnabled())

    await user.click(shareButton)

    expect(writeText).toHaveBeenCalledWith(
      `/raw?luts=${encodeURIComponent(validResource)}`,
    )
    expect(writeText.mock.calls[0]?.[0]).not.toContain('viewMode=')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('image=')
  })

  it('does not download a direct CUBE query resource until its load action is clicked', async () => {
    const user = userEvent.setup()
    const cubeUrl = 'https://example.com/lazy-direct.cube'
    fetchMock.mockImplementation((input) => {
      if (fetchUrl(input) === cubeUrl) {
        return bytesResponse(encodeCube('Lazy Direct LUT'))
      }

      return pendingFetch()
    })

    renderRawRoute(`/raw?luts=${encodeURIComponent(cubeUrl)}`)

    expect(await screen.findByText('lazy-direct.cube')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load lazy-direct.cube' }),
    ).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    const browser = await openLutSourceBrowser(user, 'lazy-direct.cube')
    const loadButton = within(browser).getByRole('button', {
      name: 'Load lazy-direct.cube',
    })

    await user.click(loadButton)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      cubeUrl,
      expect.objectContaining({ credentials: 'omit' }),
    )
    await waitFor(() => expect(getLut()?.title).toBe('Lazy Direct LUT'))
  })

  it('loads a catalog query source through entry manifest, verified CUBE bytes, and active custom LUT state', async () => {
    const user = userEvent.setup()
    const catalogUrl = 'https://example.com/lumaforge-profiles.json'
    const entryUrl =
      'https://example.com/releases/v2026.05.01/entries/route-flow-lut.json'
    const cubeUrl = 'https://example.com/blobs/route-flow-lut.cube'
    const cubeBytes = encodeCube('Route Flow LUT')
    const sha256 = await sha256Hex(cubeBytes)
    const primaryAsset = {
      role: 'cube-lut',
      mediaType: 'application/x-cube-lut',
      size: cubeBytes.byteLength,
      sha256,
      url: cubeUrl,
    }
    const catalog = {
      schemaVersion: 1,
      entries: [
        {
          id: 'route-flow-lut',
          kind: 'lut',
          version: '1.0.0',
          title: 'Route Flow LUT',
          license: 'NOASSERTION',
          redistributionAllowed: true,
          primaryAsset,
          entryUrl,
        },
      ],
    }
    const entryManifest = {
      schemaVersion: 1,
      id: 'route-flow-lut',
      kind: 'lut',
      format: 'cube',
      version: '1.0.0',
      title: 'Route Flow LUT',
      license: 'NOASSERTION',
      redistributionAllowed: true,
      entryUrl,
      primaryAsset,
      assets: [],
      lut: {
        intent: 'combined-look-output',
        input: {
          gamut: 'arri-wide-gamut-3',
          transfer: 'logc3',
          range: 'full',
        },
        output: { gamut: 'rec709', transfer: 'gamma24', range: 'legal' },
      },
      tags: ['route-acceptance'],
    }

    fetchMock.mockImplementation((input) => {
      const url = fetchUrl(input)

      if (url === catalogUrl) return jsonResponse(catalog)
      if (url === entryUrl) return jsonResponse(entryManifest)
      if (url === cubeUrl) return bytesResponse(cubeBytes)

      return Promise.reject(new Error(`Unexpected URL: ${url}`))
    })

    renderRawRoute(`/raw?luts=${encodeURIComponent(catalogUrl)}`)

    expect(
      await screen.findByText('Catalog from example.com'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load Route Flow LUT' }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(fetchUrls()).toEqual([catalogUrl]))

    const browser = await openLutSourceBrowser(user, 'Catalog from example.com')
    const loadButton = within(browser).getByRole('button', {
      name: 'Load Route Flow LUT',
    })

    await user.click(loadButton)

    await waitFor(() =>
      expect(fetchUrls()).toEqual([catalogUrl, entryUrl, cubeUrl]),
    )
    await waitFor(() => expect(getLut()?.title).toBe('Route Flow LUT'))
    expect(getProcessingParams()).toMatchObject({
      styleKind: 'custom',
      builtinPreset: null,
    })
    expect(getLut()?.profileResolution).toMatchObject({
      kind: 'resolved',
      confidence: 'user',
      profile: {
        role: 'combined-look-output',
        inputGamut: 'arri-wide-gamut-3',
        inputTransfer: 'logc3',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
        outputRange: 'legal',
      },
    })
  })

  it('rejects catalog CUBE bytes that do not match the entry hash', async () => {
    const user = userEvent.setup()
    const catalogUrl = 'https://example.com/hash-check/catalog.json'
    const entryUrl =
      'https://example.com/hash-check/entries/hash-check-lut.json'
    const cubeUrl = 'https://example.com/hash-check/blobs/hash-check-lut.cube'
    const cubeBytes = encodeCube('Hash Check LUT')
    const primaryAsset = {
      role: 'cube-lut',
      mediaType: 'application/x-cube-lut',
      size: cubeBytes.byteLength,
      sha256:
        '0000000000000000000000000000000000000000000000000000000000000000',
      url: cubeUrl,
    }
    const catalog = {
      schemaVersion: 1,
      entries: [
        {
          id: 'hash-check-lut',
          kind: 'lut',
          version: '1.0.0',
          title: 'Hash Check LUT',
          license: 'NOASSERTION',
          redistributionAllowed: true,
          primaryAsset,
          entryUrl,
        },
      ],
    }
    const entryManifest = {
      schemaVersion: 1,
      id: 'hash-check-lut',
      kind: 'lut',
      format: 'cube',
      version: '1.0.0',
      title: 'Hash Check LUT',
      license: 'NOASSERTION',
      redistributionAllowed: true,
      entryUrl,
      primaryAsset,
      assets: [],
      lut: {
        intent: 'combined-look-output',
        input: {
          gamut: 'arri-wide-gamut-3',
          transfer: 'logc3',
          range: 'full',
        },
        output: { gamut: 'rec709', transfer: 'gamma24', range: 'legal' },
      },
      tags: ['route-acceptance'],
    }

    fetchMock.mockImplementation((input) => {
      const url = fetchUrl(input)

      if (url === catalogUrl) return jsonResponse(catalog)
      if (url === entryUrl) return jsonResponse(entryManifest)
      if (url === cubeUrl) return bytesResponse(cubeBytes)

      return Promise.reject(new Error(`Unexpected URL: ${url}`))
    })

    renderRawRoute(`/raw?luts=${encodeURIComponent(catalogUrl)}`)

    expect(
      await screen.findByText('Catalog from example.com'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load Hash Check LUT' }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(fetchUrls()).toEqual([catalogUrl]))

    const browser = await openLutSourceBrowser(user, 'Catalog from example.com')
    const loadButton = within(browser).getByRole('button', {
      name: 'Load Hash Check LUT',
    })

    await user.click(loadButton)

    await waitFor(() =>
      expect(fetchUrls()).toEqual([catalogUrl, entryUrl, cubeUrl]),
    )
    await waitFor(() =>
      expect(mockedToastError).toHaveBeenCalledWith(
        'Failed to load LUT',
        expect.objectContaining({
          description: 'Online profile asset hash does not match the manifest.',
        }),
      ),
    )
    expect(getLut()).toBeNull()
    expect(getProcessingParams()).toMatchObject({
      styleKind: 'none',
      builtinPreset: null,
    })
  })
})

describe('fileFactsTool empty state', () => {
  it('shows support as not loaded before any RAW session facts exist', () => {
    render(
      <FileFactsTool
        supportLevel="experimental"
        metadata={null}
        stats={null}
      />,
    )

    const supportRow = screen.getByText('Support').closest('div')

    expect(supportRow).not.toBeNull()
    expect(supportRow).toHaveTextContent('Support')
    expect(supportRow).toHaveTextContent('Not loaded')
    expect(screen.queryByText('experimental')).not.toBeInTheDocument()
  })
})

describe('support classification', () => {
  it('marks unknown but decodable files as experimental', () => {
    expect(
      classifySupportLevel({
        cameraBrand: 'Sony',
        cameraModel: 'Unknown Model',
        rawFormat: 'arw',
      }),
    ).toBe('experimental')
  })
})
