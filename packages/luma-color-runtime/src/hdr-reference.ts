/**
 * The HDR reference LumaForge's linear light follows (ITU-R BT.2100 with the
 * BT.2408 and ISO 22028-5 operating points).
 *
 * Linear 1.0 is diffuse white everywhere in the color runtime: the SDR
 * output's white, and HDR Reference White (203 cd/m², 58% PQ, 75% HLG) in an
 * HDR signal. HDR highlights are linear values above 1.0, up to the nominal
 * peak of the reference display.
 */

/** HDR Reference White (BT.2408): the luminance linear 1.0 stands for. */
export const HDR_REFERENCE_WHITE_NITS = 203

/** Nominal peak luminance of the HDR reference display (ISO 22028-5). */
export const HDR_NOMINAL_PEAK_NITS = 1000

/** The nominal peak as linear light: how far HDR highlights may rise. */
export const HDR_NOMINAL_PEAK_LINEAR =
  HDR_NOMINAL_PEAK_NITS / HDR_REFERENCE_WHITE_NITS

/** Absolute luminance a PQ (SMPTE ST 2084) code value of 1.0 stands for. */
export const PQ_PEAK_NITS = 10000

/**
 * HLG system gamma (BT.2100) of the reference display, whose peak is the
 * nominal peak: the OOTF exponent that turns HLG scene light into display
 * light there.
 */
export const HLG_SYSTEM_GAMMA = 1.2
