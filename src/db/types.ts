// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Lensfun database record types (mirrors the JSON converted from Lensfun XML).
// The lens *data* itself remains CC BY-SA 3.0 — see NOTICE.

export type DistortionModel = "poly3" | "poly5" | "ptlens";
export type TcaModel = "linear" | "poly3";

export interface DistortionCal {
  focal: number;
  model: DistortionModel;
  /** poly3: [k1], poly5: [k1,k2], ptlens: [a,b,c] */
  k: number[];
}

export interface TcaCal {
  focal: number;
  model: TcaModel;
  /** linear: [kr,kb], poly3: [br,cr,dr, bb,cb,db] */
  k: number[];
}

export interface VignettingCal {
  focal: number;
  aperture: number;
  distance: number;
  k: [number, number, number];
}

export interface LensfunLens {
  id: string;
  maker: string;
  model: string;
  mounts: string[];
  cropFactor: number;
  /** Long/short aspect of the frame the calibration was made on, when Lensfun
   *  declares it. */
  aspectRatio?: number;
  type: string;
  focalMin: number;
  focalMax: number;
  apertureMin: number;
  apertureMax: number;
  distortion: DistortionCal[];
  tca: TcaCal[];
  vignetting: VignettingCal[];
  /** Bodies this lens is built into (fixed-lens cameras only), from the Lensfun
   *  `<camera>` blocks sharing its mount. Absent for interchangeable lenses. */
  cameras?: LensfunCamera[];
}

export interface LensfunCamera {
  maker: string;
  model: string;
}

// ─── Resolved profile — interpolated coefficients ready for the shader ───────

export interface ResolvedDistortion {
  model: DistortionModel;
  /** As Lensfun defines them — poly3: [k1] for 1 - k1 + k1·r²;
   *  poly5: [k1, k2] for 1 + k1·r² + k2·r⁴; ptlens: [a, b, c] for
   *  a·r³ + b·r² + c·r + 1 - a - b - c — each the factor an output point's
   *  radius is scaled by to find its source sample. */
  k: number[];
}

export interface ResolvedTca {
  model: TcaModel;
  /** linear: [kr,kb], poly3: [br,cr,dr, bb,cb,db] */
  k: number[];
}

export interface ResolvedVignetting {
  k: [number, number, number];
}

export interface ResolvedProfile {
  lensId: string;
  lensName: string;
  /** Where the coefficients came from — drives the panel's status line. */
  source: "lensfun" | "embedded" | "lcp" | "manual";
  /** Sensor crop factor of the calibration. */
  cropFactor?: number;
  /** Multiplies the stages' radius (1 at the half-diagonal) into the radius the
   *  distortion and TCA coefficients are expressed in. Absent means 1. */
  radiusScale?: number;
  distortion: ResolvedDistortion | null;
  tca: ResolvedTca | null;
  vignetting: ResolvedVignetting | null;
}
