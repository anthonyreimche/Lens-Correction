// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Adobe lens model → ResolvedProfile conversion. Both Adobe Lens Profiles
// (.lcp) and DNG OpcodeList3 corrections use the same radial-polynomial family.
// Rectilinear distortion maps onto the poly5 stage model (with its r⁶ term),
// fisheye distortion onto the adobeFisheye model, CA onto poly3 and vignetting
// onto the radial vignette stage.
//
// RADIUS: the stages measure r = 1 at the shot's half-diagonal. Adobe measures
// it in focal lengths, with FocalLengthX the focal length as a fraction of the
// calibration frame's long side. `radiusS` converts one to the other, allowing
// for a portrait shot, the calibration frame's own aspect, and a body whose
// crop factor differs from the calibration camera's. DNG corrections carry no
// focal length (FocalLengthX 0) and are already in half-diagonal units.

import type {
  ResolvedProfile,
  ResolvedDistortion,
  ResolvedTca,
  ResolvedVignetting,
} from "../db/types";

/** One Adobe calibration entry (a single focal length / aperture / distance). */
export interface AdobeEntry {
  focal: number; // mm; 0 if unspecified
  aperture: number; // f-number; 0 if unspecified
  /** Focus distance in metres; 0 or absent if unspecified. */
  distance?: number;
  /** CameraRawProfile: true for raw files, false for camera JPEGs, absent if
   *  unspecified. */
  raw?: boolean;
  /** Normalized focal length (calibration long-side units). 0 ⇒ radius is
   *  already half-diagonal-normalized (DNG opcode convention). */
  focalLengthX: number;
  /** The distortion is Adobe's fisheye model rather than the rectilinear one. */
  fisheye?: boolean;
  /** Rectilinear: ru·(1 + k1·ru² + k2·ru⁴ + k3·ru⁶) is where a corrected point
   *  at ru is found in the source. Fisheye: θ·(1 + k1·θ² + k2·θ⁴), θ = atan(ru). */
  distortion?: { k1: number; k2: number; k3: number };
  /** Radial vignette gain model: gain = 1 + a1·rd² + a2·rd⁴ + a3·rd⁶. */
  vignette?: { a1: number; a2: number; a3: number };
  /** Per-channel lateral CA relative to green: scale·(1 + k1·r² + k2·r⁴). */
  ca?: { redK1: number; redK2: number; blueK1: number; blueK2: number; redScale?: number; blueScale?: number };
}

export interface AdobeProfile {
  make: string;
  model: string;
  lens: string;
  lensPrettyName?: string;
  /** Crop factor of the calibration camera (SensorFormatFactor). */
  sensorFormatFactor?: number;
  /** Long/short aspect of the calibration images. */
  imageAspect?: number;
  entries: AdobeEntry[];
}

/** What the conversion needs to know about the shot. */
export interface AdobeShot {
  focal: number;
  /** Frame width/height after orientation. */
  aspect: number;
  /** f-number. */
  aperture?: number;
  /** Focus distance in metres. */
  distance?: number;
  cropFactor?: number;
  /** Whether the photo is a raw file; absent if unknown. */
  raw?: boolean;
}

type Kind = "distortion" | "vignette" | "ca";

/** Radius scale S such that the Adobe radius = S · r (r = half-diagonal-normalized). */
function radiusS(entry: AdobeEntry, profile: AdobeProfile, shot: AdobeShot): number {
  if (!(entry.focalLengthX > 0)) return 1;
  const a = profile.imageAspect ?? Math.max(shot.aspect, 1 / shot.aspect);
  const halfDiagPerLongSide = Math.hypot(a, 1) / (2 * a);
  const crop =
    profile.sensorFormatFactor && shot.cropFactor ? profile.sensorFormatFactor / shot.cropFactor : 1;
  return (halfDiagPerLongSide / entry.focalLengthX) * crop;
}

function convertDistortion(e: AdobeEntry, s: number): ResolvedDistortion | null {
  const d = e.distortion;
  if (!d) return null;
  if (e.fisheye) return { model: "adobeFisheye", k: [d.k1, d.k2] };
  const s2 = s * s;
  return { model: "poly5", k: [d.k1 * s2, d.k2 * s2 * s2, d.k3 * s2 * s2 * s2] };
}

function convertVignette(e: AdobeEntry, s: number): ResolvedVignetting | null {
  const v = e.vignette;
  if (!v) return null;
  const s2 = s * s;
  return { k: [v.a1 * s2, v.a2 * s2 * s2, v.a3 * s2 * s2 * s2] };
}

/** The poly3 stage holds b·rt² + c·rt + v, with rt = r · `rScale`. Adobe's r⁴
 *  term folds into r² by a least-squares fit over the frame (weighted by area,
 *  ∫r⁷/∫r⁵ = 3/4). */
function convertCa(e: AdobeEntry, s: number, rScale: number): ResolvedTca | null {
  const c = e.ca;
  if (!c) return null;
  const s2 = s * s;
  const fit = (k1: number, k2: number, scale: number) => (scale * (k1 * s2 + 0.75 * k2 * s2 * s2)) / (rScale * rScale);
  const redScale = c.redScale ?? 1;
  const blueScale = c.blueScale ?? 1;
  return {
    model: "poly3",
    k: [fit(c.redK1, c.redK2, redScale), 0, redScale, fit(c.blueK1, c.blueK2, blueScale), 0, blueScale],
  };
}

/** Raw calibrations for a raw file and camera-JPEG ones for a JPEG, when the
 *  profile has that kind; every entry otherwise. */
function entriesForShot(entries: AdobeEntry[], raw: boolean | undefined): AdobeEntry[] {
  if (raw === undefined) return entries;
  const own = entries.filter((e) => e.raw === undefined || e.raw === raw);
  return own.length > 0 ? own : entries;
}

// Diopters, with an unknown or far distance as infinity.
const diopters = (metres: number | undefined) => (metres && metres > 0 ? 1 / metres : 0);

/** How far an entry's shooting conditions are from the shot's, for one kind:
 *  aperture in stops first (vignetting only), then focus distance. */
function mismatch(e: AdobeEntry, kind: Kind, shot: AdobeShot): [number, number] {
  const stops =
    kind === "vignette" && e.aperture > 0 && shot.aperture && shot.aperture > 0
      ? Math.abs(Math.log2(e.aperture / shot.aperture))
      : 0;
  return [stops, Math.abs(diopters(e.distance) - diopters(shot.distance))];
}

interface Bracket {
  lo: AdobeEntry;
  hi: AdobeEntry;
  /** Weight of `hi`. */
  t: number;
}

/** The best-matching calibrations at the calibrated focal lengths either side
 *  of the shot's, held at the nearest outside the calibrated range. */
function bracket(entries: AdobeEntry[], kind: Kind, shot: AdobeShot): Bracket | null {
  const cands = entries.filter((e) => e[kind]);
  if (cands.length === 0) return null;
  const bestAt = (focal: number) =>
    cands
      .filter((e) => e.focal === focal)
      .reduce((best, e) => {
        const [a, b] = mismatch(e, kind, shot);
        const [ba, bb] = mismatch(best, kind, shot);
        return a < ba || (a === ba && b < bb) ? e : best;
      });
  const focals = [...new Set(cands.map((e) => e.focal))].sort((a, b) => a - b);
  const f = shot.focal;
  if (!(f > 0) || focals.length === 1) {
    const only = bestAt(f > 0 ? focals.reduce((n, x) => (Math.abs(x - f) < Math.abs(n - f) ? x : n)) : focals[0]);
    return { lo: only, hi: only, t: 0 };
  }
  const below = focals.filter((x) => x <= f);
  const above = focals.filter((x) => x >= f);
  const loF = below.length ? below[below.length - 1] : above[0];
  const hiF = above.length ? above[0] : loF;
  return { lo: bestAt(loF), hi: bestAt(hiF), t: hiF > loF ? (f - loF) / (hiF - loF) : 0 };
}

const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + ((b[i] ?? 0) - v) * t);

/** Convert an Adobe profile to a ResolvedProfile for a given shot. */
export function adobeToResolved(
  profile: AdobeProfile,
  shot: AdobeShot,
  source: ResolvedProfile["source"],
): ResolvedProfile | null {
  const entries = entriesForShot(profile.entries, shot.raw);
  const S = (e: AdobeEntry) => radiusS(e, profile, shot);

  // The fisheye model isn't polynomial in r, so it keeps its own radius scale
  // (and the nearer calibration, unblended); the CA stage shares that scale.
  const dist = bracket(entries, "distortion", shot);
  const nearest = dist && (dist.t < 0.5 ? dist.lo : dist.hi);
  const rScale = nearest?.fisheye ? S(nearest) : 1;

  let distortion: ResolvedDistortion | null = null;
  if (dist && nearest) {
    if (nearest.fisheye || dist.lo.fisheye !== dist.hi.fisheye) {
      distortion = convertDistortion(nearest, S(nearest) / rScale);
    } else {
      const lo = convertDistortion(dist.lo, S(dist.lo))!;
      const hi = convertDistortion(dist.hi, S(dist.hi))!;
      distortion = { model: "poly5", k: lerp(lo.k, hi.k, dist.t) };
    }
  }

  const ca = bracket(entries, "ca", shot);
  const tca: ResolvedTca | null = ca && {
    model: "poly3",
    k: lerp(convertCa(ca.lo, S(ca.lo), rScale)!.k, convertCa(ca.hi, S(ca.hi), rScale)!.k, ca.t),
  };

  const vig = bracket(entries, "vignette", shot);
  const vignetting: ResolvedVignetting | null = vig && {
    k: lerp(convertVignette(vig.lo, S(vig.lo))!.k, convertVignette(vig.hi, S(vig.hi))!.k, vig.t) as [number, number, number],
  };

  if (!distortion && !tca && !vignetting) return null;
  return {
    lensId: `${source}:${profile.make}:${profile.lens}`,
    lensName: profile.lens || `${profile.make} ${profile.model}`,
    source,
    ...(rScale !== 1 && { radiusScale: rScale }),
    distortion,
    tca,
    vignetting,
  };
}
