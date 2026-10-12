import {
  useErrorMessageValue,
  usePipelineFactsValue,
  useProcessingStatusValue,
  useProgressValue,
  useSetErrorMessage,
  useSetPipelineStats,
  useSetProcessingStatus,
  useSetProgress,
} from '../state/workflow.atoms'

export function useRawWorkflowState() {
  const status = useProcessingStatusValue()
  const setStatus = useSetProcessingStatus()
  const error = useErrorMessageValue()
  const setError = useSetErrorMessage()
  const progress = useProgressValue()
  const setProgress = useSetProgress()
  // The facts alone: the timings a preview render reports are the stats
  // provider's, so a new timing leaves the workflow as it was.
  const previewFacts = usePipelineFactsValue()
  const setStats = useSetPipelineStats()

  return {
    status,
    setStatus,
    error,
    setError,
    progress,
    setProgress,
    previewFacts,
    setStats,
  }
}
