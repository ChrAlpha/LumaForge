export { createProgram, runCli } from './cli'
export type { CliIo } from './commands/context'
export type { LmfgErrorCode } from './protocol/errors'
export { LmfgError } from './protocol/errors'
export { EXIT_CODES } from './protocol/exit-codes'
export { listSchemas, showSchema } from './schemas/registry'
export type {
  ContactSheetMap,
  IterationRecord,
  SessionRecord,
} from './schemas/results'
export {
  ContactSheetMapSchema,
  IterationRecordSchema,
  SessionRecordSchema,
} from './schemas/results'
export {
  assertPortablePathSegment,
  DEFAULT_WORKSPACE_DIRNAME,
  isPortablePathSegment,
  resolveWorkspaceRoot,
  toFileUri,
  workspacePaths,
} from './workspace/paths'
