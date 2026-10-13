export default {
  siteUrl: 'https://luma.ichr.me',
  outputDir: 'dist',
  crossOriginIsolationHeaders: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
  wasmHeaders: {
    'Content-Type': 'application/wasm',
  },
  cloudflare: {
    projectNameEnv: 'CLOUDFLARE_PAGES_PROJECT',
  },
  vercel: {
    outputDir: '.vercel/output',
    orgIdEnv: 'VERCEL_ORG_ID',
    projectIdEnv: 'VERCEL_PROJECT_ID',
  },
}
