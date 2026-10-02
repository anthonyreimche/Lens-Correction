// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Match the best Lensfun lens for a photo's EXIF, then interpolate calibration
// for the shot's focal/aperture/distance.

import type { ExifData } from "../types/safelight";
import type { LensfunLens, ResolvedProfile } from "./types";
import { resolveProfile } from "./interpolate";
import { huginRadiusScale } from "./radius-scale";
import { canonicalMaker, compact } from "./makers";

interface MatchResult {
  lens: LensfunLens;
  score: number;
}

/** Find the best matching Lensfun lens for the given EXIF, or null. A body with
 *  a built-in lens can only be wearing that lens, so the camera decides first. */
export function matchLens(exif: ExifData, db: LensfunLens[]): LensfunLens | null {
  const builtIn = builtInLenses(exif, db);
  return builtIn.length > 0 ? pickBuiltInLens(builtIn, exif.lens) : matchByLensName(exif, db);
}

// Lensfun lists extra setups for a fixed-lens body as variants of its standard
// entry: "X & compatibles, with TCL-X100", "…, macro at 2 inches lens-to-subject",
// "Ricoh GR III & compatibles + GW-4". "…, with CHDK's DNG" is the bare lens
// profiled from CHDK raw files, so it stands in when there is no standard entry.
const VARIANT = /,\s|\s\+\s/;
const ACCESSORY = /(?:,\s*with|\s\+)\s+([^(]+)/i;
const CHDK_DNG = /\bCHDK\b/i;

function builtInLenses(exif: ExifData, db: LensfunLens[]): LensfunLens[] {
  const body = exifBody(exif);
  if (!body) return [];
  return db.filter((lens) => lens.cameras?.some((cam) => bodyKey(cam.maker, cam.model) === body));
}

function exifBody(exif: ExifData): string | null {
  return exif.cameraMake && exif.cameraModel ? bodyKey(exif.cameraMake, exif.cameraModel) : null;
}

/** A body as canonical maker plus model key, so EXIF and Lensfun spellings agree. */
function bodyKey(make: string, model: string): string {
  const maker = compact(canonicalMaker(make));
  return `${maker}|${modelKey(model, maker)}`;
}

/** The body's standard lens, or a converter variant its EXIF lens string names.
 *  Converter and macro setups are left to a manual pick: most shots are taken
 *  without them. */
function pickBuiltInLens(candidates: LensfunLens[], exifLens = ""): LensfunLens | null {
  const lensKey = compact(exifLens);
  return (
    candidates.find((lens) => namesAccessory(lensKey, lens.model)) ??
    candidates.find((lens) => !VARIANT.test(lens.model)) ??
    candidates.find((lens) => CHDK_DNG.test(lens.model)) ??
    null
  );
}

/** Whether the EXIF lens string names the converter of a "…, with <converter>" variant. */
function namesAccessory(exifLens: string, model: string): boolean {
  const accessory = compact(ACCESSORY.exec(model)?.[1].replace(/\bconverter\b/i, "") ?? "");
  return accessory.length >= 3 && exifLens.includes(accessory);
}

/** Model as letters and digits only, minus a leading maker name: EXIF writes
 *  "Canon PowerShot G7 X" where a Lensfun entry may leave the maker off. */
function modelKey(model: string, maker: string): string {
  const key = compact(model);
  return key.startsWith(maker) && key.length > maker.length ? key.slice(maker.length) : key;
}

function matchByLensName(exif: ExifData, db: LensfunLens[]): LensfunLens | null {
  if (!exif.lens) return null;

  const exifLens = normalize(exif.lens);
  const exifMaker = exif.lensMake ? canonicalMaker(exif.lensMake) : null;

  let best: MatchResult | null = null;

  for (const lens of db) {
    const dbModel = normalize(lens.model);
    const dbMaker = canonicalMaker(lens.maker);

    if (exifLens === dbModel) return lens;

    if (exifMaker && dbMaker.toLowerCase() !== exifMaker.toLowerCase()) continue;

    const score = tokenScore(exifLens, dbModel);
    if (score < 0.5) continue;

    let focalBonus = 0;
    if (exif.focalLength && lens.focalMin > 0 && lens.focalMax > 0) {
      if (exif.focalLength >= lens.focalMin && exif.focalLength <= lens.focalMax) {
        focalBonus = 0.1;
      }
    }

    const total = score + focalBonus;
    if (!best || total > best.score) best = { lens, score: total };
  }

  return best && best.score >= 0.6 ? best.lens : null;
}

/** Resolve a full profile for a photo from its EXIF + the database. `aspect` is
 *  the photo's width/height. */
export function resolveForPhoto(
  exif: ExifData,
  db: LensfunLens[],
  aspect: number,
): { lens: LensfunLens; profile: ResolvedProfile } | null {
  const lens = matchLens(exif, db);
  if (!lens) return null;
  return { lens, profile: resolveForLens(lens, exif, aspect) };
}

/** Resolve a profile for an explicitly chosen lens (manual picker / remembered
 *  choice), interpolated to this shot's focal/aperture/distance and scaled to
 *  its frame (`aspect` is the photo's width/height). */
export function resolveForLens(lens: LensfunLens, exif: ExifData, aspect: number): ResolvedProfile {
  const focal = exif.focalLength ?? lens.focalMin;
  const aperture = exif.aperture ?? lens.apertureMin;
  const distance = exif.subjectDistance ?? 1000;
  return {
    ...resolveProfile(lens, focal, aperture, distance),
    radiusScale: huginRadiusScale(lens, { aspect, focalLength: exif.focalLength, focalLength35mm: exif.focalLength35mm }),
  };
}

/** The key a manual lens pick is remembered under. A body with a built-in lens
 *  is keyed by the body, since its EXIF lens string is often generic
 *  ("8.8-36.8 mm") or missing and so shared with other bodies; any other photo
 *  by its EXIF lens string. */
export function rememberKey(exif: ExifData, db: LensfunLens[]): string | null {
  return builtInLenses(exif, db).length > 0 ? `camera:${exifBody(exif)}` : exif.lens || null;
}

// ─── String matching helpers ────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

function tokenScore(exifNorm: string, dbNorm: string): number {
  const exifTokens = tokenize(exifNorm);
  const dbTokens = tokenize(dbNorm);
  if (exifTokens.length === 0) return 0;

  let matched = 0;
  for (const et of exifTokens) {
    if (dbTokens.some((dt) => dt === et || dt.includes(et) || et.includes(dt))) {
      matched++;
    }
  }
  return matched / exifTokens.length;
}
