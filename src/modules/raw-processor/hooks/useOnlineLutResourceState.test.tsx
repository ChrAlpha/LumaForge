import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useOnlineLutResourceState } from './useOnlineLutResourceState'
import type { UseOnlineLutSourcesResult } from './useOnlineLutSources'

type OnlineLutState = UseOnlineLutSourcesResult['state']

function createState(overrides: Partial<OnlineLutState> = {}): OnlineLutState {
  return {
    resources: [
      {
        id: 'source-a',
        url: 'https://example.test/a.json',
        type: 'catalog',
        label: 'Source A',
        fromQuery: false,
      },
      {
        id: 'source-b',
        url: 'https://example.test/b.json',
        type: 'catalog',
        label: 'Source B',
        fromQuery: false,
      },
    ],
    entries: [],
    issues: [],
    activeResourceId: null,
    isLoading: false,
    ...overrides,
  }
}

describe('useOnlineLutResourceState', () => {
  it('indexes entries and issues by resource and groups the selected entries', () => {
    const state = {
      resources: [
        {
          id: 'source-a',
          url: 'https://example.test/a.json',
          type: 'catalog',
          label: 'Source A',
          fromQuery: false,
        },
        {
          id: 'source-b',
          url: 'https://example.test/b.json',
          type: 'catalog',
          label: 'Source B',
          fromQuery: true,
        },
      ],
      entries: [
        {
          id: 'entry-a1',
          title: 'A One',
          sourceUrl: 'https://example.test/a.cube',
          sourceType: 'catalog-entry',
          cube: {
            url: 'https://example.test/a.cube',
            sha256: 'a'.repeat(64),
          },
          tags: [],
          family: 'A Family',
          resourceId: 'source-a',
        },
        {
          id: 'entry-b1',
          title: 'B One',
          sourceUrl: 'https://example.test/b.cube',
          sourceType: 'catalog-entry',
          cube: {
            url: 'https://example.test/b.cube',
            sha256: 'b'.repeat(64),
          },
          tags: [],
          resourceId: 'source-b',
        },
      ],
      issues: [
        {
          code: 'invalid-entry',
          message: 'Bad entry',
          resourceId: 'source-a',
          entryId: 'entry-a1',
        },
      ],
      activeResourceId: 'source-a',
      isLoading: true,
    } satisfies UseOnlineLutSourcesResult['state']

    const { result } = renderHook(() =>
      useOnlineLutResourceState({ state, resourceId: 'source-a' }),
    )

    expect(result.current.resourcesById.get('source-a')?.label).toBe('Source A')
    expect(result.current.entriesByResourceId.get('source-a')).toHaveLength(1)
    expect(result.current.issuesByResourceId.get('source-a')).toHaveLength(1)
    expect(result.current.selectedResource?.id).toBe('source-a')
    expect(result.current.selectedEntries.map((entry) => entry.id)).toEqual([
      'entry-a1',
    ])
    expect(result.current.selectedIssues.map((issue) => issue.entryId)).toEqual(
      ['entry-a1'],
    )
    expect(result.current.selectedResourceLoading).toBe(true)
    expect(result.current.selectedEntryGroups.families).toHaveLength(1)
    expect(result.current.selectedEntryGroups.others).toHaveLength(0)
  })

  it('reports loading only for the selected source while its catalog loads', () => {
    const { result, rerender } = renderHook(
      ({ state, resourceId }: { state: OnlineLutState; resourceId: string }) =>
        useOnlineLutResourceState({ state, resourceId }),
      {
        initialProps: {
          state: createState({ activeResourceId: 'source-a', isLoading: true }),
          resourceId: 'source-a',
        },
      },
    )

    expect(result.current.selectedResourceLoading).toBe(true)

    rerender({
      state: createState({ activeResourceId: 'source-a', isLoading: true }),
      resourceId: 'source-b',
    })
    expect(result.current.selectedResource?.id).toBe('source-b')
    expect(result.current.selectedResourceLoading).toBe(false)

    rerender({
      state: createState({ activeResourceId: 'source-b', isLoading: false }),
      resourceId: 'source-b',
    })
    expect(result.current.selectedResourceLoading).toBe(false)
  })

  it('keeps an empty entry list for a listed source whose catalog has not loaded', () => {
    const { result } = renderHook(() =>
      useOnlineLutResourceState({
        state: createState(),
        resourceId: 'source-b',
      }),
    )

    expect(result.current.entriesByResourceId.get('source-a')).toEqual([])
    expect(result.current.entriesByResourceId.get('source-b')).toEqual([])
    expect(result.current.selectedEntries).toEqual([])
    expect(result.current.selectedEntryGroups.families).toHaveLength(0)
    expect(result.current.selectedEntryGroups.others).toHaveLength(0)
  })

  it('leaves issues without a source out of the per-source index', () => {
    const { result } = renderHook(() =>
      useOnlineLutResourceState({
        state: createState({
          issues: [
            { code: 'invalid-source-url', message: 'Loose issue' },
            {
              code: 'catalog-load-failed',
              message: 'Source failed',
              resourceId: 'source-b',
            },
          ],
        }),
        resourceId: 'source-b',
      }),
    )

    expect([...result.current.issuesByResourceId.keys()]).toEqual(['source-b'])
    expect(result.current.selectedIssues.map((issue) => issue.code)).toEqual([
      'catalog-load-failed',
    ])
  })

  it('selects nothing without a state, a selection, or a listed source', () => {
    const empty = renderHook(() => useOnlineLutResourceState({}))
    expect(empty.result.current.resourcesById.size).toBe(0)
    expect(empty.result.current.selectedResource).toBeNull()
    expect(empty.result.current.selectedEntries).toEqual([])
    expect(empty.result.current.selectedIssues).toEqual([])
    expect(empty.result.current.selectedResourceLoading).toBe(false)

    const unselected = renderHook(() =>
      useOnlineLutResourceState({
        state: createState({ activeResourceId: 'source-a', isLoading: true }),
        resourceId: null,
      }),
    )
    expect(unselected.result.current.selectedResource).toBeNull()
    expect(unselected.result.current.selectedResourceLoading).toBe(false)

    const unknown = renderHook(() =>
      useOnlineLutResourceState({
        state: createState(),
        resourceId: 'source-missing',
      }),
    )
    expect(unknown.result.current.selectedResource).toBeNull()
    expect(unknown.result.current.selectedEntries).toEqual([])
  })
})
