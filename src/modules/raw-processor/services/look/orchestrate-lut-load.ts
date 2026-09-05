import type {
  LUTColorProfile,
  LUTContractSelection,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { toast } from 'sonner'

import { parseCubeLUTOffThread } from '~/lib/lut/cube-parse-async'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { isSupportedLUT, validateLUT } from '~/lib/lut/cube-parser'
import {
  applyLUTContractSelection,
  toLUTContractSelection,
} from '~/lib/lut/profile-resolution'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import type { OnlineProfileFetchProgress } from '~/lib/profiles/fetch'
import {
  createBrowserOnlineProfileCache,
  fetchCachedBytesWithLimit,
  fetchVerifiedCubeAsset,
} from '~/lib/profiles/fetch'

import type { ImageSession, StyleAsset } from '../../model/session'
import {
  getStableErrorCode,
  isAbortError,
  toUserFacingErrorCode,
} from '../ingest/workflow-status'
import {
  applyActiveLookToSession,
  preserveCustomLookIntensity,
} from './look-session-state'
import {
  resolveLUTContractProfile,
  resolveOnlineLUTSourceName,
} from './lut-workflow'
import {
  buildLUTContractSelectionState,
  mapIntensityLevel,
  toCustomStyle,
} from './style-system'

const MAX_ONLINE_CUBE_BYTES = 64 * 1024 * 1024
const onlineProfileCache = createBrowserOnlineProfileCache()

/**
 * How a LUT load attempt ended. Callers must branch on this instead of
 * assuming a resolved promise means success: failures are reported (toast +
 * session error code) inside the orchestrator and intentionally not rethrown.
 */
export type LutLoadOutcome = 'loaded' | 'failed' | 'aborted'

interface LoadLUTContentOptions {
  /** Raw .cube text, or undecoded bytes (decoded on the parse worker). */
  source: string | Uint8Array
  sourceName: string
  /** SHA-256 of the .cube bytes, recorded on the style for export manifests. */
  sha256?: string
  trustedContract?: LUTContractSelection
  /** Checked after the off-thread parse so a cancelled load never applies. */
  signal?: AbortSignal
}

export class LUTLoadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LUTLoadError'
    this.code = code
  }
}

export interface LutLoadContext {
  atoms: {
    setLut: (lut: ParsedLUT | null) => void
    setSession: (
      value:
        | ImageSession
        | null
        | ((prev: ImageSession | null) => ImageSession | null),
    ) => void
    setParams: (
      value: ProcessingParams | ((prev: ProcessingParams) => ProcessingParams),
    ) => void
    getProcessingParams: () => ProcessingParams
    lut: ParsedLUT | null
    activeStyle: StyleAsset | null
  }
  refs: {
    lutDataRef: { current: LUTData | null }
    sessionRef: { current: ImageSession | null }
  }
  services: {
    scheduleToast: (notify: () => void) => void
    invalidateExportGraph: () => void
    setLutDataRef: (nextLutData: LUTData | null) => void
  }
}

function reportLUTLoadFailure(error: unknown, ctx: LutLoadContext): void {
  const message = error instanceof Error ? error.message : 'Failed to parse LUT'
  const stableCode = getStableErrorCode(error)
  const errorCode =
    toUserFacingErrorCode(stableCode ?? message) === 'RAW_UNKNOWN'
      ? 'LUT_PARSE_FAILED'
      : toUserFacingErrorCode(stableCode ?? message)

  ctx.atoms.setSession((prev) =>
    prev
      ? {
          ...prev,
          renderState: {
            ...prev.renderState,
            lastErrorCode: errorCode,
          },
        }
      : prev,
  )
  ctx.services.scheduleToast(() =>
    toast.error('Failed to load LUT', { description: message }),
  )
}

function applyLoadedLUT(
  parsed: ParsedLUT,
  ctx: LutLoadContext,
  sha256?: string,
): void {
  const style = toCustomStyle(parsed, { sha256 })
  ctx.services.invalidateExportGraph()
  ctx.atoms.setLut(parsed)
  ctx.atoms.setSession((prev) =>
    prev
      ? applyActiveLookToSession(prev, {
          style,
          lutProfileSelection: buildLUTContractSelectionState(parsed),
          clearExportResult: true,
        })
      : prev,
  )
  if (!ctx.refs.sessionRef.current) {
    ctx.atoms.setParams((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: mapIntensityLevel(style.defaultIntensityLevel),
    }))
  }
  ctx.services.scheduleToast(() =>
    toast.success(`Loaded LUT: ${parsed.title}`, {
      description: `${parsed.size}³ grid`,
    }),
  )
}

async function loadLUTContent(
  options: LoadLUTContentOptions,
  ctx: LutLoadContext,
): Promise<void> {
  const parsedLut = await parseCubeLUTOffThread(options.source, {
    sourceName: options.sourceName,
  })
  const parsed: ParsedLUT = options.sha256
    ? { ...parsedLut, sha256: options.sha256 }
    : parsedLut
  if (options.signal?.aborted) {
    throw new DOMException('LUT load aborted.', 'AbortError')
  }
  const contracted = options.trustedContract
    ? applyLUTContractSelection(parsed, options.trustedContract)
    : parsed
  if (!contracted) throw new Error('Unsupported LUT color contract.')

  const validation = validateLUT(contracted)
  if (!validation.valid) {
    throw new LUTLoadError(
      'LUT_INVALID',
      validation.errors[0] ?? 'Invalid LUT file.',
    )
  }

  applyLoadedLUT(contracted, ctx, options.sha256)
}

/** Browsers expose `arrayBuffer()`; older DOM shims (jsdom) only expose `text()`. */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new TextEncoder().encode(await file.text())
}

export async function orchestrateLutLoadFromFile(
  file: File,
  ctx: LutLoadContext,
): Promise<LutLoadOutcome> {
  if (!isSupportedLUT(file)) {
    ctx.atoms.setSession((prev) =>
      prev
        ? {
            ...prev,
            renderState: {
              ...prev.renderState,
              lastErrorCode: 'LUT_UNSUPPORTED_FORMAT',
            },
          }
        : prev,
    )
    ctx.services.scheduleToast(() =>
      toast.error('Unsupported LUT format', {
        description: 'Only .cube files are supported',
      }),
    )
    return 'failed'
  }

  try {
    const bytes = await readFileBytes(file)
    await loadLUTContent(
      {
        source: bytes,
        sourceName: file.name,
        sha256: (await sourceContentIdFromBytes(bytes)).sha256,
      },
      ctx,
    )
    return 'loaded'
  } catch (err) {
    reportLUTLoadFailure(err, ctx)
    return 'failed'
  }
}

export async function orchestrateOnlineLutLoad(
  entry: OnlineLUTEntry,
  options:
    | { signal?: AbortSignal; onProgress?: OnlineProfileFetchProgress }
    | undefined,
  ctx: LutLoadContext,
): Promise<LutLoadOutcome> {
  try {
    if (options?.signal?.aborted) return 'aborted'

    const bytes =
      entry.sourceType === 'catalog-entry'
        ? await fetchVerifiedCubeAsset(entry.cube, {
            signal: options?.signal,
            maxBytes: MAX_ONLINE_CUBE_BYTES,
            cache: onlineProfileCache,
            onProgress: options?.onProgress,
          })
        : await fetchCachedBytesWithLimit(entry.cube.url, {
            signal: options?.signal,
            maxBytes: MAX_ONLINE_CUBE_BYTES,
            cache: onlineProfileCache,
            onProgress: options?.onProgress,
          })

    if (options?.signal?.aborted) return 'aborted'

    await loadLUTContent(
      {
        source: bytes,
        sourceName: resolveOnlineLUTSourceName(entry),
        sha256: (await sourceContentIdFromBytes(bytes)).sha256,
        trustedContract:
          entry.sourceType === 'catalog-entry'
            ? entry.trustedContract
            : undefined,
        signal: options?.signal,
      },
      ctx,
    )
    return 'loaded'
  } catch (err) {
    if (isAbortError(err) || options?.signal?.aborted) return 'aborted'

    reportLUTLoadFailure(err, ctx)
    return 'failed'
  }
}

export function orchestrateProfileSelection(
  profile: LUTColorProfile | string,
  ctx: LutLoadContext,
): void {
  if (!ctx.atoms.lut) {
    ctx.services.scheduleToast(() => toast.error('No LUT loaded'))
    return
  }

  const contractProfile = resolveLUTContractProfile(profile)
  const updatedLut = contractProfile
    ? applyLUTContractSelection(
        ctx.atoms.lut,
        toLUTContractSelection(contractProfile),
      )
    : undefined
  if (!updatedLut) {
    ctx.services.scheduleToast(() =>
      toast.error('Incomplete LUT contract', {
        description: typeof profile === 'string' ? profile : profile.id,
      }),
    )
    return
  }

  const style = preserveCustomLookIntensity(
    toCustomStyle(updatedLut, {
      sha256: ctx.atoms.activeStyle?.lutAsset?.sha256,
    }),
    ctx.atoms.activeStyle,
  )

  ctx.atoms.setLut(updatedLut)
  ctx.services.invalidateExportGraph()
  ctx.atoms.setSession((prev) =>
    prev
      ? applyActiveLookToSession(prev, {
          style,
          lutProfileSelection: buildLUTContractSelectionState(updatedLut),
          clearExportResult: true,
        })
      : prev,
  )
  if (!ctx.refs.sessionRef.current) {
    ctx.atoms.setParams((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: mapIntensityLevel(style.currentIntensityLevel),
    }))
  }
}
