import type { DecodedImage } from '~/lib/raw/decoder'
import { QUICK_PREVIEW_MAX_PIXELS } from '~/lib/raw/decoder'

/** Recover a bounded CPU input when a GPU device is lost after the HQ upgrade.
 * Keep the authoritative decoded source intact; the client owns its own copy. */
export function createCpuRecoverySource(
  image: DecodedImage,
  maxPixels = QUICK_PREVIEW_MAX_PIXELS,
) {
  if (
    image.layout !== 'rgb-u16' ||
    image.colorSpace !== 'linear-prophoto-rgb' ||
    !(image.data instanceof Uint16Array) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 3
  )
    return null
  const scale = Math.min(
    1,
    Math.sqrt(Math.max(1, maxPixels) / (image.width * image.height)),
  )
  const width = Math.max(1, Math.floor(image.width * scale))
  const height = Math.max(1, Math.floor(image.height * scale))
  if (width === image.width && height === image.height)
    return { width, height, data: image.data }
  const data = new Uint16Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor(((y + 0.5) * image.height) / height),
    )
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor(((x + 0.5) * image.width) / width),
      )
      const source = (sourceY * image.width + sourceX) * 3
      const target = (y * width + x) * 3
      data[target] = image.data[source]
      data[target + 1] = image.data[source + 1]
      data[target + 2] = image.data[source + 2]
    }
  }
  return { width, height, data }
}
