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
  type: string;
  focalMin: number;
  focalMax: number;
  apertureMin: number;
  apertureMax: number;
  distortion: DistortionCal[];
  tca: TcaCal[];
  vignetting: VignettingCal[];
}

// ─── Resolved profile — interpolated coefficients ready for the shader ───────

export interface ResolvedDistortion {
  model: DistortionModel;
  /** poly3: [k1], poly5: [k1,k2], ptlens: [a,b,c] */
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
  /** Sensor crop factor of the calibration, so the shader can rescale the
   *  normalized radius when the shot's sensor differs (rare; usually equal). */
  cropFactor?: number;
  distortion: ResolvedDistortion | null;
  tca: ResolvedTca | null;
  vignetting: ResolvedVignetting | null;
}
