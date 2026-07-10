import type { CSSProperties, ReactNode } from 'react'
import { createElement } from 'react'
import { render } from 'takumi-js'

export const LUMAFORGE_OG_IMAGE_WIDTH = 1200
export const LUMAFORGE_OG_IMAGE_HEIGHT = 630

interface LumaForgeOgImageAssets {
  fontData: Uint8Array
  heroImageSrc: string
  logoSrc: string
}

const colors = {
  bg: 'oklch(0.075 0.006 255)',
  text: 'oklch(0.94 0.012 240)',
  textMuted: 'oklch(0.68 0.012 255)',
  amber: 'oklch(0.78 0.14 63)',
  green: 'oklch(0.59 0.15 153)',
  border: 'oklch(0.9 0.01 255 / 0.08)',
  onPhotoBg: 'oklch(0.08 0.006 255 / 0.72)',
  onPhotoBorder: 'oklch(0.9 0.01 255 / 0.16)',
  divider: 'oklch(0.94 0.012 240 / 0.92)',
  dividerHandleBg: 'oklch(0.08 0.006 255 / 0.62)',
}

const e = createElement

function checkIcon(size = 12, stroke = 2.4) {
  return e(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: colors.green,
      strokeWidth: stroke,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { display: 'block', flexShrink: 0 },
    },
    e('polyline', { points: '20 6 9 17 4 12' }),
  )
}

function imageUpIcon() {
  return e(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: colors.amber,
      strokeWidth: 1.9,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { display: 'block', flexShrink: 0 },
    },
    e('path', {
      d: 'M21 12V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12',
    }),
    e('path', { d: 'M3 16l5-5 4 4' }),
    e('path', { d: 'M18 22v-6' }),
    e('polyline', { points: '15 19 18 16 21 19' }),
  )
}

function compareHandleIcon() {
  return e(
    'svg',
    {
      width: 20,
      height: 14,
      viewBox: '0 0 20 14',
      fill: 'none',
      stroke: 'oklch(0.94 0.012 240 / 0.88)',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { display: 'block' },
    },
    e('polyline', { points: '5 2 1 7 5 12' }),
    e('polyline', { points: '15 2 19 7 15 12' }),
  )
}

function markLockup(logoSrc: string) {
  return e(
    'div',
    { style: { display: 'flex', alignItems: 'center', height: 36 } },
    e('img', {
      src: logoSrc,
      width: 36,
      height: 36,
      style: {
        width: 36,
        height: 36,
        borderRadius: 5,
        boxShadow: '0 8px 22px oklch(0.025 0.008 255 / 0.44)',
      },
    }),
    e(
      'div',
      {
        style: {
          marginLeft: 12,
          color: colors.text,
          fontSize: 18,
          fontWeight: 680,
          letterSpacing: '-0.005em',
          lineHeight: 1,
        },
      },
      'LumaForge',
    ),
  )
}

function eyebrow() {
  return e(
    'div',
    {
      style: {
        marginBottom: 22,
        color: colors.amber,
        fontSize: 12.5,
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: 1.2,
        textTransform: 'uppercase',
      },
    },
    'Browser-local RAW finishing',
  )
}

function headlineLine(children: ReactNode) {
  return e('div', { style: { whiteSpace: 'nowrap' } }, children)
}

function headline() {
  return e(
    'div',
    {
      style: {
        margin: 0,
        color: colors.text,
        fontSize: 62,
        fontWeight: 800,
        lineHeight: 0.93,
        letterSpacing: '-0.035em',
      },
    },
    headlineLine('A complete'),
    headlineLine('RAW finish.'),
    headlineLine('Tone. Color.'),
    headlineLine('Compare.'),
    headlineLine('Export.'),
  )
}

function statusLine() {
  return e(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        color: colors.textMuted,
        fontSize: 13.5,
        fontWeight: 560,
        lineHeight: 1,
      },
    },
    checkIcon(13, 2.2),
    e(
      'div',
      { style: { marginLeft: 9 } },
      'Local RAW · reproducible export only',
    ),
  )
}

function chipStyle(extra?: CSSProperties): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 13px',
    borderRadius: 999,
    border: `1px solid ${colors.onPhotoBorder}`,
    backgroundColor: colors.onPhotoBg,
    color: colors.text,
    fontSize: 12.5,
    fontWeight: 660,
    letterSpacing: '0.01em',
    lineHeight: 1,
    ...extra,
  }
}

function rawTag() {
  return e(
    'div',
    { style: chipStyle({ position: 'absolute', top: 28, left: 28 }) },
    e('div', {
      style: {
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: colors.amber,
        boxShadow: `0 0 8px ${colors.amber}`,
      },
    }),
    e('div', { style: { marginLeft: 8 } }, 'Neutral preview'),
  )
}

function finishedTag() {
  return e(
    'div',
    { style: chipStyle({ position: 'absolute', top: 28, right: 28 }) },
    checkIcon(),
    e('div', { style: { marginLeft: 8 } }, 'Color finish'),
  )
}

function contractChip() {
  return e(
    'div',
    {
      style: chipStyle({
        position: 'absolute',
        bottom: 28,
        left: 28,
        padding: '8px 13px 8px 11px',
      }),
    },
    checkIcon(),
    e('div', { style: { marginLeft: 8 } }, 'Tone · Color · HSL'),
  )
}

function filePill() {
  return e(
    'div',
    {
      style: {
        position: 'absolute',
        right: 28,
        bottom: 28,
        display: 'flex',
        alignItems: 'center',
        padding: '10px 14px',
        borderRadius: 8,
        border: `1px solid ${colors.onPhotoBorder}`,
        backgroundColor: colors.onPhotoBg,
        color: colors.text,
        fontSize: 12.5,
        fontWeight: 660,
        lineHeight: 1,
        fontFeatureSettings: '"tnum" 1',
      },
    },
    imageUpIcon(),
    e('div', { style: { marginLeft: 10 } }, 'SGL00940.ARW'),
    e('div', {
      style: {
        width: 1,
        height: 14,
        marginLeft: 10,
        backgroundColor: 'oklch(0.9 0.01 255 / 0.16)',
      },
    }),
    e('div', { style: { marginLeft: 10, color: colors.textMuted } }, '82.8 MB'),
  )
}

function rightPane(heroImageSrc: string) {
  const fullImageStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: 670,
    height: 630,
    objectFit: 'cover',
  }

  return e(
    'div',
    {
      style: {
        position: 'relative',
        width: 670,
        height: 630,
        overflow: 'hidden',
      },
    },
    e('img', {
      src: heroImageSrc,
      width: 670,
      height: 630,
      style: {
        ...fullImageStyle,
        filter: 'saturate(0.50) contrast(0.90) brightness(0.84)',
      },
    }),
    e(
      'div',
      {
        style: {
          position: 'absolute',
          top: 0,
          left: 335,
          width: 335,
          height: 630,
          overflow: 'hidden',
        },
      },
      e('img', {
        src: heroImageSrc,
        width: 670,
        height: 630,
        style: {
          position: 'absolute',
          top: 0,
          left: -335,
          width: 670,
          height: 630,
          objectFit: 'cover',
          filter: 'saturate(1.04) contrast(1.04) brightness(1.01)',
        },
      }),
    ),
    e('div', {
      style: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 334,
        width: 2,
        backgroundColor: colors.divider,
        boxShadow: '0 0 14px oklch(0.025 0.008 255 / 0.48)',
      },
    }),
    e(
      'div',
      {
        style: {
          position: 'absolute',
          top: 289,
          left: 309,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: '1.5px solid oklch(0.9 0.01 255 / 0.2)',
          backgroundColor: colors.dividerHandleBg,
        },
      },
      compareHandleIcon(),
    ),
    rawTag(),
    finishedTag(),
    contractChip(),
    filePill(),
  )
}

function ogImageElement({ heroImageSrc, logoSrc }: LumaForgeOgImageAssets) {
  return e(
    'div',
    {
      style: {
        display: 'flex',
        width: LUMAFORGE_OG_IMAGE_WIDTH,
        height: LUMAFORGE_OG_IMAGE_HEIGHT,
        overflow: 'hidden',
        backgroundColor: colors.bg,
        color: colors.text,
        fontFamily: 'Geist Sans',
        fontFeatureSettings: '"ss01" 1, "cv11" 1',
      },
    },
    e(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: 530,
          height: 630,
          padding: '56px 44px 52px 64px',
          borderRight: `1px solid ${colors.border}`,
          boxSizing: 'border-box',
        },
      },
      markLockup(logoSrc),
      e('div', null, eyebrow(), headline()),
      statusLine(),
    ),
    rightPane(heroImageSrc),
  )
}

export async function renderLumaForgeOgImage(assets: LumaForgeOgImageAssets) {
  return render(ogImageElement(assets), {
    width: LUMAFORGE_OG_IMAGE_WIDTH,
    height: LUMAFORGE_OG_IMAGE_HEIGHT,
    fonts: [
      {
        name: 'Geist Sans',
        data: assets.fontData,
      },
    ],
    loadDefaultFonts: false,
    emoji: 'from-font',
  })
}
