/**
 * Chromium flags for a software WebGPU adapter (SwiftShader over Vulkan).
 * Canvas presentation of WebGPU frames needs the ANGLE compositor too.
 */
export const SOFTWARE_WEBGPU_CHROMIUM_ARGS = Object.freeze([
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-vulkan-surface',
  '--use-angle=swiftshader',
])
