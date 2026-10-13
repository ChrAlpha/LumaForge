import type { ColorGamutId, ColorSpaceDef } from './constants'
import { COLOR_GAMUT_SOURCE_URLS, COLOR_SPACES } from './constants'
import type {
  TransferFunctionId,
  TransferFunctionMetadata,
} from './log-encoding'
import { TRANSFER_FUNCTIONS } from './log-encoding'

export type LUTRole =
  | 'display-look'
  | 'scene-creative'
  | 'technical-output'
  | 'combined-look-output'

export type SignalRange = 'full' | 'legal' | 'unknown'

export interface LUTColorProfile {
  id: string
  label: string
  role: LUTRole
  inputGamut: ColorGamutId
  inputTransfer: TransferFunctionId
  inputRange: SignalRange
  outputGamut?: ColorGamutId
  outputTransfer?: TransferFunctionId
  outputRange?: SignalRange
  aliases: string[]
  source?: string
}

export interface ColorGamut {
  id: ColorGamutId
  label: string
  colorSpaceName: string
  primaries: ColorSpaceDef['primaries']
  whitePoint: ColorSpaceDef['whitePoint']
  aliases: string[]
  source: string
}

function createColorGamut(
  id: ColorGamutId,
  label: string,
  extraAliases: string[] = [],
): ColorGamut {
  const colorSpace = COLOR_SPACES[id]
  return {
    id,
    label,
    colorSpaceName: colorSpace.name,
    primaries: colorSpace.primaries,
    whitePoint: colorSpace.whitePoint,
    aliases: Array.from(
      new Set([label, colorSpace.name, ...colorSpace.aliases, ...extraAliases]),
    ),
    source: COLOR_GAMUT_SOURCE_URLS[id],
  }
}

export const COLOR_GAMUTS: Record<ColorGamutId, ColorGamut> = {
  'prophoto-rgb': createColorGamut('prophoto-rgb', 'ProPhoto RGB'),
  'srgb-rec709': createColorGamut('srgb-rec709', 'sRGB / Rec.709 primaries'),
  'display-p3': createColorGamut('display-p3', 'Display P3'),
  rec2020: createColorGamut('rec2020', 'Rec.2020 / BT.2020', [
    'N-Log Rec.2020',
    'Leica L-Gamut',
    'leica-l-gamut',
  ]),
  'dji-d-gamut': createColorGamut('dji-d-gamut', 'DJI D-Gamut', [
    'D-Gamut',
    'DJI D-Gamut/D-Log',
  ]),
  's-gamut': createColorGamut('s-gamut', 'S-Gamut'),
  's-gamut3': createColorGamut('s-gamut3', 'S-Gamut3'),
  's-gamut3-cine': createColorGamut('s-gamut3-cine', 'S-Gamut3.Cine', [
    'S-Gamut3Cine',
    'Sony S-Gamut3.Cine',
    'sony-s-gamut3-cine',
  ]),
  'v-gamut': createColorGamut('v-gamut', 'V-Gamut'),
  'f-gamut': createColorGamut('f-gamut', 'F-Gamut'),
  'f-gamut-c': createColorGamut('f-gamut-c', 'F-Gamut C', ['FGamutC']),
  'canon-cinema-gamut': createColorGamut(
    'canon-cinema-gamut',
    'Canon Cinema Gamut',
    ['Cinema Gamut'],
  ),
  'arri-wide-gamut-3': createColorGamut(
    'arri-wide-gamut-3',
    'ARRI Wide Gamut 3',
    ['ARRI Alexa Wide Gamut', 'AWG3'],
  ),
  'arri-wide-gamut-4': createColorGamut(
    'arri-wide-gamut-4',
    'ARRI Wide Gamut 4',
    ['AWG4'],
  ),
  'red-wide-gamut-rgb': createColorGamut(
    'red-wide-gamut-rgb',
    'REDWideGamutRGB',
    ['RED Wide Gamut RGB', 'RWG'],
  ),
  'aces-ap1': createColorGamut('aces-ap1', 'ACES AP1', ['ACEScg', 'AP1']),
}

function profile(
  id: string,
  label: string,
  inputGamut: ColorGamutId,
  inputTransfer: TransferFunctionId,
  aliases: string[],
  source?: string,
  role: LUTRole = 'scene-creative',
): LUTColorProfile {
  return {
    id,
    label,
    role,
    inputGamut,
    inputTransfer,
    inputRange: 'full',
    aliases,
    source:
      source ??
      TRANSFER_FUNCTIONS[inputTransfer].source ??
      COLOR_GAMUTS[inputGamut].source,
  }
}

export const TIER1_LUT_COLOR_PROFILES: LUTColorProfile[] = [
  profile(
    'arri-awg4-logc4',
    'ARRI Wide Gamut 4 / LogC4',
    'arri-wide-gamut-4',
    'logc4',
    ['ARRI AWG4 LogC4', 'AWG4 LogC4', 'ARRI LogC4'],
  ),
  profile(
    'arri-awg3-logc3',
    'ARRI Wide Gamut 3 / LogC3',
    'arri-wide-gamut-3',
    'logc3',
    [
      'ARRI AWG3 LogC3',
      'ARRI Alexa Wide Gamut LogC3',
      'AWG3 LogC3',
      'ARRI LogC3',
    ],
  ),
  profile(
    'red-rwg-log3g10',
    'REDWideGamutRGB / Log3G10',
    'red-wide-gamut-rgb',
    'log3g10',
    ['RED RWG Log3G10', 'REDWideGamutRGB Log3G10', 'RWG Log3G10'],
  ),
  profile(
    'nikon-zr-rwg-log3g10',
    'Nikon ZR REDWideGamutRGB / Log3G10',
    'red-wide-gamut-rgb',
    'log3g10',
    ['Nikon ZR RWG Log3G10', 'Nikon ZR Log3G10', 'ZR RWG Log3G10'],
    'https://downloadcenter.nikonimglib.com/en/download/sw/274.html',
  ),
  profile('nikon-bt2020-nlog', 'Nikon Rec.2020 / N-Log', 'rec2020', 'n-log', [
    'Nikon N-Log',
    'N-Log Rec.2020',
    'BT.2020 N-Log',
  ]),
  profile(
    'sony-sgamut3cine-slog3',
    'Sony S-Gamut3.Cine / S-Log3',
    's-gamut3-cine',
    's-log3',
    ['Sony S-Gamut3 Cine SLog3', 'S-Gamut3.Cine S-Log3', 'S-Gamut3Cine SLog3'],
  ),
  profile(
    'sony-sgamut3-slog3',
    'Sony S-Gamut3 / S-Log3',
    's-gamut3',
    's-log3',
    ['Sony S-Gamut3 SLog3', 'S-Gamut3 S-Log3'],
  ),
  profile('sony-sgamut-slog2', 'Sony S-Gamut / S-Log2', 's-gamut', 's-log2', [
    'Sony S-Gamut SLog2',
    'S-Gamut S-Log2',
  ]),
  profile(
    'canon-cinema-gamut-clog2',
    'Canon Cinema Gamut / Canon Log 2',
    'canon-cinema-gamut',
    'canon-log2',
    ['Canon C.Gamut C-Log2', 'Cinema Gamut CLog2', 'Cinema Gamut Canon Log 2'],
  ),
  profile(
    'canon-cinema-gamut-clog3',
    'Canon Cinema Gamut / Canon Log 3',
    'canon-cinema-gamut',
    'canon-log3',
    ['Canon C.Gamut C-Log3', 'Cinema Gamut CLog3', 'Cinema Gamut Canon Log 3'],
  ),
  profile(
    'canon-cinema-gamut-clog',
    'Canon Cinema Gamut / Canon Log',
    'canon-cinema-gamut',
    'canon-log',
    ['Canon C.Gamut C-Log', 'Cinema Gamut CLog', 'Cinema Gamut Canon Log'],
  ),
  profile('fuji-fgamut-flog', 'Fujifilm F-Gamut / F-Log', 'f-gamut', 'f-log', [
    'Fuji F-Gamut F-Log',
    'Fujifilm FLog',
  ]),
  profile(
    'fuji-fgamut-flog2',
    'Fujifilm F-Gamut / F-Log2',
    'f-gamut',
    'f-log2',
    ['Fuji F-Gamut F-Log2', 'Fujifilm FLog2'],
  ),
  profile(
    'fuji-fgamutc-flog2c',
    'Fujifilm F-Gamut C / F-Log2C',
    'f-gamut-c',
    'f-log2c',
    ['Fuji F-GamutC F-Log2C', 'FGamutC FLog2C', 'F-Log2 C'],
  ),
  profile(
    'panasonic-vgamut-vlog',
    'Panasonic V-Gamut / V-Log',
    'v-gamut',
    'v-log',
    ['Panasonic VLog', 'V-Gamut V-Log'],
  ),
  profile('aces-ap1-acescc', 'ACES AP1 / ACEScc', 'aces-ap1', 'acescc', [
    'ACEScg ACEScc',
    'AP1 ACEScc',
  ]),
  profile('aces-ap1-acescct', 'ACES AP1 / ACEScct', 'aces-ap1', 'acescct', [
    'ACEScg ACEScct',
    'AP1 ACEScct',
  ]),
  profile(
    'display-srgb',
    'Display sRGB',
    'srgb-rec709',
    'srgb',
    ['sRGB display', 'display referred sRGB'],
    undefined,
    'display-look',
  ),
  profile(
    'rec709-gamma24',
    'Rec.709 / Gamma 2.4',
    'srgb-rec709',
    'gamma24',
    ['Rec709 Gamma 2.4', 'BT.709 Gamma 2.4', 'Rec.709 BT.1886'],
    undefined,
    'display-look',
  ),
]

const LUT_PROFILE_BY_ID = new Map<string, LUTColorProfile>()
const COLOR_GAMUT_BY_ALIAS = new Map<string, ColorGamut>()
const TRANSFER_BY_ALIAS = new Map<string, TransferFunctionMetadata>()

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function searchTokens(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean)
}

function aliasKey(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '')
}

for (const profileEntry of TIER1_LUT_COLOR_PROFILES) {
  LUT_PROFILE_BY_ID.set(aliasKey(profileEntry.id), profileEntry)
  for (const alias of profileEntry.aliases) {
    LUT_PROFILE_BY_ID.set(aliasKey(alias), profileEntry)
  }
}

for (const gamut of Object.values(COLOR_GAMUTS)) {
  COLOR_GAMUT_BY_ALIAS.set(aliasKey(gamut.id), gamut)
  COLOR_GAMUT_BY_ALIAS.set(aliasKey(gamut.label), gamut)
  for (const alias of gamut.aliases) {
    COLOR_GAMUT_BY_ALIAS.set(aliasKey(alias), gamut)
  }
}

for (const transfer of Object.values(TRANSFER_FUNCTIONS)) {
  TRANSFER_BY_ALIAS.set(aliasKey(transfer.id), transfer)
  TRANSFER_BY_ALIAS.set(aliasKey(transfer.label), transfer)
  for (const alias of transfer.aliases) {
    TRANSFER_BY_ALIAS.set(aliasKey(alias), transfer)
  }
}

function profileSearchText(profileEntry: LUTColorProfile): string {
  const gamut = COLOR_GAMUTS[profileEntry.inputGamut]
  const transfer = TRANSFER_FUNCTIONS[profileEntry.inputTransfer]
  return normalizeSearchText(
    [
      profileEntry.id,
      profileEntry.label,
      profileEntry.aliases.join(' '),
      gamut.id,
      gamut.label,
      gamut.aliases.join(' '),
      transfer.id,
      transfer.label,
      transfer.aliases.join(' '),
    ].join(' '),
  )
}

function profileScore(profileEntry: LUTColorProfile, query: string): number {
  const normalizedQuery = normalizeSearchText(query)
  const compactQuery = aliasKey(query)
  const haystack = profileSearchText(profileEntry)
  const compactHaystack = aliasKey(haystack)
  const tokens = searchTokens(query)
  let score = 0

  if (compactHaystack.includes(compactQuery)) score += 6
  if (aliasKey(profileEntry.id).includes(compactQuery)) score += 8

  for (const alias of profileEntry.aliases) {
    const normalizedAlias = normalizeSearchText(alias)
    if (normalizedAlias.includes(normalizedQuery)) score += 10
    if (aliasKey(alias).includes(compactQuery)) score += 8
  }

  for (const token of tokens) {
    if (haystack.includes(token)) score += 1
  }

  return score
}

export function getColorGamut(
  id: ColorGamutId | string,
): ColorGamut | undefined {
  return COLOR_GAMUT_BY_ALIAS.get(aliasKey(id))
}

export function getTransferFunction(
  id: TransferFunctionId | string,
): TransferFunctionMetadata | undefined {
  return TRANSFER_BY_ALIAS.get(aliasKey(id))
}

export function getLUTColorProfile(id: string): LUTColorProfile | undefined {
  return LUT_PROFILE_BY_ID.get(aliasKey(id))
}

export function searchLUTColorProfiles(query: string): LUTColorProfile[] {
  if (!query.trim()) return [...TIER1_LUT_COLOR_PROFILES]

  return TIER1_LUT_COLOR_PROFILES.map((profileEntry) => ({
    profile: profileEntry,
    score: profileScore(profileEntry, query),
  }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((result) => result.profile)
}

export function inferLUTColorProfileHints(input: {
  title: string
  sourceName?: string
  comments: string[]
}): LUTColorProfile[] {
  const query = [input.title, input.sourceName, ...input.comments]
    .filter(Boolean)
    .join(' ')

  if (!query.trim()) return []

  return searchLUTColorProfiles(query)
}
