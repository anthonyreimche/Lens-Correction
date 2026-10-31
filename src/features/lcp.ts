// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Resolve a photo against the imported Adobe Lens Profile (.lcp) library: match
// the EXIF lens to a stored profile and convert its coefficients for the shot.

import type { ExifData } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { adobeToResolved, type AdobeProfile } from "./adobe-model";
import { lcpLibrary } from "./parse-lcp";

export interface LcpShot {
  /** Frame width/height after orientation. */
  aspect: number;
  /** Whether the photo is a raw file; absent if unknown. */
  raw?: boolean;
  /** Also accept a close lens name: the photo was set to prefer LCP. */
  fuzzy?: boolean;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\w\s.]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenScore(a: string, b: string): number {
  const at = norm(a).split(" ").filter(Boolean);
  const bt = new Set(norm(b).split(" ").filter(Boolean));
  if (at.length === 0) return 0;
  let m = 0;
  for (const t of at) if (bt.has(t) || [...bt].some((x) => x.includes(t) || t.includes(x))) m++;
  return m / at.length;
}

// Letters, digits and points only, so "FE 24-70mm f/2.8" and "FE24-70mm F2.8"
// read alike; a leading maker name is dropped.
function lensIdentity(name: string, make: string): string {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const id = compact(name);
  const maker = compact(make.split(/\s+/)[0] ?? "");
  return maker && id.startsWith(maker) && id.length > maker.length ? id.slice(maker.length) : id;
}

function sameLens(p: AdobeProfile, exifLens: string): boolean {
  const target = lensIdentity(exifLens, p.make);
  return [p.lens, p.lensPrettyName].some((n) => n && lensIdentity(n, p.make) === target);
}

// A profile made on the photo's own camera, then on its maker's, beats another.
function cameraAffinity(p: AdobeProfile, exif: ExifData): number {
  const same = (a?: string, b?: string) => !!a && !!b && norm(a) === norm(b);
  return same(p.model, exif.cameraModel) ? 2 : same(p.make, exif.cameraMake) ? 1 : 0;
}

function findProfile(lib: AdobeProfile[], exif: ExifData, fuzzy: boolean): AdobeProfile | null {
  const lens = exif.lens!;
  const exact = lib.filter((p) => sameLens(p, lens));
  if (exact.length > 0) {
    return exact.reduce((best, p) => (cameraAffinity(p, exif) > cameraAffinity(best, exif) ? p : best));
  }
  if (!fuzzy) return null;
  let best: { p: AdobeProfile; score: number } | null = null;
  for (const p of lib) {
    const name = p.lens || p.model;
    if (!name) continue;
    const score = tokenScore(lens, name);
    if (!best || score > best.score) best = { p, score };
  }
  return best && best.score >= 0.6 ? best.p : null;
}

/** Match the EXIF lens against the LCP library and convert for this shot. */
export async function resolveLcp(exif: ExifData, shot: LcpShot): Promise<ResolvedProfile | null> {
  if (!exif.lens) return null;
  const lib = await lcpLibrary();
  if (lib.length === 0) return null;
  const profile = findProfile(lib, exif, shot.fuzzy ?? false);
  if (!profile) return null;

  const focal = exif.focalLength ?? 0;
  const focal35 = exif.focalLength35mm ?? 0;
  return adobeToResolved(
    profile,
    {
      focal,
      aspect: shot.aspect,
      aperture: exif.aperture,
      distance: exif.subjectDistance,
      cropFactor: focal > 0 && focal35 > 0 ? focal35 / focal : undefined,
      raw: shot.raw,
    },
    "lcp",
  );
}
