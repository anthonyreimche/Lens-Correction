import { describe, it, expect } from "vitest";
import type { ResolvedDistortion, ResolvedProfile } from "./types";
import { computeAutoCropScale } from "./auto-crop";
import { resolveForLens } from "./matcher";
import { findLensById } from "./loader";
import { distortionScale, distortionUniforms, shaderRadius, type DistortionUniforms } from "../distortion";

const profile = (distortion: ResolvedDistortion, radiusScale?: number): ResolvedProfile => ({
  lensId: "test",
  lensName: "Test",
  source: "lensfun",
  distortion,
  tca: null,
  vignetting: null,
  ...(radiusScale === undefined ? {} : { radiusScale }),
});

/** Every edge of the frame, as offsets from its centre in UV units. */
function boundary(perEdge: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i <= perEdge; i++) {
    const t = -0.5 + i / perEdge;
    points.push([t, -0.5], [t, 0.5], [-0.5, t], [0.5, t]);
  }
  return points;
}

/** Where the distortion stage samples the source for an output offset (cx, cy),
 *  as an offset from the centre: cen · scl / cropScale. */
function sourceOffset(u: DistortionUniforms, cropScale: number, cx: number, cy: number, aspect: number): [number, number] {
  const k = distortionScale(u, shaderRadius(cx, cy, aspect)) / cropScale;
  return [cx * k, cy * k];
}

/** The largest |offset| / 0.5 over the boundary: above 1 means a sample left the source. */
function maxReach(u: DistortionUniforms, cropScale: number, aspect: number): number {
  return Math.max(...boundary(4000).map(([x, y]) => Math.max(...sourceOffset(u, cropScale, x, y, aspect).map((v) => Math.abs(v) / 0.5))));
}

const GFX_ASPECT = 11648 / 8736;

describe("computeAutoCropScale", () => {
  it("is 1 without distortion", () => {
    expect(computeAutoCropScale(distortionUniforms(null, 0), 1.5)).toBe(1);
  });

  it("leaves the corrected GFX100RF frame uncropped: its barrel correction samples inside the source", () => {
    const lens = findLensById("fujifilm-gfx100rf-compatibles-standard")!;
    const u = distortionUniforms(resolveForLens(lens, { focalLength: 35 }, GFX_ASPECT), 0);
    const crop = computeAutoCropScale(u, GFX_ASPECT);
    expect(crop).toBeGreaterThanOrEqual(1);
    expect(crop).toBeLessThan(1 + 1e-9);
    expect(maxReach(u, crop, GFX_ASPECT)).toBeLessThan(1 + 1e-9);
  });

  it("crops the border the half-diagonal reading of that profile leaves at the long edges' midpoints", () => {
    const lens = findLensById("fujifilm-gfx100rf-compatibles-standard")!;
    const u = distortionUniforms({ ...resolveForLens(lens, { focalLength: 35 }, GFX_ASPECT), radiusScale: 1 }, 0);
    const midpoint = distortionScale(u, shaderRadius(0, 0.5, GFX_ASPECT));
    expect(midpoint).toBeCloseTo(1.025, 3);
    expect(computeAutoCropScale(u, GFX_ASPECT)).toBeCloseTo(midpoint, 6);
  });

  it("is 1 for barrel correction", () => {
    const u = distortionUniforms(profile({ model: "poly3", k: [-0.05] }, Math.hypot(1.5, 1)), 0);
    expect(distortionScale(u, 1)).toBeLessThan(1);
    const crop = computeAutoCropScale(u, 1.5);
    expect(crop).toBeGreaterThanOrEqual(1);
    expect(crop).toBeLessThan(1 + 1e-12);
  });

  it("zooms pincushion correction until every boundary sample lands inside the source, and no further", () => {
    const u = distortionUniforms(profile({ model: "poly3", k: [0.03] }, Math.hypot(1.5, 1)), 0);
    const crop = computeAutoCropScale(u, 1.5);
    expect(crop).toBeGreaterThan(1.05);
    expect(maxReach(u, crop, 1.5)).toBeLessThan(1 + 1e-7);
    expect(maxReach(u, crop, 1.5)).toBeGreaterThan(1 - 1e-7);
    expect(maxReach(u, 1, 1.5)).toBeGreaterThan(1.05);
  });

  it("removes a border thinner than a thousandth of the frame", () => {
    const u = distortionUniforms(profile({ model: "poly5", k: [0.0006, 0] }), 0);
    const crop = computeAutoCropScale(u, 1.5);
    expect(crop).toBeGreaterThan(1);
    expect(crop).toBeLessThan(1.001);
    expect(maxReach(u, crop, 1.5)).toBeLessThan(1 + 1e-9);
  });

  it("finds a wavy profile's peak between a corner and an edge midpoint", () => {
    // Peaks at r = 0.7, on the 3:2 frame's long edges between their midpoint (r ≈ 0.555) and the corner.
    const u = distortionUniforms(profile({ model: "poly5", k: [0.098, -0.1] }), 0);
    const peak = distortionScale(u, 0.7);
    const corner = distortionScale(u, shaderRadius(0.5, 0.5, 1.5));
    const midpoints = [shaderRadius(0, 0.5, 1.5), shaderRadius(0.5, 0, 1.5)].map((r) => distortionScale(u, r));
    expect(peak).toBeGreaterThan(Math.max(corner, ...midpoints) + 0.003);

    const crop = computeAutoCropScale(u, 1.5);
    expect(crop).toBeCloseTo(peak, 6);
    expect(maxReach(u, crop, 1.5)).toBeLessThan(1 + 1e-7);
  });

  it("includes the manual term", () => {
    const u = distortionUniforms(profile({ model: "poly3", k: [-0.01] }, Math.hypot(1.5, 1)), 100);
    const crop = computeAutoCropScale(u, 1.5);
    expect(crop).toBeGreaterThan(1);
    expect(maxReach(u, crop, 1.5)).toBeLessThan(1 + 1e-7);
  });

  it("treats portrait frames the same way", () => {
    const u = distortionUniforms(profile({ model: "poly3", k: [0.03] }, Math.hypot(1.5, 1)), 0);
    const crop = computeAutoCropScale(u, 2 / 3);
    expect(crop).toBeCloseTo(computeAutoCropScale(u, 1.5), 9);
    expect(maxReach(u, crop, 2 / 3)).toBeLessThan(1 + 1e-7);
  });
});
