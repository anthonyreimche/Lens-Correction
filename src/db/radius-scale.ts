// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Lensfun's distortion and TCA coefficients follow Hugin's convention: r = 1 at
// half the shorter side of the frame they were calibrated on. The stages
// measure r = 1 at the shot's half-diagonal, so the Lensfun path scales the
// stages' radius by this factor before evaluating those models. (Vignetting
// already uses the half-diagonal and needs none.)

import type { LensfunLens } from "./types";

export interface ShotGeometry {
  /** Frame width/height after orientation; either orientation reads the same. */
  aspect: number;
  focalLength?: number;
  focalLength35mm?: number;
}

/** The factor taking the shader's half-diagonal radius to the Hugin radius the
 *  lens's distortion and TCA coefficients were fitted in. */
export function huginRadiusScale(
  lens: Pick<LensfunLens, "cropFactor" | "aspectRatio">,
  shot: ShotGeometry,
): number {
  const shotAspect = Math.max(shot.aspect, 1 / shot.aspect);
  // Lensfun assumes 1.5 when undeclared, but untagged 4:3 systems (GF, GFX100RF) only match their makers' tables at 4:3.
  const calibrationAspect = lens.aspectRatio ?? shotAspect;
  return Math.hypot(calibrationAspect, 1) * (lens.cropFactor / shotCropFactor(lens, shot));
}

function shotCropFactor(lens: Pick<LensfunLens, "cropFactor">, shot: ShotGeometry): number {
  const { focalLength = 0, focalLength35mm = 0 } = shot;
  return focalLength > 0 && focalLength35mm > 0 ? focalLength35mm / focalLength : lens.cropFactor;
}
