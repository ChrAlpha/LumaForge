import process from 'node:process'

const REQUIRED_ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
}

const WASM_ASSETS = [
  'native/desktop/luma_raw.wasm',
  'native/low-memory/luma_raw.wasm',
  'native/luma_jpeg.wasm',
]

function normalizeDeployUrl(url) {
  const value = url?.trim()
  if (!value) throw new Error('DEPLOY_URL is required for deploy smoke checks.')
  return value.replace(/\/+$/g, '')
}

function joinDeployUrl(baseUrl, path) {
  return `${baseUrl}/${path.replace(/^\/+/g, '')}`
}

function isVercelDeployment(url, env) {
  if (env.DEPLOY_TARGET === 'vercel') return true

  try {
    return new URL(url).hostname.endsWith('.vercel.app')
  } catch {
    return false
  }
}

function createRequestOptions(url, env) {
  const options = {
    method: 'HEAD',
    redirect: 'follow',
  }
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
  if (bypassSecret && isVercelDeployment(url, env)) {
    options.headers = {
      'x-vercel-protection-bypass': bypassSecret,
    }
  }

  return options
}

async function head(fetchImpl, url, env) {
  const response = await fetchImpl(url, createRequestOptions(url, env))
  if (!response.ok) {
    if (response.status === 401 && isVercelDeployment(url, env)) {
      throw new Error(
        'Vercel Deployment Protection returned HTTP 401. Configure VERCEL_AUTOMATION_BYPASS_SECRET as a GitHub Actions secret and Vercel Protection Bypass for Automation secret.',
      )
    }

    throw new Error(
      `Deploy smoke check failed for ${url}: HTTP ${response.status}`,
    )
  }
  return response.headers
}

async function assertIsolationHeaders(fetchImpl, url, label, env) {
  const headers = await head(fetchImpl, url, env)

  for (const [header, expected] of Object.entries(REQUIRED_ISOLATION_HEADERS)) {
    const actual = headers.get(header)
    if (actual !== expected) {
      throw new Error(
        `${label} is missing ${header}: expected ${expected}, received ${actual ?? 'null'}.`,
      )
    }
  }
}

async function assertWasmContentType(fetchImpl, url, env) {
  const headers = await head(fetchImpl, url, env)
  const contentType = headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/wasm')) {
    throw new Error(
      `${url} must be served as application/wasm, received ${contentType || 'null'}.`,
    )
  }
}

export async function smokeDeployUrl(
  url,
  fetchImpl = globalThis.fetch,
  env = process.env,
) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'A Fetch implementation is required for deploy smoke checks.',
    )
  }

  const baseUrl = normalizeDeployUrl(url)
  await assertIsolationHeaders(
    fetchImpl,
    joinDeployUrl(baseUrl, '/'),
    'Root',
    env,
  )
  await assertIsolationHeaders(
    fetchImpl,
    joinDeployUrl(baseUrl, '/raw'),
    'Raw route',
    env,
  )

  for (const asset of WASM_ASSETS) {
    await assertWasmContentType(fetchImpl, joinDeployUrl(baseUrl, asset), env)
  }
}

if (import.meta.main) {
  await smokeDeployUrl(process.env.DEPLOY_URL)
  console.log('Deploy smoke checks passed.')
}
