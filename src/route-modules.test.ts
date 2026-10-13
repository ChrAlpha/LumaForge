import { describe, expect, it } from 'vitest'

import { routes } from './generated-routes'

// The route builder hands the router a sync module's named `Component`,
// `loader`, and `handle`, and react-router reads the same named exports
// from a lazy module. Route files export only those.
describe('route modules', () => {
  const children = routes[0]?.children ?? []

  it('mounts the landing from the sync module named exports', async () => {
    const landing = children.find((route) => route.path === '')
    const module = await import('./pages/(main)/index.sync')

    expect(landing?.Component).toBe(module.Component)
    expect(landing?.loader).toBe(module.loader)
    expect(landing?.handle).toBe(module.handle)
    expect(Object.keys(module).sort()).toEqual([
      'Component',
      'handle',
      'loader',
    ])
  })

  // The first import of /raw transforms the whole RAW Lab module graph.
  it('loads /raw lazily from its named exports', async () => {
    const raw = children.find((route) => route.path === 'raw')
    expect(typeof raw?.lazy).toBe('function')

    const module = await (raw?.lazy as () => Promise<Record<string, unknown>>)()

    expect(typeof module.Component).toBe('function')
    expect(module.handle).toEqual(
      expect.objectContaining({ seo: expect.anything() }),
    )
    expect(Object.keys(module).sort()).toEqual(['Component', 'handle'])
  }, 30_000)
})
