import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LmfgError } from '../protocol/errors'

export const DEFAULT_WORKSPACE_DIRNAME = '.lmfg'

function segment(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[/\\<>:"|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(
      value.split('.')[0].trimEnd(),
    )
  ) {
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
  join(root, 'sessions', segment(id))
const iteration = (root: string, id: string, iterationId: string) =>
  join(session(root, id), 'iterations', segment(iterationId))
const candidate = (
  root: string,
  id: string,
  iterationId: string,
  candidateId: string,
) => join(iteration(root, id, iterationId), 'candidates', segment(candidateId))

export const workspacePaths = {
  luts: (root: string) => join(root, 'luts'),
  lutCacheFile: (root: string, sha256: string) =>
    join(root, 'luts', `${segment(sha256)}.cube`),
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
    join(session(root, id), 'previews', `${segment(previewId)}.jpg`),
  previewManifestFile: (root: string, id: string, previewId: string) =>
    join(session(root, id), 'previews', `${segment(previewId)}.manifest.json`),
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
  ) => join(iteration(root, id, iterationId), `${segment(name)}.jpg`),
  contactSheetMapFile: (
    root: string,
    id: string,
    iterationId: string,
    name = 'contact-sheet',
  ) => join(iteration(root, id, iterationId), `${segment(name)}.map.json`),
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
    join(session(root, id), 'replays', segment(key)),
  replayOutputFile: (root: string, id: string, key: string) =>
    join(session(root, id), 'replays', segment(key), 'output.jpg'),
  replayManifestFile: (root: string, id: string, key: string) =>
    join(session(root, id), 'replays', segment(key), 'manifest.json'),
  workspaceReplay: (root: string, key: string) =>
    join(root, 'replays', segment(key)),
  exports: (root: string, id: string) => join(session(root, id), 'exports'),
  exportFile: (root: string, id: string, name: string) =>
    join(session(root, id), 'exports', `${segment(name)}.jpg`),
  exportManifestFile: (root: string, id: string, name: string) =>
    join(session(root, id), 'exports', `${segment(name)}.manifest.json`),
}
