// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Adobe lens model → ResolvedProfile conversion. Both Adobe Lens Profiles
// (.lcp) and DNG OpcodeList3 corrections use the same radial-polynomial family.
// Rather than add a new GPU model, we map Adobe coefficients onto the existing,
// parity-validated poly5 (distortion) / poly3 (CA) / radial (vignette) shader
// stages by re-scaling the radius normalization.
//
// NORMALIZATION (the one thing to validate against a reference image): the
// shader normalizes radius so r = 1 at the sensor half-diagonal; Adobe's model
// measures radius in units of FocalLengthX (image-width-normalized). `radiusS`
// converts one to the other. If a corrected image is visibly over/under-warped,
// this factor is where to look — everything else is a direct substitution.

import type {
  ResolvedProfile,
  ResolvedDistortion,
  ResolvedTca,
  ResolvedVignetting,
} from "../db/types";

/** One Adobe calibration entry (a single focal length / aperture). */
export interface AdobeEntry {
  focal: number; // mm; 0 if unspecified
  aperture: number; // f-number; 0 if unspecified
  /** Normalized focal length (image-width units). 0 ⇒ treat radius as already
   *  half-diagonal-normalized (DNG opcode convention). */
  focalLengthX: number;
  /** Rectilinear radial distortion: ru = rd·(1 + k1·rd² + k2·rd⁴ + k3·rd⁶). */
  distortion?: { k1: number; k2: number; k3: number };
  /** Radial vignette gain model: gain = 1 + a1·rd² + a2·rd⁴ + a3·rd⁶. */
  vignette?: { a1: number; a2: number; a3: number };
  /** Per-channel lateral CA radial scale (relative to green). */
  ca?: { redK1: number; redK2: number; blueK1: number; blueK2: number };
}

export interface AdobeProfile {
  make: string;
  model: string;
  lens: string;
  entries: AdobeEntry[];
}

/** radius scale S such that rd = S · r (r = half-diagonal-normalized). */
function radiusS(focalLengthX: number, aspect: number): number {
  if (!focalLengthX || focalLengthX <= 0) return 1; // DNG-opcode convention
  // half-diagonal in image-width units = 0.5·sqrt(1 + (H/W)²) = 0.5·sqrt(1 + 1/aspect²)
  const halfDiagW = 0.5 * Math.sqrt(1 + 1 / (aspect * aspect));
  return halfDiagW / focalLengthX;
}

function convertDistortion(
  d: AdobeEntry["distortion"],
  s: number,
): ResolvedDistortion | null {
  if (!d) return null;
  // scale(r) = 1 + k1·(S·r)² + k2·(S·r)⁴ (drop k3·r⁶ — poly5 holds two terms).
  const a = d.k1 * s * s; // r² coefficient
  const b = d.k2 * s * s * s * s; // r⁴ coefficient
  // poly5 shader is `1 + DistB·r² + DistA·r⁴`, bound as DistA=k[0], DistB=k[1].
  return { model: "poly5", k: [b, a] };
}

function convertVignette(
  v: AdobeEntry["vignette"],
  s: number,
): ResolvedVignetting | null {
  if (!v) return null;
  const s2 = s * s;
  // gain = 1 + a1·rd² + a2·rd⁴ + a3·rd⁶ → in half-diagonal r.
  return { k: [v.a1 * s2, v.a2 * s2 * s2, v.a3 * s2 * s2 * s2] };
}

function convertCa(c: AdobeEntry["ca"], s: number): ResolvedTca | null {
  if (!c) return null;
  const s2 = s * s;
  // poly3 shader: scale = Br·r² + Cr·r + Kr (Kr ≈ 1, linear term 0).
  // [br, cr, vr, bb, cb, vb]
  return {
    model: "poly3",
    k: [c.redK1 * s2, 0, 1, c.blueK1 * s2, 0, 1],
  };
}

/** Pick / interpolate the calibration entry nearest the shot's focal length. */
export function pickEntry(entries: AdobeEntry[], focal: number): AdobeEntry | null {
  if (entries.length === 0) return null;
  if (entries.length === 1 || !focal) return entries[0];
  return entries.reduce((best, e) =>
    Math.abs((e.focal || focal) - focal) < Math.abs((best.focal || focal) - focal) ? e : best,
  );
}

/** Convert an Adobe profile to a ResolvedProfile for a given shot. */
export function adobeToResolved(
  profile: AdobeProfile,
  focal: number,
  aspect: number,
  source: ResolvedProfile["source"],
): ResolvedProfile | null {
  const entry = pickEntry(profile.entries, focal);
  if (!entry) return null;
  const s = radiusS(entry.focalLengthX, aspect);
  return {
    lensId: `${source}:${profile.make}:${profile.lens}`,
    lensName: profile.lens || `${profile.make} ${profile.model}`,
    source,
    distortion: convertDistortion(entry.distortion, s),
    tca: convertCa(entry.ca, s),
    vignetting: convertVignette(entry.vignette, s),
  };
}
