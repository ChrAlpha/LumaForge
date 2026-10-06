import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractSelection,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { toLUTContractSelection } from '@lumaforge/luma-color-runtime'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { toast } from 'sonner'

import { parseCubeLUTOffThread } from '~/lib/lut/cube-parse-async'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { isSupportedLUT, validateLUT } from '~/lib/lut/cube-parser'
import {
  applyLUTContractSelection,
  applyTrustedLUTContract,
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
import { buildLUTContractSelectionState, toCustomStyle } from './style-system'

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
  /** Catalog contract: applied as metadata, never stored as a user choice. */
  trustedContract?: LUTContractSelection
  /** Checked just before the LUT applies, so a stale load never lands. */
  mayApply: () => boolean
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
    /** Writes the detached color intent; it never carries view state. */
    setColorIntent: (
      value: ColorGraphIntent | ((prev: ColorGraphIntent) => ColorGraphIntent),
    ) => void
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
    /**
     * False while an export runs or holds the preview released: a LUT
     * landing then would cancel that export or discard its JPEG.
     */
    canApplyLoadedLut: () => boolean
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
    ctx.atoms.setColorIntent((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: style.defaultIntensity,
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
  const contracted = options.trustedContract
    ? applyTrustedLUTContract(parsed, options.trustedContract)
    : parsed
  if (!contracted) throw new Error('Unsupported LUT color contract.')

  const validation = validateLUT(contracted)
  if (!validation.valid) {
    throw new LUTLoadError(
      'LUT_INVALID',
      validation.errors[0] ?? 'Invalid LUT file.',
    )
  }

  if (!options.mayApply()) {
    throw new DOMException('LUT load aborted.', 'AbortError')
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
  options?: { signal?: AbortSignal },
): Promise<LutLoadOutcome> {
  const startSessionId = ctx.refs.sessionRef.current?.id ?? null
  // A load begun on a photo belongs to that photo. One begun before any
  // photo seeds whichever photo arrives, as a detached look does.
  const mayApply = () =>
    !options?.signal?.aborted &&
    (startSessionId === null ||
      ctx.refs.sessionRef.current?.id === startSessionId) &&
    ctx.services.canApplyLoadedLut()

  if (!mayApply()) return 'aborted'
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
    if (!mayApply()) return 'aborted'
    const { sha256 } = await sourceContentIdFromBytes(bytes)
    if (!mayApply()) return 'aborted'
    await loadLUTContent(
      { source: bytes, sourceName: file.name, sha256, mayApply },
      ctx,
    )
    return 'loaded'
  } catch (err) {
    // A load that went stale reports nothing, even if it also failed.
    if (isAbortError(err) || !mayApply()) return 'aborted'

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
        mayApply: () =>
          !options?.signal?.aborted && ctx.services.canApplyLoadedLut(),
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
  // An explicit user choice is the only contract persisted for later loads.
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
    ctx.atoms.setColorIntent((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: style.currentIntensity,
    }))
  }
}
