import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sha256Hex } from '~/lib/profiles/fetch'

import { Component as RawRoute } from '../../../pages/(main)/raw'
import { FileFactsTool } from '../components/tools/FileFactsTool'
import { RawProcessorView } from '../RawProcessorView'
import {
  DEFAULT_LUMAFORGE_PROFILE_SOURCE,
  ONLINE_LUT_SOURCE_STORAGE_KEY,
} from '../services/look/online-lut-sources'
import {
  getLut,
  getProcessingParams,
  resetToDefaults,
} from '../state/workflow.atoms'

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

function hideDefaultOnlineLutSource() {
  localStorage.setItem(
    ONLINE_LUT_SOURCE_STORAGE_KEY,
    JSON.stringify({
      resources: [],
      removedDefaultUrls: [DEFAULT_LUMAFORGE_PROFILE_SOURCE.url],
    }),
  )
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
    previewMode: 'gpu',
    reason: null,
  })

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
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
      previewMode: 'gpu',
      reason: null,
    })

    render(<RawProcessorView />)

    expect(screen.getByRole('banner')).toHaveAttribute(
      'data-raw-desktop-chrome',
      'on-photo-topbar',
    )
    expect(screen.getByRole('banner')).toHaveAttribute(
      'data-raw-desktop-density',
      'compact-command',
    )
    expect(screen.getByText('LumaForge RAW Lab')).toBeInTheDocument()
    expect(screen.getByText('Finish a RAW with a LUT')).toBeInTheDocument()
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
      previewMode: 'gpu',
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
    expect(viewportShell).toHaveClass('raw-lab')
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'empty')
    expect(stageToolsLayout).not.toBeNull()
    expect(stageToolsLayout).toHaveClass('raw-lab-shell')
    expect(stageToolsLayout).toHaveAttribute(
      'data-raw-desktop-layout',
      'photo-stage-command-rail',
    )
  })

  it('lets the raw route hand viewport ownership directly to the shell', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      previewMode: 'gpu',
      reason: null,
    })

    const { container } = render(<RawRoute />)
    const routeRoot = container.firstElementChild

    expect(routeRoot).not.toBeNull()
    expect(routeRoot).toHaveAttribute('data-raw-lab-shell', 'viewport')
    expect(routeRoot).toHaveClass('raw-lab')
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

  it('says no RAW is loaded, once, in the export block before one is', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      previewMode: 'gpu',
      reason: null,
    })

    render(<RawProcessorView />)

    const exportBlock = screen.getByRole('region', { name: 'Export' })
    expect(within(exportBlock).getAllByText('No image loaded')).toHaveLength(1)
    expect(
      within(exportBlock).queryByText(
        'Full-resolution export source is still loading.',
      ),
    ).toBeNull()
    expect(
      within(exportBlock).getByRole('button', {
        name: /export full-resolution jpeg/i,
      }),
    ).toBeDisabled()
  })
})

describe('rawProcessorView online LUT route sources', () => {
  beforeEach(() => {
    hideDefaultOnlineLutSource()
  })

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
    const { container } = renderRawRoute(
      `/raw?luts=${encodeURIComponent(
        'javascript:alert(1)',
      )}&luts=${encodeURIComponent('https://example.com/valid.cube')}`,
    )

    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-raw-lut="source-resource"]'),
      ).toHaveLength(1),
    )
    expect(
      screen.getByRole('button', { name: 'Load valid.cube' }),
    ).toBeInTheDocument()

    const status = await screen.findByRole('status')
    // Rejected sources surface translated copy, not the raw runtime string.
    expect(status).toHaveTextContent('Only https sources are supported.')
    // One collapsed warning, not a stack: no "+N more" affordance.
    expect(status).not.toHaveTextContent('more')
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
    const loadButton = screen.getByRole('button', {
      name: 'Load lazy-direct.cube',
    })
    expect(fetchMock).not.toHaveBeenCalled()

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
    await waitFor(() => expect(fetchUrls()).toEqual([catalogUrl]))
    const loadButton = screen.getByRole('button', {
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
      kind: 'confirmed',
      confidence: 'metadata',
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
    await waitFor(() => expect(fetchUrls()).toEqual([catalogUrl]))
    const loadButton = screen.getByRole('button', {
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
