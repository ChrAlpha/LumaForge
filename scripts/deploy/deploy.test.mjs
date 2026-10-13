import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkDeployArtifact } from './check.mjs'
import { createDeployConfig, resolveDeployOptions } from './config.mjs'
import { prepareCloudflareDeploy, prepareVercelDeploy } from './prepare.mjs'
import { createPublishCommand, resolveDeploymentUrl } from './publish.mjs'
import { smokeDeployUrl } from './smoke.mjs'

const tempDirs = []

async function makeTempProject() {
  const root = await mkdtemp(join(tmpdir(), 'lumaforge-deploy-'))
  tempDirs.push(root)
  return root
}

async function writeFixtureDist(root, { includeSeoArtifacts = true } = {}) {
  const config = createDeployConfig(root)
  await mkdir(join(config.outputDir, 'native'), { recursive: true })
  await writeFile(
    join(config.outputDir, 'index.html'),
    '<main>LumaForge</main>',
  )
  await writeFile(join(config.outputDir, 'app.js'), 'console.log("app")')

  if (includeSeoArtifacts) {
    await mkdir(join(config.outputDir, 'raw'), { recursive: true })
    await writeFile(
      join(config.outputDir, 'raw/index.html'),
      '<main>LumaForge RAW</main>',
    )
    await writeFile(join(config.outputDir, 'og-image.png'), 'og image')
    await writeFile(
      join(config.outputDir, 'robots.txt'),
      'User-agent: *\nAllow: /\n',
    )
    await writeFile(
      join(config.outputDir, 'sitemap.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><urlset />',
    )
  }

  for (const asset of config.nativeAssets) {
    await mkdir(dirname(join(config.outputDir, asset)), { recursive: true })
    await writeFile(join(config.outputDir, asset), asset)
  }

  return config
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  )
})

describe('deploy configuration', () => {
  it('requires both RAW runtime memory-profile artifact sets', () => {
    expect(createDeployConfig().nativeAssets).toEqual(
      expect.arrayContaining([
        'native/desktop/luma_raw.js',
        'native/desktop/luma_raw.wasm',
        'native/low-memory/luma_raw.js',
        'native/low-memory/luma_raw.wasm',
        'native/luma_jpeg.js',
        'native/luma_jpeg.wasm',
      ]),
    )
    expect(createDeployConfig().nativeAssets).not.toContain(
      'native/luma_raw.wasm',
    )
  })

  it('requires a single supported deploy target from DEPLOY_TARGET', () => {
    expect(
      resolveDeployOptions({
        DEPLOY_TARGET: 'cloudflare',
        DEPLOY_ENV: 'production',
      }),
    ).toEqual({ target: 'cloudflare', deployEnv: 'production' })

    expect(
      resolveDeployOptions({
        DEPLOY_TARGET: 'vercel',
        DEPLOY_ENV: 'preview',
      }),
    ).toEqual({ target: 'vercel', deployEnv: 'preview' })

    expect(() => resolveDeployOptions({ DEPLOY_TARGET: 'netlify' })).toThrow(
      'DEPLOY_TARGET must be one of: cloudflare, vercel',
    )
  })

  it('defaults DEPLOY_ENV to preview', () => {
    expect(resolveDeployOptions({ DEPLOY_TARGET: 'vercel' })).toEqual({
      target: 'vercel',
      deployEnv: 'preview',
    })
  })

  it('infers deploy environment from GitHub event context when DEPLOY_ENV is omitted', () => {
    expect(
      resolveDeployOptions({
        DEPLOY_TARGET: 'cloudflare',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_HEAD_REF: 'feat/deploy-preview',
        GITHUB_REF_NAME: '12/merge',
      }),
    ).toEqual({ target: 'cloudflare', deployEnv: 'preview' })

    expect(
      resolveDeployOptions({
        DEPLOY_TARGET: 'vercel',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'main',
      }),
    ).toEqual({ target: 'vercel', deployEnv: 'production' })

    expect(
      resolveDeployOptions({
        DEPLOY_TARGET: 'vercel',
        DEPLOY_ENV: 'preview',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'main',
      }),
    ).toEqual({ target: 'vercel', deployEnv: 'preview' })
  })
})

describe('deploy artifact checks', () => {
  it('fails when SEO artifacts are missing from the deploy output', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root, { includeSeoArtifacts: false })

    await expect(checkDeployArtifact(config)).rejects.toThrow(
      'Missing deploy artifact: raw/index.html',
    )
  })

  it('fails when a required native runtime asset is missing', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root)
    await rm(join(config.outputDir, 'native/desktop/luma_raw.wasm'))

    await expect(checkDeployArtifact(config)).rejects.toThrow(
      'Missing deploy artifact: native/desktop/luma_raw.wasm',
    )
  })

  it('fails when the social preview image is missing', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root)
    await rm(join(config.outputDir, 'og-image.png'))

    await expect(checkDeployArtifact(config)).rejects.toThrow(
      'Missing deploy artifact: og-image.png',
    )
  })

  it('accepts a complete static artifact with native runtime files', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root)

    await expect(checkDeployArtifact(config)).resolves.toBeUndefined()
  })
})

describe('platform preparation', () => {
  it('writes Cloudflare Pages headers and SPA redirects into dist', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root)

    await prepareCloudflareDeploy(config)

    await expect(readFile(join(config.outputDir, '_headers'), 'utf8')).resolves
      .toMatchInlineSnapshot(`
        "/*
          Cross-Origin-Opener-Policy: same-origin
          Cross-Origin-Embedder-Policy: require-corp

        /*.wasm
          Content-Type: application/wasm
        "
      `)
    await expect(
      readFile(join(config.outputDir, '_redirects'), 'utf8'),
    ).resolves.toBe('/* /index.html 200\n')
  })

  it('creates a Vercel Build Output API directory from dist', async () => {
    const root = await makeTempProject()
    const config = await writeFixtureDist(root)
    await writeFile(join(config.outputDir, '_headers'), 'cloudflare-only')
    await writeFile(join(config.outputDir, '_redirects'), 'cloudflare-only')

    await prepareVercelDeploy(config)

    await expect(
      readFile(join(config.vercel.outputStaticDir, 'index.html'), 'utf8'),
    ).resolves.toBe('<main>LumaForge</main>')
    await expect(
      readFile(
        join(config.vercel.outputStaticDir, 'native/luma_jpeg.wasm'),
        'utf8',
      ),
    ).resolves.toBe('native/luma_jpeg.wasm')
    await expect(
      readFile(join(config.vercel.outputStaticDir, '_headers'), 'utf8'),
    ).rejects.toThrow()
    await expect(
      readFile(join(config.vercel.outputStaticDir, '_redirects'), 'utf8'),
    ).rejects.toThrow()

    const vercelConfig = JSON.parse(
      await readFile(join(config.vercel.outputDir, 'config.json'), 'utf8'),
    )
    expect(vercelConfig).toEqual({
      version: 3,
      routes: [
        {
          src: '/(.*)',
          headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
          continue: true,
        },
        {
          src: '/(.*)\\.wasm',
          headers: {
            'Content-Type': 'application/wasm',
          },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    })
  })
})

describe('publish command selection', () => {
  it('builds a Cloudflare direct-upload command', () => {
    const config = createDeployConfig('/repo')
    expect(
      createPublishCommand(config, {
        target: 'cloudflare',
        deployEnv: 'production',
        env: {
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_API_TOKEN: 'token',
          CLOUDFLARE_PAGES_PROJECT: 'lumaforge',
          GITHUB_REF_NAME: 'main',
        },
      }),
    ).toEqual({
      command: 'pnpm',
      args: [
        'exec',
        'wrangler',
        'pages',
        'deploy',
        '/repo/dist',
        '--project-name',
        'lumaforge',
        '--branch',
        'main',
      ],
    })
  })

  it('uses the pull-request head branch for Cloudflare preview deploys', () => {
    const config = createDeployConfig('/repo')
    expect(
      createPublishCommand(config, {
        target: 'cloudflare',
        deployEnv: 'preview',
        env: {
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_API_TOKEN: 'token',
          CLOUDFLARE_PAGES_PROJECT: 'lumaforge',
          GITHUB_HEAD_REF: 'feat/prod-preview',
          GITHUB_REF_NAME: '17/merge',
        },
      }).args,
    ).toEqual([
      'exec',
      'wrangler',
      'pages',
      'deploy',
      '/repo/dist',
      '--project-name',
      'lumaforge',
      '--branch',
      'feat/prod-preview',
    ])
  })

  it('pins Cloudflare production deploys to the configured production branch', () => {
    const config = createDeployConfig('/repo')
    expect(
      createPublishCommand(config, {
        target: 'cloudflare',
        deployEnv: 'production',
        env: {
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_API_TOKEN: 'token',
          CLOUDFLARE_PAGES_PROJECT: 'lumaforge',
          DEPLOY_PRODUCTION_BRANCHES: 'main,master',
          GITHUB_REF_NAME: 'feat/manual-production',
        },
      }).args,
    ).toEqual([
      'exec',
      'wrangler',
      'pages',
      'deploy',
      '/repo/dist',
      '--project-name',
      'lumaforge',
      '--branch',
      'main',
    ])
  })

  it('builds a Vercel prebuilt command and only adds --prod for production', () => {
    const config = createDeployConfig('/repo')
    expect(
      createPublishCommand(config, {
        target: 'vercel',
        deployEnv: 'production',
        env: {
          VERCEL_TOKEN: 'token',
          VERCEL_ORG_ID: 'org',
          VERCEL_PROJECT_ID: 'project',
        },
      }),
    ).toEqual({
      command: 'pnpm',
      args: [
        'exec',
        'vercel',
        'deploy',
        '--prebuilt',
        '--archive=tgz',
        '--prod',
      ],
    })

    expect(
      createPublishCommand(config, {
        target: 'vercel',
        deployEnv: 'preview',
        env: {
          VERCEL_TOKEN: 'token',
          VERCEL_ORG_ID: 'org',
          VERCEL_PROJECT_ID: 'project',
        },
      }).args,
    ).not.toContain('--prod')
  })

  it('resolves deploy URLs for platform-specific post-deploy checks', () => {
    expect(
      resolveDeploymentUrl({
        target: 'cloudflare',
        deployEnv: 'preview',
        env: {
          CLOUDFLARE_PAGES_PROJECT: 'lumaforge',
          GITHUB_HEAD_REF: 'feat/prod-preview',
        },
        output: '',
      }),
    ).toBe('https://feat-prod-preview.luma.ichr.me')

    expect(
      resolveDeploymentUrl({
        target: 'cloudflare',
        deployEnv: 'production',
        env: {
          CLOUDFLARE_PAGES_PROJECT: 'lumaforge',
          GITHUB_REF_NAME: 'main',
        },
        output: '',
      }),
    ).toBe('https://luma.ichr.me')

    expect(
      resolveDeploymentUrl({
        target: 'vercel',
        deployEnv: 'preview',
        env: {},
        output: 'Queued\nhttps://lumaforge-git-feature.vercel.app\n',
      }),
    ).toBe('https://lumaforge-git-feature.vercel.app')

    expect(
      resolveDeploymentUrl({
        target: 'vercel',
        deployEnv: 'preview',
        env: {},
        output:
          'Inspect: https://vercel.com/chralpha/lumaforge/abc123\nPreview: https://lumaforge-git-feature-chralpha.vercel.app\n',
      }),
    ).toBe('https://lumaforge-git-feature-chralpha.vercel.app')

    expect(
      resolveDeploymentUrl({
        target: 'cloudflare',
        deployEnv: 'preview',
        env: { CLOUDFLARE_PAGES_PROJECT: 'lumaforge' },
        output:
          'View deployment: https://dash.cloudflare.com/account/pages/view/lumaforge\nPreview URL: https://feat-prod-preview.luma.ichr.me\n',
      }),
    ).toBe('https://feat-prod-preview.luma.ichr.me')
  })
})

describe('deployed artifact smoke checks', () => {
  it('checks production headers, SPA fallback, and native wasm MIME types', async () => {
    const fetch = vi.fn(async (url) => {
      const headers = new Headers()
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      if (String(url).endsWith('.wasm')) {
        headers.set('Content-Type', 'application/wasm')
      }

      return { ok: true, status: 200, headers }
    })

    await expect(
      smokeDeployUrl('https://preview.example.com', fetch),
    ).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledWith('https://preview.example.com/', {
      method: 'HEAD',
      redirect: 'follow',
    })
    expect(fetch).toHaveBeenCalledWith('https://preview.example.com/raw', {
      method: 'HEAD',
      redirect: 'follow',
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://preview.example.com/native/desktop/luma_raw.wasm',
      { method: 'HEAD', redirect: 'follow' },
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://preview.example.com/native/low-memory/luma_raw.wasm',
      { method: 'HEAD', redirect: 'follow' },
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://preview.example.com/native/luma_jpeg.wasm',
      { method: 'HEAD', redirect: 'follow' },
    )
  })

  it('sends the Vercel automation bypass header when configured', async () => {
    const fetch = vi.fn(async (url) => {
      const headers = new Headers()
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      if (String(url).endsWith('.wasm')) {
        headers.set('Content-Type', 'application/wasm')
      }

      return { ok: true, status: 200, headers }
    })

    await expect(
      smokeDeployUrl('https://lumaforge-preview.vercel.app', fetch, {
        DEPLOY_TARGET: 'vercel',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      }),
    ).resolves.toBeUndefined()

    for (const call of fetch.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: {
          'x-vercel-protection-bypass': 'bypass-secret',
        },
      })
    }
  })

  it('explains protected Vercel deployment failures', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
    }))

    await expect(
      smokeDeployUrl('https://lumaforge-preview.vercel.app', fetch, {
        DEPLOY_TARGET: 'vercel',
      }),
    ).rejects.toThrow(
      'Vercel Deployment Protection returned HTTP 401. Configure VERCEL_AUTOMATION_BYPASS_SECRET',
    )
  })
})
