// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The distortion stage's uniform binding and a CPU mirror of its GLSL scale
// function (distortionStage in stages.ts). The shader uniforms and auto-crop
// both come from distortionUniforms(), so the GPU and the CPU read a profile's
// coefficients the same way.

import type { ResolvedProfile } from "./db/types";

/** distKA..distKC carry the profile's k[0..2] in order; distRScale takes the
 *  stage's radius into the units those coefficients were fitted in. */
export interface DistortionUniforms {
  distModel: number;
  distKA: number;
  distKB: number;
  distKC: number;
  distRScale: number;
  distManual: number;
}

const MODEL_ID = { poly3: 1, poly5: 2, ptlens: 3 } as const;

/** Bind `profile`'s distortion (null when profile distortion is off) and the
 *  manual slider. */
export function distortionUniforms(profile: ResolvedProfile | null, manual: number): DistortionUniforms {
  const d = profile?.distortion;
  if (!d) return { distModel: 0, distKA: 0, distKB: 0, distKC: 0, distRScale: 1, distManual: manual };
  return {
    distModel: MODEL_ID[d.model],
    distKA: d.k[0] ?? 0,
    distKB: d.k[1] ?? 0,
    distKC: d.k[2] ?? 0,
    distRScale: profile.radiusScale ?? 1,
    distManual: manual,
  };
}

/** The shader's normalised radius: 1 at the frame's half-diagonal. `cx`, `cy`
 *  are the offset from the frame centre in UV units. */
export function shaderRadius(cx: number, cy: number, aspect: number): number {
  const px = cx * aspect;
  const halfDiag = 0.5 * Math.sqrt(aspect * aspect + 1);
  return Math.sqrt(px * px + cy * cy) / halfDiag;
}

/** The factor the stage scales an output point's offset from the centre by to
 *  find its source sample, at shader radius `rr`. */
export function distortionScale(u: DistortionUniforms, rr: number): number {
  const rr2 = rr * rr;
  const rp = rr * u.distRScale;
  const rp2 = rp * rp;
  let scl = 1;
  if (u.distModel === 1) {
    scl = 1 - u.distKA + u.distKA * rp2;
  } else if (u.distModel === 2) {
    scl = 1 + u.distKA * rp2 + u.distKB * rp2 * rp2;
  } else if (u.distModel === 3) {
    scl = u.distKA * rp2 * rp + u.distKB * rp2 + u.distKC * rp + (1 - u.distKA - u.distKB - u.distKC);
  }
  if (Math.abs(u.distManual) > 0.001) {
    scl += u.distManual * 0.0003 * rr2;
  }
  return scl;
}
