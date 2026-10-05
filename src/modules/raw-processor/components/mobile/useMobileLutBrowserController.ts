import { useEffect, useId, useRef, useState } from 'react'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { useOnlineLutResourceState } from '../tools/lut/useOnlineLutResourceState'

type MobileLutView = 'overview' | 'catalog'

interface UseMobileLutBrowserControllerInput {
  open: boolean
  onlineLutSources?: UseOnlineLutSourcesResult
}

export function useMobileLutBrowserController({
  open,
  onlineLutSources,
}: UseMobileLutBrowserControllerInput) {
  const onlineSourceInputId = useId()
  const [view, setView] = useState<MobileLutView>('overview')
  const [catalogResourceId, setCatalogResourceId] = useState<string | null>(
    null,
  )
  const overviewBodyRef = useRef<HTMLDivElement | null>(null)
  const catalogBodyRef = useRef<HTMLDivElement | null>(null)

  const resources = onlineLutSources?.state.resources
  const onlineResourceState = useOnlineLutResourceState({
    state: onlineLutSources?.state,
    resourceId: catalogResourceId,
  })

  useEffect(() => {
    if (open) return
    setView('overview')
    setCatalogResourceId(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  useEffect(() => {
    if (view !== 'catalog' || !catalogResourceId) return
    const resourceExists =
      resources?.some((resource) => resource.id === catalogResourceId) ?? false

    if (!resourceExists) {
      setCatalogResourceId(null)
      setView('overview')
    }
  }, [catalogResourceId, resources, view])

  const scrollOverviewToTop = () => {
    requestAnimationFrame(() => {
      if (overviewBodyRef.current) overviewBodyRef.current.scrollTop = 0
    })
  }

  const returnToOverview = () => {
    setView('overview')
    setCatalogResourceId(null)
    scrollOverviewToTop()
  }

  const openCatalogResource = (resourceId: string) => {
    setCatalogResourceId(resourceId)
    setView('catalog')
  }

  return {
    view,
    onlineSourceInputId,
    overviewBodyRef,
    catalogBodyRef,
    ...onlineResourceState,
    returnToOverview,
    openCatalogResource,
  }
}
