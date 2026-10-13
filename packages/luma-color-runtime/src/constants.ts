/**
 * Color constants and mappings for RAW processing pipeline.
 */

export type ColorGamutId =
  | 'prophoto-rgb'
  | 'srgb-rec709'
  | 'display-p3'
  | 'rec2020'
  | 'dji-d-gamut'
  | 's-gamut'
  | 's-gamut3'
  | 's-gamut3-cine'
  | 'v-gamut'
  | 'f-gamut'
  | 'f-gamut-c'
  | 'canon-cinema-gamut'
  | 'arri-wide-gamut-3'
  | 'arri-wide-gamut-4'
  | 'red-wide-gamut-rgb'
  | 'aces-ap1'

export const COLOR_GAMUT_SOURCE_URLS: Record<ColorGamutId, string> = {
  'prophoto-rgb': 'https://www.color.org/chardata/rgb/rommrgb.xalter',
  'srgb-rec709': 'https://www.w3.org/Graphics/Color/srgb.pdf',
  'display-p3':
    'https://developer.apple.com/documentation/coregraphics/cgcolorspace/displayp3',
  rec2020: 'https://www.itu.int/rec/R-REC-BT.2020/en',
  'dji-d-gamut':
    'https://dl.djicdn.com/downloads/DJI_Ronin_4D/X9_D_Log_D_Gamut_Whitepaper.pdf',
  's-gamut': 'https://www.sony.com/electronics/support/articles/00145908',
  's-gamut3':
    'https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf',
  's-gamut3-cine':
    'https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf',
  'v-gamut':
    'https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf',
  'f-gamut':
    'https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.2.pdf',
  'f-gamut-c':
    'https://dl.fujifilm-x.com/support/lut/F-Log2C_DataSheet_E_Ver.1.0.pdf',
  'canon-cinema-gamut':
    'https://www.usa.canon.com/content/dam/canon-assets/white-papers/pro/white-paper-canon-log-gamma-curves.pdf',
  'arri-wide-gamut-3':
    'https://www.arri.com/en/learn-help/learn-help-camera-system/image-science/log-c',
  'arri-wide-gamut-4':
    'https://www.arri.com/resource/blob/278790/f3318e8c9c65617d8c5ca3f8b3e32051/2023-05-arri-logc4-specification-data.pdf',
  'red-wide-gamut-rgb':
    'https://www.red.com/download/white-paper-on-redwidegamutrgb-and-log3g10',
  'aces-ap1': 'https://docs.acescentral.com/encodings/acescct/',
}

/**
 * Color space primaries and white points for gamut transformations.
 * Using CIE 1931 xyY chromaticity coordinates.
 */
export interface ColorSpaceDef {
  name: string
  primaries: {
    red: [number, number]
    green: [number, number]
    blue: [number, number]
  }
  whitePoint: [number, number] // D50 or D65
  aliases: string[]
}

// D65 standard illuminant
export const D65_WHITE: [number, number] = [0.3127, 0.329]

// D50 standard illuminant
export const D50_WHITE: [number, number] = [0.3457, 0.3585]

// ACES white point (D60)
export const ACES_WHITE: [number, number] = [0.32168, 0.33767]

export const COLOR_SPACES: Record<ColorGamutId, ColorSpaceDef> = {
  'prophoto-rgb': {
    name: 'ProPhoto RGB',
    primaries: {
      red: [0.7347, 0.2653],
      green: [0.1596, 0.8404],
      blue: [0.0366, 0.0001],
    },
    whitePoint: D50_WHITE,
    aliases: ['ProPhoto', 'ROMM RGB'],
  },
  'srgb-rec709': {
    name: 'sRGB',
    primaries: {
      red: [0.64, 0.33],
      green: [0.3, 0.6],
      blue: [0.15, 0.06],
    },
    whitePoint: D65_WHITE,
    aliases: ['Rec.709', 'BT.709', 'ITU-R BT.709'],
  },
  'display-p3': {
    name: 'Display P3',
    primaries: {
      red: [0.68, 0.32],
      green: [0.265, 0.69],
      blue: [0.15, 0.06],
    },
    whitePoint: D65_WHITE,
    aliases: ['P3-D65'],
  },
  rec2020: {
    name: 'ITU-R BT.2020',
    primaries: {
      red: [0.708, 0.292],
      green: [0.17, 0.797],
      blue: [0.131, 0.046],
    },
    whitePoint: D65_WHITE,
    aliases: [
      'Rec.2020',
      'BT.2020',
      'N-Gamut',
      'N-Log Rec.2020',
      'Leica L-Gamut',
      'leica-l-gamut',
    ],
  },
  'dji-d-gamut': {
    name: 'DJI D-Gamut',
    primaries: {
      red: [0.71, 0.31],
      green: [0.21, 0.88],
      blue: [0.09, -0.08],
    },
    whitePoint: D65_WHITE,
    aliases: ['D-Gamut', 'DJI D-Gamut/D-Log'],
  },
  's-gamut': {
    name: 'S-Gamut',
    primaries: {
      red: [0.73, 0.28],
      green: [0.14, 0.855],
      blue: [0.1, -0.05],
    },
    whitePoint: D65_WHITE,
    aliases: ['S-Gamut/S-Log2', 'Sony S-Gamut', 'sony-s-gamut'],
  },
  's-gamut3': {
    name: 'S-Gamut3',
    primaries: {
      red: [0.73, 0.28],
      green: [0.14, 0.855],
      blue: [0.1, -0.05],
    },
    whitePoint: D65_WHITE,
    aliases: ['S-Gamut3/S-Log3'],
  },
  's-gamut3-cine': {
    name: 'S-Gamut3.Cine',
    primaries: {
      red: [0.766, 0.275],
      green: [0.225, 0.8],
      blue: [0.089, -0.087],
    },
    whitePoint: D65_WHITE,
    aliases: [
      'S-Gamut3Cine',
      'S-Gamut3.Cine/S-Log3',
      'Sony S-Gamut3.Cine',
      'sony-s-gamut3-cine',
    ],
  },
  'v-gamut': {
    name: 'V-Gamut',
    primaries: {
      red: [0.73, 0.28],
      green: [0.165, 0.84],
      blue: [0.1, -0.03],
    },
    whitePoint: D65_WHITE,
    aliases: ['V-Gamut/V-Log'],
  },
  'f-gamut': {
    name: 'F-Gamut',
    primaries: {
      red: [0.708, 0.292],
      green: [0.17, 0.797],
      blue: [0.131, 0.046],
    },
    whitePoint: D65_WHITE,
    aliases: ['F-Gamut/F-Log'],
  },
  'f-gamut-c': {
    name: 'F-Gamut C',
    primaries: {
      red: [0.7347, 0.2653],
      green: [0.0263, 0.9737],
      blue: [0.1173, -0.0224],
    },
    whitePoint: D65_WHITE,
    aliases: [
      'F-GamutC',
      'F-Gamut C/F-Log2C',
      'Fujifilm F-Gamut C',
      'fujifilm-f-gamut-c',
    ],
  },
  'canon-cinema-gamut': {
    name: 'Canon Cinema Gamut',
    primaries: {
      red: [0.74, 0.27],
      green: [0.17, 1.14],
      blue: [0.08, -0.1],
    },
    whitePoint: D65_WHITE,
    aliases: ['Cinema Gamut', 'Canon C.Gamut'],
  },
  'arri-wide-gamut-3': {
    name: 'ARRI Wide Gamut 3',
    primaries: {
      red: [0.684, 0.313],
      green: [0.221, 0.848],
      blue: [0.0861, -0.102],
    },
    whitePoint: D65_WHITE,
    aliases: ['AWG3', 'Alexa Wide Gamut', 'ARRI ALEXA Wide Gamut'],
  },
  'arri-wide-gamut-4': {
    name: 'ARRI Wide Gamut 4',
    primaries: {
      red: [0.7347, 0.2653],
      green: [0.1424, 0.8576],
      blue: [0.0991, -0.0308],
    },
    whitePoint: D65_WHITE,
    aliases: ['AWG4', 'ARRI Wide Gamut 4'],
  },
  'red-wide-gamut-rgb': {
    name: 'REDWideGamutRGB',
    primaries: {
      red: [0.780308, 0.304253],
      green: [0.121595, 1.493994],
      blue: [0.095612, -0.084589],
    },
    whitePoint: D65_WHITE,
    aliases: ['RED Wide Gamut RGB', 'RWG'],
  },
  'aces-ap1': {
    name: 'ACES AP1',
    primaries: {
      red: [0.713, 0.293],
      green: [0.165, 0.83],
      blue: [0.128, 0.044],
    },
    whitePoint: ACES_WHITE,
    aliases: ['ACEScg', 'AP1'],
  },
}
