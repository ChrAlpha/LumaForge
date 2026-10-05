// Before/after QA consistency harness for the /raw route.
//
// `capture` drives a running `vite preview` build of LumaForge through the
// real UI (file inputs, sliders, cards, dialogs, export buttons), and saves
// per-scenario evidence: element screenshots of the preview, stage and
// histogram, a JSON record of the observable DOM state, renderer evidence,
// console/page errors, and any exported JPEGs with their sha256.
//
// `compare` pixel-diffs two capture directories (for example WebGL `main`
// against the WebGPU branch, or run-to-run on one build), diffs the state
// records, compares export hashes, and prints a summary table.
//
// Scope: this observes what a user can observe. It does not read app state
// through private hooks, so a scenario that the UI cannot express is listed
// as not covered rather than forced through internals.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { deflateSync, inflateSync } from 'node:zlib'

import { chromium } from '@playwright/test'

const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-vulkan-surface',
  '--use-angle=swiftshader',
]

const VIEWPORTS = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  },
}

const DEFAULTS = {
  raw: '/workspaces/LumaForge/nxc-data/camera-coverage-20260920/zf-6885.NEF',
  raw2: '/workspaces/LumaForge/nxc-data/camera-coverage-20260920/z5ii-7745.NEF',
  luts: [
    '/workspaces/LumaForge/test-images/phase1-illegal-29.cube',
    '/workspaces/LumaForge/test-images/phase1-legal-33.cube',
  ],
  lutCache: '/tmp/lf-webgpu/qa/lut-cache',
}

// Hidden while screenshotting pixels so that UI chrome which animates or
// floats over the photo (split knob, labels, toasts, mobile dock) cannot leak
// into a colour comparison. `visibility` keeps layout, so the preview is not
// resized (and re-rendered) by the screenshot itself.
const PIXEL_STYLE = `
  .raw-lab-compare-handle, .raw-lab-compare-label,
  [data-sonner-toaster], [data-mobile-dock], [data-mobile-topbar],
  [data-cpu-preview-banner] { visibility: hidden !important; }
  *, *::before, *::after { caret-color: transparent !important; }
`
const CHROME_STYLE = `
  [data-sonner-toaster] { visibility: hidden !important; }
  *, *::before, *::after { caret-color: transparent !important; }
`

const SCREENSHOT_TIMEOUT = 300_000

const usage = `Usage:
  node scripts/webgpu/qa/raw-consistency.mjs capture --url <base url> --out <dir>
       [--raw <file>] [--raw2 <file>] [--lut <cube> ...] [--label baseline|candidate]
       [--viewport desktop|mobile] [--force-cpu]
       [--only <regex>] [--skip <regex>] [--hq-timeout <s>] [--lut-cache <dir>]
       [--quiet-ms <ms>] [--headed]
  node scripts/webgpu/qa/raw-consistency.mjs compare --a <dir> --b <dir> --out <report.json>
       [--diff-images <dir>] [--no-jpeg-pixels]
  node scripts/webgpu/qa/raw-consistency.mjs list [--viewport desktop|mobile] [--force-cpu]

The capture target is a running server, for example:
  LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm exec vite preview --host 127.0.0.1 --port 4291 --strictPort
Use 127.0.0.1 or localhost: the app only honours ?forcePreview= on local hosts.`

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// Strength presets in percent: the detents on the Strength slider row.
const STRENGTH_PERCENT = { Off: 0, Light: 40, Standard: 70, Strong: 100 }

function approxEqual(a, b, step) {
  return Math.abs(Number(a) - Number(b)) <= Math.max(1e-6, step / 2)
}

function logLine(message) {
  const time = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[${time}] ${message}\n`)
}

// ---------------------------------------------------------------------------
// PNG decode/encode (pure Node, 8-bit non-interlaced, which is what
// Chromium screenshots and canvas.toDataURL produce)
// ---------------------------------------------------------------------------

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature)
    throw new Error('NOT_A_PNG')
  let offset = 8
  let header
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!header) throw new Error('PNG_MISSING_IHDR')
  const { width, height, bitDepth, colorType, interlace } = header
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (bitDepth !== 8 || !channels || interlace !== 0)
    throw new Error(
      `PNG_UNSUPPORTED: depth=${bitDepth} type=${colorType} interlace=${interlace}`,
    )
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[x] = value & 0xFF
    }
    previous = out
  }
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const source = index * channels
    const target = index * 4
    if (channels >= 3) {
      rgba[target] = pixels[source]
      rgba[target + 1] = pixels[source + 1]
      rgba[target + 2] = pixels[source + 2]
      rgba[target + 3] = channels === 4 ? pixels[source + 3] : 255
    } else {
      rgba[target] = rgba[target + 1] = rgba[target + 2] = pixels[source]
      rgba[target + 3] = channels === 2 ? pixels[source + 1] : 255
    }
  }
  return { width, height, rgba }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePngRgb(width, height, rgb) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// Per-pixel error is the largest channel difference on R, G and B. Alpha is
// ignored: every screenshot here is opaque.
function diffRgba(a, b, width, height, wantImage) {
  let max = 0
  let sum = 0
  let squared = 0
  let over1 = 0
  let over2 = 0
  let changed = 0
  const histogram = Array.from({length: 9}).fill(0)
  const image = wantImage ? new Uint8Array(width * height * 3) : null
  for (let index = 0; index < width * height; index++) {
    const o = index * 4
    let pixelMax = 0
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(a[o + channel] - b[o + channel])
      sum += error
      squared += error * error
      if (error > pixelMax) pixelMax = error
    }
    if (pixelMax > max) max = pixelMax
    if (pixelMax > 0) changed++
    if (pixelMax > 1) over1++
    if (pixelMax > 2) over2++
    histogram[Math.min(8, pixelMax)]++
    if (image) {
      const amplified = Math.min(255, pixelMax * 32)
      image[index * 3] = amplified
      image[index * 3 + 1] = pixelMax > 2 ? 0 : amplified
      image[index * 3 + 2] = pixelMax > 0 && pixelMax <= 2 ? 160 : 0
    }
  }
  const pixels = width * height
  const samples = pixels * 3
  return {
    max,
    mean: sum / samples,
    rms: Math.sqrt(squared / samples),
    pctChanged: (100 * changed) / pixels,
    pctOver1: (100 * over1) / pixels,
    pctOver2: (100 * over2) / pixels,
    pixelMaxHistogram: Object.fromEntries(
      histogram.map((count, error) => [error === 8 ? '8+' : String(error), count]),
    ),
    image,
  }
}

// ---------------------------------------------------------------------------
// Page instrumentation (installed before any app script runs)
// ---------------------------------------------------------------------------

function installInstrumentation() {
  const qa = {
    gl: { contexts: 0, draw: 0, finish: 0, flush: 0, readPixels: 0 },
    gpu: {
      requestAdapter: 0,
      requestDevice: 0,
      configure: 0,
      submit: 0,
      adapters: [],
    },
    ctx2d: { putImageData: 0, drawImage: 0 },
    contextRequests: [],
    toasts: [],
  }
  window.__lfQa = qa
  const canvasTypes = new WeakMap()
  qa.contextTypes = (canvas) => [...(canvasTypes.get(canvas) ?? [])]

  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest)
    if (context) {
      let types = canvasTypes.get(this)
      if (!types) {
        types = new Set()
        canvasTypes.set(this, types)
        qa.contextRequests.push({
          type,
          at: Math.round(performance.now()),
          className: String(this.className ?? ''),
        })
        if (type === 'webgl' || type === 'webgl2') qa.gl.contexts++
      }
      types.add(type)
    }
    return context
  }

  const wrap = (prototype, method, bump) => {
    if (!prototype || typeof prototype[method] !== 'function') return
    const original = prototype[method]
    prototype[method] = function (...args) {
      bump()
      return original.apply(this, args)
    }
  }
  for (const prototype of [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ]) {
    wrap(prototype, 'drawArrays', () => qa.gl.draw++)
    wrap(prototype, 'drawElements', () => qa.gl.draw++)
    wrap(prototype, 'finish', () => qa.gl.finish++)
    wrap(prototype, 'flush', () => qa.gl.flush++)
    wrap(prototype, 'readPixels', () => qa.gl.readPixels++)
  }
  wrap(
    globalThis.CanvasRenderingContext2D?.prototype,
    'putImageData',
    () => qa.ctx2d.putImageData++,
  )
  wrap(
    globalThis.CanvasRenderingContext2D?.prototype,
    'drawImage',
    () => qa.ctx2d.drawImage++,
  )
  wrap(globalThis.GPUQueue?.prototype, 'submit', () => qa.gpu.submit++)
  wrap(
    globalThis.GPUCanvasContext?.prototype,
    'configure',
    () => qa.gpu.configure++,
  )
  wrap(
    globalThis.GPUAdapter?.prototype,
    'requestDevice',
    () => qa.gpu.requestDevice++,
  )
  const gpuPrototype = globalThis.GPU?.prototype
  if (gpuPrototype?.requestAdapter) {
    const requestAdapter = gpuPrototype.requestAdapter
    gpuPrototype.requestAdapter = async function (...args) {
      qa.gpu.requestAdapter++
      const adapter = await requestAdapter.apply(this, args)
      if (adapter && qa.gpu.adapters.length < 4) {
        const info = adapter.info ?? {}
        qa.gpu.adapters.push({
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
          isFallbackAdapter: adapter.isFallbackAdapter ?? null,
        })
      }
      return adapter
    }
  }

  // Toasts are transient; keep every one that was ever shown.
  const seen = new WeakMap()
  const scan = () => {
    for (const element of document.querySelectorAll('[data-sonner-toast]')) {
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
      const text = element.innerText.replace(/\s+/g, ' ').trim()
      const entry = seen.get(element)
      if (!entry) {
        const next = { at: Math.round(performance.now()), text }
        seen.set(element, next)
        qa.toasts.push(next)
      } else if (text && entry.text !== text) {
        entry.text = text
      }
    }
  }
  const start = () =>
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}

// Everything the user can see that describes state. Runs in the page.
function collectDomState() {
  const q = (selector, root = document) => root.querySelector(selector)
  const qa = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ]
  const text = (element) =>
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
    element ? element.innerText.replace(/\s+/g, ' ').trim() : null
  const isVisible = (element) =>
    Boolean(element) &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  const nameOf = (element) => {
    const label = element.getAttribute('aria-label')
    if (label) return label
    const ids = element.getAttribute('aria-labelledby')
    if (!ids) return text(element)
    return ids
      .split(/\s+/)
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
      .map((id) => document.getElementById(id)?.innerText.trim() ?? '')
      .join(' ')
      .trim()
  }
  const qaState = window.__lfQa

  const canvases = qa('canvas').map((canvas) => {
    const types = qaState?.contextTypes(canvas) ?? []
    const rect = canvas.getBoundingClientRect()
    const entry = {
      className: String(canvas.className ?? ''),
      ariaLabel: canvas.getAttribute('aria-label'),
      inTransformOverlay: Boolean(canvas.closest('[data-raw-transform-preview]')),
      width: canvas.width,
      height: canvas.height,
      css: [Math.round(rect.width), Math.round(rect.height)],
      visible: isVisible(canvas),
      dataset: { ...canvas.dataset },
      contextTypes: types,
    }
    const glType = types.find((type) => type === 'webgl2' || type === 'webgl')
    if (glType) {
      const gl = canvas.getContext(glType)
      if (gl) {
        const debug = gl.getExtension('WEBGL_debug_renderer_info')
        entry.webgl = {
          lost: gl.isContextLost(),
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          version: gl.getParameter(gl.VERSION),
          renderer: debug
            ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        }
      }
    }
    if (types.includes('webgpu')) {
      const context = canvas.getContext('webgpu')
      let configuration = null
      try {
        configuration = context?.getConfiguration?.() ?? null
      } catch {
        configuration = null
      }
      entry.webgpu = {
        configured: Boolean(configuration),
        format: configuration?.format ?? null,
        alphaMode: configuration?.alphaMode ?? null,
      }
    }
    return entry
  })

  const sliders = {}
  for (const element of qa('[role="slider"]')) {
    if (!isVisible(element)) continue
    const row = element.closest(
      '[data-tone-field],[data-color-field],[data-hsl-band],[data-hsl-band-row],[data-raw-transform-group],[data-adjust-list-section],[data-transform-list-section],[data-raw-desktop-strength],[data-mobile-look-strength]',
    )
    const name = nameOf(element)
    let key
    if (element.classList.contains('raw-lab-compare-handle'))
      key = 'compare.split'
    else if (row?.dataset.rawDesktopStrength || row?.hasAttribute('data-mobile-look-strength'))
      key = 'look.strength'
    else if (row?.dataset.toneField) key = `tone.${row.dataset.toneField}`
    else if (row?.dataset.colorField) key = `color.${row.dataset.colorField}`
    else if (row?.dataset.hslBand)
      key = `hsl.${row.dataset.hslBand}.${row.dataset.hslAxis}`
    else if (row?.dataset.hslBandRow) key = `hsl.${row.dataset.hslBandRow}.${name}`
    else if (row?.dataset.rawTransformGroup) key = `transform.${name}`
    else if (row?.dataset.transformListSection) key = `transform.${name}`
    else if (row?.dataset.adjustListSection)
      key = `${row.dataset.adjustListSection}.${name}`
    else key = `other.${name}`
    sliders[key] = element.getAttribute('aria-valuenow')
  }

  const pressed = (root) =>
    root
      ? qa('[aria-pressed="true"]', root).map((element) => text(element))
      : null
  const track = q('[data-raw-compare-track="image"]')
  const trackStyle = track ? getComputedStyle(track) : null
  const transformOverlay = q('[data-raw-transform-preview]')
  const transformTool = q('[data-raw-transform-tool]')
  const exportBlock =
    q('[data-raw-export-block]') ??
    q('[data-mobile-export-panel]')
  const histogramCard = q('[data-tool-card="histogram"]')
  const histogramImage = q('[role="img"][aria-label*="histogram" i]')
  const cropBox = transformTool
    ? q('[role="checkbox"]', transformTool) ?? q('input[type="checkbox"]', transformTool)
    : null
  const buttonState = (pattern) => {
    const button = qa('button').find(
      (element) => isVisible(element) && pattern.test(text(element) ?? ''),
    )
    return button ? (button.disabled ? 'disabled' : 'enabled') : 'absent'
  }

  return {
    // eslint-disable-next-line no-restricted-globals -- runs inside the page under test, not the app
    url: `${location.pathname}${location.search}`,
    rawLabState: q('.raw-lab')?.dataset.rawLabState ?? null,
    heading: text(q('.raw-lab h1, .raw-lab h2')),
    progressOverlay: q('[data-progress-overlay]')?.dataset.progressOverlay ?? null,
    previewState: q('[data-preview-state]')?.dataset.previewState ?? null,
    previewTrackReady:
      q('[data-preview-track-ready]')?.dataset.previewTrackReady ?? null,
    compareMode: q('[data-compare-mode]')?.dataset.compareMode ?? null,
    compareFallbackReason:
      q('[data-compare-mode]')?.dataset.compareFallbackReason ?? null,
    originalReferenceSource:
      q('[data-original-reference-source]')?.dataset.originalReferenceSource ??
      null,
    viewport: trackStyle
      ? {
          zoom: trackStyle.getPropertyValue('--raw-preview-zoom').trim(),
          panX: trackStyle.getPropertyValue('--raw-preview-pan-x').trim(),
          panY: trackStyle.getPropertyValue('--raw-preview-pan-y').trim(),
        }
      : null,
    cpuBanner: isVisible(q('[data-cpu-preview-banner]'))
      ? text(q('[data-cpu-preview-banner]'))
      : null,
    cpuSpinner: qa('[data-testid="cpu-preview-spinner"]').length,
    cpuUnavailable: qa('[data-testid="cpu-preview-unavailable"]').length,
    renderBackends: qa('[data-render-backend]').map(
      (element) => `${element.className}:${element.dataset.renderBackend}`,
    ),
    canvases,
    sliders,
    // Strength is a slider row on both surfaces: "62%", or "Off" at 0.
    strength:
      q(
        '[data-raw-desktop-strength] [role="slider"], [data-mobile-look-strength] [role="slider"]',
      )?.getAttribute('aria-valuetext') ?? null,
    hslAxis: text(q('[data-hsl-axis-tabs] [aria-selected="true"]')),
    lookText: text(q('[data-tool-card="look"]')),
    lutDropzone: text(q('[data-raw-lut="dropzone"]')),
    lutContractStatus: qa('[data-raw-lut="contract-status"]').map(text),
    histogram: {
      present: Boolean(histogramImage),
      visible: isVisible(histogramImage),
      ariaLabel: histogramImage?.getAttribute('aria-label') ?? null,
      cardText: text(histogramCard),
    },
    transform: {
      toolVisible: isVisible(transformTool),
      overlay: Boolean(transformOverlay),
      overlayBusy: transformOverlay?.getAttribute('aria-busy') ?? null,
      matrix: transformOverlay?.dataset.transformMatrix ?? null,
      pressed: pressed(transformTool),
      message: text(q('[data-raw-transform-message]')),
      crop:
        cropBox?.getAttribute('aria-checked') ??
        cropBox?.getAttribute('data-state') ??
        null,
    },
    export: {
      text: text(exportBlock),
      ready: exportBlock?.dataset?.rawExportReady ?? null,
      fullRes: buttonState(/^Export full-resolution JPEG$/),
      hqPreview: buttonState(/^Export HQ preview JPEG$/),
      download: buttonState(/^Download$/),
      restorePreview: buttonState(/^Restore preview$/),
    },
    fileFacts: text(q('[data-tool-card="fileFacts"]')),
    mobile: {
      dockSelected: text(
        q('[role="tablist"][aria-label="Lab modes"] [aria-selected="true"]'),
      ),
      dockPanel: isVisible(q('[data-mobile-dock-panel]')),
      exportPanel: isVisible(q('[data-mobile-export-panel]')),
      exportAction: q('[data-mobile-export-action]')?.dataset.state ?? null,
      compareLens: q('[data-mobile-compare-lens]')?.dataset.state ?? null,
      compareLensMode:
        q('[data-mobile-compare-lens]')?.dataset.lensMode ?? null,
      look: {
        view: q('[data-mobile-look-deck]')?.dataset.mobileLookDeck ?? null,
        applied:
          q('[data-mobile-lut-tile][aria-pressed="true"]')?.dataset.lutTitle ??
          null,
        footer: text(q('[data-mobile-look-footer]')),
        contractStep:
          q('[data-mobile-look-contract]')?.dataset.lutContractStep ?? null,
      },
      peek: Boolean(q('[data-peek]')),
    },
    alerts: qa('[role="alert"], [role="alertdialog"]')
      .filter(isVisible)
      .map(text)
      .filter(Boolean),
    dialogs: qa('[role="dialog"]').filter(isVisible).map(nameOf),
  }
}

// ---------------------------------------------------------------------------
// Harness: the run context shared by drivers and scenarios
// ---------------------------------------------------------------------------

class Harness {
  constructor({ page, context, options, outDir, surface, preview }) {
    this.page = page
    this.context = context
    this.options = options
    this.outDir = outDir
    this.surface = surface
    this.preview = preview
    this.consoleErrors = []
    this.consoleWarnings = 0
    this.pageErrors = []
    this.actions = []
    this.renderSamples = []
    // What the scenarios changed, so a reset does not depend on which
    // controls happen to be mounted (the mobile dock shows one panel).
    this.dirty = { tone: false, color: false, hsl: false, transform: false }
    this.lut = null
    // Strength in percent; a look starts at Standard.
    this.strength = STRENGTH_PERCENT.Standard
    page.on('console', (message) => {
      if (message.type() === 'error')
        this.consoleErrors.push({ at: Date.now(), text: message.text() })
      else if (message.type() === 'warning') this.consoleWarnings++
    })
    page.on('pageerror', (error) =>
      this.pageErrors.push({ at: Date.now(), text: error.message }),
    )
  }

  get desktop() {
    return this.surface === 'desktop'
  }

  get cpu() {
    return this.preview === 'cpu'
  }

  record(action) {
    this.actions.push(action)
    return action
  }

  async counters() {
    return this.page.evaluate(() => {
      const qa = window.__lfQa
      return qa
        ? {
            gl: { ...qa.gl },
            gpu: { ...qa.gpu, adapters: undefined },
            ctx2d: { ...qa.ctx2d },
          }
        : null
    })
  }

  async dom() {
    return this.page.evaluate(collectDomState)
  }

  async toasts() {
    return this.page.evaluate(() => window.__lfQa?.toasts ?? [])
  }

  // The element whose pixels are the processed preview.
  async previewLocator() {
    const gpu = this.page.locator('.raw-preview-canvas')
    if (await gpu.count()) return gpu.first()
    const cpu = this.page.locator('.raw-lab-stage canvas')
    if (await cpu.count()) return cpu.first()
    return this.page.locator('.raw-lab-stage').first()
  }

  async busy() {
    return this.page.evaluate(() => {
      const reasons = []
      if (document.querySelector('.raw-progress-overlay'))
        reasons.push('progress-overlay')
      if (document.querySelector('[data-testid="cpu-preview-spinner"]'))
        reasons.push('cpu-spinner')
      const overlay = document.querySelector('[data-raw-transform-preview]')
      if (overlay?.getAttribute('aria-busy') === 'true')
        reasons.push('transform-busy')
      const histogram = document.querySelector('[data-tool-card="histogram"]')
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
      if (histogram && /\b(?:Computing|Stale)\b/.test(histogram.innerText))
        reasons.push('histogram-pending')
      if (document.querySelector('[data-raw-lut-entry-loading="true"]'))
        reasons.push('lut-entry-loading')
      return reasons
    })
  }

  // Wait until the preview stops changing: no blocking UI, no new GPU or 2D
  // canvas work, and two consecutive compositor screenshots identical for
  // `quietMs`. Screenshots block while the GPU process is busy, so a slow
  // SwiftShader frame is waited out rather than raced.
  async settle({
    changeFrom = null,
    timeoutMs = 600_000,
    label = '',
    on = 'preview',
  } = {}) {
    const started = Date.now()
    const deadline = started + timeoutMs
    const quietMs = this.options.quietMs
    let changed = changeFrom === null ? null : false
    let previousHash = null
    let previousCounters = null
    let stableSince = Date.now()
    let iterations = 0
    let lastBusy = []
    while (Date.now() < deadline) {
      iterations++
      const target =
        on === 'stage'
          ? this.page.locator('[data-raw-preview-frame], .raw-lab-stage').first()
          : await this.previewLocator()
      let shot
      try {
        shot = await target.screenshot({
          animations: 'disabled',
          style: PIXEL_STYLE,
          timeout: SCREENSHOT_TIMEOUT,
        })
      } catch (error) {
        lastBusy = [`screenshot: ${error.message.split('\n')[0]}`]
        await sleep(500)
        continue
      }
      const hash = sha1(shot)
      const counters = JSON.stringify(await this.counters())
      // A histogram that never leaves "Stale" must not hang the run; after
      // 45 s it is recorded instead of waited for.
      lastBusy = (await this.busy()).filter(
        (reason) =>
          reason !== 'histogram-pending' || Date.now() - started < 45_000,
      )
      if (changeFrom !== null && hash !== changeFrom) changed = true
      const waitingForChange =
        changeFrom !== null &&
        !changed &&
        Date.now() - started < this.options.changeTimeoutMs
      if (
        hash !== previousHash ||
        counters !== previousCounters ||
        lastBusy.length ||
        waitingForChange
      ) {
        stableSince = Date.now()
      } else if (Date.now() - stableSince >= quietMs) {
        const pending = await this.busy()
        return {
          hash,
          changed,
          waitedMs: Date.now() - started,
          iterations,
          timedOut: false,
          ...(pending.length ? { stillPending: pending } : {}),
        }
      }
      previousHash = hash
      previousCounters = counters
      await sleep(250)
    }
    logLine(`  settle timed out ${label} busy=${lastBusy.join(',')}`)
    return {
      hash: previousHash,
      changed,
      waitedMs: Date.now() - started,
      iterations,
      timedOut: true,
      busy: lastBusy,
    }
  }

  async previewHash(on = 'preview') {
    const target =
      on === 'stage'
        ? this.page.locator('[data-raw-preview-frame], .raw-lab-stage').first()
        : await this.previewLocator()
    const shot = await target.screenshot({
      animations: 'disabled',
      style: PIXEL_STYLE,
      timeout: SCREENSHOT_TIMEOUT,
    })
    return sha1(shot)
  }

  // Set a Radix slider to an exact value: one absolute pointer press on the
  // track (one render), then keyboard steps until aria-valuenow matches.
  async setSlider(thumb, target, { step, label }) {
    await thumb.scrollIntoViewIfNeeded()
    const read = async () => Number(await thumb.getAttribute('aria-valuenow'))
    const start = await read()
    let current = start
    let pointer = false
    let keys = 0
    if (!approxEqual(current, target, step)) {
      const min = Number(await thumb.getAttribute('aria-valuemin'))
      const max = Number(await thumb.getAttribute('aria-valuemax'))
      const root = thumb.locator('xpath=ancestor::*[@data-slot="slider-root"][1]')
      const track = root.locator('[data-slot="slider-track"]').first()
      const box = await track.boundingBox()
      if (box && Number.isFinite(min) && Number.isFinite(max) && max > min) {
        pointer = true
        const x = box.x + ((target - min) / (max - min)) * box.width
        const y = box.y + box.height / 2
        await this.page.mouse.move(x, y)
        await this.page.mouse.down()
        await this.page.mouse.up()
        await this.waitForAttributeChange(thumb, 'aria-valuenow', String(start))
        current = await read()
      }
    }
    while (!approxEqual(current, target, step) && keys < 60) {
      const steps = Math.round((target - current) / step)
      const key =
        Math.abs(steps) >= 10
          ? steps > 0
            ? 'PageUp'
            : 'PageDown'
          : steps > 0
            ? 'ArrowRight'
            : 'ArrowLeft'
      await thumb.focus()
      const before = current
      await this.page.keyboard.press(key)
      keys++
      await this.waitForAttributeChange(thumb, 'aria-valuenow', String(before))
      current = await read()
    }
    if (pointer || keys) await this.page.mouse.move(2, 2)
    return this.record({
      type: 'slider',
      label,
      requested: target,
      actual: current,
      exact: approxEqual(current, target, step),
      via: pointer ? (keys ? 'pointer+keys' : 'pointer') : keys ? 'keys' : 'none',
      keys,
    })
  }

  async waitForAttributeChange(locator, name, previous, timeout = 15_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if ((await locator.getAttribute(name)) !== previous) return true
      await sleep(50)
    }
    return false
  }

  async clickIfEnabled(locator, label) {
    if (!(await locator.count())) return false
    const target = locator.first()
    if (!(await target.isVisible()) || !(await target.isEnabled())) return false
    await target.scrollIntoViewIfNeeded()
    await target.click()
    this.record({ type: 'click', label })
    return true
  }

  async waitForToast(pattern, { since = 0, timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const toasts = await this.toasts()
      const hit = toasts.find(
        (toast) => toast.at >= since && pattern.test(toast.text),
      )
      if (hit) return hit
      await sleep(250)
    }
    return null
  }

  // The app announces every LUT load outcome with a toast; wait for it.
  async lutLoaded(what, since) {
    const toast = await this.waitForToast(/^(Loaded LUT|Failed to load LUT)/, {
      since,
      timeoutMs: 120_000,
    })
    const ok = Boolean(toast && toast.text.startsWith('Loaded LUT'))
    if (ok) this.lut = what
    return this.record({ type: 'lut-load', ...what, ok, toast: toast?.text ?? null })
  }

  async pageNow() {
    return this.page.evaluate(() => Math.round(performance.now()))
  }

  async download(trigger, name) {
    const downloading = this.page.waitForEvent('download', { timeout: 120_000 })
    await trigger()
    const download = await downloading
    const suggested = download.suggestedFilename()
    const extension = suggested.includes('.') ? suggested.split('.').pop() : 'bin'
    const file = join(this.scenarioDir, `${name}.${extension}`)
    await download.saveAs(file)
    const bytes = await readFile(file)
    return {
      file: basename(file),
      suggestedFilename: suggested,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }
  }
}

// ---------------------------------------------------------------------------
// Surface drivers: the same intent expressed through the desktop rail or
// the mobile dock.
// ---------------------------------------------------------------------------

const TONE = [
  ['userExposureEv', 'Exposure', 0.01],
  ['userContrast', 'Contrast', 1],
  ['userHighlights', 'Highlights', 1],
  ['userShadows', 'Shadows', 1],
  ['userWhites', 'Whites', 1],
  ['userBlacks', 'Blacks', 1],
]
const COLOR = [
  ['userTemperature', 'Temperature', 1],
  ['userTint', 'Tint', 1],
  ['userSaturation', 'Saturation', 1],
  ['userVibrance', 'Vibrance', 1],
]
const HSL_AXES = { hue: 'Hue', saturation: 'Saturation', lightness: 'Lightness' }
// Strength is a continuous slider row on both surfaces (0-100%, step 1);
// it is set like any Adjust slider, through the row's track and the keys.
async function setStrengthSlider(h, thumb, percent) {
  await thumb.waitFor()
  if (Number(await thumb.getAttribute('aria-valuenow')) === percent) return false
  if ((await thumb.getAttribute('data-disabled')) !== null) return false
  await h.setSlider(thumb, percent, { step: 1, label: 'look.strength' })
  h.strength = percent
  h.record({ type: 'strength', percent })
  return true
}

const fieldOf = (table, key) => {
  const field = table.find(([id]) => id === key)
  if (!field) throw new Error(`UNKNOWN_FIELD ${key}`)
  return { key: field[0], label: field[1], step: field[2] }
}

class DesktopDriver {
  constructor(h) {
    this.h = h
    this.page = h.page
  }

  async loadRaw(path) {
    const choosing = this.page.waitForEvent('filechooser')
    await this.page
      .getByRole('button', { name: /finish a raw with a lut/i })
      .click({ position: { x: 24, y: 24 } })
    await (await choosing).setFiles(path)
  }

  async replaceRaw(path) {
    const choosing = this.page.waitForEvent('filechooser')
    await this.page.locator('[data-raw-header-action="replace"]').click()
    await (await choosing).setFiles(path)
  }

  async resetSession() {
    await this.page.locator('[data-raw-header-action="reset"]').click()
    const dialog = this.page.getByRole('alertdialog', { name: 'Reset session' })
    await dialog.waitFor()
    await dialog
      .getByRole('button', { name: 'Reset session', exact: true })
      .click()
  }

  async openCard(id) {
    const trigger = this.page.locator(`[data-tool-card-trigger="${id}"]`)
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click()
      await this.page.waitForTimeout(250)
    }
  }

  async closeCard(id) {
    const trigger = this.page.locator(`[data-tool-card-trigger="${id}"]`)
    if ((await trigger.getAttribute('aria-expanded')) === 'true') {
      await trigger.click()
      await this.page.waitForTimeout(250)
    }
  }

  async setTone(key, value) {
    await this.openCard('adjust')
    const field = fieldOf(TONE, key)
    const thumb = this.page.locator(`[data-tone-field="${key}"] [role="slider"]`)
    this.h.dirty.tone = true
    return this.h.setSlider(thumb, value, { step: field.step, label: `tone.${key}` })
  }

  async setColor(key, value) {
    await this.openCard('adjust')
    const field = fieldOf(COLOR, key)
    const thumb = this.page.locator(
      `[data-color-field="${key}"] [role="slider"]`,
    )
    this.h.dirty.color = true
    return this.h.setSlider(thumb, value, {
      step: field.step,
      label: `color.${key}`,
    })
  }

  hslRegion() {
    return this.page.getByRole('region', { name: 'HSL' }).first()
  }

  async setHsl(band, axis, value) {
    await this.openCard('adjust')
    const region = this.hslRegion()
    const tab = region.getByRole('tab', { name: HSL_AXES[axis], exact: true })
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click()
      this.h.record({ type: 'hsl-axis', axis })
    }
    const thumb = region
      .locator(`[data-hsl-band="${band}"]`)
      .getByRole('slider', { name: HSL_AXES[axis] })
    this.h.dirty.hsl = true
    return this.h.setSlider(thumb, value, { step: 1, label: `hsl.${band}.${axis}` })
  }

  async resetTone() {
    await this.openCard('adjust')
    this.h.dirty.tone = false
    return this.h.clickIfEnabled(
      this.page.getByRole('button', { name: 'Reset tone', exact: true }),
      'Reset tone',
    )
  }

  async resetColor() {
    await this.openCard('adjust')
    this.h.dirty.color = false
    return this.h.clickIfEnabled(
      this.page.getByRole('button', { name: 'Reset color', exact: true }),
      'Reset color',
    )
  }

  async resetHsl() {
    await this.openCard('adjust')
    this.h.dirty.hsl = false
    return this.h.clickIfEnabled(
      this.hslRegion().getByRole('button', { name: 'Reset all', exact: true }),
      'HSL Reset all',
    )
  }

  async lookTitles() {
    await this.openCard('look')
    await this.page
      .getByRole('button', { name: 'Open LumaForge Profiles' })
      .click()
    const dialog = this.page.getByRole('dialog', {
      name: 'LumaForge Profiles LUTs',
    })
    await dialog.waitFor({ timeout: 60_000 })
    const titles = await dialog
      .locator('[data-raw-lut="catalog-entry"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute('aria-label').replace(/^Load /, ''),
        ),
      )
    await this.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    return titles
  }

  // Catalog entries are addressed by position. An entry keeps its catalog
  // title once loaded, but two catalogs can list one title, so the listing
  // title is only a name for the scenario.
  async loadCatalogLook(index, title) {
    await this.openCard('look')
    await this.page
      .getByRole('button', { name: 'Open LumaForge Profiles' })
      .click()
    const dialog = this.page.getByRole('dialog', {
      name: 'LumaForge Profiles LUTs',
    })
    await dialog.waitFor({ timeout: 60_000 })
    const entry = dialog.locator('[data-raw-lut="catalog-entry"]').nth(index)
    const label = await entry.getAttribute('aria-label')
    const since = await this.h.pageNow()
    await entry.click()
    await dialog.waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => {})
    return this.h.lutLoaded({ kind: 'catalog', index, title, label }, since)
  }

  async loadLutFile(path) {
    await this.openCard('look')
    const since = await this.h.pageNow()
    await this.page
      .locator('input[type="file"][accept=".cube"]')
      .first()
      .setInputFiles(path)
    return this.h.lutLoaded({ kind: 'file', file: basename(path) }, since)
  }

  async clearLut() {
    await this.openCard('look')
    this.h.lut = null
    return this.h.clickIfEnabled(
      this.page.getByRole('button', { name: 'Clear LUT', exact: true }),
      'Clear LUT',
    )
  }

  strengthSlider() {
    return this.page.locator('[data-raw-desktop-strength]').getByRole('slider')
  }

  // Strength is a continuous slider row (0-100%); `percent` is any whole
  // percent, presets included (STRENGTH_PERCENT).
  async setStrength(percent) {
    await this.openCard('look')
    return setStrengthSlider(this.h, this.strengthSlider(), percent)
  }

  async setLutContract(input, output) {
    await this.openCard('look')
    await this.page.getByRole('button', { name: 'Change LUT contract' }).click()
    const dialog = this.page.getByRole('dialog', { name: 'LUT contract browser' })
    await dialog.waitFor()
    await this.pickContract(dialog, input, output)
  }

  async pickContract(dialog, input, output) {
    const inputTab = dialog.getByRole('tab', { name: 'Input', exact: true })
    if ((await inputTab.count()) && (await inputTab.isEnabled()))
      await inputTab.click()
    await dialog
      .getByRole('button', { name: `Use ${input} as LUT input`, exact: true })
      .first()
      .click()
    const outputButton = dialog
      .getByRole('button', { name: `Use ${output} as LUT output`, exact: true })
      .first()
    try {
      await outputButton.waitFor({ timeout: 5_000 })
    } catch {
      const outputTab = dialog.getByRole('tab', { name: 'Output', exact: true })
      if (await outputTab.count()) await outputTab.click()
    }
    const outputClicked = (await outputButton.count()) > 0
    if (outputClicked) await outputButton.click()
    if (await dialog.isVisible()) {
      await this.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' }).catch(() => {})
    }
    this.h.record({ type: 'lut-contract', input, output, outputClicked })
  }

  compareHandle() {
    return this.page.getByRole('slider', {
      name: 'Compare unprocessed RAW and final JPEG',
    })
  }

  // Desktop GPU preview is always a split; 0 shows the processed photo only.
  async setSplit(value) {
    if (this.h.cpu) return this.setCpuVariant(value >= 1 ? 'Original' : 'Processed')
    const handle = this.compareHandle()
    if (!(await handle.count())) return this.h.record({ type: 'split', skipped: true })
    const target = Math.round(value * 100)
    const read = async () => Number(await handle.getAttribute('aria-valuenow'))
    await handle.focus()
    if (target <= 50) {
      if ((await read()) !== 0) await this.page.keyboard.press('Home')
      while ((await read()) < target) await this.page.keyboard.press('ArrowRight')
    } else {
      if ((await read()) !== 100) await this.page.keyboard.press('End')
      while ((await read()) > target) await this.page.keyboard.press('ArrowLeft')
    }
    await this.page.locator('body').focus().catch(() => {})
    return this.h.record({ type: 'split', requested: value, actual: (await read()) / 100 })
  }

  async setCpuVariant(name) {
    const button = this.page
      .locator('.raw-lab-stage')
      .getByRole('button', { name, exact: true })
    if (!(await button.count())) return this.h.record({ type: 'cpu-variant', skipped: true })
    await button.click()
    return this.h.record({ type: 'cpu-variant', name })
  }

  async resetCompareView() {
    await this.openCard('compare')
    return this.h.clickIfEnabled(
      this.page.getByRole('button', { name: 'Reset compare view' }),
      'Reset compare view',
    )
  }

  async zoomStage({ x = 0.4, y = 0.45, delta = -900 } = {}) {
    const frame = this.page.locator('[data-raw-preview-frame]').first()
    const box = await frame.boundingBox()
    await this.page.mouse.move(box.x + box.width * x, box.y + box.height * y)
    await this.page.mouse.wheel(0, delta)
    this.h.record({ type: 'wheel-zoom', x, y, delta })
  }

  async resetZoom() {
    const frame = this.page.locator('[data-raw-preview-frame]').first()
    const box = await frame.boundingBox()
    await this.page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.5)
    this.h.record({ type: 'dblclick-reset-zoom' })
  }

  transformTool() {
    return this.page.locator('[data-raw-transform-tool]')
  }

  async openTransform() {
    await this.openCard('transform')
    await this.waitForTransform()
  }

  async closeTransform() {
    await this.closeCard('transform')
  }

  async waitForTransform() {
    const tool = this.transformTool()
    await tool.waitFor({ timeout: 60_000 })
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      const ready = await this.page.evaluate(() => {
        const tool = document.querySelector('[data-raw-transform-tool]')
        // Mobile mounts only the active section (Upright, Perspective or
        // Frame), so the Auto button exists only while Upright is open.
        const auto = tool?.querySelector('[data-testid="mode-auto"]')
        const activeTab = tool
          ?.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent?.trim()
        const uprightShown = !activeTab || activeTab === 'Upright'
        const overlay = document.querySelector('[data-raw-transform-preview]')
        return (
          Boolean(tool) &&
          (uprightShown ? Boolean(auto) && !auto.disabled : true) &&
          (!overlay || overlay.getAttribute('aria-busy') === 'false')
        )
      })
      if (ready) return true
      await sleep(250)
    }
    return false
  }

  async transformSection() {}

  async setUpright(mode) {
    await this.openTransform()
    await this.transformSection('Upright')
    const button = this.transformTool().getByRole('button', {
      name: mode,
      exact: true,
    })
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
    this.h.dirty.transform = true
    this.h.record({ type: 'upright', mode })
    await this.waitForTransform()
  }

  async setTransformToggle(name, on) {
    await this.openTransform()
    await this.transformSection('Upright')
    const button = this.transformTool().getByRole('button', { name, exact: true })
    const pressed = (await button.getAttribute('aria-pressed')) === 'true'
    if (pressed === on) return
    // Overlays enable only once the Transform capture is current.
    const deadline = Date.now() + (on ? 120_000 : 0)
    while (!(await button.isEnabled()) && Date.now() < deadline) await sleep(250)
    if (await button.isEnabled()) await button.click()
    if (on) this.h.dirty.transform = true
    this.h.record({ type: 'transform-toggle', name, on })
  }

  async setRotate(value) {
    await this.openTransform()
    await this.transformSection('Perspective')
    const thumb = this.transformTool().getByRole('slider', {
      name: 'Rotate',
      exact: true,
    })
    this.h.dirty.transform = true
    const result = await this.h.setSlider(thumb, value, {
      step: 0.1,
      label: 'transform.rotate',
    })
    await this.waitForTransform()
    return result
  }

  async setCrop(on) {
    await this.openTransform()
    await this.transformSection('Frame')
    const box = this.transformTool().getByRole('checkbox').first()
    const checked = (await box.getAttribute('aria-checked')) === 'true'
    if (checked !== on) await box.click()
    this.h.dirty.transform = true
    this.h.record({ type: 'constrain-crop', on })
    await this.waitForTransform()
  }

  async resetTransform() {
    await this.openTransform()
    await this.transformSection('Upright')
    const name = this.h.desktop ? 'Reset' : 'Reset Upright'
    const clicked = await this.h.clickIfEnabled(
      this.transformTool().getByRole('button', { name, exact: true }),
      'Transform reset',
    )
    for (const toggle of ['Grid', 'Detected lines'])
      await this.setTransformToggle(toggle, false).catch(() => {})
    this.h.dirty.transform = false
    return clicked
  }

  async exportRegion() {
    return this.page.locator('[data-raw-export-block]').first()
  }

  async exportButton(name) {
    const region = await this.exportRegion()
    return region.getByRole('button', { name, exact: true })
  }

  async restorePreview() {
    const button = this.page.getByRole('button', { name: /^restore preview$/i })
    if (!(await button.count())) return false
    await button.first().click()
    this.h.record({ type: 'restore-preview' })
    return true
  }

  async showHistogram() {
    await this.openCard('histogram')
  }

  async histogramLocator() {
    return this.page.locator('[data-tool-card="histogram"] [role="img"]').first()
  }
}

class MobileDriver extends DesktopDriver {
  async loadRaw(path) {
    const choosing = this.page.waitForEvent('filechooser')
    await this.page.getByRole('button', { name: /browse raw files/i }).click()
    await (await choosing).setFiles(path)
  }

  async more(item) {
    await this.page.getByRole('button', { name: 'More actions' }).click()
    await this.page.getByRole('menuitem', { name: item }).click()
  }

  async replaceRaw(path) {
    const choosing = this.page.waitForEvent('filechooser')
    await this.more('Replace RAW')
    await (await choosing).setFiles(path)
  }

  async resetSession() {
    await this.more('Reset session')
    const dialog = this.page.getByRole('alertdialog', { name: 'Reset session' })
    await dialog.waitFor()
    await dialog
      .getByRole('button', { name: 'Reset session', exact: true })
      .click()
  }

  // The dock holds tools only (Look, Adjust, Transform). Compare is a lens
  // over the stage and Export is a topbar action; neither is a tab.
  dockTab(name) {
    return this.page
      .getByRole('tablist', { name: 'Lab modes' })
      .getByRole('tab', { name, exact: true })
  }

  async openMode(name) {
    const tab = this.dockTab(name)
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click()
      await this.page.locator('[data-mobile-dock-panel]').waitFor()
      await this.page.waitForTimeout(400)
    }
  }

  compareLens() {
    return this.page.locator('[data-mobile-compare-lens]')
  }

  async setCompareLens(on) {
    const lens = this.compareLens()
    if (!(await lens.count())) return false
    const state = await lens.getAttribute('data-state')
    if (state === 'disabled' || (state === 'on') === on) return false
    await lens.click()
    await this.page.waitForTimeout(300)
    return true
  }

  // The mobile CPU preview has no toggle row under the photo: the compare
  // lens is an original toggle there (aria-pressed while the original shows).
  async setCpuVariant(name) {
    const lens = this.compareLens()
    if (!(await lens.count()))
      return this.h.record({ type: 'cpu-variant', skipped: true })
    const wantOriginal = name === 'Original'
    const pressed = (await lens.getAttribute('aria-pressed')) === 'true'
    if (pressed !== wantOriginal) {
      await lens.click()
      await this.page.waitForTimeout(300)
    }
    return this.h.record({ type: 'cpu-variant', name })
  }

  exportAction() {
    return this.page.locator('[data-mobile-export-action]')
  }

  async openExport() {
    const panel = this.page.locator('[data-mobile-export-panel]')
    if (!(await panel.isVisible().catch(() => false))) {
      await this.exportAction().click()
      await panel.waitFor()
      await this.page.waitForTimeout(400)
    }
    return panel
  }

  async closeExport() {
    const close = this.page.locator('[data-mobile-export-close]')
    if (await close.isVisible().catch(() => false)) {
      await close.click()
      await this.page.waitForTimeout(400)
    }
  }

  async closeDock() {
    // The export panel borrows the deck with no tab selected; hand it back
    // first so the selected tool can collapse it.
    await this.closeExport()
    const selected = this.page
      .getByRole('tablist', { name: 'Lab modes' })
      .locator('[aria-selected="true"]')
    if (await selected.count()) {
      await selected.first().click()
      await this.page.waitForTimeout(400)
    }
  }

  async openCard() {}

  async closeCard() {}

  async adjustSection(name) {
    await this.openMode('Adjust')
    const panel = this.page.locator('[data-mobile-dock-panel]')
    const tab = panel.getByRole('tab', { name, exact: true })
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
    const section = panel.locator(
      `[data-adjust-list-section="${name.toLowerCase()}"]`,
    )
    await section.waitFor()
    return section
  }

  async setTone(key, value) {
    const field = fieldOf(TONE, key)
    const section = await this.adjustSection('Tone')
    const thumb = section.getByRole('slider', { name: field.label, exact: true })
    this.h.dirty.tone = true
    return this.h.setSlider(thumb, value, { step: field.step, label: `tone.${key}` })
  }

  async setColor(key, value) {
    const field = fieldOf(COLOR, key)
    const section = await this.adjustSection('Color')
    const thumb = section.getByRole('slider', { name: field.label, exact: true })
    this.h.dirty.color = true
    return this.h.setSlider(thumb, value, {
      step: field.step,
      label: `color.${key}`,
    })
  }

  async setHsl(band, axis, value) {
    const section = await this.adjustSection('HSL')
    const row = section.locator(`[data-hsl-band-row="${band}"]`)
    if ((await row.getAttribute('data-open')) !== 'true') {
      await row.getByRole('button').first().click()
      await this.page.waitForTimeout(300)
    }
    const thumb = row.getByRole('slider', { name: HSL_AXES[axis], exact: true })
    this.h.dirty.hsl = true
    return this.h.setSlider(thumb, value, { step: 1, label: `hsl.${band}.${axis}` })
  }

  async resetSection(section, label) {
    await this.adjustSection(section)
    const button = this.page
      .locator('[data-mobile-dock-panel] [data-adjust-section-chrome]')
      .getByRole('button', { name: /^Reset/ })
    return this.h.clickIfEnabled(button.last(), label)
  }

  async resetTone() {
    this.h.dirty.tone = false
    return this.resetSection('Tone', 'Reset tone')
  }

  async resetColor() {
    this.h.dirty.color = false
    return this.resetSection('Color', 'Reset color')
  }

  async resetHsl() {
    this.h.dirty.hsl = false
    return this.resetSection('HSL', 'HSL reset')
  }

  // Looks are tried on the photo from the Look deck: a strip of tiles
  // (Original, the applied file, every catalog look, Import .cube), the
  // Strength row, and a footer that states the LUT contract. The contract is
  // chosen inside the deck; the LUT sources sheet only administers sources.
  lookStrip() {
    return this.page.getByRole('group', { name: 'Looks' })
  }

  lookContract() {
    return this.page.locator('[data-mobile-look-contract]')
  }

  async openLook() {
    await this.openMode('Look')
    await this.closeLookContract()
    await this.lookStrip().waitFor()
    return this.lookStrip()
  }

  async closeLookContract() {
    const contract = this.lookContract()
    if (!(await contract.isVisible().catch(() => false))) return
    const back = contract.getByRole('button', { name: /^Back to/ })
    // Output step goes back to the input; the input step leaves the editor.
    for (let i = 0; i < 2 && (await contract.isVisible().catch(() => false)); i++)
      await back.first().click()
    await contract.waitFor({ state: 'hidden' }).catch(() => {})
  }

  async closeLutBrowser() {
    const close = this.page.getByRole('button', { name: 'Close LUT sources' })
    if (await close.count()) {
      await close.first().click()
      await this.page
        .locator('[data-mobile-lut-view]')
        .waitFor({ state: 'hidden' })
        .catch(() => {})
    }
  }

  catalogTiles() {
    return this.lookStrip().locator('[data-mobile-lut-tile="entry"]')
  }

  async lookTitles() {
    await this.openLook()
    await this.catalogTiles().first().waitFor({ timeout: 60_000 })
    return this.catalogTiles().evaluateAll((elements) =>
      elements.map((element) => element.dataset.lutTitle),
    )
  }

  // Strip tiles are addressed by position, like the desktop catalog. A tile
  // keeps its catalog title in every state; family dividers sit between
  // groups and are not tiles.
  async loadCatalogLook(index, title) {
    await this.openLook()
    await this.catalogTiles().first().waitFor({ timeout: 60_000 })
    const tile = this.catalogTiles().nth(index)
    const label = await tile.getAttribute('data-lut-title')
    if ((await tile.getAttribute('aria-pressed')) === 'true') {
      // Tapping the applied look is a no-op; it is already on the photo.
      this.h.lut = { kind: 'catalog', index, title, label }
      return this.h.record({
        type: 'lut-load',
        kind: 'catalog',
        index,
        title,
        label,
        ok: true,
        alreadyApplied: true,
      })
    }
    const since = await this.h.pageNow()
    await tile.click()
    return this.h.lutLoaded({ kind: 'catalog', index, title, label }, since)
  }

  async loadLutFile(path) {
    await this.openLook()
    const since = await this.h.pageNow()
    await this.page
      .locator('[data-mobile-lut-import-input]')
      .setInputFiles(path)
    const result = await this.h.lutLoaded({ kind: 'file', file: basename(path) }, since)
    // An import nothing resolved opens its contract in the deck; hand the
    // deck back to the strip so the next step starts from it.
    await this.page.waitForTimeout(300)
    await this.closeLookContract()
    return result
  }

  async clearLut() {
    this.h.lut = null
    const strip = await this.openLook()
    const original = strip.getByRole('button', { name: 'Original', exact: true })
    if ((await original.getAttribute('aria-pressed')) === 'true') return false
    return this.h.clickIfEnabled(original, 'Original (clear LUT)')
  }

  async setStrength(percent) {
    await this.openLook()
    return setStrengthSlider(
      this.h,
      this.page.locator('[data-mobile-look-strength]').getByRole('slider'),
      percent,
    )
  }

  async setLutContract(input, output) {
    await this.openLook()
    // The footer opens the contract: the confirmed line, the amber prompt,
    // or a recommendation's label.
    const open = this.page
      .locator('[data-mobile-look-footer]')
      .getByRole('button', {
        name: /^(Edit color contract for|Choose what this LUT expects|Recommended:)/,
      })
    await open.first().click()
    const contract = this.lookContract()
    await contract.waitFor()
    await this.pickContract(contract, input, output)
    await this.closeLookContract()
  }

  async setSplit(value) {
    if (this.h.cpu) return this.setCpuVariant(value >= 1 ? 'Original' : 'Processed')
    if (value <= 0) {
      // Processed only: the mobile surface has no split open by default. A
      // tap on the lens closes an open split.
      if (await this.compareHandle().count()) await this.setCompareLens(false)
      return this.h.record({ type: 'split', requested: 0, actual: 'closed' })
    }
    const handle = this.compareHandle()
    if (!(await handle.count())) await this.setCompareLens(true)
    await handle.waitFor({ timeout: 30_000 })
    return super.setSplit(value)
  }

  async resetCompareView() {
    return this.setSplit(0.5)
  }

  // Touch-and-hold peeks the unprocessed RAW; the touch stays down until the
  // returned release runs. Playwright has no touch hold, so this uses CDP.
  async holdPreview() {
    const cdp = await this.h.context.newCDPSession(this.page)
    const box = await this.page.locator('[data-raw-preview-frame]').first().boundingBox()
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    const peeking = await this.page
      .locator('[data-peek]')
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true, () => false)
    this.h.record({ type: 'touch-hold', point, peeking })
    return async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
    }
  }

  async openTransform() {
    await this.openMode('Transform')
    await this.waitForTransform()
  }

  async closeTransform() {
    await this.closeDock()
  }

  async transformSection(name) {
    const tool = this.transformTool()
    const tab = tool.getByRole('tab', { name, exact: true })
    if ((await tab.count()) && (await tab.getAttribute('aria-selected')) !== 'true') {
      await tab.click()
      await this.page.waitForTimeout(250)
    }
  }

  async exportRegion() {
    return this.openExport()
  }

  // The histogram is a checkable item in the More menu.
  async setHistogram(shown) {
    await this.page.getByRole('button', { name: 'More actions' }).click()
    const item = this.page.getByRole('menuitemcheckbox', { name: 'Histogram' })
    await item.waitFor()
    if (((await item.getAttribute('aria-checked')) === 'true') === shown) {
      await this.page.keyboard.press('Escape')
      return false
    }
    await item.click()
    this.h.record({ type: shown ? 'show-histogram' : 'hide-histogram' })
    return true
  }

  async showHistogram() {
    return this.setHistogram(true)
  }

  async hideHistogram() {
    return this.setHistogram(false)
  }

  async histogramLocator() {
    return this.page.locator('[role="img"][aria-label*="histogram" i]').first()
  }
}

// ---------------------------------------------------------------------------
// Shared scenario steps
// ---------------------------------------------------------------------------

async function waitForRawLoaded(h, file, { requireHq = true } = {}) {
  const page = h.page
  const name = basename(file)
  const started = Date.now()
  await page
    .locator('.raw-lab[data-raw-lab-state="loaded"]')
    .waitFor({ timeout: 240_000 })
  await page
    .getByRole('heading', { name, exact: true })
    .first()
    .waitFor({ timeout: 240_000 })
    .catch(() => {})
  await page
    .locator('.raw-progress-overlay')
    .waitFor({ state: 'detached', timeout: 240_000 })
  const loadedMs = Date.now() - started
  let hq = null
  if (requireHq) {
    // Ingest announces `Loaded <file>` only after the bounded HQ preview.
    hq = await h.waitForToast(new RegExp(`^Loaded ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), {
      timeoutMs: h.options.hqTimeoutMs,
    })
  }
  return {
    file: name,
    loadedMs,
    hqReady: Boolean(hq),
    hqToast: hq?.text ?? null,
    hqMs: hq ? Date.now() - started : null,
  }
}

async function neutralize(h, d, { keepLut = false } = {}) {
  const dom = await h.dom()
  const visiblyDirty = (prefix) =>
    Object.entries(dom.sliders).some(
      ([key, value]) => key.startsWith(prefix) && Number(value) !== 0,
    )
  let changed = false
  if (h.dirty.transform || dom.transform.overlay || dom.transform.matrix) {
    changed = (await d.resetTransform()) || changed
    await d.closeTransform()
  }
  if (h.dirty.tone || visiblyDirty('tone.')) changed = (await d.resetTone()) || changed
  if (h.dirty.color || visiblyDirty('color.'))
    changed = (await d.resetColor()) || changed
  if (h.dirty.hsl || visiblyDirty('hsl.')) changed = (await d.resetHsl()) || changed
  if (h.lut && h.strength !== STRENGTH_PERCENT.Standard)
    changed = (await d.setStrength(STRENGTH_PERCENT.Standard)) || changed
  if (h.lut && !keepLut) changed = (await d.clearLut()) || changed
  if (h.cpu) {
    await d.setCpuVariant('Processed')
  } else if (dom.sliders['compare.split'] !== undefined) {
    if (h.desktop ? dom.sliders['compare.split'] !== '0' : true) await d.setSplit(0)
  }
  if (!h.desktop) await d.closeDock()
  return changed
}

async function captureShots(h, d, shots) {
  const files = {}
  const page = h.page
  const save = async (name, buffer) => {
    const file = join(h.scenarioDir, name)
    await writeFile(file, buffer)
    files[name] = { sha256: sha256(buffer), bytes: buffer.length }
  }
  if (shots.includes('preview')) {
    const target = await h.previewLocator()
    await save(
      'preview.png',
      await target.screenshot({
        animations: 'disabled',
        style: PIXEL_STYLE,
        timeout: SCREENSHOT_TIMEOUT,
      }),
    )
  }
  if (shots.includes('stage')) {
    const stage = page.locator('[data-raw-preview-frame], .raw-lab-stage').first()
    if (await stage.count())
      await save(
        'stage.png',
        await stage.screenshot({
          animations: 'disabled',
          style: PIXEL_STYLE,
          timeout: SCREENSHOT_TIMEOUT,
        }),
      )
  }
  if (shots.includes('histogram')) {
    const histogram = await d.histogramLocator()
    if ((await histogram.count()) && (await histogram.isVisible())) {
      await histogram.scrollIntoViewIfNeeded().catch(() => {})
      await save(
        'histogram.png',
        await histogram.screenshot({
          animations: 'disabled',
          style: CHROME_STYLE,
          timeout: SCREENSHOT_TIMEOUT,
        }),
      )
    }
  }
  if (shots.includes('transform')) {
    const canvas = page.locator('[data-raw-transform-preview] canvas').first()
    if (await canvas.count()) {
      await save(
        'transform.png',
        await canvas.screenshot({
          animations: 'disabled',
          style: PIXEL_STYLE,
          timeout: SCREENSHOT_TIMEOUT,
        }),
      )
      // The Transform preview is a 2D canvas, so its exact pixels are
      // readable; keep them as a lossless PNG next to the compositor shot.
      const exact = await canvas.evaluate(async (element) => {
        const pixels = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data
        const digest = await crypto.subtle.digest('SHA-256', pixels)
        return {
          dataUrl: element.toDataURL('image/png'),
          width: element.width,
          height: element.height,
          rgbaSha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
        }
      })
      await save(
        'transform-canvas.png',
        Buffer.from(exact.dataUrl.split(',')[1], 'base64'),
      )
      files['transform-canvas.png'].rgbaSha256 = exact.rgbaSha256
      files['transform-canvas.png'].size = [exact.width, exact.height]
    }
  }
  return files
}

async function runExport(h, d, kind) {
  const page = h.page
  const label =
    kind === 'full' ? 'Export full-resolution JPEG' : 'Export HQ preview JPEG'
  const readyText = kind === 'full' ? 'JPEG ready' : 'HQ preview JPEG ready'
  const button = await d.exportButton(label)
  await button.waitFor({ timeout: 60_000 })
  const deadline = Date.now() + 120_000
  while (!(await button.isEnabled()) && Date.now() < deadline) await sleep(500)
  if (!(await button.isEnabled())) {
    const region = await d.exportRegion()
    return {
      kind,
      started: false,
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
      reason: (await region.innerText()).replace(/\s+/g, ' ').trim(),
    }
  }
  const since = await h.pageNow()
  const started = Date.now()
  await button.click()
  h.record({ type: 'export', kind })
  // A previous result may still be on screen; see this export start before
  // trusting a "ready" line (a fast HQ export may finish within the window).
  await page
    .waitForFunction(
      ({ readyText }) => {
        const region =
          document.querySelector('[data-raw-export-block]') ??
          document.querySelector('[data-mobile-dock-panel]')
        // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
        const text = region?.innerText ?? ''
        return (
          /Preparing JPEG/.test(text) ||
          document.querySelector('[data-preview-state="exporting-released"]') ||
          !text
            .split('\n')
            .some(
              (line) =>
                line.trim() === readyText ||
                (readyText === 'JPEG ready' &&
                  /\.jpe?g ready$/i.test(line.trim())),
            )
        )
      },
      { readyText },
      { timeout: 30_000, polling: 100 },
    )
    .catch(() => {})
  // Wait for the result (or a refusal) of *this* export, not a stale one.
  const outcome = await page.waitForFunction(
    ({ readyText, sinceAt }) => {
      const region =
        document.querySelector('[data-raw-export-block]') ??
        document.querySelector('[data-mobile-dock-panel]')
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
      const text = region?.innerText ?? ''
      const failure = (window.__lfQa?.toasts ?? []).find(
        (toast) =>
          toast.at >= sinceAt && /fail|unavailable|error|refus/i.test(toast.text),
      )
      if (failure) return { state: 'failed', text: failure.text }
      const busy = /Preparing JPEG|Sealing/.test(text)
      // Desktop says "JPEG ready"; the mobile dock names the file instead
      // ("<name>.jpg ready").
      const hasReady = text
        .split('\n')
        .some(
          (line) =>
            line.trim() === readyText ||
            (readyText === 'JPEG ready' && /\.jpe?g ready$/i.test(line.trim())),
        )
      const download = [...(region?.querySelectorAll('button') ?? [])].some(
        // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
        (element) => element.innerText.trim() === 'Download' && !element.disabled,
      )
      if (hasReady && download && !busy) return { state: 'ready' }
      return false
    },
    { readyText, sinceAt: since },
    { timeout: 1_800_000, polling: 500 },
  )
  const result = await outcome.jsonValue()
  const elapsedMs = Date.now() - started
  if (result.state !== 'ready') return { kind, started: true, ...result, elapsedMs }
  const region = await d.exportRegion()
  // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text a user sees, not hidden nodes
  const statusText = (await region.innerText()).replace(/\s+/g, ' ').trim()
  const jpeg = await h.download(
    () => region.getByRole('button', { name: 'Download', exact: true }).click(),
    kind === 'full' ? 'export-full' : 'export-hq-preview',
  )
  let manifest = null
  if (kind === 'full') {
    const manifestButton = region.getByRole('button', { name: /^manifest$/i })
    try {
      await manifestButton.waitFor({ timeout: 180_000 })
      const saved = await h.download(() => manifestButton.click(), 'export-manifest')
      const json = JSON.parse(await readFile(join(h.scenarioDir, saved.file), 'utf8'))
      manifest = {
        ...saved,
        outputSha256: json.output?.sha256 ?? null,
        outputMatchesDownload: json.output?.sha256 === jpeg.sha256,
        sourceSha256: json.source_raw?.sha256 ?? null,
        policy: json.policy?.kind ?? null,
      }
    } catch (error) {
      manifest = { error: error.message.split('\n')[0] }
    }
  }
  return { kind, started: true, state: 'ready', elapsedMs, statusText, jpeg, manifest }
}

async function afterFullExport(h, d) {
  const restored = await d.restorePreview()
  if (restored) {
    await h.page
      .locator('[data-preview-state]')
      .waitFor({ state: 'detached', timeout: 300_000 })
      .catch(() => {})
    await h.settle({ label: 'restore-preview' })
  }
  return restored
}

async function applyCombinedEdit(h, d, look) {
  await d.setTone('userExposureEv', 0.3)
  await d.setTone('userContrast', 20)
  await d.setTone('userHighlights', -25)
  await d.setTone('userShadows', 15)
  await d.setColor('userTemperature', 15)
  await d.setColor('userSaturation', 25)
  await d.setColor('userVibrance', 20)
  await d.setHsl('red', 'hue', 20)
  await d.setHsl('blue', 'saturation', -30)
  if (look) await d.loadCatalogLook(0, look)
}

// ---------------------------------------------------------------------------
// Scenario list
// ---------------------------------------------------------------------------

function buildScenarios({ surface, preview, looks }) {
  const desktop = surface === 'desktop'
  const cpu = preview === 'cpu'
  const list = []
  const add = (scenario) => list.push({ shots: ['preview', 'histogram'], ...scenario })

  add({
    name: 'ingest-default',
    shots: ['preview', 'stage', 'histogram'],
    noReset: true,
    noChangeExpected: true,
    run: async () => {},
  })
  add({
    name: 'neutral',
    shots: ['preview', 'stage', 'histogram'],
    noChangeExpected: true,
    run: async () => {},
  })

  const toneSingles = [
    ['userExposureEv', 0.75],
    ['userContrast', 40],
    ['userHighlights', -50],
    ['userShadows', 45],
    ['userWhites', -30],
    ['userBlacks', 25],
  ]
  for (const [key, value] of toneSingles)
    add({
      name: `tone-${slug(key.replace(/^user/, '').replace(/Ev$/, ''))}${value > 0 ? '+' : ''}${value}`,
      run: async (h, d) => d.setTone(key, value),
    })
  add({
    name: 'tone-combined',
    run: async (h, d) => {
      for (const [key, value] of [
        ['userExposureEv', 0.4],
        ['userContrast', 25],
        ['userHighlights', -35],
        ['userShadows', 20],
        ['userWhites', -15],
        ['userBlacks', 10],
      ])
        await d.setTone(key, value)
    },
  })

  for (const [key, values] of [
    ['userTemperature', [40, -40]],
    ['userTint', [30, -30]],
    ['userSaturation', [50, -60]],
    ['userVibrance', [60, -50]],
  ])
    for (const value of values)
      add({
        name: `color-${slug(key.replace(/^user/, ''))}${value > 0 ? '+' : ''}${value}`,
        run: async (h, d) => d.setColor(key, value),
      })

  add({
    name: 'hsl-red-orange',
    run: async (h, d) => {
      await d.setHsl('red', 'hue', 30)
      await d.setHsl('orange', 'hue', -20)
      await d.setHsl('red', 'saturation', 40)
      await d.setHsl('orange', 'lightness', -25)
    },
  })
  add({
    name: 'hsl-green-aqua-blue',
    run: async (h, d) => {
      await d.setHsl('green', 'hue', -40)
      await d.setHsl('aqua', 'saturation', 30)
      await d.setHsl('blue', 'saturation', -50)
      await d.setHsl('blue', 'lightness', 30)
      await d.setHsl('yellow', 'lightness', 20)
    },
  })

  // Compare: an edit makes the two halves differ, then the split moves.
  if (cpu) {
    add({
      name: 'compare-cpu-original',
      shots: ['preview', 'stage'],
      settleOn: 'stage',
      run: async (h, d) => {
        await d.setTone('userContrast', 30)
        await d.setColor('userSaturation', 30)
        await h.settle({ label: 'compare-edit' })
        await d.setCpuVariant('Original')
      },
    })
  } else {
    if (!desktop)
      add({
        name: 'compare-peek-original',
        // The unprocessed view may legitimately equal the neutral render.
        noChangeExpected: true,
        run: async (h, d) => {
          await d.setTone('userContrast', 30)
          await d.setColor('userSaturation', 30)
          await d.closeDock()
          await h.settle({ label: 'compare-edit' })
          h.release = await d.holdPreview()
        },
        after: async (h) => h.release?.(),
      })
    add({
      name: 'compare-split-50',
      shots: ['stage'],
      settleOn: 'stage',
      run: async (h, d) => {
        await d.setTone('userContrast', 30)
        await d.setColor('userSaturation', 30)
        await h.settle({ label: 'compare-edit' })
        if (desktop) await d.resetCompareView()
        else await d.setSplit(0.5)
      },
    })
    for (const split of [0.27, 0.8, 1])
      add({
        name: `compare-split-${Math.round(split * 100)}`,
        shots: ['stage'],
        settleOn: 'stage',
        keepEdits: true,
        run: async (h, d) => d.setSplit(split),
      })
    if (desktop)
      add({
        name: 'compare-zoom-pan',
        shots: ['stage'],
        settleOn: 'stage',
        keepEdits: true,
        run: async (h, d) => {
          await d.setSplit(0.5)
          await d.zoomStage()
          await h.page.waitForTimeout(600)
        },
        after: async (h, d) => {
          await d.resetZoom()
          await h.page.waitForTimeout(600)
        },
      })
  }

  // Looks: every catalog look at the default strength, then strengths.
  looks.forEach((title, index) => {
    add({
      name: `look-${slug(title)}`,
      keepLut: true,
      run: async (h, d) => d.loadCatalogLook(index, title),
    })
    // The presets, plus one amount between them: strength is continuous
    // through preview, export and the manifest.
    if (index === 0)
      for (const [level, percent] of [
        ['light', STRENGTH_PERCENT.Light],
        ['strong', STRENGTH_PERCENT.Strong],
        ['off', STRENGTH_PERCENT.Off],
        ['62', 62],
      ])
        add({
          name: `look-${slug(title)}-strength-${level}`,
          keepLut: true,
          run: async (h, d) => d.setStrength(percent),
        })
  })

  add({
    name: 'lut-file-illegal-29-rejected',
    noChangeExpected: true,
    run: async (h, d) => d.loadLutFile(h.options.luts[0]),
  })
  add({
    name: 'lut-file-legal-33-loaded',
    keepLut: true,
    // The cube's contract is unconfirmed until an output is chosen, so the
    // app keeps it out of the preview.
    noChangeExpected: true,
    run: async (h, d) => d.loadLutFile(h.options.luts[1]),
  })
  for (const [input, output] of [
    ['Sony S-Gamut3.Cine / S-Log3', 'Rec.709 / Gamma 2.4'],
    ['Nikon Rec.2020 / N-Log', 'Display sRGB'],
    ['ARRI Wide Gamut 3 / LogC3', 'Rec.709 / Gamma 2.4'],
    ['Display sRGB', 'Display sRGB'],
  ])
    add({
      name: `lut-contract-${slug(input)}--${slug(output)}`,
      keepLut: true,
      run: async (h, d) => d.setLutContract(input, output),
    })

  // Transform.
  const transformShots = ['preview', 'stage', 'transform']
  add({
    name: 'transform-grid',
    shots: transformShots,
    run: async (h, d) => {
      await d.openTransform()
      await d.setTransformToggle('Grid', true)
      await d.waitForTransform()
    },
  })
  for (const mode of ['Auto', 'Level', 'Vertical', 'Full'])
    add({
      name: `transform-upright-${mode.toLowerCase()}`,
      shots: transformShots,
      run: async (h, d) => d.setUpright(mode),
    })
  add({
    name: 'transform-rotate+3',
    shots: transformShots,
    run: async (h, d) => d.setRotate(3),
  })
  add({
    name: 'transform-rotate+3-crop-off',
    shots: transformShots,
    run: async (h, d) => {
      await d.setRotate(3)
      await d.setCrop(false)
    },
  })

  // Exports. HQ preview first: full-resolution export releases the preview.
  add({
    name: 'export-hq-preview-neutral',
    noChangeExpected: true,
    shots: ['preview'],
    run: async (h, d) => {
      h.exportResult = await runExport(h, d, 'hq')
    },
  })
  add({
    name: 'export-hq-preview-combined',
    noChangeExpected: true,
    shots: ['preview', 'histogram'],
    keepLut: false,
    run: async (h, d) => {
      await applyCombinedEdit(h, d, looks[0])
      await h.settle({ label: 'combined-edit' })
      h.exportResult = await runExport(h, d, 'hq')
    },
  })
  add({
    name: 'export-full-neutral',
    noChangeExpected: true,
    shots: ['preview'],
    run: async (h, d) => {
      h.exportResult = await runExport(h, d, 'full')
      h.exportResult.restoredPreview = await afterFullExport(h, d)
    },
  })
  add({
    name: 'export-full-combined',
    noChangeExpected: true,
    shots: ['preview', 'histogram'],
    run: async (h, d) => {
      await applyCombinedEdit(h, d, looks[0])
      await h.settle({ label: 'combined-edit' })
      h.exportResult = await runExport(h, d, 'full')
      h.exportResult.restoredPreview = await afterFullExport(h, d)
    },
  })
  add({
    name: 'export-full-transform-rotate+3',
    noChangeExpected: true,
    shots: ['preview', 'transform'],
    run: async (h, d) => {
      await d.setRotate(3)
      await d.closeTransform()
      await h.settle({ label: 'transform-edit' })
      h.exportResult = await runExport(h, d, 'full')
      h.exportResult.restoredPreview = await afterFullExport(h, d)
    },
  })

  if (!desktop)
    add({
      name: 'histogram-floating',
      shots: ['histogram'],
      run: async (h, d) => d.showHistogram(),
      after: async (h, d) => d.hideHistogram(),
    })

  add({
    name: 'replace-raw',
    shots: ['preview', 'histogram'],
    noReset: true,
    noChangeExpected: true,
    run: async (h, d) => {
      await d.replaceRaw(h.options.raw2)
      h.loadInfo = await waitForRawLoaded(h, h.options.raw2)
    },
  })
  add({
    name: 'session-reset',
    shots: [],
    noReset: true,
    noChangeExpected: true,
    run: async (h, d) => {
      await d.resetSession()
      await h.page
        .locator('.raw-lab[data-raw-lab-state="loaded"]')
        .waitFor({ state: 'detached', timeout: 60_000 })
    },
  })
  return list
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function cachedLutRoute(context, cacheDir, ledger) {
  await mkdir(cacheDir, { recursive: true })
  await context.route('https://luma-prof.ichr.me/**', async (route) => {
    const url = route.request().url()
    const key = sha256(url)
    const bodyFile = join(cacheDir, `${key}.body`)
    const metaFile = join(cacheDir, `${key}.json`)
    try {
      if (!existsSync(bodyFile)) {
        const response = await route.fetch()
        const body = await response.body()
        await writeFile(bodyFile, body)
        await writeFile(
          metaFile,
          JSON.stringify({
            url,
            status: response.status(),
            headers: response.headers(),
          }),
        )
      }
      const meta = JSON.parse(await readFile(metaFile, 'utf8'))
      const body = await readFile(bodyFile)
      ledger.push({ url, status: meta.status, sha256: sha256(body) })
      await route.fulfill({
        status: meta.status,
        headers: {
          'content-type': meta.headers['content-type'] ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
        },
        body,
      })
    } catch (error) {
      ledger.push({ url, error: error.message })
      await route.abort()
    }
  })
}

async function capture(options) {
  const surface = options.viewport
  const forced = options.forcePreview ?? (options.forceCpu ? 'cpu' : null)
  const outDir = resolve(options.out)
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true })
  await mkdir(join(outDir, 'scenarios'), { recursive: true })
  const url = new URL('/raw', options.url)
  if (forced) url.searchParams.set('forcePreview', forced)

  const run = {
    schemaVersion: 1,
    label: options.label,
    url: url.href,
    surface,
    forcedPreview: forced,
    raw: { path: options.raw, sha256: sha256(await readFile(options.raw)) },
    raw2: { path: options.raw2, sha256: sha256(await readFile(options.raw2)) },
    luts: await Promise.all(
      options.luts.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })),
    ),
    chromiumArgs: CHROMIUM_ARGS,
    contextOptions: VIEWPORTS[surface],
    startedAt: new Date().toISOString(),
    scenarios: [],
    lutNetwork: [],
    errors: [],
  }
  const browser = await chromium.launch({
    headless: !options.headed,
    args: CHROMIUM_ARGS,
  })
  run.browserVersion = browser.version()
  const context = await browser.newContext({
    ...VIEWPORTS[surface],
    acceptDownloads: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  })
  await context.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
    localStorage.setItem(
      'raw-tool-cards-open',
      JSON.stringify(['histogram', 'look', 'adjust', 'compare', 'fileFacts']),
    )
  })
  await context.addInitScript(installInstrumentation)
  await cachedLutRoute(context, options.lutCache, run.lutNetwork)
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const h = new Harness({ page, context, options, outDir, surface, preview: 'pending' })
  const d = surface === 'desktop' ? new DesktopDriver(h) : new MobileDriver(h)

  const writeRun = () =>
    writeFile(join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)

  try {
    logLine(`capture ${options.label} ${surface} ${url.href}`)
    await page.goto(url.href)
    await page.locator('[data-raw-lab-shell="viewport"]').waitFor()
    await d.loadRaw(options.raw)
    run.load = await waitForRawLoaded(h, options.raw)
    logLine(`loaded ${JSON.stringify(run.load)}`)
    const initial = await h.dom()
    h.preview = initial.cpuBanner || forced === 'cpu' ? 'cpu' : 'gpu'
    run.previewMode = h.preview
    const looks = await d.lookTitles().catch((error) => {
      run.errors.push({ phase: 'look-titles', message: error.message })
      return []
    })
    run.looks = looks
    const scenarios = buildScenarios({ surface, preview: h.preview, looks })
    const only = options.only ? new RegExp(options.only) : null
    const skip = options.skip ? new RegExp(options.skip) : null
    let index = 0
    for (const scenario of scenarios) {
      index++
      const enabled =
        (!only || only.test(scenario.name) || scenario.name === 'ingest-default') &&
        !(skip && skip.test(scenario.name))
      if (!enabled) continue
      const name = `${String(index).padStart(2, '0')}-${scenario.name}`
      h.scenarioDir = join(outDir, 'scenarios', name)
      await mkdir(h.scenarioDir, { recursive: true })
      h.actions = []
      h.exportResult = undefined
      h.loadInfo = undefined
      const errorMark = h.consoleErrors.length
      const pageErrorMark = h.pageErrors.length
      const toastMark = await h.pageNow().catch(() => 0)
      const started = Date.now()
      const record = { name, scenario: scenario.name, startedAt: new Date().toISOString() }
      logLine(`scenario ${name}`)
      try {
        if (!scenario.noReset && !scenario.keepEdits) {
          const reset = await neutralize(h, d, { keepLut: scenario.keepLut })
          record.reset = { changed: reset, actions: h.actions.splice(0) }
          record.reset.settle = await h.settle({ label: `${name} reset` })
        }
        const on = scenario.settleOn ?? 'preview'
        const before = scenario.noChangeExpected
          ? null
          : await h.previewHash(on).catch(() => null)
        await scenario.run(h, d)
        record.actions = h.actions.splice(0)
        record.settle =
          scenario.shots.length || !scenario.noChangeExpected
            ? await h.settle({ changeFrom: before, label: name, on })
            : null
        record.files = await captureShots(h, d, scenario.shots)
        if (h.exportResult) record.export = h.exportResult
        if (h.loadInfo) record.load = h.loadInfo
        record.status = 'ok'
      } catch (error) {
        record.status = 'error'
        record.error = error.message.split('\n').slice(0, 6).join('\n')
        record.actions = h.actions.splice(0)
        logLine(`  ${record.status}: ${record.error.split('\n')[0]}`)
        await page
          .screenshot({ path: join(h.scenarioDir, 'failure-page.png'), timeout: 120_000 })
          .catch(() => {})
        // Close stray dialogs so the next scenario starts from the workspace.
        await page.keyboard.press('Escape').catch(() => {})
      }
      try {
        record.dom = await h.dom()
        record.counters = await h.counters()
        record.toasts = (await h.toasts()).filter((toast) => toast.at >= toastMark)
        record.tracked = { dirty: { ...h.dirty }, lut: h.lut, strength: h.strength }
        h.renderSamples.push(renderSample(name, record.dom))
      } catch (error) {
        record.domError = error.message
      }
      if (scenario.after) await scenario.after(h, d).catch(() => {})
      record.consoleErrors = h.consoleErrors.slice(errorMark).map((entry) => entry.text)
      record.pageErrors = h.pageErrors.slice(pageErrorMark).map((entry) => entry.text)
      record.durationMs = Date.now() - started
      await writeFile(
        join(h.scenarioDir, 'state.json'),
        `${JSON.stringify(record, null, 2)}\n`,
      )
      run.scenarios.push({
        name,
        status: record.status,
        error: record.error,
        durationMs: record.durationMs,
        changed: record.settle?.changed ?? null,
        settleTimedOut: record.settle?.timedOut ?? null,
        exportSha256: record.export?.jpeg?.sha256 ?? null,
        consoleErrors: record.consoleErrors.length,
        pageErrors: record.pageErrors.length,
      })
      await writeRun()
      logLine(
        `  ${record.status} ${Math.round(record.durationMs / 1000)}s changed=${record.settle?.changed ?? '-'}${record.export?.jpeg ? ` jpeg=${record.export.jpeg.sha256.slice(0, 12)}` : ''}`,
      )
    }
  } catch (error) {
    run.errors.push({ phase: 'capture', message: error.message })
    logLine(`capture failed: ${error.message.split('\n')[0]}`)
    await page
      .screenshot({ path: join(outDir, 'failure-page.png'), timeout: 120_000 })
      .catch(() => {})
  } finally {
    run.renderer = await rendererEvidence(h).catch((error) => ({ error: error.message }))
    run.rendererSamples = h.renderSamples
    run.consoleErrors = h.consoleErrors.map((entry) => entry.text)
    run.consoleWarnings = h.consoleWarnings
    run.pageErrors = h.pageErrors.map((entry) => entry.text)
    run.finishedAt = new Date().toISOString()
    await writeRun()
    await browser.close()
  }
  const failed = run.scenarios.filter((scenario) => scenario.status !== 'ok')
  logLine(
    `done: ${run.scenarios.length} scenarios, ${failed.length} not ok, ${run.consoleErrors.length} console errors, ${run.pageErrors.length} page errors -> ${outDir}`,
  )
  return run
}

// Evidence for which renderer drew the preview, gathered from instrumentation
// that has been watching since before the app booted.
async function rendererEvidence(h) {
  const evidence = await h.page.evaluate(() => {
    const qa = window.__lfQa
    return {
      contextRequests: qa?.contextRequests ?? [],
      gl: qa ? { ...qa.gl } : null,
      gpu: qa ? { ...qa.gpu } : null,
      ctx2d: qa ? { ...qa.ctx2d } : null,
      navigatorGpu: 'gpu' in navigator,
    }
  })
  // The run ends on an empty session, so the preview canvases are gone; keep
  // the last scenario that still showed a preview.
  evidence.sample =
    [...h.renderSamples].reverse().find((sample) => sample.previewCanvas) ?? null
  return evidence
}

function renderSample(scenario, dom) {
  const describe = (canvas) =>
    canvas && {
      className: canvas.className,
      size: [canvas.width, canvas.height],
      contextTypes: canvas.contextTypes,
      renderBackend: canvas.dataset?.renderBackend ?? null,
      webglRenderer: canvas.webgl?.renderer ?? null,
      webglLost: canvas.webgl?.lost ?? null,
      webgpuConfigured: canvas.webgpu?.configured ?? null,
    }
  const processed =
    dom.canvases.find((canvas) => canvas.className.includes('raw-preview-canvas')) ??
    dom.canvases.find(
      (canvas) => !canvas.inTransformOverlay && canvas.contextTypes.includes('2d'),
    )
  const original = dom.canvases.find((canvas) =>
    canvas.className.includes('original'),
  )
  return {
    scenario,
    previewCanvas: describe(processed),
    originalCanvas: describe(original),
    cpuBanner: dom.cpuBanner,
    compareMode: dom.compareMode,
  }
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

async function listScenarioDirs(root) {
  const base = join(root, 'scenarios')
  if (!existsSync(base)) return new Map()
  const entries = await readdir(base, { withFileTypes: true })
  const map = new Map()
  for (const entry of entries)
    if (entry.isDirectory()) map.set(entry.name.replace(/^\d+-/, ''), join(base, entry.name))
  return map
}

const STATE_IGNORE = [
  /^counters\b/,
  /^durationMs$/,
  /^startedAt$/,
  /^name$/,
  /\.waitedMs$/,
  /\.iterations$/,
  /^settle\.hash$/,
  /^reset\.settle\.hash$/,
  /^dom\.canvases\.\d+\.(contextTypes|dataset|webgl|webgpu)/,
  /^dom\.renderBackends/,
  /^toasts\.\d+\.at$/,
  /^export\.elapsedMs$/,
  /^export\.(jpeg|manifest)\.file$/,
  /^export\.manifest\.(sha256|bytes)$/,
  /^files\./,
  /^consoleErrors/,
  /^pageErrors/,
  /^load\.(loadedMs|hqMs)$/,
]

function flatten(value, prefix = '', out = {}) {
  if (value && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value)
    if (!entries.length) out[prefix] = Array.isArray(value) ? '[]' : '{}'
    for (const [key, item] of entries)
      flatten(item, prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value
  }
  return out
}

function normalizeStateValue(path, value) {
  if (typeof value !== 'string') return value
  // Timings are not behaviour.
  return value
    .replace(/\bRender \d+ ms\b/g, 'Render <n> ms')
    .replace(/\b\d+(?:\.\d+)? ?ms\b/g, '<n> ms')
}

function diffStates(a, b) {
  const left = flatten(a)
  const right = flatten(b)
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const diffs = []
  for (const key of [...keys].sort()) {
    if (STATE_IGNORE.some((pattern) => pattern.test(key))) continue
    const x = normalizeStateValue(key, left[key])
    const y = normalizeStateValue(key, right[key])
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ path: key, a: x, b: y })
  }
  return diffs
}

let jpegBrowser = null
async function diffJpegs(fileA, fileB) {
  jpegBrowser ??= await chromium.launch({ headless: true })
  const page = await jpegBrowser.newPage()
  try {
    const [a, b] = await Promise.all([readFile(fileA), readFile(fileB)])
    return await page.evaluate(
      async ({ a, b }) => {
        const decode = async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none',
          })
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext('2d', { willReadFrequently: true })
          context.drawImage(bitmap, 0, 0)
          const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
          return { width: bitmap.width, height: bitmap.height, data }
        }
        const x = await decode(a)
        const y = await decode(b)
        if (x.width !== y.width || x.height !== y.height)
          return { sizeMismatch: [[x.width, x.height], [y.width, y.height]] }
        let max = 0
        let sum = 0
        let over1 = 0
        let over2 = 0
        const pixels = x.width * x.height
        for (let index = 0; index < pixels; index++) {
          const o = index * 4
          let pixelMax = 0
          for (let channel = 0; channel < 3; channel++) {
            const error = Math.abs(x.data[o + channel] - y.data[o + channel])
            sum += error
            if (error > pixelMax) pixelMax = error
          }
          if (pixelMax > max) max = pixelMax
          if (pixelMax > 1) over1++
          if (pixelMax > 2) over2++
        }
        return {
          size: [x.width, x.height],
          max,
          mean: sum / (pixels * 3),
          pctOver1: (100 * over1) / pixels,
          pctOver2: (100 * over2) / pixels,
        }
      },
      { a: a.toString('base64'), b: b.toString('base64') },
    )
  } finally {
    await page.close()
  }
}

async function compare(options) {
  const rootA = resolve(options.a)
  const rootB = resolve(options.b)
  const readRun = async (root) =>
    existsSync(join(root, 'run.json'))
      ? JSON.parse(await readFile(join(root, 'run.json'), 'utf8'))
      : null
  const [runA, runB] = await Promise.all([readRun(rootA), readRun(rootB)])
  const dirsA = await listScenarioDirs(rootA)
  const dirsB = await listScenarioDirs(rootB)
  const names = [...new Set([...dirsA.keys(), ...dirsB.keys()])]
  const order = (name) => {
    const dir = dirsA.get(name) ?? dirsB.get(name)
    return basename(dir)
  }
  names.sort((x, y) => order(x).localeCompare(order(y)))
  const report = {
    schemaVersion: 1,
    a: { dir: rootA, label: runA?.label, surface: runA?.surface, previewMode: runA?.previewMode, load: runA?.load },
    b: { dir: rootB, label: runB?.label, surface: runB?.surface, previewMode: runB?.previewMode, load: runB?.load },
    renderer: { a: summarizeRenderer(runA), b: summarizeRenderer(runB) },
    scenarios: [],
    totals: {},
  }
  const rows = []
  for (const name of names) {
    const dirA = dirsA.get(name)
    const dirB = dirsB.get(name)
    const entry = { scenario: name, inA: Boolean(dirA), inB: Boolean(dirB), images: [], exports: [] }
    report.scenarios.push(entry)
    if (!dirA || !dirB) {
      rows.push([name, 'missing', '', '', '', '', '', dirA ? 'only A' : 'only B'])
      continue
    }
    const stateA = JSON.parse(await readFile(join(dirA, 'state.json'), 'utf8'))
    const stateB = JSON.parse(await readFile(join(dirB, 'state.json'), 'utf8'))
    entry.status = [stateA.status, stateB.status]
    entry.stateDiffs = diffStates(stateA, stateB)
    entry.consoleErrors = [stateA.consoleErrors?.length ?? 0, stateB.consoleErrors?.length ?? 0]
    const files = new Set([
      ...(await readdir(dirA)).filter((file) => file.endsWith('.png') && !file.startsWith('failure')),
      ...(await readdir(dirB)).filter((file) => file.endsWith('.png') && !file.startsWith('failure')),
    ])
    for (const file of [...files].sort()) {
      const fileA = join(dirA, file)
      const fileB = join(dirB, file)
      if (!existsSync(fileA) || !existsSync(fileB)) {
        entry.images.push({ file, missing: existsSync(fileA) ? 'B' : 'A' })
        rows.push([name, file, 'missing', '', '', '', '', ''])
        continue
      }
      const [bufferA, bufferB] = await Promise.all([readFile(fileA), readFile(fileB)])
      const a = decodePng(bufferA)
      const b = decodePng(bufferB)
      if (a.width !== b.width || a.height !== b.height) {
        entry.images.push({ file, sizeMismatch: [[a.width, a.height], [b.width, b.height]] })
        rows.push([name, file, `${a.width}x${a.height}≠${b.width}x${b.height}`, '', '', '', '', ''])
        continue
      }
      const stats = diffRgba(a.rgba, b.rgba, a.width, a.height, Boolean(options.diffImages))
      const { image, ...summary } = stats
      entry.images.push({ file, size: [a.width, a.height], identical: bufferA.equals(bufferB) || stats.max === 0, ...summary })
      if (image && stats.max > 0) {
        const target = join(resolve(options.diffImages), name, file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, encodePngRgb(a.width, a.height, image))
      }
      rows.push([
        name,
        file,
        `${a.width}x${a.height}`,
        String(stats.max),
        stats.mean.toFixed(4),
        stats.pctOver1.toFixed(3),
        stats.pctOver2.toFixed(3),
        entry.stateDiffs.length ? `${entry.stateDiffs.length} state diffs` : '',
      ])
    }
    for (const exportName of ['export-full.jpg', 'export-hq-preview.jpg']) {
      const fileA = join(dirA, exportName)
      const fileB = join(dirB, exportName)
      if (!existsSync(fileA) && !existsSync(fileB)) continue
      if (!existsSync(fileA) || !existsSync(fileB)) {
        entry.exports.push({ file: exportName, missing: existsSync(fileA) ? 'B' : 'A' })
        rows.push([name, exportName, 'missing', '', '', '', '', ''])
        continue
      }
      const [x, y] = await Promise.all([readFile(fileA), readFile(fileB)])
      const result = { file: exportName, sha256: [sha256(x), sha256(y)], equal: sha256(x) === sha256(y) }
      if (!result.equal && !options.noJpegPixels)
        result.pixels = await diffJpegs(fileA, fileB).catch((error) => ({ error: error.message }))
      entry.exports.push(result)
      rows.push([
        name,
        exportName,
        result.equal ? 'sha256 equal' : 'sha256 DIFFERS',
        result.pixels?.max != null ? String(result.pixels.max) : '',
        result.pixels?.mean != null ? result.pixels.mean.toFixed(4) : '',
        result.pixels?.pctOver1 != null ? result.pixels.pctOver1.toFixed(3) : '',
        result.pixels?.pctOver2 != null ? result.pixels.pctOver2.toFixed(3) : '',
        result.sha256[0].slice(0, 12),
      ])
    }
    if (!entry.images.length && !entry.exports.length)
      rows.push([name, '(state only)', '', '', '', '', '', entry.stateDiffs.length ? `${entry.stateDiffs.length} state diffs` : 'state equal'])
  }
  await jpegBrowser?.close()
  const images = report.scenarios.flatMap((entry) => entry.images.filter((image) => image.size))
  const exports = report.scenarios.flatMap((entry) => entry.exports.filter((item) => item.sha256))
  report.totals = {
    scenarios: names.length,
    images: images.length,
    identicalImages: images.filter((image) => image.identical).length,
    maxPixelError: images.reduce((max, image) => Math.max(max, image.max), 0),
    worstPctOver2: images.reduce((max, image) => Math.max(max, image.pctOver2), 0),
    exports: exports.length,
    exportsEqual: exports.filter((item) => item.equal).length,
    scenariosWithStateDiffs: report.scenarios.filter((entry) => entry.stateDiffs?.length).length,
    statusMismatches: report.scenarios.filter(
      (entry) => entry.status && entry.status[0] !== entry.status[1],
    ).length,
  }
  await mkdir(dirname(resolve(options.out)), { recursive: true })
  await writeFile(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`)
  printTable(
    ['scenario', 'file', 'size/result', 'max', 'mean', '%>1', '%>2', 'note'],
    rows,
  )
  process.stdout.write(`\nrenderer A: ${JSON.stringify(report.renderer.a)}\n`)
  process.stdout.write(`renderer B: ${JSON.stringify(report.renderer.b)}\n`)
  process.stdout.write(`totals: ${JSON.stringify(report.totals)}\n`)
  for (const entry of report.scenarios)
    for (const diff of (entry.stateDiffs ?? []).slice(0, 8))
      process.stdout.write(
        `  state ${entry.scenario}: ${diff.path}: ${JSON.stringify(diff.a)?.slice(0, 120)} -> ${JSON.stringify(diff.b)?.slice(0, 120)}\n`,
      )
  process.stdout.write(`report: ${resolve(options.out)}\n`)
  return report
}

function summarizeRenderer(run) {
  if (!run) return null
  const sample = run.renderer?.sample
  return {
    previewMode: run.previewMode,
    forcedPreview: run.forcedPreview,
    contextTypes: [...new Set((run.renderer?.contextRequests ?? []).map((entry) => `${entry.type}${entry.className ? `(${entry.className.split(' ')[0]})` : ''}`))],
    glDraws: run.renderer?.gl?.draw ?? null,
    gpuSubmits: run.renderer?.gpu?.submit ?? null,
    gpuAdapters: run.renderer?.gpu?.adapters ?? null,
    previewCanvas: sample?.previewCanvas ?? null,
    cpuBanner: sample?.cpuBanner ?? null,
    compareMode: sample?.compareMode ?? null,
  }
}

function printTable(header, rows) {
  const widths = header.map((title, column) =>
    Math.min(48, Math.max(title.length, ...rows.map((row) => String(row[column] ?? '').length))),
  )
  const line = (cells) =>
    cells
      .map((cell, column) => String(cell ?? '').slice(0, widths[column]).padEnd(widths[column]))
      .join(' | ')
  process.stdout.write(`${line(header)}\n${widths.map((width) => '-'.repeat(width)).join('-+-')}\n`)
  for (const row of rows) process.stdout.write(`${line(row)}\n`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'url': { type: 'string' },
    'raw': { type: 'string', default: DEFAULTS.raw },
    'raw2': { type: 'string', default: DEFAULTS.raw2 },
    'lut': { type: 'string', multiple: true },
    'out': { type: 'string' },
    'label': { type: 'string', default: 'run' },
    'viewport': { type: 'string', default: 'desktop' },
    'force-cpu': { type: 'boolean', default: false },
    'force-preview': { type: 'string' },
    'only': { type: 'string' },
    'skip': { type: 'string' },
    'hq-timeout': { type: 'string', default: '300' },
    'change-timeout': { type: 'string', default: '90' },
    'quiet-ms': { type: 'string', default: '1500' },
    'lut-cache': { type: 'string', default: DEFAULTS.lutCache },
    'headed': { type: 'boolean', default: false },
    'a': { type: 'string' },
    'b': { type: 'string' },
    'diff-images': { type: 'string' },
    'no-jpeg-pixels': { type: 'boolean', default: false },
    'help': { type: 'boolean', default: false },
  },
})

const mode = positionals[0]
if (values.help || !mode) {
  process.stdout.write(`${usage}\n`)
  process.exit(values.help ? 0 : 1)
}

if (mode === 'capture') {
  if (!values.url || !values.out) {
    process.stderr.write(`${usage}\n`)
    process.exit(1)
  }
  if (!VIEWPORTS[values.viewport]) throw new Error(`UNKNOWN_VIEWPORT ${values.viewport}`)
  const luts = values.lut?.length ? values.lut : DEFAULTS.luts
  for (const file of [values.raw, values.raw2, ...luts])
    if (!existsSync(file)) throw new Error(`MISSING_INPUT ${file}`)
  const run = await capture({
    url: values.url,
    raw: resolve(values.raw),
    raw2: resolve(values.raw2),
    luts: luts.map((file) => resolve(file)),
    out: values.out,
    label: values.label,
    viewport: values.viewport,
    forceCpu: values['force-cpu'],
    forcePreview: values['force-preview'],
    only: values.only,
    skip: values.skip,
    hqTimeoutMs: Number(values['hq-timeout']) * 1000,
    changeTimeoutMs: Number(values['change-timeout']) * 1000,
    quietMs: Number(values['quiet-ms']),
    lutCache: resolve(values['lut-cache']),
    headed: values.headed,
  })
  if (run.errors.length || run.scenarios.some((scenario) => scenario.status !== 'ok'))
    process.exitCode = 1
} else if (mode === 'compare') {
  if (!values.a || !values.b || !values.out) {
    process.stderr.write(`${usage}\n`)
    process.exit(1)
  }
  await compare({
    a: values.a,
    b: values.b,
    out: values.out,
    diffImages: values['diff-images'],
    noJpegPixels: values['no-jpeg-pixels'],
  })
} else if (mode === 'list') {
  const scenarios = buildScenarios({
    surface: values.viewport,
    preview: values['force-cpu'] ? 'cpu' : 'gpu',
    looks: ['<each catalog look>'],
  })
  for (const scenario of scenarios)
    process.stdout.write(`${scenario.name}  [${scenario.shots.join(', ')}]\n`)
} else {
  process.stderr.write(`${usage}\n`)
  process.exit(1)
}
