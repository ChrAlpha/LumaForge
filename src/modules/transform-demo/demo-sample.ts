import type { PreviewSource } from './preview-types'

export function createDemoSample(): PreviewSource {
  const width = 1200
  const height = 800
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  const project = (x: number, y: number) => {
    const z = 1 - 0.42 * (y - 0.5)
    const px = ((x - 0.5) / z) * width
    const py = ((y - 0.5) / z) * height
    const angle = (6 * Math.PI) / 180
    return [
      width / 2 + px * Math.cos(angle) - py * Math.sin(angle),
      height / 2 + px * Math.sin(angle) + py * Math.cos(angle),
    ]
  }
  function rectangle(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
  ) {
    context.fillStyle = color
    context.beginPath()
    for (const [index, point] of [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ].entries()) {
      const [px, py] = project(point[0], point[1])
      if (index === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    }
    context.closePath()
    context.fill()
  }
  context.fillStyle = 'rgb(168 186 191)'
  context.fillRect(0, 0, width, height)
  rectangle(0.13, 0.1, 0.74, 0.79, 'rgb(206 197 175)')
  rectangle(0.115, 0.09, 0.77, 0.027, 'rgb(121 124 115)')
  rectangle(0.1, 0.89, 0.8, 0.04, 'rgb(125 134 135)')
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      const x = 0.16 + col * 0.1
      const y = 0.145 + row * 0.117
      rectangle(x, y, 0.074, 0.081, 'rgb(74 96 110)')
      rectangle(x + 0.004, y + 0.005, 0.03, 0.066, 'rgb(109 144 157)')
      rectangle(x + 0.04, y + 0.005, 0.03, 0.066, 'rgb(128 156 165)')
      rectangle(x - 0.006, y + 0.081, 0.086, 0.009, 'rgb(238 231 213)')
    }
    rectangle(0.13, 0.241 + row * 0.117, 0.74, 0.008, 'rgb(175 169 152)')
  }
  for (let col = 0; col < 8; col++)
    rectangle(0.14 + col * 0.1, 0.12, 0.009, 0.758, 'rgb(232 222 201)')
  return {
    frame: {
      width,
      height,
      data: context.getImageData(0, 0, width, height).data,
    },
    name: 'perspective-study.png',
    kind: 'sample',
    originalWidth: width,
    originalHeight: height,
  }
}
