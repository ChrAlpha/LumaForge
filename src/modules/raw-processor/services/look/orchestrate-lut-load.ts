import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractSelection,
  ParsedLUT,
} from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  isSupportedLUT,
  normalizeLookIntensity,
  toLUTContractSelection,
  validateLUT,
} from '@lumaforge/luma-color-runtime'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'

import { parseCubeLUTOffThread } from '~/lib/lut/cube-parse-async'
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

import type { ImageSession } from '../../model/session'
import { isAbortError } from '../ingest/workflow-status'
import {
  applyActiveLookToSession,
  preserveCustomLookIntensity,
} from './look-session-state'
import {
  buildLUTContractSelectionState,
  DEFAULT_LOOK_INTENSITY,
  toCustomStyle,
} from './style-system'

const MAX_ONLINE_CUBE_BYTES = 64 * 1024 * 1024
const onlineProfileCache = createBrowserOnlineProfileCache()

/**
 * How a LUT load attempt ended. Callers must branch on this instead of
 * assuming a resolved promise means success: failures are reported (a
 * notification + session error code) inside the orchestrator and
 * intentionally not rethrown.
 */
export type LutLoadOutcome = 'loaded' | 'failed' | 'aborted'

/**
 * What a LUT load or contract choice tells the user. A load reports at most
 * one, after its session writes, and none once it went stale; how and when it
 * is shown belongs to the caller.
 */
export type LutNotification =
  | { kind: 'loaded'; title: string; gridSize: number }
  /** The file is not a .cube. */
  | { kind: 'unsupported-format' }
  /**
   * Read, download, parse or validation failure. The message is the
   * runtime's or parser's own detail, shown as given; null when it gave none.
   */
  | { kind: 'load-failed'; message: string | null }
  /** A catalog contract that does not apply to the LUT it came with. */
  | { kind: 'unsupported-contract' }
  /** A contract was chosen while no LUT is loaded. */
  | { kind: 'no-lut' }
  /** The chosen profile does not resolve to a complete LUT contract. */
  | { kind: 'incomplete-contract'; profileId: string }

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

/**
 * Thrown when a catalog's trusted contract does not apply to the LUT it came
 * with; it is reported as its own notification, not as a parse failure.
 */
class UnsupportedLUTContractError extends Error {
  constructor() {
    super('Unsupported LUT color contract.')
    this.name = 'UnsupportedLUTContractError'
  }
}

export interface LutLoadContext {
  atoms: {
    /**
     * Reads the session from the store when called, so a load or reset
     * written in the same tick is seen before any rerender.
     */
    getSession: () => ImageSession | null
    /**
     * Reads the LUT from the store when called, so a contract choice applies
     * to the LUT current when it runs, never to one replaced or cleared since
     * the caller last rendered.
     */
    getLut: () => ParsedLUT | null
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
  }
  services: {
    notify: (notification: LutNotification) => void
    invalidateExportGraph: () => void
    /**
     * False while an export runs or holds the preview released: a LUT
     * landing then would cancel that export or discard its JPEG.
     */
    canApplyLoadedLut: () => boolean
  }
}

function reportLUTLoadFailure(error: unknown, ctx: LutLoadContext): void {
  const message = error instanceof Error ? error.message : null
  ctx.services.notify(
    error instanceof UnsupportedLUTContractError
      ? { kind: 'unsupported-contract' }
      : { kind: 'load-failed', message },
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
        })
      : prev,
  )
  if (!ctx.atoms.getSession()) {
    ctx.atoms.setColorIntent((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: style.defaultIntensity,
    }))
  }
  ctx.services.notify({
    kind: 'loaded',
    title: parsed.title,
    gridSize: parsed.size,
  })
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
  if (!contracted) throw new UnsupportedLUTContractError()

  const validation = validateLUT(contracted)
  if (!validation.valid) {
    throw new Error(validation.errors[0] ?? 'Invalid LUT file.')
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

/**
 * A load begun on a photo belongs to that photo. One begun before any photo
 * seeds whichever photo arrives, as a detached look does. Both reads go to
 * the store, so a load started in the tick a load or reset wrote belongs to
 * the session that exists after it.
 */
function captureLoadSession(ctx: LutLoadContext): () => boolean {
  const startSessionId = ctx.atoms.getSession()?.id ?? null
  return () =>
    startSessionId === null || ctx.atoms.getSession()?.id === startSessionId
}

export async function orchestrateLutLoadFromFile(
  file: File,
  ctx: LutLoadContext,
  options?: { signal?: AbortSignal },
): Promise<LutLoadOutcome> {
  const ownsSession = captureLoadSession(ctx)
  const mayApply = () =>
    !options?.signal?.aborted &&
    ownsSession() &&
    ctx.services.canApplyLoadedLut()

  if (!mayApply()) return 'aborted'
  if (!isSupportedLUT(file.name)) {
    ctx.services.notify({ kind: 'unsupported-format' })
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
  const ownsSession = captureLoadSession(ctx)
  try {
    if (options?.signal?.aborted) return 'aborted'

    // A catalog asset comes back with the hash it was verified against;
    // direct URLs declare none, so their bytes are hashed here.
    const { bytes, sha256: verifiedSha256 } =
      entry.sourceType === 'catalog-entry'
        ? await fetchVerifiedCubeAsset(entry.cube, {
            signal: options?.signal,
            maxBytes: MAX_ONLINE_CUBE_BYTES,
            cache: onlineProfileCache,
            onProgress: options?.onProgress,
          })
        : {
            bytes: await fetchCachedBytesWithLimit(entry.cube.url, {
              signal: options?.signal,
              maxBytes: MAX_ONLINE_CUBE_BYTES,
              cache: onlineProfileCache,
              onProgress: options?.onProgress,
            }),
            sha256: null,
          }

    if (options?.signal?.aborted) return 'aborted'

    await loadLUTContent(
      {
        source: bytes,
        sourceName: entry.title,
        sha256:
          verifiedSha256 ?? (await sourceContentIdFromBytes(bytes)).sha256,
        trustedContract:
          entry.sourceType === 'catalog-entry'
            ? entry.trustedContract
            : undefined,
        mayApply: () =>
          !options?.signal?.aborted &&
          ownsSession() &&
          ctx.services.canApplyLoadedLut(),
      },
      ctx,
    )
    return 'loaded'
  } catch (err) {
    // A download whose photo was replaced or reset reports nothing on the
    // session that took its place.
    if (isAbortError(err) || options?.signal?.aborted || !ownsSession()) {
      return 'aborted'
    }

    reportLUTLoadFailure(err, ctx)
    return 'failed'
  }
}

function resolveSelectedLUTSha256(
  lut: ParsedLUT,
  session: ImageSession,
): string | undefined {
  if (lut.sha256) return lut.sha256
  const asset = session.activeStyle?.lutAsset
  return asset?.fingerprint === lut.fingerprint ? asset.sha256 : undefined
}

export function orchestrateProfileSelection(
  profile: LUTColorProfile | string,
  ctx: LutLoadContext,
): void {
  // The choice belongs to the LUT the store holds now: its table, hash and
  // fingerprint, never those of a LUT replaced or cleared before it ran.
  const lut = ctx.atoms.getLut()
  if (!lut) {
    ctx.services.notify({ kind: 'no-lut' })
    return
  }

  const contractProfile =
    typeof profile === 'string' ? getLUTColorProfile(profile) : profile
  // An explicit user choice is the only contract persisted for later loads.
  const updatedLut = contractProfile
    ? applyLUTContractSelection(lut, toLUTContractSelection(contractProfile))
    : undefined
  if (!updatedLut) {
    ctx.services.notify({
      kind: 'incomplete-contract',
      profileId: typeof profile === 'string' ? profile : profile.id,
    })
    return
  }

  ctx.atoms.setLut(updatedLut)
  ctx.services.invalidateExportGraph()
  // The look keeps the strength it holds when the choice lands, so a Strength
  // write in the same tick survives a contract change. The hash belongs to the
  // LUT the choice applies to: the session look's hash is inherited only when
  // that look is the same LUT.
  ctx.atoms.setSession((prev) =>
    prev
      ? applyActiveLookToSession(prev, {
          style: preserveCustomLookIntensity(
            toCustomStyle(updatedLut, {
              sha256: resolveSelectedLUTSha256(updatedLut, prev),
            }),
            prev.activeStyle,
          ),
          lutProfileSelection: buildLUTContractSelectionState(updatedLut),
        })
      : prev,
  )
  if (!ctx.atoms.getSession()) {
    ctx.atoms.setColorIntent((prev) => ({
      ...prev,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: normalizeLookIntensity(prev.intensity, DEFAULT_LOOK_INTENSITY),
    }))
  }
}
