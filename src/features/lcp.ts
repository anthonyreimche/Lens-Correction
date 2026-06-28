// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Resolve a photo against the imported Adobe Lens Profile (.lcp) library: match
// the EXIF lens to a stored profile and convert its coefficients for the shot.

import type { SafelightAPI, ExifData } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { adobeToResolved, type AdobeProfile } from "./adobe-model";
import { lcpLibrary } from "./parse-lcp";

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

/** Match the EXIF lens against the LCP library and convert for this shot. */
export async function resolveLcp(
  _api: SafelightAPI,
  exif: ExifData,
  aspect: number,
): Promise<ResolvedProfile | null> {
  const lens = exif.lens;
  if (!lens) return null;
  const lib = await lcpLibrary();
  if (lib.length === 0) return null;

  let best: { p: AdobeProfile; score: number } | null = null;
  for (const p of lib) {
    const name = p.lens || p.model;
    if (!name) continue;
    if (norm(name) === norm(lens)) {
      best = { p, score: 1 };
      break;
    }
    const score = tokenScore(lens, name);
    if (!best || score > best.score) best = { p, score };
  }
  if (!best || best.score < 0.6) return null;

  const focal = exif.focalLength ?? 0;
  return adobeToResolved(best.p, focal, aspect, "lcp");
}
