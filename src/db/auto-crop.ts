// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The zoom that keeps distortion correction from sampling outside the source.
// The distortion stage samples the source at 0.5 + cen·scl / cropScale, so an
// output point on the frame's edge falls outside the source exactly where
// scl > 1 there. The crop is the largest scl along the edge, found with the
// stage's own scale function and uniforms; barrel correction (scl < 1 at the
// edge) needs none.

import { distortionScale, shaderRadius, type DistortionUniforms } from "../distortion";

// Dense enough to catch a profile whose peak lies between a corner and an edge
// midpoint, to well under a pixel.
const SAMPLES_PER_EDGE = 1024;

export function computeAutoCropScale(u: DistortionUniforms, aspect: number): number {
  const edgeScale = (cx: number, cy: number) => distortionScale(u, shaderRadius(cx, cy, aspect));
  let peak = 1;
  for (let i = 0; i <= SAMPLES_PER_EDGE; i++) {
    const t = -0.5 + i / SAMPLES_PER_EDGE;
    peak = Math.max(peak, edgeScale(t, -0.5), edgeScale(t, 0.5), edgeScale(-0.5, t), edgeScale(0.5, t));
  }
  return peak;
}
