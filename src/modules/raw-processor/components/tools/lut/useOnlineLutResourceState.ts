import { useMemo } from 'react'

import type { UseOnlineLutSourcesResult } from '../../../hooks/useOnlineLutSources'
import { groupEntriesByFamily } from '../../../services/look/lut-source-grouping'

type OnlineLutState = UseOnlineLutSourcesResult['state']
type OnlineResource = OnlineLutState['resources'][number]
type OnlineEntry = OnlineLutState['entries'][number]
type OnlineIssue = OnlineLutState['issues'][number]

const EMPTY_RESOURCES: OnlineResource[] = []
const EMPTY_ENTRIES: OnlineEntry[] = []
const EMPTY_ISSUES: OnlineIssue[] = []

export function useOnlineLutResourceState({
  state,
  resourceId,
}: {
  state?: OnlineLutState
  resourceId?: string | null
}) {
  const resourcesById = useMemo(
    () =>
      new Map(
        (state?.resources ?? EMPTY_RESOURCES).map((resource) => [
          resource.id,
          resource,
        ]),
      ),
    [state?.resources],
  )
  const entriesByResourceId = useMemo(() => {
    const entries = new Map<string, OnlineEntry[]>()

    for (const resource of state?.resources ?? EMPTY_RESOURCES) {
      entries.set(resource.id, [])
    }

    for (const entry of state?.entries ?? EMPTY_ENTRIES) {
      entries.set(entry.resourceId, [
        ...(entries.get(entry.resourceId) ?? []),
        entry,
      ])
    }

    return entries
  }, [state?.entries, state?.resources])
  const issuesByResourceId = useMemo(() => {
    const issues = new Map<string, OnlineIssue[]>()

    for (const issue of state?.issues ?? EMPTY_ISSUES) {
      if (!issue.resourceId) continue

      issues.set(issue.resourceId, [
        ...(issues.get(issue.resourceId) ?? []),
        issue,
      ])
    }

    return issues
  }, [state?.issues])
  const selectedResource = resourceId
    ? (resourcesById.get(resourceId) ?? null)
    : null
  const selectedEntries = resourceId
    ? (entriesByResourceId.get(resourceId) ?? EMPTY_ENTRIES)
    : EMPTY_ENTRIES
  const selectedIssues = resourceId
    ? (issuesByResourceId.get(resourceId) ?? EMPTY_ISSUES)
    : EMPTY_ISSUES
  const selectedResourceLoading = Boolean(
    resourceId && state?.isLoading && state.activeResourceId === resourceId,
  )
  const selectedEntryGroups = useMemo(
    () => groupEntriesByFamily(selectedEntries),
    [selectedEntries],
  )

  return {
    resourcesById,
    entriesByResourceId,
    issuesByResourceId,
    selectedResource,
    selectedEntries,
    selectedIssues,
    selectedResourceLoading,
    selectedEntryGroups,
  }
}
