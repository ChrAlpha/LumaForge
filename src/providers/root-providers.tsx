import { QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'jotai'
import { LazyMotion, MotionConfig } from 'motion/react'
import type { FC, PropsWithChildren } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { ErrorElement } from '~/components/common/ErrorElement'
import { Toaster } from '~/components/ui/sonner'
import { I18nProvider } from '~/lib/i18n'
import { jotaiStore } from '~/lib/jotai'
import { queryClient } from '~/lib/query-client'
import { Spring } from '~/lib/spring'

import { EventProvider } from './event-provider'
import { SettingSync } from './setting-sync'
import { StableRouterProvider } from './stable-router-provider'

const loadFeatures = () =>
  import('../framer-lazy-feature').then((res) => res.default)

const AppErrorFallback: FC<{
  error: unknown
  resetErrorBoundary: () => void
}> = ({ error, resetErrorBoundary }) => (
  <ErrorElement error={error} onReset={resetErrorBoundary} />
)

export const RootProviders: FC<PropsWithChildren> = ({ children }) => (
  <LazyMotion features={loadFeatures} strict>
    <MotionConfig transition={Spring.presets.smooth}>
      <QueryClientProvider client={queryClient}>
        <Provider store={jotaiStore}>
          <I18nProvider>
            <ErrorBoundary
              FallbackComponent={AppErrorFallback}
              onError={(error) => {
                console.error('Root error boundary caught:', error)
              }}
            >
              <EventProvider />
              <StableRouterProvider />
              <SettingSync />
              {children}
            </ErrorBoundary>
          </I18nProvider>
        </Provider>
      </QueryClientProvider>
    </MotionConfig>
    <Toaster />
  </LazyMotion>
)
