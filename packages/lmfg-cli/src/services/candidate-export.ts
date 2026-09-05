import { resolve } from 'node:path'

import type { RenderManifest } from '@lumaforge/render-engine'

import { LmfgError, toLmfgError } from '../protocol/errors'
import type { LoadedSource } from '../runtime/source-loader'
import { readJsonOrNull } from '../workspace/atomic-fs'
import type { ReplayPlan } from './replay'
import { prepareReplay } from './replay'

export async function prepareCandidateExport(input: {
  manifest: RenderManifest
  source: LoadedSource
  candidateParamsPath: string
  workspaceRoot: string
  cwd: string
}): Promise<ReplayPlan> {
  try {
    if (input.manifest.kind !== 'candidate') {
      throw new LmfgError('manifest.invalid', {
        message:
          'The selected candidate does not contain a candidate manifest.',
      })
    }
    // The sidecar is only a file locator; the manifest owns every render value.
    const sidecar = input.manifest.lut
      ? await readJsonOrNull<{ lut?: { path?: unknown } }>(
          input.candidateParamsPath,
        )
      : null
    const plan = await prepareReplay({
      manifest: input.manifest,
      source: input.source,
      lutPath:
        typeof sidecar?.lut?.path === 'string'
          ? resolve(input.cwd, sidecar.lut.path)
          : undefined,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
    })
    if (plan.fingerprintMatch !== true) {
      throw new LmfgError('manifest.invalid', {
        message:
          'The selected candidate uses a color graph descriptor this runtime cannot verify.',
      })
    }
    return plan
  } catch (error) {
    const failure = toLmfgError(error)
    throw new LmfgError('export.refused', {
      message: `Candidate export refused: ${failure.message}`,
      details: failure.details,
      suggestedNextActions: failure.suggestedNextActions,
      cause: error,
    })
  }
}
