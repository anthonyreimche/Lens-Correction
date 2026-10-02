import { describe, it, expect } from "vitest";
import type { LensfunLens, ResolvedProfile } from "./types";
import { huginRadiusScale } from "./radius-scale";
import { resolveForLens, resolveForPhoto } from "./matcher";
import { findLensById } from "./loader";
import { distortionScale, distortionUniforms } from "../distortion";
import { parseRafTables, RAF_HEADER_BYTES, rafMetadataRange } from "../features/parse-raf";
import { GFX100RF_META_RAF_BASE64 } from "../features/__fixtures__/gfx100rf-meta";

const calibration = (over: Partial<Pick<LensfunLens, "cropFactor" | "aspectRatio">> = {}) => ({ cropFactor: 1, ...over });

const HALF_DIAG_3_2 = Math.hypot(1.5, 1);

describe("huginRadiusScale", () => {
  it("maps the half-diagonal onto half the short side of a declared 3:2 calibration", () => {
    expect(huginRadiusScale(calibration({ aspectRatio: 1.5 }), { aspect: 1.5 })).toBeCloseTo(HALF_DIAG_3_2, 12);
  });

  it("prefers the declared calibration aspect over the shot's", () => {
    expect(huginRadiusScale(calibration({ aspectRatio: 4 / 3 }), { aspect: 1.5 })).toBeCloseTo(5 / 3, 12);
  });

  it("takes an undeclared calibration aspect from the shot", () => {
    expect(huginRadiusScale(calibration(), { aspect: 4 / 3 })).toBeCloseTo(5 / 3, 12);
    expect(huginRadiusScale(calibration(), { aspect: 1.5 })).toBeCloseTo(HALF_DIAG_3_2, 12);
  });

  it("reads a portrait shot like its landscape orientation", () => {
    expect(huginRadiusScale(calibration(), { aspect: 3 / 4 })).toBeCloseTo(5 / 3, 12);
    expect(huginRadiusScale(calibration({ aspectRatio: 1.5 }), { aspect: 2 / 3 })).toBeCloseTo(HALF_DIAG_3_2, 12);
  });

  it("scales by the calibration's crop factor over the shot's", () => {
    const apsCalibration = calibration({ cropFactor: 1.5, aspectRatio: 1.5 });
    expect(huginRadiusScale(apsCalibration, { aspect: 1.5, focalLength: 50, focalLength35mm: 50 })).toBeCloseTo(1.5 * HALF_DIAG_3_2, 12);
    const fullFrameCalibration = calibration({ cropFactor: 1, aspectRatio: 1.5 });
    expect(huginRadiusScale(fullFrameCalibration, { aspect: 1.5, focalLength: 50, focalLength35mm: 75 })).toBeCloseTo(HALF_DIAG_3_2 / 1.5, 12);
  });

  it("assumes the calibration's crop factor when the shot's can't be derived", () => {
    const apsCalibration = calibration({ cropFactor: 1.5, aspectRatio: 1.5 });
    for (const shot of [{ focalLength: 50 }, { focalLength35mm: 75 }, { focalLength: 0, focalLength35mm: 75 }, { focalLength: 50, focalLength35mm: 0 }]) {
      expect(huginRadiusScale(apsCalibration, { aspect: 1.5, ...shot })).toBeCloseTo(HALF_DIAG_3_2, 12);
    }
  });
});

const lensfunLens = (over: Partial<LensfunLens> = {}): LensfunLens => ({
  id: "test",
  maker: "Canon",
  model: "EF 50mm f/1.8 STM",
  mounts: ["Canon EF"],
  cropFactor: 1,
  type: "rectilinear",
  focalMin: 50,
  focalMax: 50,
  apertureMin: 1.8,
  apertureMax: 22,
  distortion: [{ focal: 50, model: "poly3", k: [0.01] }],
  tca: [],
  vignetting: [],
  ...over,
});

describe("Lensfun profiles", () => {
  it("carry the radius scale for the shot they were resolved for", () => {
    const lens = lensfunLens({ aspectRatio: 1.5, cropFactor: 1.6 });
    const exif = { focalLength: 50, focalLength35mm: 80 };
    expect(resolveForLens(lens, exif, 1.5).radiusScale).toBeCloseTo(HALF_DIAG_3_2, 12);
    expect(resolveForLens(lens, { focalLength: 50, focalLength35mm: 50 }, 1.5).radiusScale).toBeCloseTo(1.6 * HALF_DIAG_3_2, 12);
  });

  it("take an undeclared calibration aspect from the photo being resolved", () => {
    const lens = lensfunLens();
    expect(resolveForLens(lens, { focalLength: 50 }, 4 / 3).radiusScale).toBeCloseTo(5 / 3, 12);
    const viaPhoto = resolveForPhoto({ lens: "EF 50mm f/1.8 STM", focalLength: 50 }, [lens], 4 / 3);
    expect(viaPhoto?.profile.radiusScale).toBeCloseTo(5 / 3, 12);
  });
});

// ─── Ground truth: the GFX100RF's Lensfun profile against Fujifilm's table ───

describe("GFX100RF: Lensfun distortion against the camera's own correction", () => {
  const bytes = Uint8Array.from(atob(GFX100RF_META_RAF_BASE64), (c) => c.charCodeAt(0)).buffer;
  const range = rafMetadataRange(bytes.slice(0, RAF_HEADER_BYTES))!;
  const fuji = parseRafTables(bytes.slice(range.start, range.end))!.distortion!;

  const lens = findLensById("fujifilm-gfx100rf-compatibles-standard")!;
  const exif = { cameraMake: "FUJIFILM", cameraModel: "GFX100RF", focalLength: 35 };
  const profile = resolveForLens(lens, exif, 11648 / 8736);

  /** Largest gap, in full-resolution pixels, between the Lensfun shape s(r)/s(0)
   *  and Fujifilm's sampling scale 1 + p/100 at the table's radii. */
  const maxGapPx = (p: ResolvedProfile): number => {
    const u = distortionUniforms(p, 0);
    const centre = distortionScale(u, 0);
    const gaps = fuji.radii.map((r, i) => Math.abs(distortionScale(u, r) / centre - (1 + fuji.values[i] / 100)) * r * fuji.radiusPx);
    return Math.max(...gaps);
  };

  it("is the real, untagged ptlens record", () => {
    expect(lens.aspectRatio).toBeUndefined();
    expect(lens.distortion).toEqual([{ focal: 35, model: "ptlens", k: [0.0122972, -0.0707816, 0.026727] }]);
  });

  it("matches Fujifilm's shape within 20 px at full resolution", () => {
    expect(maxGapPx(profile)).toBeLessThan(20);
  });

  it("misses it by over 400 px when read with r = 1 at the half-diagonal", () => {
    expect(maxGapPx({ ...profile, radiusScale: 1 })).toBeGreaterThan(400);
  });
});
