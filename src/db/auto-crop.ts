// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Compute the zoom factor needed to crop out invalid edge pixels after
// distortion correction. The returned value (>= 1.0) drives the geometry
// stage's autoCropScale uniform.

import type { DistortionModel } from "./types";

export function computeAutoCropScale(
  model: DistortionModel,
  coeffs: number[],
  manualDistortion: number,
  aspect: number,
): number {
  const halfH = 1.0;
  const halfW = aspect;
  const testPoints = [
    [-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH],
    [0, -halfH], [0, halfH], [-halfW, 0], [halfW, 0],
  ];

  // Normalize so the diagonal = 1.0 (Lensfun convention)
  const diag = Math.sqrt(halfW * halfW + halfH * halfH);

  let maxInwardRatio = 1.0;

  for (const [x, y] of testPoints) {
    const nx = x / diag;
    const ny = y / diag;
    const r = Math.sqrt(nx * nx + ny * ny);
    if (r < 1e-6) continue;

    const distortedR = applyDistortion(model, coeffs, r) + manualDistortion * 0.0003 * r * r * r;
    const ratio = distortedR / r;

    if (ratio < maxInwardRatio) maxInwardRatio = ratio;
  }

  return maxInwardRatio > 0.01 ? 1.0 / maxInwardRatio : 1.0;
}

function applyDistortion(model: DistortionModel, k: number[], r: number): number {
  const r2 = r * r;
  switch (model) {
    case "poly3":
      return r * (1.0 - (k[0] ?? 0) + (k[0] ?? 0) * r2);
    case "poly5":
      return r * (1.0 + (k[0] ?? 0) * r2 + (k[1] ?? 0) * r2 * r2);
    case "ptlens": {
      const a = k[0] ?? 0;
      const b = k[1] ?? 0;
      const c = k[2] ?? 0;
      return r * (a * r2 * r + b * r2 + c * r + 1.0 - a - b - c);
    }
    default:
      return r;
  }
}
