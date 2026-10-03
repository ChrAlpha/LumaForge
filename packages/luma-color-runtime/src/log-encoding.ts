/**
 * Log encoding/decoding functions for various camera log formats.
 * Implements transfer functions matching industry-standard log curves.
 */

import { warn } from './warnings'

/**
 * Log encoding function signature
 */
export type LogEncodingFn = (linear: number) => number
export type LogDecodingFn = (encoded: number) => number

export type TransferFunctionId =
  | 's-log2'
  | 's-log3'
  | 'canon-log'
  | 'canon-log2'
  | 'canon-log3'
  | 'n-log'
  | 'f-log'
  | 'f-log2'
  | 'f-log2c'
  | 'v-log'
  | 'logc3'
  | 'logc4'
  | 'log3g10'
  | 'acescc'
  | 'acescct'
  | 'srgb'
  | 'bt709'
  | 'gamma24'
  | 'apple-log'
  | 'dji-d-log'
  | 'l-log'
  | 'linear'

export interface TransferFunctionReferencePoint {
  label: string
  linear: number
  encoded: number
}

export interface TransferFunctionMetadata {
  id: TransferFunctionId
  label: string
  encode: LogEncodingFn
  decode: LogDecodingFn
  aliases: string[]
  source: string
  referencePoints: TransferFunctionReferencePoint[]
}

const TRANSFER_SOURCE_URLS: Record<TransferFunctionId, string> = {
  's-log2': 'https://www.sony.com/electronics/support/articles/00145908',
  's-log3':
    'https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf',
  'canon-log':
    'https://www.usa.canon.com/content/dam/canon-assets/white-papers/pro/white-paper-canon-log-gamma-curves.pdf',
  'canon-log2':
    'https://www.usa.canon.com/content/dam/canon-assets/white-papers/pro/white-paper-canon-log-gamma-curves.pdf',
  'canon-log3':
    'https://www.usa.canon.com/content/dam/canon-assets/white-papers/pro/white-paper-canon-log-gamma-curves.pdf',
  'n-log': 'https://downloadcenter.nikonimglib.com/en/download/sw/258.html',
  'f-log':
    'https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.2.pdf',
  'f-log2':
    'https://dl.fujifilm-x.com/support/lut/F-Log2_DataSheet_E_Ver.1.0.pdf',
  'f-log2c':
    'https://dl.fujifilm-x.com/support/lut/F-Log2C_DataSheet_E_Ver.1.0.pdf',
  'v-log':
    'https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf',
  logc3:
    'https://www.arri.com/en/learn-help/learn-help-camera-system/image-science/log-c',
  logc4:
    'https://www.arri.com/resource/blob/278790/f3318e8c9c65617d8c5ca3f8b3e32051/2023-05-arri-logc4-specification-data.pdf',
  log3g10:
    'https://www.red.com/download/white-paper-on-redwidegamutrgb-and-log3g10',
  acescc: 'https://docs.acescentral.com/encodings/acescc/',
  acescct: 'https://docs.acescentral.com/encodings/acescct/',
  srgb: 'https://www.w3.org/Graphics/Color/srgb.pdf',
  bt709: 'https://www.itu.int/rec/R-REC-BT.709',
  gamma24:
    'https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1886-0-201103-I!!PDF-E.pdf',
  'apple-log':
    'https://raw.githubusercontent.com/ampas/aces-dev/528c78fe2c0f4e7eb322581e98aba05de79466cb/transforms/ctl/idt/vendorSupplied/apple/IDT.Apple.AppleLog_BT2020.ctl',
  'dji-d-log':
    'https://dl.djicdn.com/downloads/DJI_Ronin_4D/X9_D_Log_D_Gamut_Whitepaper.pdf',
  'l-log':
    'https://leica-camera.com/sites/default/files/pm-101409-l-log_reference_manual_v1.4.pdf',
  linear: 'https://en.wikipedia.org/wiki/Linear_light',
}

/**
 * S-Log2 encoding (Sony)
 */
export function sLog2Encode(linear: number): number {
  // S-Log2 is log-based with a hard real domain limit, so sub-black linear has
  // no signed extension; clamp to the curve black to stay finite and match the
  // WGSL encoder for consistent LUT-domain sampling.
  const reflectedLinear = 0.9 * Math.max(linear, 0)
  return 0.432699 * Math.log10(reflectedLinear + 0.037584) + 0.616596 + 0.03
}

export function sLog2Decode(encoded: number): number {
  return (Math.pow(10, (encoded - 0.03 - 0.616596) / 0.432699) - 0.037584) / 0.9
}

/**
 * S-Log3 encoding (Sony)
 * Reference: S-Log3 Technical Summary
 */
export function sLog3Encode(linear: number): number {
  if (linear >= 0.01125) {
    return (420 + Math.log10((linear + 0.01) / (0.18 + 0.01)) * 261.5) / 1023
  }
  return ((linear * (171.2102946929 - 95)) / 0.01125 + 95) / 1023
}

export function sLog3Decode(encoded: number): number {
  const x = encoded * 1023
  if (x >= 171.2102946929) {
    return Math.pow(10, (x - 420) / 261.5) * (0.18 + 0.01) - 0.01
  }
  return ((x - 95) * 0.01125) / (171.2102946929 - 95)
}

/**
 * V-Log encoding (Panasonic)
 * Reference: V-Log/V-Gamut Technical Documents
 */
export function vLogEncode(linear: number): number {
  const b = 0.00873
  const c = 0.241514
  const d = 0.598206

  if (linear < 0.01) {
    return 5.6 * linear + 0.125
  }
  return c * Math.log10(linear + b) + d
}

export function vLogDecode(encoded: number): number {
  const b = 0.00873
  const c = 0.241514
  const d = 0.598206

  if (encoded < 0.181) {
    return (encoded - 0.125) / 5.6
  }
  return Math.pow(10, (encoded - d) / c) - b
}

/**
 * F-Log encoding (Fujifilm)
 * Reference: F-Log Data Sheet
 */
export function fLogEncode(linear: number): number {
  const a = 0.555556
  const b = 0.009468
  const c = 0.344676
  const d = 0.790453
  const e = 8.735631
  const f = 0.092864
  const cut = 0.00089

  if (linear < cut) {
    return e * linear + f
  }
  return c * Math.log10(a * linear + b) + d
}

export function fLogDecode(encoded: number): number {
  const a = 0.555556
  const b = 0.009468
  const c = 0.344676
  const d = 0.790453
  const e = 8.735631
  const f = 0.092864
  const cut = 0.100537775223865

  if (encoded < cut) {
    return (encoded - f) / e
  }
  return (Math.pow(10, (encoded - d) / c) - b) / a
}

/**
 * F-Log2 encoding (Fujifilm)
 */
export function fLog2Encode(linear: number): number {
  const a = 5.555556
  const b = 0.064829
  const c = 0.245281
  const d = 0.384316
  const e = 8.799461
  const f = 0.092864
  const cut = 0.000889

  if (linear < cut) {
    return e * linear + f
  }
  return c * Math.log10(a * linear + b) + d
}

export function fLog2Decode(encoded: number): number {
  const a = 5.555556
  const b = 0.064829
  const c = 0.245281
  const d = 0.384316
  const e = 8.799461
  const f = 0.092864
  const cut = 0.100686685370811

  if (encoded < cut) {
    return (encoded - f) / e
  }
  return (Math.pow(10, (encoded - d) / c) - b) / a
}

/**
 * N-Log encoding (Nikon)
 */
export function nLogEncode(linear: number): number {
  const a = 650 / 1023
  const b = 0.0075
  const c = 150 / 1023
  const d = 619 / 1023
  const cut = 0.328

  if (linear < cut) {
    // Real cube root extends the toe through zero (matching the cubic decode)
    // instead of going NaN for sub-black linear values.
    return Math.cbrt(linear) * a + b
  }
  return Math.log(linear) * c + d
}

export function nLogDecode(encoded: number): number {
  const a = 650 / 1023
  const b = 0.0075
  const c = 150 / 1023
  const d = 619 / 1023
  const cut = Math.pow(0.328, 1 / 3) * a + b

  if (encoded < cut) {
    return Math.pow((encoded - b) / a, 3)
  }
  return Math.exp((encoded - d) / c)
}

/**
 * Canon Log encoding
 */
export function canonLogEncode(linear: number): number {
  const a = 0.529136
  const b = 10.1596
  const c = 0.0730597

  if (linear < 0) {
    return -a * Math.log10(-b * linear + 1) + c
  }
  return a * Math.log10(b * linear + 1) + c
}

export function canonLogDecode(encoded: number): number {
  const a = 0.529136
  const b = 10.1596
  const c = 0.0730597

  if (encoded < c) {
    return -(Math.pow(10, (c - encoded) / a) - 1) / b
  }
  return (Math.pow(10, (encoded - c) / a) - 1) / b
}

/**
 * Canon Log 2 encoding
 */
export function canonLog2Encode(linear: number): number {
  const a = 0.24136077
  const b = 87.099375
  const c = 0.092864125

  if (linear < 0) {
    return -a * Math.log10(1 - (b * linear) / 0.9) + c
  }
  return a * Math.log10(1 + (b * linear) / 0.9) + c
}

export function canonLog2Decode(encoded: number): number {
  const a = 0.24136077
  const b = 87.099375
  const c = 0.092864125

  if (encoded < c) {
    return (0.9 * (1 - Math.pow(10, (c - encoded) / a))) / b
  }
  return (0.9 * (Math.pow(10, (encoded - c) / a) - 1)) / b
}

/**
 * Canon Log 3 encoding
 */
export function canonLog3Encode(linear: number): number {
  const a = 0.36726845
  const b = 14.98325

  if (linear < -0.0126) {
    return -a * Math.log10(1 - (b * linear) / 0.9) + 0.12783901
  }
  if (linear <= 0.0126) {
    return (linear * 1.9754798) / 0.9 + 0.12512219
  }
  return a * Math.log10(1 + (b * linear) / 0.9) + 0.12240537
}

export function canonLog3Decode(encoded: number): number {
  const a = 0.36726845
  const b = 14.98325

  if (encoded < 0.097465473) {
    return (0.9 * (1 - Math.pow(10, (0.12783901 - encoded) / a))) / b
  }
  if (encoded <= 0.15277891) {
    return (0.9 * (encoded - 0.12512219)) / 1.9754798
  }
  return (0.9 * (Math.pow(10, (encoded - 0.12240537) / a) - 1)) / b
}

/**
 * ARRI LogC3 encoding (EI 800)
 */
export function logC3Encode(linear: number): number {
  const cut = 0.010591
  const a = 5.555556
  const b = 0.052272
  const c = 0.24719
  const d = 0.385537
  const e = 5.367655
  const f = 0.092809

  if (linear > cut) {
    return c * Math.log10(a * linear + b) + d
  }
  return e * linear + f
}

export function logC3Decode(encoded: number): number {
  const cut = 0.1496 // Approximate output
  const a = 5.555556
  const b = 0.052272
  const c = 0.24719
  const d = 0.385537
  const e = 5.367655
  const f = 0.092809

  if (encoded > cut) {
    return (Math.pow(10, (encoded - d) / c) - b) / a
  }
  return (encoded - f) / e
}

/**
 * ARRI LogC4 encoding
 */
const LOG_C4_A = (Math.pow(2, 18) - 16) / 117.45
const LOG_C4_B = (1023 - 95) / 1023
const LOG_C4_C = 95 / 1023
const LOG_C4_S =
  (7 * Math.log(2) * Math.pow(2, 7 - (14 * LOG_C4_C) / LOG_C4_B)) /
  (LOG_C4_A * LOG_C4_B)
const LOG_C4_T = (Math.pow(2, 14 * (-LOG_C4_C / LOG_C4_B) + 6) - 64) / LOG_C4_A

export function logC4Encode(linear: number): number {
  if (linear < LOG_C4_T) {
    return (linear - LOG_C4_T) / LOG_C4_S
  }

  return ((Math.log2(LOG_C4_A * linear + 64) - 6) / 14) * LOG_C4_B + LOG_C4_C
}

export function logC4Decode(encoded: number): number {
  if (encoded < 0) {
    return encoded * LOG_C4_S + LOG_C4_T
  }

  const p = (14 * (encoded - LOG_C4_C)) / LOG_C4_B + 6
  return (Math.pow(2, p) - 64) / LOG_C4_A
}

/**
 * Log3G10 encoding (RED)
 */
export function log3G10Encode(linear: number): number {
  const a = 0.224282
  const b = 155.975327
  const c = 0.01
  const g = 15.1927

  const y = linear + c
  if (y < 0) return y * g
  return a * Math.log10(b * y + 1)
}

export function log3G10Decode(encoded: number): number {
  const a = 0.224282
  const b = 155.975327
  const c = 0.01
  const g = 15.1927

  if (encoded < 0) return encoded / g - c
  return (Math.pow(10, encoded / a) - 1) / b - c
}

/**
 * Apple Log Profile encoding
 */
const APPLE_LOG_R0 = -0.05641088
const APPLE_LOG_RT = 0.01
const APPLE_LOG_C = 47.28711236
const APPLE_LOG_BETA = 0.00964052
const APPLE_LOG_GAMMA = 0.08550479
const APPLE_LOG_DELTA = 0.69336945
const APPLE_LOG_PT = APPLE_LOG_C * Math.pow(APPLE_LOG_RT - APPLE_LOG_R0, 2)

export function appleLogEncode(linear: number): number {
  if (linear < APPLE_LOG_R0) {
    return 0
  }
  if (linear < APPLE_LOG_RT) {
    return APPLE_LOG_C * Math.pow(linear - APPLE_LOG_R0, 2)
  }
  return APPLE_LOG_GAMMA * Math.log2(linear + APPLE_LOG_BETA) + APPLE_LOG_DELTA
}

export function appleLogDecode(encoded: number): number {
  if (encoded < 0) {
    return APPLE_LOG_R0
  }
  if (encoded < APPLE_LOG_PT) {
    return Math.sqrt(encoded / APPLE_LOG_C) + APPLE_LOG_R0
  }
  return (
    Math.pow(2, (encoded - APPLE_LOG_DELTA) / APPLE_LOG_GAMMA) - APPLE_LOG_BETA
  )
}

/**
 * DJI D-Log encoding
 */
export function djiDLogEncode(linear: number): number {
  if (linear <= 0.0078) {
    return 6.025 * linear + 0.0929
  }
  return Math.log10(linear * 0.9892 + 0.0108) * 0.256663 + 0.584555
}

export function djiDLogDecode(encoded: number): number {
  if (encoded <= 0.14) {
    return (encoded - 0.0929) / 6.025
  }
  return (Math.pow(10, 3.89616 * encoded - 2.27752) - 0.0108) / 0.9892
}

/**
 * L-Log encoding (Leica)
 */
export function lLogEncode(linear: number): number {
  const a = 8
  const b = 0.09
  const c = 0.27
  const d = 1.3
  const e = 0.0115
  const f = 0.6

  if (linear <= 0.006) {
    return a * linear + b
  }
  return c * Math.log10(d * linear + e) + f
}

export function lLogDecode(encoded: number): number {
  const a = 8
  const b = 0.09
  const c = 0.27
  const d = 1.3
  const e = 0.0115
  const f = 0.6

  if (encoded <= 0.138) {
    return (encoded - b) / a
  }
  return (Math.pow(10, (encoded - f) / c) - e) / d
}

const ACES_LOG_A = 17.52
const ACES_LOG_B = 9.72
const ACESCC_LOW = Math.pow(2, -16)
const ACESCC_CUT = Math.pow(2, -15)
const ACESCC_CUT_ENCODED = (Math.log2(ACESCC_CUT) + ACES_LOG_B) / ACES_LOG_A
const ACESCCT_CUT = 0.0078125
const ACESCCT_SLOPE = 10.5402377416545
const ACESCCT_OFFSET = 0.0729055341958355
const ACESCCT_CUT_ENCODED = 0.155251141552511

export function acesccEncode(linear: number): number {
  if (linear <= 0) {
    return (Math.log2(ACESCC_LOW) + ACES_LOG_B) / ACES_LOG_A
  }
  if (linear < ACESCC_CUT) {
    return (Math.log2(ACESCC_LOW + linear * 0.5) + ACES_LOG_B) / ACES_LOG_A
  }
  return (Math.log2(linear) + ACES_LOG_B) / ACES_LOG_A
}

export function acesccDecode(encoded: number): number {
  if (encoded <= ACESCC_CUT_ENCODED) {
    return (Math.pow(2, encoded * ACES_LOG_A - ACES_LOG_B) - ACESCC_LOW) * 2
  }
  return Math.pow(2, encoded * ACES_LOG_A - ACES_LOG_B)
}

export function acescctEncode(linear: number): number {
  if (linear <= ACESCCT_CUT) {
    return ACESCCT_SLOPE * linear + ACESCCT_OFFSET
  }
  return (Math.log2(linear) + ACES_LOG_B) / ACES_LOG_A
}

export function acescctDecode(encoded: number): number {
  if (encoded <= ACESCCT_CUT_ENCODED) {
    return (encoded - ACESCCT_OFFSET) / ACESCCT_SLOPE
  }
  return Math.pow(2, encoded * ACES_LOG_A - ACES_LOG_B)
}

export function srgbEncode(linear: number): number {
  if (linear <= 0.0031308) {
    return 12.92 * linear
  }
  return 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
}

export function srgbDecode(encoded: number): number {
  if (encoded <= 0.04045) {
    return encoded / 12.92
  }
  return Math.pow((encoded + 0.055) / 1.055, 2.4)
}

export function bt709Encode(linear: number): number {
  if (linear <= 0.018) {
    return 4.5 * linear
  }
  return 1.099 * Math.pow(linear, 0.45) - 0.099
}

export function bt709Decode(encoded: number): number {
  if (encoded <= 0.081) {
    return encoded / 4.5
  }
  return Math.pow(Math.max((encoded + 0.099) / 1.099, 0), 1 / 0.45)
}

export function gamma24Encode(linear: number): number {
  return Math.pow(Math.max(linear, 0), 1 / 2.4)
}

export function gamma24Decode(encoded: number): number {
  return Math.pow(Math.max(encoded, 0), 2.4)
}

export function linearTransfer(value: number): number {
  return value
}

/**
 * Mapping of log space names to encode/decode functions
 */
export const LOG_FUNCTIONS: Record<
  string,
  { encode: LogEncodingFn; decode: LogDecodingFn }
> = {
  'S-Log2': { encode: sLog2Encode, decode: sLog2Decode },
  'S-Log3': { encode: sLog3Encode, decode: sLog3Decode },
  'S-Log3.Cine': { encode: sLog3Encode, decode: sLog3Decode },
  'V-Log': { encode: vLogEncode, decode: vLogDecode },
  'F-Log': { encode: fLogEncode, decode: fLogDecode },
  'F-Log2': { encode: fLog2Encode, decode: fLog2Decode },
  'F-Log2C': { encode: fLog2Encode, decode: fLog2Decode },
  'N-Log': { encode: nLogEncode, decode: nLogDecode },
  'Canon Log': { encode: canonLogEncode, decode: canonLogDecode },
  'Canon Log 2': { encode: canonLog2Encode, decode: canonLog2Decode },
  'Canon Log 3': { encode: canonLog3Encode, decode: canonLog3Decode },
  'Arri LogC3': { encode: logC3Encode, decode: logC3Decode },
  'Arri LogC4': { encode: logC4Encode, decode: logC4Decode },
  Log3G10: { encode: log3G10Encode, decode: log3G10Decode },
  'Apple Log': { encode: appleLogEncode, decode: appleLogDecode },
  'DJI D-Log': { encode: djiDLogEncode, decode: djiDLogDecode },
  ACEScc: { encode: acesccEncode, decode: acesccDecode },
  ACEScct: { encode: acescctEncode, decode: acescctDecode },
  sRGB: { encode: srgbEncode, decode: srgbDecode },
  'BT.709': { encode: bt709Encode, decode: bt709Decode },
  'Rec.709': { encode: bt709Encode, decode: bt709Decode },
  'Gamma 2.4': { encode: gamma24Encode, decode: gamma24Decode },
  'Rec.709 Gamma 2.4': { encode: gamma24Encode, decode: gamma24Decode },
  'L-Log': { encode: lLogEncode, decode: lLogDecode },
  Linear: { encode: linearTransfer, decode: linearTransfer },
  linear: { encode: linearTransfer, decode: linearTransfer },
}

function referencePoint(
  label: string,
  linear: number,
  encoded: number,
): TransferFunctionReferencePoint {
  return { label, linear, encoded }
}

export const TRANSFER_FUNCTIONS: Record<
  TransferFunctionId,
  TransferFunctionMetadata
> = {
  's-log2': {
    id: 's-log2',
    label: 'S-Log2',
    encode: sLog2Encode,
    decode: sLog2Decode,
    aliases: ['S-Log2', 'SLog2', 'Sony S-Log2'],
    source: TRANSFER_SOURCE_URLS['s-log2'],
    referencePoints: [
      referencePoint('black', 0, sLog2Encode(0)),
      referencePoint('18% gray sanity', 0.18, sLog2Encode(0.18)),
    ],
  },
  's-log3': {
    id: 's-log3',
    label: 'S-Log3',
    encode: sLog3Encode,
    decode: sLog3Decode,
    aliases: ['S-Log3', 'S-Log3.Cine', 'SLog3', 'Sony S-Log3'],
    source: TRANSFER_SOURCE_URLS['s-log3'],
    referencePoints: [
      referencePoint('black', 0, 95 / 1023),
      referencePoint('18% gray', 0.18, 420 / 1023),
    ],
  },
  'canon-log': {
    id: 'canon-log',
    label: 'Canon Log',
    encode: canonLogEncode,
    decode: canonLogDecode,
    aliases: ['Canon Log', 'C-Log', 'CLog'],
    source: TRANSFER_SOURCE_URLS['canon-log'],
    referencePoints: [
      referencePoint('black', 0, canonLogEncode(0)),
      referencePoint('18% gray sanity', 0.18, canonLogEncode(0.18)),
    ],
  },
  'canon-log2': {
    id: 'canon-log2',
    label: 'Canon Log 2',
    encode: canonLog2Encode,
    decode: canonLog2Decode,
    aliases: ['Canon Log 2', 'C-Log2', 'CLog2', 'clog2'],
    source: TRANSFER_SOURCE_URLS['canon-log2'],
    referencePoints: [
      referencePoint('black', 0, 0.092864125),
      referencePoint('18% gray', 0.18, 0.39825469203794917),
      referencePoint('high', 1, 0.5732292786822207),
    ],
  },
  'canon-log3': {
    id: 'canon-log3',
    label: 'Canon Log 3',
    encode: canonLog3Encode,
    decode: canonLog3Decode,
    aliases: ['Canon Log 3', 'C-Log3', 'CLog3', 'clog3'],
    source: TRANSFER_SOURCE_URLS['canon-log3'],
    referencePoints: [
      referencePoint('lower branch cut', -0.0126, 0.0974654728),
      referencePoint('black', 0, 0.12512219),
      referencePoint('upper branch cut', 0.0126, 0.1527789072),
      referencePoint('18% gray', 0.18, 0.3433893703739356),
      referencePoint('high', 1, 0.5802777942163708),
    ],
  },
  'n-log': {
    id: 'n-log',
    label: 'N-Log',
    encode: nLogEncode,
    decode: nLogDecode,
    aliases: ['N-Log', 'NLog', 'Nikon N-Log'],
    source: TRANSFER_SOURCE_URLS['n-log'],
    referencePoints: [
      referencePoint('black', 0, nLogEncode(0)),
      referencePoint('18% gray sanity', 0.18, nLogEncode(0.18)),
    ],
  },
  'f-log': {
    id: 'f-log',
    label: 'F-Log',
    encode: fLogEncode,
    decode: fLogDecode,
    aliases: ['F-Log', 'FLog', 'Fujifilm F-Log'],
    source: TRANSFER_SOURCE_URLS['f-log'],
    referencePoints: [
      referencePoint('0% reflection', 0, 95 / 1023),
      referencePoint('18% gray', 0.18, 470 / 1023),
      referencePoint('90% reflection', 0.9, 705 / 1023),
    ],
  },
  'f-log2': {
    id: 'f-log2',
    label: 'F-Log2',
    encode: fLog2Encode,
    decode: fLog2Decode,
    aliases: ['F-Log2', 'FLog2', 'Fujifilm F-Log2'],
    source: TRANSFER_SOURCE_URLS['f-log2'],
    referencePoints: [
      referencePoint('0% reflection', 0, 95 / 1023),
      referencePoint('18% gray', 0.18, 400 / 1023),
      referencePoint('90% reflection', 0.9, 570 / 1023),
    ],
  },
  'f-log2c': {
    id: 'f-log2c',
    label: 'F-Log2C',
    encode: fLog2Encode,
    decode: fLog2Decode,
    aliases: ['F-Log2C', 'FLog2C', 'F-Log2 C', 'Fujifilm F-Log2C'],
    source: TRANSFER_SOURCE_URLS['f-log2c'],
    referencePoints: [
      referencePoint('0% reflection', 0, 95 / 1023),
      referencePoint('18% gray', 0.18, 400 / 1023),
      referencePoint('90% reflection', 0.9, 570 / 1023),
    ],
  },
  'v-log': {
    id: 'v-log',
    label: 'V-Log',
    encode: vLogEncode,
    decode: vLogDecode,
    aliases: ['V-Log', 'VLog', 'Panasonic V-Log'],
    source: TRANSFER_SOURCE_URLS['v-log'],
    referencePoints: [
      referencePoint('black', 0, 0.125),
      referencePoint('18% gray sanity', 0.18, vLogEncode(0.18)),
    ],
  },
  logc3: {
    id: 'logc3',
    label: 'LogC3',
    encode: logC3Encode,
    decode: logC3Decode,
    aliases: ['LogC3', 'Log C3', 'Arri LogC3', 'ARRI LogC3'],
    source: TRANSFER_SOURCE_URLS.logc3,
    referencePoints: [
      referencePoint('black', 0, logC3Encode(0)),
      referencePoint('18% gray', 0.18, logC3Encode(0.18)),
    ],
  },
  logc4: {
    id: 'logc4',
    label: 'LogC4',
    encode: logC4Encode,
    decode: logC4Decode,
    aliases: ['LogC4', 'Log C4', 'Arri LogC4', 'ARRI LogC4'],
    source: TRANSFER_SOURCE_URLS.logc4,
    referencePoints: [
      referencePoint('black', 0, 95 / 1023),
      referencePoint('18% gray', 0.18, 0.2783958365482653),
      referencePoint('LogC4 maximum', 469.8, 1),
    ],
  },
  log3g10: {
    id: 'log3g10',
    label: 'Log3G10',
    encode: log3G10Encode,
    decode: log3G10Decode,
    aliases: ['Log3G10', 'Log 3G10', 'RED Log3G10'],
    source: TRANSFER_SOURCE_URLS.log3g10,
    referencePoints: [
      referencePoint('black sanity', 0, log3G10Encode(0)),
      referencePoint('18% gray', 0.18, 1 / 3),
    ],
  },
  acescc: {
    id: 'acescc',
    label: 'ACEScc',
    encode: acesccEncode,
    decode: acesccDecode,
    aliases: ['ACEScc'],
    source: TRANSFER_SOURCE_URLS.acescc,
    referencePoints: [
      referencePoint('zero', 0, acesccEncode(0)),
      referencePoint('18% gray', 0.18, 0.4135884),
    ],
  },
  acescct: {
    id: 'acescct',
    label: 'ACEScct',
    encode: acescctEncode,
    decode: acescctDecode,
    aliases: ['ACEScct'],
    source: TRANSFER_SOURCE_URLS.acescct,
    referencePoints: [
      referencePoint('zero', 0, 0.0729055341958355),
      referencePoint('18% gray', 0.18, 0.4135884),
    ],
  },
  srgb: {
    id: 'srgb',
    label: 'sRGB',
    encode: srgbEncode,
    decode: srgbDecode,
    aliases: ['sRGB', 'IEC 61966-2-1'],
    source: TRANSFER_SOURCE_URLS.srgb,
    referencePoints: [
      referencePoint('black', 0, 0),
      referencePoint('linear segment threshold', 0.0031308, 0.04045),
    ],
  },
  bt709: {
    id: 'bt709',
    label: 'BT.709',
    encode: bt709Encode,
    decode: bt709Decode,
    aliases: ['BT.709', 'Rec.709', 'Rec709', 'ITU-R BT.709'],
    source: TRANSFER_SOURCE_URLS.bt709,
    referencePoints: [
      referencePoint('black', 0, 0),
      referencePoint('linear segment threshold', 0.018, 0.081),
      referencePoint('18% gray sanity', 0.18, bt709Encode(0.18)),
    ],
  },
  gamma24: {
    id: 'gamma24',
    label: 'Gamma 2.4',
    encode: gamma24Encode,
    decode: gamma24Decode,
    aliases: ['Gamma 2.4', 'Rec.709 Gamma 2.4', 'gamma24', 'BT.1886'],
    source: TRANSFER_SOURCE_URLS.gamma24,
    referencePoints: [
      referencePoint('black', 0, 0),
      referencePoint('18% gray', 0.18, gamma24Encode(0.18)),
    ],
  },
  'apple-log': {
    id: 'apple-log',
    label: 'Apple Log',
    encode: appleLogEncode,
    decode: appleLogDecode,
    aliases: ['Apple Log', 'AppleLog', 'apple-log'],
    source: TRANSFER_SOURCE_URLS['apple-log'],
    referencePoints: [
      referencePoint('18% gray', 0.18, 0.48827245852686763),
      referencePoint('white', 1, 0.6951555328783671),
    ],
  },
  'dji-d-log': {
    id: 'dji-d-log',
    label: 'DJI D-Log',
    encode: djiDLogEncode,
    decode: djiDLogDecode,
    aliases: ['DJI D-Log', 'D-Log', 'DLog', 'dji-d-log'],
    source: TRANSFER_SOURCE_URLS['dji-d-log'],
    referencePoints: [
      referencePoint('black', 0, 0.0929),
      referencePoint('18% gray', 0.18, 408 / 1023),
      referencePoint('90% reflection', 0.9, 586 / 1023),
    ],
  },
  'l-log': {
    id: 'l-log',
    label: 'L-Log',
    encode: lLogEncode,
    decode: lLogDecode,
    aliases: ['L-Log', 'LLog', 'Leica L-Log', 'leica-l-log'],
    source: TRANSFER_SOURCE_URLS['l-log'],
    referencePoints: [
      referencePoint('black', 0, 0.09),
      referencePoint('18% gray', 0.18, 445 / 1023),
      referencePoint('90% reflection', 0.9, 634 / 1023),
    ],
  },
  linear: {
    id: 'linear',
    label: 'Linear',
    encode: linearTransfer,
    decode: linearTransfer,
    aliases: ['Linear', 'Linear Light', 'Scene Linear'],
    source: TRANSFER_SOURCE_URLS.linear,
    referencePoints: [referencePoint('18% gray', 0.18, 0.18)],
  },
}

/**
 * Get log encoding function for a given log space
 */
export function getLogEncoder(logSpace: string): LogEncodingFn {
  const funcs = LOG_FUNCTIONS[logSpace]
  if (!funcs) {
    warn(`Unknown log space: ${logSpace}, using S-Log3`)
    return sLog3Encode
  }
  return funcs.encode
}

/**
 * Get log decoding function for a given log space
 */
export function getLogDecoder(logSpace: string): LogDecodingFn {
  const funcs = LOG_FUNCTIONS[logSpace]
  if (!funcs) {
    warn(`Unknown log space: ${logSpace}, using S-Log3`)
    return sLog3Decode
  }
  return funcs.decode
}
