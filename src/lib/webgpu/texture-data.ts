import type { RawUploadInput } from '~/lib/gl/pipeline'

export function validateImageUpload(
  input: RawUploadInput,
  maxDimension: number,
) {
  const { width, height, data } = input
  const channels = input.layout === 'rgb-u16' ? 3 : 4
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > maxDimension ||
    height > maxDimension ||
    data.length !== width * height * channels
  )
    throw new Error('GPU_IMAGE_LAYOUT_INVALID')
}

/** Bound transient upload memory; WebGPU has no three-channel U16 format. */
export function uploadRgb16(
  device: GPUDevice,
  texture: GPUTexture,
  input: Extract<RawUploadInput, { layout: 'rgb-u16' }>,
) {
  const rows = Math.min(
    input.height,
    Math.max(1, Math.floor((4 * 1024 * 1024) / (input.width * 8))),
  )
  const staging = new Uint16Array(input.width * rows * 4)
  for (let y = 0; y < input.height; y += rows) {
    const count = Math.min(rows, input.height - y)
    for (let pixel = 0; pixel < input.width * count; pixel++) {
      const source = (y * input.width + pixel) * 3
      const target = pixel * 4
      staging[target] = input.data[source]
      staging[target + 1] = input.data[source + 1]
      staging[target + 2] = input.data[source + 2]
      staging[target + 3] = 65535
    }
    device.queue.writeTexture(
      { texture, origin: [0, y] },
      staging,
      { bytesPerRow: input.width * 8 },
      [input.width, count],
    )
  }
}

export function padLut(data: Float32Array): Float32Array<ArrayBuffer> {
  if (data.length % 3 !== 0) throw new Error('GPU_LUT_LAYOUT_INVALID')
  const padded = new Float32Array((data.length / 3) * 4)
  for (
    let source = 0, target = 0;
    source < data.length;
    source += 3, target += 4
  ) {
    padded[target] = data[source]
    padded[target + 1] = data[source + 1]
    padded[target + 2] = data[source + 2]
    padded[target + 3] = 1
  }
  return padded
}

export function decodeFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >>> 10) & 31
  const fraction = bits & 1023
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 31)
    return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

/** Readback is explicit and asynchronous; never part of an interactive frame. */
export async function readFloat16Texture(
  device: GPUDevice,
  texture: GPUTexture,
) {
  const { width, height } = texture
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256
  const buffer = device.createBuffer({
    label: 'raw-preview-readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  try {
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [
      width,
      height,
    ])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const mapped = new Uint16Array(buffer.getMappedRange())
    const pixels = new Float32Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * 4; x++) {
        pixels[y * width * 4 + x] = decodeFloat16(
          mapped[(y * bytesPerRow) / 2 + x],
        )
      }
    }
    return pixels
  } finally {
    if (buffer.mapState === 'mapped') buffer.unmap()
    buffer.destroy()
  }
}
