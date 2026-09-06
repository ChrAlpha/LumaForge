import type { Plugin, ViteDevServer } from 'vite'

export function preserveIsolationHeaders(
  headers: Readonly<Record<string, string>>,
): Plugin {
  const install = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((_request, response, next) => {
      // Static-file revalidation may return before Vite's custom headers run.
      for (const [name, value] of Object.entries(headers))
        response.setHeader(name, value)
      next()
    })
  }
  return {
    name: 'preserve-isolation-headers',
    configureServer: install,
    configurePreviewServer: install,
  }
}
