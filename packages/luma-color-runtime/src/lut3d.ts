export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function mix(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function sampleLutTrilinear(
  data: Float32Array,
  size: number,
  r: number,
  g: number,
  b: number,
  output: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const maxIndex = Math.max(0, size - 1)
  const x = clamp01(r) * maxIndex
  const y = clamp01(g) * maxIndex
  const z = clamp01(b) * maxIndex

  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const z0 = Math.floor(z)
  const x1 = Math.min(maxIndex, x0 + 1)
  const y1 = Math.min(maxIndex, y0 + 1)
  const z1 = Math.min(maxIndex, z0 + 1)

  const tx = x - x0
  const ty = y - y0
  const tz = z - z0

  const index000 = ((z0 * size + y0) * size + x0) * 3
  const index100 = ((z0 * size + y0) * size + x1) * 3
  const index010 = ((z0 * size + y1) * size + x0) * 3
  const index110 = ((z0 * size + y1) * size + x1) * 3
  const index001 = ((z1 * size + y0) * size + x0) * 3
  const index101 = ((z1 * size + y0) * size + x1) * 3
  const index011 = ((z1 * size + y1) * size + x0) * 3
  const index111 = ((z1 * size + y1) * size + x1) * 3

  for (let channel = 0; channel < 3; channel += 1) {
    const c00 = mix(
      data[index000 + channel] ?? 0,
      data[index100 + channel] ?? 0,
      tx,
    )
    const c10 = mix(
      data[index010 + channel] ?? 0,
      data[index110 + channel] ?? 0,
      tx,
    )
    const c01 = mix(
      data[index001 + channel] ?? 0,
      data[index101 + channel] ?? 0,
      tx,
    )
    const c11 = mix(
      data[index011 + channel] ?? 0,
      data[index111 + channel] ?? 0,
      tx,
    )
    const c0 = mix(c00, c10, ty)
    const c1 = mix(c01, c11, ty)
    output[channel] = mix(c0, c1, tz)
  }

  return output
}
