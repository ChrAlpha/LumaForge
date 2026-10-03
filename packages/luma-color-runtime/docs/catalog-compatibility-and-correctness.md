# LUT Catalog Compatibility and Color Math Correctness

This document is intended to be self-contained. Source links are provenance
only; the runtime formulas and project-specific calculation rules are written
out here so a reader does not need to follow each source to understand the
implemented math.

Snapshot checked on 2026-04-30 against the stable catalog snapshot current at
verification time.

- Catalog tag: `v2026.05.01`
- Catalog generated at: `2026-04-30T16:51:45.130Z`
- Entries checked: 70
- Entry metadata used: `entryUrl` JSON only. `.cube` files were not downloaded.

## Runtime Model

The full-resolution export graph starts from scene-linear ProPhoto RGB / ROMM
RGB and produces final JPEG bytes in sRGB / Rec.709. Preview and export share
the same color contracts, but export is the authoritative path.

For each RGB pixel, the export graph applies these operations:

1. Convert integer source rows to normalized linear values when needed:
   `linear = u16 / 65535`.
2. Apply RAW render exposure: `rgb = rgb * 2^ev`.
   Auto and metadata-derived render EV are clamped to `[-3, 3]`.
3. Apply user color balance as ProPhoto-relative RGB gain:
   `rgb = rgb * gain`.
4. Apply user exposure: `rgb = rgb * 2^ev`.
   User exposure EV is clamped to `[-5, 5]`.
5. Apply user contrast in linear ProPhoto luminance.
6. Apply regional tone in linear ProPhoto luminance.
7. If no LUT is active, convert linear ProPhoto to linear sRGB, encode sRGB,
   clamp to `[0, 1]`, and round to 8-bit JPEG bytes.
8. If a LUT is active, convert to the LUT input contract, encode the LUT input
   transfer, apply signal range, apply the 3D LUT, remove output signal range,
   decode the LUT output transfer, convert the declared LUT output gamut to
   linear sRGB, mix by LUT role, encode sRGB, clamp, and round to bytes.

The final JPEG is always sRGB / Rec.709. The LUT output is not assumed to be
Rec.709 unless its output contract says so.

### Contract Roles

Catalog and user-selected LUTs resolve to one of these runtime roles:

- `display-look`: input must be display-like, meaning `srgb-rec709` gamut and
  one of `srgb`, `bt709`, or `gamma24` transfer.
- `scene-creative`: LUT input is scene-linear ProPhoto converted to the LUT
  input gamut and transfer. Output must have a complete contract for export.
- `combined-look-output`: LUT input is scene-linear, and LUT output is treated
  as the declared final/output color contract.
- `technical-output`: same output-contract requirement as combined output, but
  semantically a technical transform rather than a creative look.

Trusted catalog metadata that declares a non-display input and a complete
output contract is treated as `combined-look-output`, even when the catalog
intent string says `display-look`. This preserves the stricter UI rule that
manually selected `display-look` LUTs must be display-like while allowing
stable catalog technical/look LUTs with explicit output metadata to export
through the scene-referred graph.

Export fails closed when:

- The LUT profile is unresolved.
- A non-display role has no complete output gamut, output transfer, and output
  range.
- The resolved output range is `unknown`.
- The resolved output transfer is `linear`.

Input and output signal ranges are:

- Full range: `V_full = V`.
- Legal input encoding: `V_legal = V_full * ((940 - 64) / 1023) + 64 / 1023`.
- Legal output removal:
  `V_full = (V_legal - 64 / 1023) * (1023 / (940 - 64))`.

## User Tone And Balance Calculations

These steps run before any scene-referred LUT input is constructed. Linear
ProPhoto luminance is:

```text
Y = 0.2880402 R + 0.7118741 G + 0.0000857 B
```

Color balance clamps `temperature` and `tint` to `[-100, 100]`, normalizes
them to `/ 100`, computes EV-based raw gains, and normalizes those gains so
neutral luminance stays stable:

```text
rawR = 2^(temperatureNorm * 0.22 + tintNorm * 0.16 * 0.35)
rawG = 2^(-tintNorm * 0.16)
rawB = 2^(-temperatureNorm * 0.22 + tintNorm * 0.16 * 0.35)
luma = rawR * 0.2880402 + rawG * 0.7118741 + rawB * 0.0000857
gain = [rawR, rawG, rawB] / max(luma, 1e-6)
```

User contrast clamps `amount` to `[-100, 100]`. If `amount = 0`, contrast is
identity. If `Y <= 0`, it returns black.

```text
factor = 2^(amount / 200)
pivot = 0.18
targetY = pivot * (Y / pivot)^factor
scale = targetY / Y
rgbOut = max(rgbIn, 0) * scale
```

Regional tone clamps `highlights`, `shadows`, `whites`, and `blacks` to
`[-100, 100]`, computes `logY = log2(Y / 0.18)`, and returns identity when all
regional sliders are zero. If `Y <= 0`, it returns black.

```text
smoothstep(a, b, x):
  t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
highlightsMask = smoothstep(-1, 3, logY)
shadowsMask = 1 - smoothstep(-4, 1, logY)
whitesMask = smoothstep(2, 5.5, logY)
blacksMask = 1 - smoothstep(-8, -3, logY)
amountToEv(amount, maxAbsEv) = (amount / 100) * maxAbsEv
ev =
  highlightsMask * amountToEv(highlights, 1.25) +
  shadowsMask * amountToEv(shadows, 1.25) +
  whitesMask * amountToEv(whites, 1.0) +
  blacksMask * amountToEv(blacks, 1.0)
scale = 2^ev
rgbOut = max(rgbIn, 0) * scale
```

RAW render exposure can come from DNG `BaselineExposure` or image statistics.
The image-statistics path samples up to about 4096 pixels, ignores values at or
below `1 / 65535`, sorts usable luminance values, then clamps EV to `[-3, 3]`:

```text
p95Ev = log2(0.75 / p95)
p99Ev = p99 > p95 ? max(0, log2(0.65 / p99)) : p95Ev
autoEv = min(p95Ev, p99Ev)
```

## Matrix Method

All gamut conversions are derived from CIE 1931 `xy` primaries and white
points. The runtime stores matrices in row-major order and applies them as:

```text
R' = m00 R + m01 G + m02 B
G' = m10 R + m11 G + m12 B
B' = m20 R + m21 G + m22 B
```

For any chromaticity coordinate `(x, y)`, the runtime converts to `XYZ` with
`Y = 1`:

```text
X = x / y
Y = 1
Z = (1 - x - y) / y
```

Given red, green, and blue primary `XYZ` values, build:

```text
P = [ [Xr, Xg, Xb],
      [ 1,  1,  1],
      [Zr, Zg, Zb] ]
W = xyToXYZ(whitePoint)
S = inverse(P) * W
M_rgb_to_xyz = P * diag(S)
```

The explicit matrix entries are:

```text
[ Sr*Xr, Sg*Xg, Sb*Xb,
  Sr,    Sg,    Sb,
  Sr*Zr, Sg*Zg, Sb*Zb ]
```

To convert source RGB to destination RGB:

```text
M_src_to_dst = inverse(M_dst_rgb_to_xyz) * A * M_src_rgb_to_xyz
```

`A` is identity when source and destination white points differ by no more than
`0.001` in both `x` and `y`. Otherwise `A` is Bradford chromatic adaptation:

```text
M_Bradford =
  [  0.8951,  0.2664, -0.1614,
    -0.7502,  1.7135,  0.0367,
     0.0389, -0.0685,  1.0296 ]

srcCone = M_Bradford * Wsrc
dstCone = M_Bradford * Wdst
D = diag(dstCone.r / srcCone.r,
         dstCone.g / srcCone.g,
         dstCone.b / srcCone.b)
A = inverse(M_Bradford) * D * M_Bradford
```

This is why linear ProPhoto RGB (D50) to camera gamuts (mostly D65) is covered
by the same code path as camera/LUT output gamuts to Rec.709/sRGB.

### Gamut Definitions

| Runtime gamut        | Red xy               | Green xy             | Blue xy               | White xy                    |
| -------------------- | -------------------- | -------------------- | --------------------- | --------------------------- |
| `prophoto-rgb`       | `0.7347, 0.2653`     | `0.1596, 0.8404`     | `0.0366, 0.0001`      | D50 `0.3457, 0.3585`        |
| `srgb-rec709`        | `0.64, 0.33`         | `0.30, 0.60`         | `0.15, 0.06`          | D65 `0.3127, 0.3290`        |
| `display-p3`         | `0.68, 0.32`         | `0.265, 0.69`        | `0.15, 0.06`          | D65 `0.3127, 0.3290`        |
| `rec2020`            | `0.708, 0.292`       | `0.17, 0.797`        | `0.131, 0.046`        | D65 `0.3127, 0.3290`        |
| `dji-d-gamut`        | `0.71, 0.31`         | `0.21, 0.88`         | `0.09, -0.08`         | D65 `0.3127, 0.3290`        |
| `s-gamut`            | `0.73, 0.28`         | `0.14, 0.855`        | `0.10, -0.05`         | D65 `0.3127, 0.3290`        |
| `s-gamut3`           | `0.73, 0.28`         | `0.14, 0.855`        | `0.10, -0.05`         | D65 `0.3127, 0.3290`        |
| `s-gamut3-cine`      | `0.766, 0.275`       | `0.225, 0.800`       | `0.089, -0.087`       | D65 `0.3127, 0.3290`        |
| `v-gamut`            | `0.730, 0.280`       | `0.165, 0.840`       | `0.100, -0.030`       | D65 `0.3127, 0.3290`        |
| `f-gamut`            | `0.708, 0.292`       | `0.17, 0.797`        | `0.131, 0.046`        | D65 `0.3127, 0.3290`        |
| `f-gamut-c`          | `0.7347, 0.2653`     | `0.0263, 0.9737`     | `0.1173, -0.0224`     | D65 `0.3127, 0.3290`        |
| `canon-cinema-gamut` | `0.74, 0.27`         | `0.17, 1.14`         | `0.08, -0.10`         | D65 `0.3127, 0.3290`        |
| `arri-wide-gamut-3`  | `0.684, 0.313`       | `0.221, 0.848`       | `0.0861, -0.102`      | D65 `0.3127, 0.3290`        |
| `arri-wide-gamut-4`  | `0.7347, 0.2653`     | `0.1424, 0.8576`     | `0.0991, -0.0308`     | D65 `0.3127, 0.3290`        |
| `red-wide-gamut-rgb` | `0.780308, 0.304253` | `0.121595, 1.493994` | `0.095612, -0.084589` | D65 `0.3127, 0.3290`        |
| `aces-ap1`           | `0.713, 0.293`       | `0.165, 0.830`       | `0.128, 0.044`        | ACES D60 `0.32168, 0.33767` |

The stable catalog currently uses only a subset of these gamuts, but the
runtime registry exposes the full table above.

## Transfer Function Formulas

The formulas below are per channel. `L` means linear input, `V` means encoded
input, `E` is encode, and `D` is decode. Unless a formula states a clamp,
signed values are allowed when the runtime allows them; this keeps legal-range
and LUT-domain math finite.

```text
linear:
  E(L) = L
  D(V) = V

srgb:
  E(L) = L <= 0.0031308 ? 12.92 L : 1.055 L^(1/2.4) - 0.055
  D(V) = V <= 0.04045 ? V / 12.92 : ((V + 0.055) / 1.055)^2.4
  final byte = round(clamp(srgbEncode(max(linear, 0)), 0, 1) * 255)

bt709:
  E(L) = L <= 0.018 ? 4.5 L : 1.099 L^0.45 - 0.099
  D(V) = V <= 0.081 ? V / 4.5 : max((V + 0.099) / 1.099, 0)^(1 / 0.45)

gamma24:
  E(L) = max(L, 0)^(1/2.4)
  D(V) = max(V, 0)^2.4

s-log2:
  reflected = 0.9 * max(L, 0)
  E(L) = 0.432699 log10(reflected + 0.037584) + 0.616596 + 0.03
  D(V) = (10^((V - 0.03 - 0.616596) / 0.432699) - 0.037584) / 0.9

s-log3:
  E(L) = L >= 0.01125
    ? (420 + log10((L + 0.01) / 0.19) * 261.5) / 1023
    : (L * (171.2102946929 - 95) / 0.01125 + 95) / 1023
  x = V * 1023
  D(V) = x >= 171.2102946929
    ? 10^((x - 420) / 261.5) * 0.19 - 0.01
    : (x - 95) * 0.01125 / (171.2102946929 - 95)

v-log:
  E(L) = L < 0.01 ? 5.6 L + 0.125 : 0.241514 log10(L + 0.00873) + 0.598206
  D(V) = V < 0.181 ? (V - 0.125) / 5.6 : 10^((V - 0.598206) / 0.241514) - 0.00873

f-log:
  E(L) = L < 0.00089 ? 8.735631 L + 0.092864 : 0.344676 log10(0.555556 L + 0.009468) + 0.790453
  D(V) = V < 0.100537775223865 ? (V - 0.092864) / 8.735631 : (10^((V - 0.790453) / 0.344676) - 0.009468) / 0.555556

f-log2 and f-log2c:
  E(L) = L < 0.000889 ? 8.799461 L + 0.092864 : 0.245281 log10(5.555556 L + 0.064829) + 0.384316
  D(V) = V < 0.100686685370811 ? (V - 0.092864) / 8.799461 : (10^((V - 0.384316) / 0.245281) - 0.064829) / 5.555556

n-log:
  a = 650 / 1023; b = 0.0075; c = 150 / 1023; d = 619 / 1023
  E(L) = L < 0.328 ? cbrt(L) * a + b : ln(L) * c + d
  cut = cbrt(0.328) * a + b
  D(V) = V < cut ? ((V - b) / a)^3 : exp((V - d) / c)

logc3:
  E(L) = L > 0.010591 ? 0.24719 log10(5.555556 L + 0.052272) + 0.385537 : 5.367655 L + 0.092809
  D(V) = V > 0.1496 ? (10^((V - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (V - 0.092809) / 5.367655

logc4:
  a = (2^18 - 16) / 117.45; b = (1023 - 95) / 1023; c = 95 / 1023
  s = (7 ln(2) * 2^(7 - (14 c) / b)) / (a b)
  t = (2^(14 * (-c / b) + 6) - 64) / a
  E(L) = L < t ? (L - t) / s : ((log2(a L + 64) - 6) / 14) * b + c
  D(V) = V < 0 ? V * s + t : (2^((14 * (V - c)) / b + 6) - 64) / a

log3g10:
  y = L + 0.01
  E(L) = y < 0 ? y * 15.1927 : 0.224282 log10(155.975327 y + 1)
  D(V) = V < 0 ? V / 15.1927 - 0.01 : (10^(V / 0.224282) - 1) / 155.975327 - 0.01

apple-log:
  r0 = -0.05641088; rt = 0.01; c = 47.28711236
  beta = 0.00964052; gamma = 0.08550479; delta = 0.69336945
  pt = c * (rt - r0)^2
  E(L) = L < r0 ? 0 : L < rt ? c * (L - r0)^2 : gamma * log2(L + beta) + delta
  D(V) = V < 0 ? r0 : V < pt ? sqrt(V / c) + r0 : 2^((V - delta) / gamma) - beta

dji-d-log:
  E(L) = L <= 0.0078 ? 6.025 L + 0.0929 : log10(0.9892 L + 0.0108) * 0.256663 + 0.584555
  D(V) = V <= 0.14 ? (V - 0.0929) / 6.025 : (10^(3.89616 V - 2.27752) - 0.0108) / 0.9892

l-log:
  E(L) = L <= 0.006 ? 8 L + 0.09 : 0.27 log10(1.3 L + 0.0115) + 0.6
  D(V) = V <= 0.138 ? (V - 0.09) / 8 : (10^((V - 0.6) / 0.27) - 0.0115) / 1.3

canon-log:
  E(L) = L < 0 ? -0.529136 log10(-10.1596 L + 1) + 0.0730597 : 0.529136 log10(10.1596 L + 1) + 0.0730597
  D(V) = V < 0.0730597 ? -(10^((0.0730597 - V) / 0.529136) - 1) / 10.1596 : (10^((V - 0.0730597) / 0.529136) - 1) / 10.1596

canon-log2:
  E(L) = L < 0 ? -0.24136077 log10(1 - (87.099375 L) / 0.9) + 0.092864125 : 0.24136077 log10(1 + (87.099375 L) / 0.9) + 0.092864125
  D(V) = V < 0.092864125 ? 0.9 * (1 - 10^((0.092864125 - V) / 0.24136077)) / 87.099375 : 0.9 * (10^((V - 0.092864125) / 0.24136077) - 1) / 87.099375

canon-log3:
  E(L) = L < -0.0126
    ? -0.36726845 log10(1 - (14.98325 L) / 0.9) + 0.12783901
    : L <= 0.0126 ? (L * 1.9754798) / 0.9 + 0.12512219
    : 0.36726845 log10(1 + (14.98325 L) / 0.9) + 0.12240537
  D(V) = V < 0.097465473
    ? 0.9 * (1 - 10^((0.12783901 - V) / 0.36726845)) / 14.98325
    : V <= 0.15277891 ? 0.9 * (V - 0.12512219) / 1.9754798
    : 0.9 * (10^((V - 0.12240537) / 0.36726845) - 1) / 14.98325

acescc:
  a = 17.52; b = 9.72; low = 2^-16; cut = 2^-15; cutV = (log2(cut) + b) / a
  E(L) = L <= 0 ? (log2(low) + b) / a : L < cut ? (log2(low + L * 0.5) + b) / a : (log2(L) + b) / a
  D(V) = V <= cutV ? (2^(V a - b) - low) * 2 : 2^(V a - b)

acescct:
  a = 17.52; b = 9.72; cut = 0.0078125
  slope = 10.5402377416545; offset = 0.0729055341958355; cutV = 0.155251141552511
  E(L) = L <= cut ? slope L + offset : (log2(L) + b) / a
  D(V) = V <= cutV ? (V - offset) / slope : 2^(V a - b)
```

## LUT Domain And Sampling

CUBE domain bounds are `domainMin = [minR, minG, minB]` and
`domainMax = [maxR, maxG, maxB]`. Before sampling, the runtime compresses
out-of-domain values by preserving channel ratios after normalization. CPU
export samples red-fastest, then green, then blue data with trilinear
interpolation. The WebGPU preview uses the same compression and samples the 3D
texture at `(sampleCoord * (N - 1) + 0.5) / N`.

```text
normalize(value, min, max):
  span = max - min
  if value or span is not finite, or span <= 0, return 0
  return max(0, (value - min) / span)
n = [normalize(R), normalize(G), normalize(B)]
peak = max(n.r, n.g, n.b)
scale = peak > 1 ? 1 / peak : 1
compressed = domainMin + (n * scale) * (domainMax - domainMin)
sampleCoord.c = clamp01(normalize(compressed.c, domainMin.c, domainMax.c))

x = clamp01(sampleCoord.r) * (N - 1)
y = clamp01(sampleCoord.g) * (N - 1)
z = clamp01(sampleCoord.b) * (N - 1)
x0 = floor(x), x1 = min(N - 1, x0 + 1), tx = x - x0
y0 = floor(y), y1 = min(N - 1, y0 + 1), ty = y - y0
z0 = floor(z), z1 = min(N - 1, z0 + 1), tz = z - z0
index(r, g, b) = ((b * N + g) * N + r) * 3

mix(a, b, t) = a + (b - a) * t
c00 = mix(C000, C100, tx)
c10 = mix(C010, C110, tx)
c01 = mix(C001, C101, tx)
c11 = mix(C011, C111, tx)
c0 = mix(c00, c10, ty)
c1 = mix(c01, c11, ty)
out = mix(c0, c1, tz)
```

## LUT Role Mixing

The runtime computes both an unstyled base display value and a styled display
value when a LUT is present. `display-look` LUTs receive display-linear sRGB.
`scene-creative`, `combined-look-output`, and `technical-output` LUTs receive
scene-linear ProPhoto converted to the declared input gamut.

```text
baseLinearSrgb = max(M_prophoto_to_srgb * sceneLinearProPhoto, 0)

display-look lutInputLinear = baseLinearSrgb
other roles lutInputLinear = M_prophoto_to_lutInputGamut * sceneLinearProPhoto
lutInputEncoded = applyInputRange(E_inputTransfer(lutInputLinear))
lutOutputEncoded = removeOutputRange(lutSample)
lutOutputLinear = D_outputTransfer(lutOutputEncoded)
styledLinearSrgb = max(M_lutOutputGamut_to_srgb * lutOutputLinear, 0)

scene-creative:
  final = srgbEncode(mix(baseLinearSrgb, styledLinearSrgb, intensity))
display-look, combined-look-output, technical-output:
  final = mix(srgbEncode(baseLinearSrgb), srgbEncode(styledLinearSrgb), intensity)
```

The final encoded values are clamped to `[0, 1]` and rounded to bytes.

## Stable Catalog Input Contract Coverage

These stable catalog input contracts are covered by public color math and
runtime tests:

| Catalog input gamut  | Catalog input transfer | Count | Runtime gamut        | Runtime transfer |
| -------------------- | ---------------------: | ----: | -------------------- | ---------------- |
| `arri-wide-gamut-3`  |           `arri-logc3` |     2 | `arri-wide-gamut-3`  | `logc3`          |
| `dji-d-gamut`        |            `dji-d-log` |     1 | `dji-d-gamut`        | `dji-d-log`      |
| `fujifilm-f-gamut-c` |     `fujifilm-f-log2c` |    12 | `f-gamut-c`          | `f-log2c`        |
| `leica-l-gamut`      |          `leica-l-log` |     2 | `rec2020`            | `l-log`          |
| `rec2020`            |            `apple-log` |     1 | `rec2020`            | `apple-log`      |
| `rec2020`            |          `nikon-n-log` |     5 | `rec2020`            | `n-log`          |
| `red-wide-gamut-rgb` |          `red-log3g10` |    16 | `red-wide-gamut-rgb` | `log3g10`        |
| `sony-s-gamut`       |          `sony-s-log2` |     4 | `s-gamut`            | `s-log2`         |
| `sony-s-gamut3-cine` |          `sony-s-log3` |     4 | `s-gamut3-cine`      | `s-log3`         |
| `v-gamut`            |                `v-log` |    15 | `v-gamut`            | `v-log`          |

Leica L-Log catalog entries are mapped to `rec2020` because the public Leica
L-Log reference states that recent Leica L-Log cameras use ITU-R BT.2020
primaries.

Additional input contracts found in the catalog but not implemented as
mathematical transforms:

| Catalog input gamut | Catalog input transfer | Count | Status                                                                                                                                                 |
| ------------------- | ---------------------: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `display-p3`        |  `om-system-om-log400` |     1 | Gamut is covered; OM-Log400 transfer is not implemented because no public formula was found.                                                           |
| `rec2020`           |  `om-system-om-log400` |     1 | Gamut is covered; OM-Log400 transfer is not implemented because no public formula was found.                                                           |
| `rec709`            |       `insta360-i-log` |     2 | Rec.709 gamut is covered; Insta360 I-Log transfer is not implemented because public Insta360 docs describe LUT workflow but not the transfer function. |
| `rec709`            |       `om-system-flat` |     1 | Rec.709 gamut is covered; OM System Flat transfer is not implemented because no public formula was found.                                              |
| `(missing)`         |            `(missing)` |     3 | Entry metadata has no input/output LUT contract.                                                                                                       |

The unresolved entries intentionally fail closed. The runtime does not map
private curves to sRGB, gamma 2.4, or another curve by guesswork.

## Stable Catalog Output Contract Coverage

These stable catalog output contracts are covered for export to final
Rec.709/sRGB JPEG:

| Catalog output gamut | Catalog output transfer | Count | Runtime output handling                          |
| -------------------- | ----------------------: | ----: | ------------------------------------------------ |
| `rec709`             |                `bt1886` |    21 | `srgb-rec709` primaries plus `gamma24` transfer. |
| `rec709`             |             `gamma-2-4` |     2 | `srgb-rec709` primaries plus `gamma24` transfer. |
| `rec709`             |                  `srgb` |    41 | `srgb-rec709` primaries plus `srgb` transfer.    |

Output contracts not implemented as mathematical transforms:

| Catalog output gamut | Catalog output transfer | Count | Status                                                                 |
| -------------------- | ----------------------: | ----: | ---------------------------------------------------------------------- |
| `rec709`             |         `om-system-sdr` |     1 | Rec.709 gamut is covered; OM System SDR output transfer is not public. |
| `rec709`             |         `om-system-wdr` |     2 | Rec.709 gamut is covered; OM System WDR output transfer is not public. |
| `(missing)`          |             `(missing)` |     3 | Entry metadata has no input/output LUT contract.                       |

## Sources

The formulas above are the runtime formulas. These links are source references
for the constants and public color specifications:

- ICC ROMM RGB / ProPhoto RGB: <https://www.color.org/chardata/rgb/rommrgb.xalter>
- W3C sRGB profile interpretation: <https://www.w3.org/Graphics/Color/srgb.pdf>
- ITU-R BT.2020: <https://www.itu.int/rec/R-REC-BT.2020/en>
- ITU-R BT.709: <https://www.itu.int/rec/R-REC-BT.709/en>
- BT.1886 display EOTF: <https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1886-0-201103-I!!PDF-E.pdf>
- ARRI LogC3 / AWG3: <https://www.arri.com/resource/blob/31918/66f56e6abb6e5b6553929edf9aa7483e/2017-03-alexa-logc-curve-in-vfx-data.pdf>
- ARRI LogC4 / AWG4: <https://www.arri.com/resource/blob/278790/f3318e8c9c65617d8c5ca3f8b3e32051/2023-05-arri-logc4-specification-data.pdf>
- DJI D-Log / D-Gamut: <https://dl.djicdn.com/downloads/DJI_Ronin_4D/X9_D_Log_D_Gamut_Whitepaper.pdf>
- Fujifilm F-Log: <https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.2.pdf>
- Fujifilm F-Log2: <https://dl.fujifilm-x.com/support/lut/F-Log2_DataSheet_E_Ver.1.0.pdf>
- Fujifilm F-Log2 C / F-Gamut C: <https://dl.fujifilm-x.com/support/lut/F-Log2C_DataSheet_E_Ver.1.0.pdf>
- Leica L-Log: <https://leica-camera.com/sites/default/files/pm-101409-l-log_reference_manual_v1.4.pdf>
- Apple Log ACES IDT: <https://raw.githubusercontent.com/ampas/aces-dev/528c78fe2c0f4e7eb322581e98aba05de79466cb/transforms/ctl/idt/vendorSupplied/apple/IDT.Apple.AppleLog_BT2020.ctl>
- Apple Log implementation reference: <https://github.com/colour-science/colour/blob/develop/colour/models/rgb/transfer_functions/apple_log_profile.py>
- REDWideGamutRGB / Log3G10: <https://docs.red.com/955-0187/PDF/915-0187%20Rev-C%20%20%20RED%20OPS%2C%20White%20Paper%20on%20REDWideGamutRGB%20and%20Log3G10.pdf>
- Sony S-Gamut/S-Log documentation: <https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf>
- Sony S-Log overview: <https://www.sony.com/electronics/support/articles/00145908>
- Panasonic V-Log / V-Gamut: <https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf>
- Canon Log gamma curves: <https://www.usa.canon.com/content/dam/canon-assets/white-papers/pro/white-paper-canon-log-gamma-curves.pdf>
- ACEScc: <https://docs.acescentral.com/encodings/acescc/>
- ACEScct: <https://docs.acescentral.com/encodings/acescct/>
- OM System I-Log/Flat-related catalog entries: <https://explore.omsystem.com/c/en/om-3>
- Insta360 I-Log: <https://onlinemanual.insta360.com/acepro2/en-us/operation-tutorials/shoot-preview/shooting-features/i-log>

## Test Coverage

Coverage is locked by package tests: `registry.test.ts` covers stable catalog
aliases and unresolved private curves; `lut-contract.test.ts` covers trusted
metadata role normalization; `log-encoding.test.ts` covers transfer reference
points, round trips, and legal-range decode behavior; `matrix.test.ts` covers
finite gamut matrices; `row-band-processor.test.ts` and `color-graph.test.ts`
cover export graph ordering, LUT roles, signal ranges, and final sRGB bytes.
