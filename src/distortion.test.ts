import { describe, it, expect } from "vitest";
import type { ResolvedDistortion, ResolvedProfile } from "./db/types";
import { distortionScale, distortionUniforms, shaderRadius } from "./distortion";

const profile = (distortion: ResolvedDistortion, radiusScale?: number): ResolvedProfile => ({
  lensId: "test",
  lensName: "Test",
  source: "lensfun",
  distortion,
  tca: null,
  vignetting: null,
  ...(radiusScale === undefined ? {} : { radiusScale }),
});

const scaleAt = (p: ResolvedProfile | null, rr: number, manual = 0) =>
  distortionScale(distortionUniforms(p, manual), rr);

// Lensfun's published models, evaluated at Lensfun's own radius r.
const lensfunPoly3 = (k1: number, r: number) => 1 - k1 + k1 * r * r;
const lensfunPoly5 = (k1: number, k2: number, r: number) => 1 + k1 * r ** 2 + k2 * r ** 4;
const lensfunPtlens = (a: number, b: number, c: number, r: number) => a * r ** 3 + b * r ** 2 + c * r + 1 - a - b - c;

describe("distortion binding", () => {
  it.each([0.5, 1])("poly3 [k1] scales by 1 - k1 + k1·r² at r = %f", (r) => {
    expect(scaleAt(profile({ model: "poly3", k: [-0.03] }), r)).toBeCloseTo(lensfunPoly3(-0.03, r), 12);
  });

  it.each([0.5, 1])("poly5 [k1, k2] scales by 1 + k1·r² + k2·r⁴ at r = %f", (r) => {
    expect(scaleAt(profile({ model: "poly5", k: [-0.08, 0.02] }), r)).toBeCloseTo(lensfunPoly5(-0.08, 0.02, r), 12);
  });

  it.each([0.5, 1])("ptlens [a, b, c] scales by a·r³ + b·r² + c·r + 1 - a - b - c at r = %f", (r) => {
    const [a, b, c] = [0.012, -0.07, 0.027];
    expect(scaleAt(profile({ model: "ptlens", k: [a, b, c] }), r)).toBeCloseTo(lensfunPtlens(a, b, c, r), 12);
  });

  it("evaluates each model at the radius scaled into the coefficients' units", () => {
    const s = 5 / 3;
    for (const r of [0.25, 0.6, 1]) {
      expect(scaleAt(profile({ model: "poly3", k: [-0.03] }, s), r)).toBeCloseTo(lensfunPoly3(-0.03, r * s), 12);
      expect(scaleAt(profile({ model: "poly5", k: [-0.08, 0.02] }, s), r)).toBeCloseTo(lensfunPoly5(-0.08, 0.02, r * s), 12);
      expect(scaleAt(profile({ model: "ptlens", k: [0.012, -0.07, 0.027] }, s), r)).toBeCloseTo(
        lensfunPtlens(0.012, -0.07, 0.027, r * s),
        12,
      );
    }
  });

  it("reads an absent radius scale as 1", () => {
    const d: ResolvedDistortion = { model: "poly5", k: [-0.08, 0.02] };
    expect(scaleAt(profile(d), 0.8)).toBe(scaleAt(profile(d, 1), 0.8));
  });

  it("keeps the manual term on the frame's own radius", () => {
    expect(scaleAt(profile({ model: "poly3", k: [-0.02] }, 2), 0.8, 40)).toBeCloseTo(
      lensfunPoly3(-0.02, 1.6) + 40 * 0.0003 * 0.64,
      12,
    );
    expect(scaleAt(null, 0.8, 40)).toBeCloseTo(1 + 40 * 0.0003 * 0.64, 12);
  });

  it("is the identity without profile or manual distortion", () => {
    for (const r of [0, 0.5, 1]) expect(scaleAt(null, r)).toBe(1);
  });
});

describe("shaderRadius", () => {
  it("is 1 at the corners and measures the edge midpoints against the half-diagonal", () => {
    expect(shaderRadius(0.5, 0.5, 4 / 3)).toBeCloseTo(1, 12);
    expect(shaderRadius(-0.5, 0.5, 4 / 3)).toBeCloseTo(1, 12);
    expect(shaderRadius(0, 0.5, 4 / 3)).toBeCloseTo(0.6, 12);
    expect(shaderRadius(0.5, 0, 4 / 3)).toBeCloseTo(0.8, 12);
    expect(shaderRadius(0, 0, 4 / 3)).toBe(0);
  });
});
