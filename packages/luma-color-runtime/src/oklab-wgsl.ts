import {
  M_LMS_TO_OKLAB,
  M_LMS_TO_PROPHOTO,
  M_OKLAB_TO_LMS,
  M_PROPHOTO_TO_LMS,
} from './oklab'

export const LUMA_COLOR_OKLAB_WGSL = /* wgsl */ `
const M_PROPHOTO_TO_LMS_W = mat3x3f(
  vec3f(${M_PROPHOTO_TO_LMS[0]}, ${M_PROPHOTO_TO_LMS[3]}, ${M_PROPHOTO_TO_LMS[6]}),
  vec3f(${M_PROPHOTO_TO_LMS[1]}, ${M_PROPHOTO_TO_LMS[4]}, ${M_PROPHOTO_TO_LMS[7]}),
  vec3f(${M_PROPHOTO_TO_LMS[2]}, ${M_PROPHOTO_TO_LMS[5]}, ${M_PROPHOTO_TO_LMS[8]})
);
const M_LMS_TO_PROPHOTO_W = mat3x3f(
  vec3f(${M_LMS_TO_PROPHOTO[0]}, ${M_LMS_TO_PROPHOTO[3]}, ${M_LMS_TO_PROPHOTO[6]}),
  vec3f(${M_LMS_TO_PROPHOTO[1]}, ${M_LMS_TO_PROPHOTO[4]}, ${M_LMS_TO_PROPHOTO[7]}),
  vec3f(${M_LMS_TO_PROPHOTO[2]}, ${M_LMS_TO_PROPHOTO[5]}, ${M_LMS_TO_PROPHOTO[8]})
);
const M_LMS_TO_OKLAB_W = mat3x3f(
  vec3f(${M_LMS_TO_OKLAB[0]}, ${M_LMS_TO_OKLAB[3]}, ${M_LMS_TO_OKLAB[6]}),
  vec3f(${M_LMS_TO_OKLAB[1]}, ${M_LMS_TO_OKLAB[4]}, ${M_LMS_TO_OKLAB[7]}),
  vec3f(${M_LMS_TO_OKLAB[2]}, ${M_LMS_TO_OKLAB[5]}, ${M_LMS_TO_OKLAB[8]})
);
const M_OKLAB_TO_LMS_W = mat3x3f(
  vec3f(${M_OKLAB_TO_LMS[0]}, ${M_OKLAB_TO_LMS[3]}, ${M_OKLAB_TO_LMS[6]}),
  vec3f(${M_OKLAB_TO_LMS[1]}, ${M_OKLAB_TO_LMS[4]}, ${M_OKLAB_TO_LMS[7]}),
  vec3f(${M_OKLAB_TO_LMS[2]}, ${M_OKLAB_TO_LMS[5]}, ${M_OKLAB_TO_LMS[8]})
);

fn signedCbrtScalar(x: f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

fn signedCbrtVec3(v: vec3f) -> vec3f {
  return sign(v) * pow(abs(v), vec3f(1.0 / 3.0));
}

fn linearProPhotoToOklab(rgb: vec3f) -> vec3f {
  let lms = M_PROPHOTO_TO_LMS_W * rgb;
  return M_LMS_TO_OKLAB_W * signedCbrtVec3(lms);
}

fn oklabToLinearProPhoto(lab: vec3f) -> vec3f {
  let lmsPrime = M_OKLAB_TO_LMS_W * lab;
  return M_LMS_TO_PROPHOTO_W * (lmsPrime * lmsPrime * lmsPrime);
}

fn oklabToOklch(lab: vec3f) -> vec3f {
  let L = lab.x;
  let C = sqrt(lab.y * lab.y + lab.z * lab.z);
  let h = atan2(lab.z, lab.y);
  let hNorm = fract(h / (2.0 * 3.14159265358979323846) + 1.0);
  return vec3f(L, C, hNorm);
}

fn oklchToOklab(lch: vec3f) -> vec3f {
  let h = lch.z * 2.0 * 3.14159265358979323846;
  return vec3f(lch.x, lch.y * cos(h), lch.y * sin(h));
}
`
