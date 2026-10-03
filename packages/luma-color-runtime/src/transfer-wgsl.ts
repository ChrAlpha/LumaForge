import { LUT_TRANSFER_UNIFORMS } from './shader-uniforms'

export const LUMA_COLOR_TRANSFER_WGSL = /* wgsl */ `
const TRANSFER_SRGB: i32 = ${LUT_TRANSFER_UNIFORMS.srgb};
const TRANSFER_BT709: i32 = ${LUT_TRANSFER_UNIFORMS.bt709};
const TRANSFER_GAMMA24: i32 = ${LUT_TRANSFER_UNIFORMS.gamma24};
const TRANSFER_S_LOG2: i32 = ${LUT_TRANSFER_UNIFORMS['s-log2']};
const TRANSFER_S_LOG3: i32 = ${LUT_TRANSFER_UNIFORMS['s-log3']};
const TRANSFER_CANON_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['canon-log']};
const TRANSFER_CANON_LOG2: i32 = ${LUT_TRANSFER_UNIFORMS['canon-log2']};
const TRANSFER_CANON_LOG3: i32 = ${LUT_TRANSFER_UNIFORMS['canon-log3']};
const TRANSFER_N_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['n-log']};
const TRANSFER_F_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['f-log']};
const TRANSFER_F_LOG2: i32 = ${LUT_TRANSFER_UNIFORMS['f-log2']};
const TRANSFER_F_LOG2C: i32 = ${LUT_TRANSFER_UNIFORMS['f-log2c']};
const TRANSFER_V_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['v-log']};
const TRANSFER_LOGC3: i32 = ${LUT_TRANSFER_UNIFORMS.logc3};
const TRANSFER_LOGC4: i32 = ${LUT_TRANSFER_UNIFORMS.logc4};
const TRANSFER_LOG3G10: i32 = ${LUT_TRANSFER_UNIFORMS.log3g10};
const TRANSFER_ACESCC: i32 = ${LUT_TRANSFER_UNIFORMS.acescc};
const TRANSFER_ACESCCT: i32 = ${LUT_TRANSFER_UNIFORMS.acescct};
const TRANSFER_L_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['l-log']};
const TRANSFER_LINEAR: i32 = ${LUT_TRANSFER_UNIFORMS.linear};
const TRANSFER_APPLE_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['apple-log']};
const TRANSFER_DJI_D_LOG: i32 = ${LUT_TRANSFER_UNIFORMS['dji-d-log']};

fn clamp01v(color: vec3f) -> vec3f {
  return clamp(color, vec3f(0.0), vec3f(1.0));
}

fn srgbToLinear(color: vec3f) -> vec3f {
  let c = clamp01v(color);
  let lower = c / 12.92;
  let higher = pow(max((c + vec3f(0.055)) / 1.055, vec3f(0.0)), vec3f(2.4));
  let lowerMix = vec3f(1.0) - step(vec3f(0.04045), c);
  return mix(higher, lower, lowerMix);
}

// sRGB encode without the upper clamp, mirroring the CPU row-band processor's
// linearToSrgb. Display-domain LUT mixes must keep values above white so a
// partial-strength look blends the same highlights the export blends.
fn linearToSrgbExtended(color: vec3f) -> vec3f {
  let c = max(color, vec3f(0.0));
  let lower = c * 12.92;
  let higher = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  let lowerMix = vec3f(1.0) - step(vec3f(0.0031308), c);
  return mix(higher, lower, lowerMix);
}

fn linearToSrgb(color: vec3f) -> vec3f {
  return clamp01v(linearToSrgbExtended(color));
}

fn encodeSrgbTransfer(linearValue: f32) -> f32 {
  if (linearValue <= 0.0031308) {
    return 12.92 * linearValue;
  }
  return 1.055 * pow(max(linearValue, 0.0), 1.0 / 2.4) - 0.055;
}

fn decodeSrgbTransfer(encodedValue: f32) -> f32 {
  if (encodedValue <= 0.04045) {
    return encodedValue / 12.92;
  }
  return pow(max((encodedValue + 0.055) / 1.055, 0.0), 2.4);
}

fn encodeBT709(linearValue: f32) -> f32 {
  if (linearValue <= 0.018) {
    return 4.5 * linearValue;
  }
  return 1.099 * pow(max(linearValue, 0.0), 0.45) - 0.099;
}

fn decodeBT709(encodedValue: f32) -> f32 {
  if (encodedValue <= 0.081) {
    return encodedValue / 4.5;
  }
  return pow(max((encodedValue + 0.099) / 1.099, 0.0), 1.0 / 0.45);
}

fn encodeSLog2(linearValue: f32) -> f32 {
  let reflectedLinear = 0.9 * max(linearValue, 0.0);
  return 0.432699 * (log(reflectedLinear + 0.037584) / log(10.0)) + 0.616596 + 0.03;
}

fn decodeSLog2(encodedValue: f32) -> f32 {
  return (pow(10.0, (encodedValue - 0.03 - 0.616596) / 0.432699) - 0.037584) / 0.9;
}

fn encodeSLog3(linearValue: f32) -> f32 {
  if (linearValue >= 0.01125) {
    return (420.0 + (log((max(linearValue, 0.0) + 0.01) / 0.19) / log(10.0)) * 261.5) / 1023.0;
  }
  return ((linearValue * (171.2102946929 - 95.0)) / 0.01125 + 95.0) / 1023.0;
}

fn decodeSLog3(encodedValue: f32) -> f32 {
  let x = encodedValue * 1023.0;
  if (x >= 171.2102946929) {
    return pow(10.0, (x - 420.0) / 261.5) * 0.19 - 0.01;
  }
  return ((x - 95.0) * 0.01125) / (171.2102946929 - 95.0);
}

fn encodeCanonLog(linearValue: f32) -> f32 {
  if (linearValue < 0.0) {
    return -0.529136 * (log(-10.1596 * linearValue + 1.0) / log(10.0)) + 0.0730597;
  }
  return 0.529136 * (log(10.1596 * linearValue + 1.0) / log(10.0)) + 0.0730597;
}

fn decodeCanonLog(encodedValue: f32) -> f32 {
  if (encodedValue < 0.0730597) {
    return -(pow(10.0, (0.0730597 - encodedValue) / 0.529136) - 1.0) / 10.1596;
  }
  return (pow(10.0, (encodedValue - 0.0730597) / 0.529136) - 1.0) / 10.1596;
}

fn encodeCanonLog2(linearValue: f32) -> f32 {
  if (linearValue < 0.0) {
    return -0.24136077 * (log(1.0 - (87.099375 * linearValue) / 0.9) / log(10.0)) + 0.092864125;
  }
  return 0.24136077 * (log(1.0 + (87.099375 * linearValue) / 0.9) / log(10.0)) + 0.092864125;
}

fn decodeCanonLog2(encodedValue: f32) -> f32 {
  if (encodedValue < 0.092864125) {
    return (0.9 * (1.0 - pow(10.0, (0.092864125 - encodedValue) / 0.24136077))) / 87.099375;
  }
  return (0.9 * (pow(10.0, (encodedValue - 0.092864125) / 0.24136077) - 1.0)) / 87.099375;
}

fn encodeCanonLog3(linearValue: f32) -> f32 {
  if (linearValue < -0.0126) {
    return -0.36726845 * (log(1.0 - (14.98325 * linearValue) / 0.9) / log(10.0)) + 0.12783901;
  }
  if (linearValue <= 0.0126) {
    return (linearValue * 1.9754798) / 0.9 + 0.12512219;
  }
  return 0.36726845 * (log(1.0 + (14.98325 * linearValue) / 0.9) / log(10.0)) + 0.12240537;
}

fn decodeCanonLog3(encodedValue: f32) -> f32 {
  if (encodedValue < 0.097465473) {
    return (0.9 * (1.0 - pow(10.0, (0.12783901 - encodedValue) / 0.36726845))) / 14.98325;
  }
  if (encodedValue <= 0.15277891) {
    return (0.9 * (encodedValue - 0.12512219)) / 1.9754798;
  }
  return (0.9 * (pow(10.0, (encodedValue - 0.12240537) / 0.36726845) - 1.0)) / 14.98325;
}

fn encodeNLog(linearValue: f32) -> f32 {
  if (linearValue < 0.328) {
    return sign(linearValue) * pow(abs(linearValue), 1.0 / 3.0) * (650.0 / 1023.0) + 0.0075;
  }
  return log(linearValue) * (150.0 / 1023.0) + (619.0 / 1023.0);
}

fn decodeNLog(encodedValue: f32) -> f32 {
  let cut = pow(0.328, 1.0 / 3.0) * (650.0 / 1023.0) + 0.0075;
  if (encodedValue < cut) {
    let toe = (encodedValue - 0.0075) / (650.0 / 1023.0);
    return toe * toe * toe;
  }
  return exp((encodedValue - (619.0 / 1023.0)) / (150.0 / 1023.0));
}

fn encodeFLog(linearValue: f32) -> f32 {
  if (linearValue < 0.00089) {
    return 8.735631 * linearValue + 0.092864;
  }
  return 0.344676 * (log(0.555556 * linearValue + 0.009468) / log(10.0)) + 0.790453;
}

fn decodeFLog(encodedValue: f32) -> f32 {
  if (encodedValue < 0.100537775223865) {
    return (encodedValue - 0.092864) / 8.735631;
  }
  return (pow(10.0, (encodedValue - 0.790453) / 0.344676) - 0.009468) / 0.555556;
}

fn encodeFLog2(linearValue: f32) -> f32 {
  if (linearValue < 0.000889) {
    return 8.799461 * linearValue + 0.092864;
  }
  return 0.245281 * (log(5.555556 * linearValue + 0.064829) / log(10.0)) + 0.384316;
}

fn decodeFLog2(encodedValue: f32) -> f32 {
  if (encodedValue < 0.100686685370811) {
    return (encodedValue - 0.092864) / 8.799461;
  }
  return (pow(10.0, (encodedValue - 0.384316) / 0.245281) - 0.064829) / 5.555556;
}

fn vLogEncodeChannel(linearValue: f32) -> f32 {
  if (linearValue < 0.01) {
    return 5.6 * linearValue + 0.125;
  }
  return 0.241514 * (log(max(linearValue, 0.0) + 0.00873) / log(10.0)) + 0.598206;
}

fn vLogDecodeChannel(encodedValue: f32) -> f32 {
  if (encodedValue < 0.181) {
    return (encodedValue - 0.125) / 5.6;
  }
  return pow(10.0, (encodedValue - 0.598206) / 0.241514) - 0.00873;
}

fn encodeLogC3(linearValue: f32) -> f32 {
  if (linearValue > 0.010591) {
    return 0.24719 * (log(5.555556 * linearValue + 0.052272) / log(10.0)) + 0.385537;
  }
  return 5.367655 * linearValue + 0.092809;
}

fn decodeLogC3(encodedValue: f32) -> f32 {
  if (encodedValue > 0.1496) {
    return (pow(10.0, (encodedValue - 0.385537) / 0.24719) - 0.052272) / 5.555556;
  }
  return (encodedValue - 0.092809) / 5.367655;
}

fn encodeLogC4(linearValue: f32) -> f32 {
  let a = (262144.0 - 16.0) / 117.45;
  let b = (1023.0 - 95.0) / 1023.0;
  let c = 95.0 / 1023.0;
  let s = (7.0 * log(2.0) * pow(2.0, 7.0 - (14.0 * c) / b)) / (a * b);
  let t = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
  if (linearValue < t) {
    return (linearValue - t) / s;
  }
  return ((log2(a * linearValue + 64.0) - 6.0) / 14.0) * b + c;
}

fn decodeLogC4(encodedValue: f32) -> f32 {
  let a = (262144.0 - 16.0) / 117.45;
  let b = (1023.0 - 95.0) / 1023.0;
  let c = 95.0 / 1023.0;
  let s = (7.0 * log(2.0) * pow(2.0, 7.0 - (14.0 * c) / b)) / (a * b);
  let t = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
  if (encodedValue < 0.0) {
    return encodedValue * s + t;
  }
  return (pow(2.0, (14.0 * (encodedValue - c)) / b + 6.0) - 64.0) / a;
}

fn encodeLog3G10(linearValue: f32) -> f32 {
  let y = linearValue + 0.01;
  if (y < 0.0) { return y * 15.1927; }
  return 0.224282 * (log(155.975327 * y + 1.0) / log(10.0));
}

fn decodeLog3G10(encodedValue: f32) -> f32 {
  if (encodedValue < 0.0) { return encodedValue / 15.1927 - 0.01; }
  return (pow(10.0, encodedValue / 0.224282) - 1.0) / 155.975327 - 0.01;
}

fn encodeACEScc(linearValue: f32) -> f32 {
  if (linearValue <= 0.0) {
    return (-16.0 + 9.72) / 17.52;
  }
  if (linearValue < pow(2.0, -15.0)) {
    return (log2(pow(2.0, -16.0) + linearValue * 0.5) + 9.72) / 17.52;
  }
  return (log2(linearValue) + 9.72) / 17.52;
}

fn decodeACEScc(encodedValue: f32) -> f32 {
  let cut = (-15.0 + 9.72) / 17.52;
  if (encodedValue <= cut) {
    return (pow(2.0, encodedValue * 17.52 - 9.72) - pow(2.0, -16.0)) * 2.0;
  }
  return pow(2.0, encodedValue * 17.52 - 9.72);
}

fn encodeACEScct(linearValue: f32) -> f32 {
  if (linearValue <= 0.0078125) {
    return 10.5402377416545 * linearValue + 0.0729055341958355;
  }
  return (log2(linearValue) + 9.72) / 17.52;
}

fn decodeACEScct(encodedValue: f32) -> f32 {
  if (encodedValue <= 0.155251141552511) {
    return (encodedValue - 0.0729055341958355) / 10.5402377416545;
  }
  return pow(2.0, encodedValue * 17.52 - 9.72);
}

fn encodeLLog(linearValue: f32) -> f32 {
  if (linearValue <= 0.006) {
    return 8.0 * linearValue + 0.09;
  }
  return 0.27 * (log(1.3 * linearValue + 0.0115) / log(10.0)) + 0.6;
}

fn decodeLLog(encodedValue: f32) -> f32 {
  if (encodedValue <= 0.138) {
    return (encodedValue - 0.09) / 8.0;
  }
  return (pow(10.0, (encodedValue - 0.6) / 0.27) - 0.0115) / 1.3;
}

fn encodeAppleLog(linearValue: f32) -> f32 {
  let r0 = -0.05641088;
  let rt = 0.01;
  let c = 47.28711236;
  let beta = 0.00964052;
  let gamma = 0.08550479;
  let delta = 0.69336945;
  if (linearValue < r0) {
    return 0.0;
  }
  if (linearValue < rt) {
    return c * pow(linearValue - r0, 2.0);
  }
  return gamma * log2(linearValue + beta) + delta;
}

fn decodeAppleLog(encodedValue: f32) -> f32 {
  let r0 = -0.05641088;
  let rt = 0.01;
  let c = 47.28711236;
  let beta = 0.00964052;
  let gamma = 0.08550479;
  let delta = 0.69336945;
  let pt = c * pow(rt - r0, 2.0);
  if (encodedValue < 0.0) {
    return r0;
  }
  if (encodedValue < pt) {
    return sqrt(encodedValue / c) + r0;
  }
  return pow(2.0, (encodedValue - delta) / gamma) - beta;
}

fn encodeDjiDLog(linearValue: f32) -> f32 {
  if (linearValue <= 0.0078) {
    return 6.025 * linearValue + 0.0929;
  }
  return (log(0.9892 * linearValue + 0.0108) / log(10.0)) * 0.256663 + 0.584555;
}

fn decodeDjiDLog(encodedValue: f32) -> f32 {
  if (encodedValue <= 0.14) {
    return (encodedValue - 0.0929) / 6.025;
  }
  return (pow(10.0, 3.89616 * encodedValue - 2.27752) - 0.0108) / 0.9892;
}

fn encodeTransferChannel(linearValue: f32, transfer: i32) -> f32 {
  if (transfer == TRANSFER_LINEAR) { return linearValue; }
  if (transfer == TRANSFER_SRGB) { return encodeSrgbTransfer(linearValue); }
  if (transfer == TRANSFER_BT709) { return encodeBT709(linearValue); }
  if (transfer == TRANSFER_GAMMA24) { return pow(max(linearValue, 0.0), 1.0 / 2.4); }
  if (transfer == TRANSFER_S_LOG2) { return encodeSLog2(linearValue); }
  if (transfer == TRANSFER_S_LOG3) { return encodeSLog3(linearValue); }
  if (transfer == TRANSFER_CANON_LOG) { return encodeCanonLog(linearValue); }
  if (transfer == TRANSFER_CANON_LOG2) { return encodeCanonLog2(linearValue); }
  if (transfer == TRANSFER_CANON_LOG3) { return encodeCanonLog3(linearValue); }
  if (transfer == TRANSFER_N_LOG) { return encodeNLog(linearValue); }
  if (transfer == TRANSFER_F_LOG) { return encodeFLog(linearValue); }
  if (transfer == TRANSFER_F_LOG2) { return encodeFLog2(linearValue); }
  if (transfer == TRANSFER_F_LOG2C) { return encodeFLog2(linearValue); }
  if (transfer == TRANSFER_V_LOG) { return vLogEncodeChannel(linearValue); }
  if (transfer == TRANSFER_LOGC3) { return encodeLogC3(linearValue); }
  if (transfer == TRANSFER_LOGC4) { return encodeLogC4(linearValue); }
  if (transfer == TRANSFER_LOG3G10) { return encodeLog3G10(linearValue); }
  if (transfer == TRANSFER_ACESCC) { return encodeACEScc(linearValue); }
  if (transfer == TRANSFER_ACESCCT) { return encodeACEScct(linearValue); }
  if (transfer == TRANSFER_L_LOG) { return encodeLLog(linearValue); }
  if (transfer == TRANSFER_APPLE_LOG) { return encodeAppleLog(linearValue); }
  if (transfer == TRANSFER_DJI_D_LOG) { return encodeDjiDLog(linearValue); }
  return linearValue;
}

fn decodeTransferChannel(encodedValue: f32, transfer: i32) -> f32 {
  if (transfer == TRANSFER_LINEAR) { return encodedValue; }
  if (transfer == TRANSFER_SRGB) { return decodeSrgbTransfer(encodedValue); }
  if (transfer == TRANSFER_BT709) { return decodeBT709(encodedValue); }
  if (transfer == TRANSFER_GAMMA24) { return pow(max(encodedValue, 0.0), 2.4); }
  if (transfer == TRANSFER_S_LOG2) { return decodeSLog2(encodedValue); }
  if (transfer == TRANSFER_S_LOG3) { return decodeSLog3(encodedValue); }
  if (transfer == TRANSFER_CANON_LOG) { return decodeCanonLog(encodedValue); }
  if (transfer == TRANSFER_CANON_LOG2) { return decodeCanonLog2(encodedValue); }
  if (transfer == TRANSFER_CANON_LOG3) { return decodeCanonLog3(encodedValue); }
  if (transfer == TRANSFER_N_LOG) { return decodeNLog(encodedValue); }
  if (transfer == TRANSFER_F_LOG) { return decodeFLog(encodedValue); }
  if (transfer == TRANSFER_F_LOG2) { return decodeFLog2(encodedValue); }
  if (transfer == TRANSFER_F_LOG2C) { return decodeFLog2(encodedValue); }
  if (transfer == TRANSFER_V_LOG) { return vLogDecodeChannel(encodedValue); }
  if (transfer == TRANSFER_LOGC3) { return decodeLogC3(encodedValue); }
  if (transfer == TRANSFER_LOGC4) { return decodeLogC4(encodedValue); }
  if (transfer == TRANSFER_LOG3G10) { return decodeLog3G10(encodedValue); }
  if (transfer == TRANSFER_ACESCC) { return decodeACEScc(encodedValue); }
  if (transfer == TRANSFER_ACESCCT) { return decodeACEScct(encodedValue); }
  if (transfer == TRANSFER_L_LOG) { return decodeLLog(encodedValue); }
  if (transfer == TRANSFER_APPLE_LOG) { return decodeAppleLog(encodedValue); }
  if (transfer == TRANSFER_DJI_D_LOG) { return decodeDjiDLog(encodedValue); }
  return encodedValue;
}

fn encodeTransfer(linearColor: vec3f, transfer: i32) -> vec3f {
  return vec3f(
    encodeTransferChannel(linearColor.r, transfer),
    encodeTransferChannel(linearColor.g, transfer),
    encodeTransferChannel(linearColor.b, transfer)
  );
}

fn decodeTransfer(encodedColor: vec3f, transfer: i32) -> vec3f {
  return vec3f(
    decodeTransferChannel(encodedColor.r, transfer),
    decodeTransferChannel(encodedColor.g, transfer),
    decodeTransferChannel(encodedColor.b, transfer)
  );
}
`
