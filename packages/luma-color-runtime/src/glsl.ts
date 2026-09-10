export { LUMA_COLOR_OKLAB_GLSL } from './oklab'
export { LUMA_COLOR_USER_SATURATION_GLSL } from './saturation-glsl'
export { LUMA_COLOR_SELECTIVE_COLOR_GLSL } from './selective-color'
export {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from './shader-uniforms'

export const LUMA_COLOR_TRANSFER_GLSL = /* glsl */ `
const int TRANSFER_SRGB = 0;
const int TRANSFER_BT709 = 1;
const int TRANSFER_GAMMA24 = 2;
const int TRANSFER_S_LOG2 = 3;
const int TRANSFER_S_LOG3 = 4;
const int TRANSFER_CANON_LOG = 5;
const int TRANSFER_CANON_LOG2 = 6;
const int TRANSFER_CANON_LOG3 = 7;
const int TRANSFER_N_LOG = 8;
const int TRANSFER_F_LOG = 9;
const int TRANSFER_F_LOG2 = 10;
const int TRANSFER_F_LOG2C = 11;
const int TRANSFER_V_LOG = 12;
const int TRANSFER_LOGC3 = 13;
const int TRANSFER_LOGC4 = 14;
const int TRANSFER_LOG3G10 = 15;
const int TRANSFER_ACESCC = 16;
const int TRANSFER_ACESCCT = 17;
const int TRANSFER_L_LOG = 18;
const int TRANSFER_LINEAR = 19;
const int TRANSFER_APPLE_LOG = 20;
const int TRANSFER_DJI_D_LOG = 21;

vec3 clamp01(vec3 color) {
  return clamp(color, 0.0, 1.0);
}

vec3 srgbToLinear(vec3 color) {
  color = clamp01(color);
  vec3 lower = color / 12.92;
  vec3 higher = pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  vec3 lowerMix = 1.0 - step(vec3(0.04045), color);
  return mix(higher, lower, lowerMix);
}

vec3 linearToSrgb(vec3 color) {
  color = max(color, vec3(0.0));
  vec3 lower = color * 12.92;
  vec3 higher = 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055;
  vec3 lowerMix = 1.0 - step(vec3(0.0031308), color);
  return clamp01(mix(higher, lower, lowerMix));
}

float encodeSrgbTransfer(float linearValue) {
  if (linearValue <= 0.0031308) {
    return 12.92 * linearValue;
  }
  return 1.055 * pow(max(linearValue, 0.0), 1.0 / 2.4) - 0.055;
}

float decodeSrgbTransfer(float encodedValue) {
  if (encodedValue <= 0.04045) {
    return encodedValue / 12.92;
  }
  return pow(max((encodedValue + 0.055) / 1.055, 0.0), 2.4);
}

float encodeBT709(float linearValue) {
  if (linearValue <= 0.018) {
    return 4.5 * linearValue;
  }
  return 1.099 * pow(max(linearValue, 0.0), 0.45) - 0.099;
}

float decodeBT709(float encodedValue) {
  if (encodedValue <= 0.081) {
    return encodedValue / 4.5;
  }
  return pow(max((encodedValue + 0.099) / 1.099, 0.0), 1.0 / 0.45);
}

float encodeSLog2(float linearValue) {
  float reflectedLinear = 0.9 * max(linearValue, 0.0);
  return 0.432699 * (log(reflectedLinear + 0.037584) / log(10.0)) + 0.616596 + 0.03;
}

float decodeSLog2(float encodedValue) {
  return (pow(10.0, (encodedValue - 0.03 - 0.616596) / 0.432699) - 0.037584) / 0.9;
}

float encodeSLog3(float linearValue) {
  if (linearValue >= 0.01125) {
    return (420.0 + (log((max(linearValue, 0.0) + 0.01) / 0.19) / log(10.0)) * 261.5) / 1023.0;
  }
  return ((linearValue * (171.2102946929 - 95.0)) / 0.01125 + 95.0) / 1023.0;
}

float decodeSLog3(float encodedValue) {
  float x = encodedValue * 1023.0;
  if (x >= 171.2102946929) {
    return pow(10.0, (x - 420.0) / 261.5) * 0.19 - 0.01;
  }
  return ((x - 95.0) * 0.01125) / (171.2102946929 - 95.0);
}

float encodeCanonLog(float linearValue) {
  if (linearValue < 0.0) {
    return -0.529136 * (log(-10.1596 * linearValue + 1.0) / log(10.0)) + 0.0730597;
  }
  return 0.529136 * (log(10.1596 * linearValue + 1.0) / log(10.0)) + 0.0730597;
}

float decodeCanonLog(float encodedValue) {
  if (encodedValue < 0.0730597) {
    return -(pow(10.0, (0.0730597 - encodedValue) / 0.529136) - 1.0) / 10.1596;
  }
  return (pow(10.0, (encodedValue - 0.0730597) / 0.529136) - 1.0) / 10.1596;
}

float encodeCanonLog2(float linearValue) {
  if (linearValue < 0.0) {
    return -0.24136077 * (log(1.0 - (87.099375 * linearValue) / 0.9) / log(10.0)) + 0.092864125;
  }
  return 0.24136077 * (log(1.0 + (87.099375 * linearValue) / 0.9) / log(10.0)) + 0.092864125;
}

float decodeCanonLog2(float encodedValue) {
  if (encodedValue < 0.092864125) {
    return (0.9 * (1.0 - pow(10.0, (0.092864125 - encodedValue) / 0.24136077))) / 87.099375;
  }
  return (0.9 * (pow(10.0, (encodedValue - 0.092864125) / 0.24136077) - 1.0)) / 87.099375;
}

float encodeCanonLog3(float linearValue) {
  if (linearValue < -0.0126) {
    return -0.36726845 * (log(1.0 - (14.98325 * linearValue) / 0.9) / log(10.0)) + 0.12783901;
  }
  if (linearValue <= 0.0126) {
    return (linearValue * 1.9754798) / 0.9 + 0.12512219;
  }
  return 0.36726845 * (log(1.0 + (14.98325 * linearValue) / 0.9) / log(10.0)) + 0.12240537;
}

float decodeCanonLog3(float encodedValue) {
  if (encodedValue < 0.097465473) {
    return (0.9 * (1.0 - pow(10.0, (0.12783901 - encodedValue) / 0.36726845))) / 14.98325;
  }
  if (encodedValue <= 0.15277891) {
    return (0.9 * (encodedValue - 0.12512219)) / 1.9754798;
  }
  return (0.9 * (pow(10.0, (encodedValue - 0.12240537) / 0.36726845) - 1.0)) / 14.98325;
}

float encodeNLog(float linearValue) {
  if (linearValue < 0.328) {
    return sign(linearValue) * pow(abs(linearValue), 1.0 / 3.0) * (650.0 / 1023.0) + 0.0075;
  }
  return log(linearValue) * (150.0 / 1023.0) + (619.0 / 1023.0);
}

float decodeNLog(float encodedValue) {
  float cut = pow(0.328, 1.0 / 3.0) * (650.0 / 1023.0) + 0.0075;
  if (encodedValue < cut) {
    float toe = (encodedValue - 0.0075) / (650.0 / 1023.0);
    return toe * toe * toe;
  }
  return exp((encodedValue - (619.0 / 1023.0)) / (150.0 / 1023.0));
}

float encodeFLog(float linearValue) {
  if (linearValue < 0.00089) {
    return 8.735631 * linearValue + 0.092864;
  }
  return 0.344676 * (log(0.555556 * linearValue + 0.009468) / log(10.0)) + 0.790453;
}

float decodeFLog(float encodedValue) {
  if (encodedValue < 0.100537775223865) {
    return (encodedValue - 0.092864) / 8.735631;
  }
  return (pow(10.0, (encodedValue - 0.790453) / 0.344676) - 0.009468) / 0.555556;
}

float encodeFLog2(float linearValue) {
  if (linearValue < 0.000889) {
    return 8.799461 * linearValue + 0.092864;
  }
  return 0.245281 * (log(5.555556 * linearValue + 0.064829) / log(10.0)) + 0.384316;
}

float decodeFLog2(float encodedValue) {
  if (encodedValue < 0.100686685370811) {
    return (encodedValue - 0.092864) / 8.799461;
  }
  return (pow(10.0, (encodedValue - 0.384316) / 0.245281) - 0.064829) / 5.555556;
}

float vLogEncodeChannel(float linearValue) {
  if (linearValue < 0.01) {
    return 5.6 * linearValue + 0.125;
  }
  return 0.241514 * (log(max(linearValue, 0.0) + 0.00873) / log(10.0)) + 0.598206;
}

float vLogDecodeChannel(float encodedValue) {
  if (encodedValue < 0.181) {
    return (encodedValue - 0.125) / 5.6;
  }
  return pow(10.0, (encodedValue - 0.598206) / 0.241514) - 0.00873;
}

float encodeLogC3(float linearValue) {
  if (linearValue > 0.010591) {
    return 0.24719 * (log(5.555556 * linearValue + 0.052272) / log(10.0)) + 0.385537;
  }
  return 5.367655 * linearValue + 0.092809;
}

float decodeLogC3(float encodedValue) {
  if (encodedValue > 0.1496) {
    return (pow(10.0, (encodedValue - 0.385537) / 0.24719) - 0.052272) / 5.555556;
  }
  return (encodedValue - 0.092809) / 5.367655;
}

float encodeLogC4(float linearValue) {
  float a = (262144.0 - 16.0) / 117.45;
  float b = (1023.0 - 95.0) / 1023.0;
  float c = 95.0 / 1023.0;
  float s = (7.0 * log(2.0) * pow(2.0, 7.0 - (14.0 * c) / b)) / (a * b);
  float t = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
  if (linearValue < t) {
    return (linearValue - t) / s;
  }
  return ((log2(a * linearValue + 64.0) - 6.0) / 14.0) * b + c;
}

float decodeLogC4(float encodedValue) {
  float a = (262144.0 - 16.0) / 117.45;
  float b = (1023.0 - 95.0) / 1023.0;
  float c = 95.0 / 1023.0;
  float s = (7.0 * log(2.0) * pow(2.0, 7.0 - (14.0 * c) / b)) / (a * b);
  float t = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
  if (encodedValue < 0.0) {
    return encodedValue * s + t;
  }
  return (pow(2.0, (14.0 * (encodedValue - c)) / b + 6.0) - 64.0) / a;
}

float encodeLog3G10(float linearValue) {
  float y = linearValue + 0.01;
  if (y < 0.0) return y * 15.1927;
  return 0.224282 * (log(155.975327 * y + 1.0) / log(10.0));
}

float decodeLog3G10(float encodedValue) {
  if (encodedValue < 0.0) return encodedValue / 15.1927 - 0.01;
  return (pow(10.0, encodedValue / 0.224282) - 1.0) / 155.975327 - 0.01;
}

float encodeACEScc(float linearValue) {
  if (linearValue <= 0.0) {
    return (-16.0 + 9.72) / 17.52;
  }
  if (linearValue < pow(2.0, -15.0)) {
    return (log2(pow(2.0, -16.0) + linearValue * 0.5) + 9.72) / 17.52;
  }
  return (log2(linearValue) + 9.72) / 17.52;
}

float decodeACEScc(float encodedValue) {
  float cut = (-15.0 + 9.72) / 17.52;
  if (encodedValue <= cut) {
    return (pow(2.0, encodedValue * 17.52 - 9.72) - pow(2.0, -16.0)) * 2.0;
  }
  return pow(2.0, encodedValue * 17.52 - 9.72);
}

float encodeACEScct(float linearValue) {
  if (linearValue <= 0.0078125) {
    return 10.5402377416545 * linearValue + 0.0729055341958355;
  }
  return (log2(linearValue) + 9.72) / 17.52;
}

float decodeACEScct(float encodedValue) {
  if (encodedValue <= 0.155251141552511) {
    return (encodedValue - 0.0729055341958355) / 10.5402377416545;
  }
  return pow(2.0, encodedValue * 17.52 - 9.72);
}

float encodeLLog(float linearValue) {
  if (linearValue <= 0.006) {
    return 8.0 * linearValue + 0.09;
  }
  return 0.27 * (log(1.3 * linearValue + 0.0115) / log(10.0)) + 0.6;
}

float decodeLLog(float encodedValue) {
  if (encodedValue <= 0.138) {
    return (encodedValue - 0.09) / 8.0;
  }
  return (pow(10.0, (encodedValue - 0.6) / 0.27) - 0.0115) / 1.3;
}

float encodeAppleLog(float linearValue) {
  float r0 = -0.05641088;
  float rt = 0.01;
  float c = 47.28711236;
  float beta = 0.00964052;
  float gamma = 0.08550479;
  float delta = 0.69336945;
  if (linearValue < r0) {
    return 0.0;
  }
  if (linearValue < rt) {
    return c * pow(linearValue - r0, 2.0);
  }
  return gamma * log2(linearValue + beta) + delta;
}

float decodeAppleLog(float encodedValue) {
  float r0 = -0.05641088;
  float rt = 0.01;
  float c = 47.28711236;
  float beta = 0.00964052;
  float gamma = 0.08550479;
  float delta = 0.69336945;
  float pt = c * pow(rt - r0, 2.0);
  if (encodedValue < 0.0) {
    return r0;
  }
  if (encodedValue < pt) {
    return sqrt(encodedValue / c) + r0;
  }
  return pow(2.0, (encodedValue - delta) / gamma) - beta;
}

float encodeDjiDLog(float linearValue) {
  if (linearValue <= 0.0078) {
    return 6.025 * linearValue + 0.0929;
  }
  return (log(0.9892 * linearValue + 0.0108) / log(10.0)) * 0.256663 + 0.584555;
}

float decodeDjiDLog(float encodedValue) {
  if (encodedValue <= 0.14) {
    return (encodedValue - 0.0929) / 6.025;
  }
  return (pow(10.0, 3.89616 * encodedValue - 2.27752) - 0.0108) / 0.9892;
}

float encodeTransferChannel(float linearValue, int transfer) {
  if (transfer == TRANSFER_LINEAR) return linearValue;
  if (transfer == TRANSFER_SRGB) return encodeSrgbTransfer(linearValue);
  if (transfer == TRANSFER_BT709) return encodeBT709(linearValue);
  if (transfer == TRANSFER_GAMMA24) return pow(max(linearValue, 0.0), 1.0 / 2.4);
  if (transfer == TRANSFER_S_LOG2) return encodeSLog2(linearValue);
  if (transfer == TRANSFER_S_LOG3) return encodeSLog3(linearValue);
  if (transfer == TRANSFER_CANON_LOG) return encodeCanonLog(linearValue);
  if (transfer == TRANSFER_CANON_LOG2) return encodeCanonLog2(linearValue);
  if (transfer == TRANSFER_CANON_LOG3) return encodeCanonLog3(linearValue);
  if (transfer == TRANSFER_N_LOG) return encodeNLog(linearValue);
  if (transfer == TRANSFER_F_LOG) return encodeFLog(linearValue);
  if (transfer == TRANSFER_F_LOG2) return encodeFLog2(linearValue);
  if (transfer == TRANSFER_F_LOG2C) return encodeFLog2(linearValue);
  if (transfer == TRANSFER_V_LOG) return vLogEncodeChannel(linearValue);
  if (transfer == TRANSFER_LOGC3) return encodeLogC3(linearValue);
  if (transfer == TRANSFER_LOGC4) return encodeLogC4(linearValue);
  if (transfer == TRANSFER_LOG3G10) return encodeLog3G10(linearValue);
  if (transfer == TRANSFER_ACESCC) return encodeACEScc(linearValue);
  if (transfer == TRANSFER_ACESCCT) return encodeACEScct(linearValue);
  if (transfer == TRANSFER_L_LOG) return encodeLLog(linearValue);
  if (transfer == TRANSFER_APPLE_LOG) return encodeAppleLog(linearValue);
  if (transfer == TRANSFER_DJI_D_LOG) return encodeDjiDLog(linearValue);
  return linearValue;
}

float decodeTransferChannel(float encodedValue, int transfer) {
  if (transfer == TRANSFER_LINEAR) return encodedValue;
  if (transfer == TRANSFER_SRGB) return decodeSrgbTransfer(encodedValue);
  if (transfer == TRANSFER_BT709) return decodeBT709(encodedValue);
  if (transfer == TRANSFER_GAMMA24) return pow(max(encodedValue, 0.0), 2.4);
  if (transfer == TRANSFER_S_LOG2) return decodeSLog2(encodedValue);
  if (transfer == TRANSFER_S_LOG3) return decodeSLog3(encodedValue);
  if (transfer == TRANSFER_CANON_LOG) return decodeCanonLog(encodedValue);
  if (transfer == TRANSFER_CANON_LOG2) return decodeCanonLog2(encodedValue);
  if (transfer == TRANSFER_CANON_LOG3) return decodeCanonLog3(encodedValue);
  if (transfer == TRANSFER_N_LOG) return decodeNLog(encodedValue);
  if (transfer == TRANSFER_F_LOG) return decodeFLog(encodedValue);
  if (transfer == TRANSFER_F_LOG2) return decodeFLog2(encodedValue);
  if (transfer == TRANSFER_F_LOG2C) return decodeFLog2(encodedValue);
  if (transfer == TRANSFER_V_LOG) return vLogDecodeChannel(encodedValue);
  if (transfer == TRANSFER_LOGC3) return decodeLogC3(encodedValue);
  if (transfer == TRANSFER_LOGC4) return decodeLogC4(encodedValue);
  if (transfer == TRANSFER_LOG3G10) return decodeLog3G10(encodedValue);
  if (transfer == TRANSFER_ACESCC) return decodeACEScc(encodedValue);
  if (transfer == TRANSFER_ACESCCT) return decodeACEScct(encodedValue);
  if (transfer == TRANSFER_L_LOG) return decodeLLog(encodedValue);
  if (transfer == TRANSFER_APPLE_LOG) return decodeAppleLog(encodedValue);
  if (transfer == TRANSFER_DJI_D_LOG) return decodeDjiDLog(encodedValue);
  return encodedValue;
}

vec3 encodeTransfer(vec3 linearColor, int transfer) {
  return vec3(
    encodeTransferChannel(linearColor.r, transfer),
    encodeTransferChannel(linearColor.g, transfer),
    encodeTransferChannel(linearColor.b, transfer)
  );
}

vec3 decodeTransfer(vec3 encodedColor, int transfer) {
  return vec3(
    decodeTransferChannel(encodedColor.r, transfer),
    decodeTransferChannel(encodedColor.g, transfer),
    decodeTransferChannel(encodedColor.b, transfer)
  );
}
`

export const LUMA_COLOR_RANGE_GLSL = /* glsl */ `
const int LUT_RANGE_FULL = 0;
const int LUT_RANGE_LEGAL = 1;
const int LUT_RANGE_UNKNOWN = 2;

vec3 applySignalRangeForLutInput(vec3 color, int range) {
  if (range == LUT_RANGE_LEGAL) {
    return color * ((940.0 - 64.0) / 1023.0) + vec3(64.0 / 1023.0);
  }
  return color;
}

vec3 removeSignalRangeFromLutOutput(vec3 color, int range) {
  if (range == LUT_RANGE_LEGAL) {
    return (color - vec3(64.0 / 1023.0)) * (1023.0 / (940.0 - 64.0));
  }
  return color;
}
`

export const LUMA_COLOR_BALANCE_GLSL = /* glsl */ `
vec3 applyUserColorBalance(vec3 color, vec3 gain) {
  return color * gain;
}
`

export const LUMA_COLOR_LUT_GLSL = /* glsl */ `
const int LUT_ROLE_DISPLAY_LOOK = 0;
const int LUT_ROLE_SCENE_CREATIVE = 1;
const int LUT_ROLE_COMBINED_LOOK_OUTPUT = 2;
const int LUT_ROLE_TECHNICAL_OUTPUT = 3;

bool isSceneCreativeLut() {
  return u_lutRole == LUT_ROLE_SCENE_CREATIVE;
}

bool isOutputLut() {
  return u_lutRole == LUT_ROLE_COMBINED_LOOK_OUTPUT || u_lutRole == LUT_ROLE_TECHNICAL_OUTPUT;
}

float normalizeLutInputChannel(float value, float domainMin, float domainMax) {
  float span = domainMax - domainMin;
  if (isnan(value) || isinf(value) || isnan(span) || isinf(span) || span <= 0.0) {
    return 0.0;
  }
  return max((value - domainMin) / span, 0.0);
}

vec3 lutTextureCoordinate(vec3 normalizedColor) {
  float size = max(u_lutSize, 1.0);
  return (normalizedColor * (size - 1.0) + vec3(0.5)) / size;
}

vec3 compressLutInputToDomain(vec3 color) {
  vec3 normalizedColor = vec3(
    normalizeLutInputChannel(color.r, u_lutDomainMin.r, u_lutDomainMax.r),
    normalizeLutInputChannel(color.g, u_lutDomainMin.g, u_lutDomainMax.g),
    normalizeLutInputChannel(color.b, u_lutDomainMin.b, u_lutDomainMax.b)
  );
  float peak = max(max(normalizedColor.r, normalizedColor.g), normalizedColor.b);
  float scale = peak > 1.0 ? 1.0 / peak : 1.0;
  vec3 compressedColor = normalizedColor * scale;
  return u_lutDomainMin + compressedColor * (u_lutDomainMax - u_lutDomainMin);
}

vec3 applyLut(vec3 color) {
  vec3 domainColor = compressLutInputToDomain(color);
  vec3 normalizedColor = vec3(
    normalizeLutInputChannel(domainColor.r, u_lutDomainMin.r, u_lutDomainMax.r),
    normalizeLutInputChannel(domainColor.g, u_lutDomainMin.g, u_lutDomainMax.g),
    normalizeLutInputChannel(domainColor.b, u_lutDomainMin.b, u_lutDomainMax.b)
  );
  normalizedColor = clamp(normalizedColor, 0.0, 1.0);
  return texture(u_lutTexture, lutTextureCoordinate(normalizedColor)).rgb;
}

vec3 applyDisplayLut(vec3 sceneLinearProPhoto) {
  vec3 displayLinear = max(linearProPhotoToLinearSrgb(sceneLinearProPhoto), vec3(0.0));
  vec3 lutInputEncoded = encodeTransfer(displayLinear, u_lutInputTransfer);
  vec3 lutInput = applySignalRangeForLutInput(lutInputEncoded, u_lutInputRange);
  vec3 lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInput), u_lutOutputRange);
  vec3 displayLinearOutput = decodeTransfer(lutOutputEncoded, u_lutOutputTransfer);
  return linearToSrgb(displayLinearOutput);
}

vec3 applySceneLutToDisplayLinear(vec3 sceneLinearProPhoto) {
  vec3 lutInputLinear = u_inputToLutGamut * sceneLinearProPhoto;
  vec3 lutInputEncoded = applySignalRangeForLutInput(encodeTransfer(lutInputLinear, u_lutInputTransfer), u_lutInputRange);
  vec3 lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInputEncoded), u_lutOutputRange);
  vec3 lutOutputLinear = decodeTransfer(lutOutputEncoded, u_lutOutputTransfer);
  return max(u_lutOutputToDisplayGamut * lutOutputLinear, vec3(0.0));
}

vec3 applyCombinedOutputLut(vec3 sceneLinearProPhoto) {
  vec3 lutInputLinear = u_inputToLutGamut * sceneLinearProPhoto;
  vec3 lutInputEncoded = applySignalRangeForLutInput(encodeTransfer(lutInputLinear, u_lutInputTransfer), u_lutInputRange);
  vec3 lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInputEncoded), u_lutOutputRange);
  vec3 displayLinear = max(u_lutOutputToDisplayGamut * decodeTransfer(lutOutputEncoded, u_lutOutputTransfer), vec3(0.0));
  return linearToSrgb(displayLinear);
}
`

export const LUMA_COLOR_TONE_GLSL = /* glsl */ `
const vec3 LINEAR_PROPHOTO_LUMINANCE = vec3(0.2880402, 0.7118741, 0.0000857);
const float USER_CONTRAST_PIVOT = 0.18;
const float USER_REGIONAL_TONE_PIVOT = 0.18;

vec3 applyUserExposure(vec3 sceneLinear, float exposureMultiplier) {
  return sceneLinear * exposureMultiplier;
}

vec3 applyUserContrast(
  vec3 exposedSceneLinear,
  float contrastAmount,
  float contrastFactor
) {
  if (contrastAmount == 0.0) {
    return exposedSceneLinear;
  }

  vec3 contrastInput = max(exposedSceneLinear, vec3(0.0));
  float y = dot(contrastInput, LINEAR_PROPHOTO_LUMINANCE);
  if (y <= 0.0) {
    return vec3(0.0);
  }

  float targetY = USER_CONTRAST_PIVOT * pow(y / USER_CONTRAST_PIVOT, contrastFactor);
  return contrastInput * (targetY / y);
}

float regionalAmountToEv(float amount, float maxAbsEv) {
  return (amount / 100.0) * maxAbsEv;
}

float regionalToneEvFromLuminance(
  float luminance,
  float highlights,
  float shadows,
  float whites,
  float blacks
) {
  if (
    highlights == 0.0 &&
    shadows == 0.0 &&
    whites == 0.0 &&
    blacks == 0.0
  ) {
    return 0.0;
  }
  if (luminance <= 0.0) {
    return 0.0;
  }

  float logLuminance = log2(luminance / USER_REGIONAL_TONE_PIVOT);
  float highlightsMask = smoothstep(-1.0, 3.0, logLuminance);
  float shadowsMask = 1.0 - smoothstep(-4.0, 1.0, logLuminance);
  float whitesMask = smoothstep(2.0, 5.5, logLuminance);
  float blacksMask = 1.0 - smoothstep(-8.0, -3.0, logLuminance);

  return
    highlightsMask * regionalAmountToEv(highlights, 1.25) +
    shadowsMask * regionalAmountToEv(shadows, 1.25) +
    whitesMask * regionalAmountToEv(whites, 1.0) +
    blacksMask * regionalAmountToEv(blacks, 1.0);
}

vec3 applyUserRegionalTone(
  vec3 contrastedSceneLinear,
  float highlights,
  float shadows,
  float whites,
  float blacks
) {
  if (
    highlights == 0.0 &&
    shadows == 0.0 &&
    whites == 0.0 &&
    blacks == 0.0
  ) {
    return contrastedSceneLinear;
  }

  vec3 regionalInput = max(contrastedSceneLinear, vec3(0.0));
  float y = dot(regionalInput, LINEAR_PROPHOTO_LUMINANCE);
  if (y <= 0.0) {
    return vec3(0.0);
  }

  float ev = regionalToneEvFromLuminance(y, highlights, shadows, whites, blacks);
  return regionalInput * exp2(ev);
}

vec3 applyUserTone(
  vec3 sceneLinear,
  float exposureMultiplier,
  float contrastAmount,
  float contrastFactor,
  float highlights,
  float shadows,
  float whites,
  float blacks
) {
  return applyUserRegionalTone(
    applyUserContrast(
      applyUserExposure(sceneLinear, exposureMultiplier),
      contrastAmount,
      contrastFactor
    ),
    highlights,
    shadows,
    whites,
    blacks
  );
}
`
