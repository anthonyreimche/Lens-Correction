import { describe, it, expect } from "vitest";
import { matchLens, resolveForPhoto, resolveForLens } from "./matcher";
import { resolveProfile } from "./interpolate";
import { computeAutoCropScale } from "./auto-crop";
import type { LensfunLens } from "./types";

const lens = (over: Partial<LensfunLens> = {}): LensfunLens => ({
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

describe("matchLens", () => {
  const db = [
    lens(),
    lens({ id: "zoom", model: "EF 24-70mm f/2.8L II USM", maker: "Canon", focalMin: 24, focalMax: 70 }),
    lens({ id: "nikon", model: "NIKKOR Z 50mm f/1.8 S", maker: "Nikon" }),
  ];

  it("matches an exact normalized model string", () => {
    expect(matchLens({ lens: "EF 50mm f/1.8 STM" }, db)?.id).toBe("test");
  });

  it("fuzzy-matches within the right maker and ignores other makers", () => {
    const m = matchLens({ lens: "EF 24-70mm f/2.8L II USM", lensMake: "Canon", focalLength: 35 }, db);
    expect(m?.id).toBe("zoom");
  });

  it("returns null when nothing crosses the score threshold", () => {
    expect(matchLens({ lens: "Totally Unknown Glass 999mm" }, db)).toBeNull();
  });

  it("returns null without a lens string", () => {
    expect(matchLens({}, db)).toBeNull();
  });
});

describe("resolveProfile", () => {
  it("interpolates distortion between two focal calibrations", () => {
    const zoom = lens({
      focalMin: 24,
      focalMax: 70,
      distortion: [
        { focal: 24, model: "poly3", k: [0.02] },
        { focal: 70, model: "poly3", k: [-0.01] },
      ],
    });
    const mid = resolveProfile(zoom, 47, 4, 1000); // halfway
    expect(mid.distortion?.k[0]).toBeCloseTo(0.005, 3);
    expect(mid.source).toBe("lensfun");
  });

  it("passes through a single calibration unchanged", () => {
    const p = resolveProfile(lens(), 50, 1.8, 1000);
    expect(p.distortion?.k[0]).toBe(0.01);
  });

  it("resolveForPhoto and resolveForLens agree on the matched lens", () => {
    const db = [lens()];
    const exif = { lens: "EF 50mm f/1.8 STM", focalLength: 50, aperture: 1.8 };
    const viaPhoto = resolveForPhoto(exif, db)?.profile.distortion?.k[0];
    const viaLens = resolveForLens(lens(), exif).distortion?.k[0];
    expect(viaPhoto).toBe(viaLens);
  });
});

describe("computeAutoCropScale", () => {
  it("returns >= 1 (zoom never shrinks the frame)", () => {
    const s = computeAutoCropScale("poly3", [0.05], 0, 1.5);
    expect(s).toBeGreaterThanOrEqual(1);
  });

  it("is ~1 for a near-zero distortion", () => {
    expect(computeAutoCropScale("poly3", [0.0], 0, 1.5)).toBeCloseTo(1, 2);
  });
});
