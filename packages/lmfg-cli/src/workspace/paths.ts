import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_WORKSPACE_DIRNAME = '.lmfg'

export function resolveWorkspaceRoot(cwd: string, option?: string): string {
  return resolve(cwd, option ?? DEFAULT_WORKSPACE_DIRNAME)
}

export function toFileUri(path: string): string {
  return pathToFileURL(path).href
}

const session = (root: string, id: string) => join(root, 'sessions', id)
const iteration = (root: string, id: string, iterationId: string) =>
  join(session(root, id), 'iterations', iterationId)
const candidate = (
  root: string,
  id: string,
  iterationId: string,
  candidateId: string,
) => join(iteration(root, id, iterationId), 'candidates', candidateId)

export const workspacePaths = {
  luts: (root: string) => join(root, 'luts'),
  lutCacheFile: (root: string, sha256: string) =>
    join(root, 'luts', `${sha256}.cube`),
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
    join(session(root, id), 'previews', `${previewId}.jpg`),
  previewManifestFile: (root: string, id: string, previewId: string) =>
    join(session(root, id), 'previews', `${previewId}.manifest.json`),
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
  ) => join(iteration(root, id, iterationId), `${name}.jpg`),
  contactSheetMapFile: (
    root: string,
    id: string,
    iterationId: string,
    name = 'contact-sheet',
  ) => join(iteration(root, id, iterationId), `${name}.map.json`),
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
    join(session(root, id), 'replays', key),
  replayOutputFile: (root: string, id: string, key: string) =>
    join(session(root, id), 'replays', key, 'output.jpg'),
  replayManifestFile: (root: string, id: string, key: string) =>
    join(session(root, id), 'replays', key, 'manifest.json'),
  workspaceReplay: (root: string, key: string) => join(root, 'replays', key),
  exports: (root: string, id: string) => join(session(root, id), 'exports'),
  exportFile: (root: string, id: string, name: string) =>
    join(session(root, id), 'exports', `${name}.jpg`),
  exportManifestFile: (root: string, id: string, name: string) =>
    join(session(root, id), 'exports', `${name}.manifest.json`),
}
