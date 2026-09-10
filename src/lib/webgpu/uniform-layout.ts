export const UNIFORM_BUFFER_SIZE = 240

export interface UniformFieldMap {
  offset: number
  type: 'f32' | 'i32' | 'vec2f' | 'vec3f' | 'mat3x3f'
}

export const UNIFORM_FIELDS: Record<string, UniformFieldMap> = {
  inputToLutGamut: { offset: 0, type: 'mat3x3f' },
  lutOutputToDisplayGamut: { offset: 48, type: 'mat3x3f' },
  lutDomainMin: { offset: 96, type: 'vec3f' },
  intensity: { offset: 108, type: 'f32' },
  lutDomainMax: { offset: 112, type: 'vec3f' },
  rawRenderExposureMultiplier: { offset: 124, type: 'f32' },
  userColorBalanceGain: { offset: 128, type: 'vec3f' },
  userExposureMultiplier: { offset: 140, type: 'f32' },
  userContrastAmount: { offset: 144, type: 'f32' },
  userContrastFactor: { offset: 148, type: 'f32' },
  userHighlights: { offset: 152, type: 'f32' },
  userShadows: { offset: 156, type: 'f32' },
  userWhites: { offset: 160, type: 'f32' },
  userBlacks: { offset: 164, type: 'f32' },
  userSaturation: { offset: 168, type: 'f32' },
  userVibrance: { offset: 172, type: 'f32' },
  compareSplit: { offset: 176, type: 'f32' },
  lutSize: { offset: 180, type: 'f32' },
  selectiveColorChromaClamp: { offset: 184, type: 'vec2f' },
  viewMode: { offset: 192, type: 'i32' },
  styleKind: { offset: 196, type: 'i32' },
  builtinPreset: { offset: 200, type: 'i32' },
  useLut: { offset: 204, type: 'i32' },
  lutInputTransfer: { offset: 208, type: 'i32' },
  lutOutputTransfer: { offset: 212, type: 'i32' },
  lutRole: { offset: 216, type: 'i32' },
  lutInputRange: { offset: 220, type: 'i32' },
  lutOutputRange: { offset: 224, type: 'i32' },
  selectiveColorActive: { offset: 228, type: 'i32' },
}

export function writeUniformF32(
  view: DataView,
  field: string,
  value: number,
): void {
  const f = UNIFORM_FIELDS[field]
  if (f) view.setFloat32(f.offset, value, true)
}

export function writeUniformI32(
  view: DataView,
  field: string,
  value: number,
): void {
  const f = UNIFORM_FIELDS[field]
  if (f) view.setInt32(f.offset, value, true)
}

export function writeUniformVec3f(
  view: DataView,
  field: string,
  x: number,
  y: number,
  z: number,
): void {
  const f = UNIFORM_FIELDS[field]
  if (!f) return
  view.setFloat32(f.offset, x, true)
  view.setFloat32(f.offset + 4, y, true)
  view.setFloat32(f.offset + 8, z, true)
}

export function writeUniformVec2f(
  view: DataView,
  field: string,
  x: number,
  y: number,
): void {
  const f = UNIFORM_FIELDS[field]
  if (!f) return
  view.setFloat32(f.offset, x, true)
  view.setFloat32(f.offset + 4, y, true)
}

export function writeUniformMat3x3f(
  view: DataView,
  field: string,
  colMajorData: Float32Array,
): void {
  const f = UNIFORM_FIELDS[field]
  if (!f) return
  for (let col = 0; col < 3; col++) {
    const colOffset = f.offset + col * 16
    for (let row = 0; row < 3; row++) {
      view.setFloat32(colOffset + row * 4, colMajorData[col * 3 + row], true)
    }
  }
}
