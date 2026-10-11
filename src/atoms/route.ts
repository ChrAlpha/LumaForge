import { atom } from 'jotai'
import type { Location, NavigateFunction, Params } from 'react-router'

import { createAtomHooks } from '~/lib/jotai'

interface RouteAtom {
  params: Readonly<Params<string>>
  searchParams: URLSearchParams
  location: Location<unknown>
}

export const [, , , , , setRoute] = createAtomHooks(
  atom<RouteAtom>({
    params: {},
    searchParams: new URLSearchParams(),
    location: {
      pathname: '',
      search: '',
      hash: '',
      state: null,
      key: '',
      unstable_mask: undefined,
    },
  }),
)

// Vite HMR will create new router instance, but RouterProvider always stable

export const [, , , , , setNavigate] = createAtomHooks(
  atom<{ fn: NavigateFunction | null }>({ fn() {} }),
)
