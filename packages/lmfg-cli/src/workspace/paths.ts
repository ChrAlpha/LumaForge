import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LmfgError } from '../protocol/errors'

export const DEFAULT_WORKSPACE_DIRNAME = '.lmfg'

/**
 * A workspace identifier or basename must be one path segment that every
 * supported OS treats the same: no separators, dot segments, drive or
 * stream syntax, control characters, Windows device names, or trailing
 * dots/spaces.
 */
export function isPortablePathSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\<>:"|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(
      value.split('.')[0].trimEnd(),
    )
  )
}

export function assertPortablePathSegment(value: string): string {
  if (!isPortablePathSegment(value)) {
    throw new LmfgError('args.invalid', {
      message:
        'Artifact identifiers and basenames must be a single portable path segment without separators, dot segments, reserved names, or trailing dots/spaces.',
    })
  }
  return value
}

export function resolveWorkspaceRoot(cwd: string, option?: string): string {
  return resolve(cwd, option ?? DEFAULT_WORKSPACE_DIRNAME)
}

export function toFileUri(path: string): string {
  return pathToFileURL(path).href
}

const session = (root: string, id: string) =>
  join(root, 'sessions', assertPortablePathSegment(id))
const iteration = (root: string, id: string, iterationId: string) =>
  join(session(root, id), 'iterations', assertPortablePathSegment(iterationId))
const candidate = (
  root: string,
  id: string,
  iterationId: string,
  candidateId: string,
) =>
  join(
    iteration(root, id, iterationId),
    'candidates',
    assertPortablePathSegment(candidateId),
  )

export const workspacePaths = {
  luts: (root: string) => join(root, 'luts'),
  lutCacheFile: (root: string, sha256: string) =>
    join(root, 'luts', `${assertPortablePathSegment(sha256)}.cube`),
  sessions: (root: string) => join(root, 'sessions'),
  session,
  sessionFile: (root: string, id: string) =>
    join(session(root, id), 'session.json'),
  source: (root: string, id: string) => join(session(root, id), 'source'),
  sourceIdentityFile: (root: string, id: string) =>
    join(session(root, id), 'source', 'source.identity.json'),
  inspectFile: (root: string, id: string) =>
    join(session(root, id), 'source', 'inspect.json'),
  embeddedPreviewFile: (root: string, id: string) =>
    join(session(root, id), 'source', 'embedded-preview.jpg'),
  previews: (root: string, id: string) => join(session(root, id), 'previews'),
  previewFile: (root: string, id: string, previewId: string) =>
    join(
      session(root, id),
      'previews',
      `${assertPortablePathSegment(previewId)}.jpg`,
    ),
  previewManifestFile: (root: string, id: string, previewId: string) =>
    join(
      session(root, id),
      'previews',
      `${assertPortablePathSegment(previewId)}.manifest.json`,
    ),
  iterations: (root: string, id: string) =>
    join(session(root, id), 'iterations'),
  iteration,
  iterationPlanFile: (root: string, id: string, iterationId: string) =>
    join(iteration(root, id, iterationId), 'plan.json'),
  iterationEventsFile: (root: string, id: string, iterationId: string) =>
    join(iteration(root, id, iterationId), 'events.ndjson'),
  contactSheetFile: (
    root: string,
    id: string,
    iterationId: string,
    name = 'contact-sheet',
  ) =>
    join(
      iteration(root, id, iterationId),
      `${assertPortablePathSegment(name)}.jpg`,
    ),
  contactSheetMapFile: (
    root: string,
    id: string,
    iterationId: string,
    name = 'contact-sheet',
  ) =>
    join(
      iteration(root, id, iterationId),
      `${assertPortablePathSegment(name)}.map.json`,
    ),
  candidates: (root: string, id: string, iterationId: string) =>
    join(iteration(root, id, iterationId), 'candidates'),
  candidate,
  candidatePreviewFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'preview.jpg'),
  candidateManifestFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'manifest.json'),
  candidateMetricsFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'metrics.json'),
  candidateParamsFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'params.json'),
  candidateTileFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'tile.rgba'),
  candidateTileMetaFile: (
    root: string,
    id: string,
    iterationId: string,
    candidateId: string,
  ) => join(candidate(root, id, iterationId, candidateId), 'tile.json'),
  replays: (root: string, id: string) => join(session(root, id), 'replays'),
  replay: (root: string, id: string, key: string) =>
    join(session(root, id), 'replays', assertPortablePathSegment(key)),
  replayOutputFile: (root: string, id: string, key: string) =>
    join(
      session(root, id),
      'replays',
      assertPortablePathSegment(key),
      'output.jpg',
    ),
  replayManifestFile: (root: string, id: string, key: string) =>
    join(
      session(root, id),
      'replays',
      assertPortablePathSegment(key),
      'manifest.json',
    ),
  workspaceReplay: (root: string, key: string) =>
    join(root, 'replays', assertPortablePathSegment(key)),
  exports: (root: string, id: string) => join(session(root, id), 'exports'),
  exportFile: (root: string, id: string, name: string) =>
    join(
      session(root, id),
      'exports',
      `${assertPortablePathSegment(name)}.jpg`,
    ),
  exportManifestFile: (root: string, id: string, name: string) =>
    join(
      session(root, id),
      'exports',
      `${assertPortablePathSegment(name)}.manifest.json`,
    ),
}
