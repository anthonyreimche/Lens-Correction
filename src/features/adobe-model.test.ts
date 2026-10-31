import { describe, it, expect } from "vitest";
import type { ResolvedProfile } from "../db/types";
import { adobeToResolved, type AdobeEntry, type AdobeProfile, type AdobeShot } from "./adobe-model";
import { distortionScale, distortionUniforms, shaderRadius } from "../distortion";
import { computeAutoCropScale } from "../db/auto-crop";

const entry = (over: Partial<AdobeEntry> = {}): AdobeEntry => ({
  focal: 24,
  aperture: 4,
  focalLengthX: 0.6,
  distortion: { k1: -0.1, k2: 0.02, k3: 0 },
  ...over,
});

const profile = (entries: AdobeEntry[], over: Partial<AdobeProfile> = {}): AdobeProfile => ({
  make: "SONY",
  model: "ILCE-7RM3",
  lens: "FE 24-70mm F2.8 GM",
  entries,
  ...over,
});

const shot = (over: Partial<AdobeShot> = {}): AdobeShot => ({ focal: 24, aspect: 1.5, ...over });

const resolve = (p: AdobeProfile, s: AdobeShot = shot()) => adobeToResolved(p, s, "lcp")!;

// The stage's scale at a point given in UV offsets from the centre.
const scaleAt = (p: ResolvedProfile, cx: number, cy: number, aspect: number) =>
  distortionScale(distortionUniforms(p, 0), shaderRadius(cx, cy, aspect));

// Adobe's rectilinear model at radius R in focal-length units.
const adobeRect = (k1: number, k2: number, k3: number, R: number) => 1 + k1 * R ** 2 + k2 * R ** 4 + k3 * R ** 6;

// Radius of the shot's corner in focal-length units, for a calibration frame of
// long/short aspect a, and FocalLengthX normalised by its long side.
const cornerR = (fx: number, a: number) => Math.hypot(a, 1) / (2 * a) / fx;

describe("adobeToResolved — radius", () => {
  it("evaluates the rectilinear model with all three terms at the corner", () => {
    const p = resolve(profile([entry({ distortion: { k1: -0.1, k2: 0.02, k3: -0.004 } })]));
    expect(scaleAt(p, 0.5, 0.5, 1.5)).toBeCloseTo(adobeRect(-0.1, 0.02, -0.004, cornerR(0.6, 1.5)), 10);
  });

  it("measures a portrait shot against the calibration frame's long side", () => {
    const p = profile([entry()]);
    const landscape = scaleAt(resolve(p, shot({ aspect: 1.5 })), 0.5, 0.5, 1.5);
    const portrait = scaleAt(resolve(p, shot({ aspect: 1 / 1.5 })), 0.5, 0.5, 1 / 1.5);
    expect(portrait).toBeCloseTo(landscape, 10);
  });

  it("takes the calibration frame's aspect from its image size when given", () => {
    const p = resolve(profile([entry()], { imageAspect: 4 / 3 }), shot({ aspect: 1.5 }));
    expect(scaleAt(p, 0.5, 0.5, 1.5)).toBeCloseTo(adobeRect(-0.1, 0.02, 0, cornerR(0.6, 4 / 3)), 10);
  });

  it("scales the radius for a body with a different crop factor than the calibration's", () => {
    const p = resolve(profile([entry()], { sensorFormatFactor: 1 }), shot({ cropFactor: 1.5 }));
    expect(scaleAt(p, 0.5, 0.5, 1.5)).toBeCloseTo(adobeRect(-0.1, 0.02, 0, cornerR(0.6, 1.5) / 1.5), 10);
  });

  it("keeps the half-diagonal radius of DNG corrections, which carry no focal length", () => {
    const p = resolve(profile([entry({ focalLengthX: 0, distortion: { k1: -0.1, k2: 0.02, k3: 0.003 } })]));
    expect(scaleAt(p, 0.5, 0.5, 1.5)).toBeCloseTo(adobeRect(-0.1, 0.02, 0.003, 1), 10);
  });
});

describe("adobeToResolved — fisheye", () => {
  // Adobe's fisheye model: a rectilinear point at R (focal-length units) is
  // found at θ·(1 + k1·θ² + k2·θ⁴) in the source, θ = atan(R).
  const adobeFisheye = (k1: number, k2: number, R: number) => {
    const t = Math.atan(R);
    return (t / R) * (1 + k1 * t ** 2 + k2 * t ** 4);
  };
  const fisheye = profile([entry({ fisheye: true, focalLengthX: 0.4, distortion: { k1: 0.05, k2: -0.01, k3: 0 } })]);

  it.each([0.25, 0.5])("defishes with Adobe's fisheye model at UV offset %f", (c) => {
    const p = resolve(fisheye);
    const R = shaderRadius(c, c, 1.5) * cornerR(0.4, 1.5);
    expect(scaleAt(p, c, c, 1.5)).toBeCloseTo(adobeFisheye(0.05, -0.01, R), 10);
  });

  it("needs no crop, since defishing samples inside the frame", () => {
    expect(computeAutoCropScale(distortionUniforms(resolve(fisheye), 0), 1.5)).toBe(1);
  });

  it("keeps the CA in the frame's own radius alongside the fisheye radius scale", () => {
    const ca = { redK1: 0.002, redK2: 0, blueK1: -0.001, blueK2: 0 };
    const rect = resolve(profile([entry({ focalLengthX: 0.4, ca })]));
    const fish = resolve(profile([entry({ fisheye: true, focalLengthX: 0.4, ca })]));
    const redAtCorner = (p: ResolvedProfile) => {
      const rt = p.radiusScale ?? 1;
      return p.tca!.k[0] * rt ** 2 + p.tca!.k[1] * rt + p.tca!.k[2];
    };
    expect(redAtCorner(fish)).toBeCloseTo(redAtCorner(rect), 12);
  });
});

describe("adobeToResolved — chromatic aberration", () => {
  it("carries the CA scale factor as the constant term", () => {
    const p = resolve(profile([entry({ ca: { redK1: 0, redK2: 0, blueK1: 0, blueK2: 0, redScale: 1.0004, blueScale: 0.9997 } })]));
    expect(p.tca).toEqual({ model: "poly3", k: [0, 0, 1.0004, 0, 0, 0.9997] });
  });
});

describe("adobeToResolved — choosing calibrations", () => {
  const vig = (a1: number) => ({ a1, a2: 0, a3: 0 });

  it("takes the vignetting calibrated at the shot's aperture", () => {
    const p = profile([
      entry({ aperture: 2.8, vignette: vig(-0.5) }),
      entry({ aperture: 5.6, vignette: vig(-0.2) }),
      entry({ aperture: 11, vignette: vig(-0.1) }),
    ]);
    const k1 = (aperture: number) => resolve(p, shot({ aperture })).vignetting!.k[0] / cornerR(0.6, 1.5) ** 2;
    expect(k1(2.8)).toBeCloseTo(-0.5, 10);
    expect(k1(6.3)).toBeCloseTo(-0.2, 10);
    expect(k1(16)).toBeCloseTo(-0.1, 10);
  });

  it("takes the distortion calibrated nearest the focus distance, infinity when unknown", () => {
    const p = profile([
      entry({ distance: 0.5, distortion: { k1: -0.3, k2: 0, k3: 0 } }),
      entry({ distance: 10000, distortion: { k1: -0.1, k2: 0, k3: 0 } }),
    ]);
    const k1 = (distance?: number) => resolve(p, shot({ distance })).distortion!.k[0] / cornerR(0.6, 1.5) ** 2;
    expect(k1()).toBeCloseTo(-0.1, 10);
    expect(k1(0.6)).toBeCloseTo(-0.3, 10);
  });

  it("interpolates between the calibrated focal lengths around the shot", () => {
    const p = profile([
      entry({ focal: 24, distortion: { k1: -0.2, k2: 0, k3: 0 } }),
      entry({ focal: 35, distortion: { k1: 0.2, k2: 0, k3: 0 } }),
    ]);
    const corner = (focal: number) => scaleAt(resolve(p, shot({ focal })), 0.5, 0.5, 1.5);
    expect(corner(29.5)).toBeCloseTo((corner(24) + corner(35)) / 2, 10);
  });

  it("holds the nearest calibration outside the calibrated range", () => {
    const p = profile([
      entry({ focal: 24, distortion: { k1: -0.2, k2: 0, k3: 0 } }),
      entry({ focal: 35, distortion: { k1: 0.2, k2: 0, k3: 0 } }),
    ]);
    const corner = (focal: number) => scaleAt(resolve(p, shot({ focal })), 0.5, 0.5, 1.5);
    expect(corner(70)).toBeCloseTo(corner(35), 12);
    expect(corner(16)).toBeCloseTo(corner(24), 12);
  });

  it("uses the raw calibrations for a raw file and the camera-JPEG ones for a JPEG", () => {
    const p = profile([
      entry({ raw: true, distortion: { k1: -0.1, k2: 0, k3: 0 } }),
      entry({ raw: false, distortion: { k1: -0.01, k2: 0, k3: 0 } }),
    ]);
    const k1 = (raw?: boolean) => resolve(p, shot({ raw })).distortion!.k[0] / cornerR(0.6, 1.5) ** 2;
    expect(k1(true)).toBeCloseTo(-0.1, 10);
    expect(k1(false)).toBeCloseTo(-0.01, 10);
  });

  it("falls back to the other kind when a profile has only one", () => {
    const p = profile([entry({ raw: false })]);
    expect(resolve(p, shot({ raw: true })).distortion).not.toBeNull();
  });
});
