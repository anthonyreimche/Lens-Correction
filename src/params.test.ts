import { describe, it, expect } from "vitest";
import type { ResolvedProfile } from "./db/types";
import { STAGE, computeStageUniforms, defaultState, type LensState } from "./params";
import { computeAutoCropScale } from "./db/auto-crop";
import { distortionUniforms } from "./distortion";
import { parseRafTables, RAF_HEADER_BYTES, rafMetadataRange, rafToResolved } from "./features/parse-raf";
import { adobeToResolved } from "./features/adobe-model";
import { GFX100RF_META_RAF_BASE64 } from "./features/__fixtures__/gfx100rf-meta";

const state = (over: Partial<LensState> = {}): LensState => ({ ...defaultState(true), ...over });

const lensfun = (over: Partial<ResolvedProfile> = {}): ResolvedProfile => ({
  lensId: "test",
  lensName: "Test",
  source: "lensfun",
  radiusScale: 5 / 3,
  distortion: { model: "poly3", k: [0.03] },
  tca: { model: "poly3", k: [1e-4, -2e-4, 1, -5e-5, 1e-4, 1] },
  vignetting: null,
  ...over,
});

const dist = (u: Record<string, number>, key: string) => u[`${STAGE.distortion}.${key}`];
const ca = (u: Record<string, number>, key: string) => u[`${STAGE.ca}.${key}`];

describe("computeStageUniforms — radius scale", () => {
  it("binds a Lensfun profile's radius scale to distortion and polynomial TCA", () => {
    const u = computeStageUniforms(state(), lensfun(), 4 / 3);
    expect(dist(u, "distRScale")).toBeCloseTo(5 / 3, 12);
    expect(ca(u, "tcaRScale")).toBeCloseTo(5 / 3, 12);
  });

  it("binds 1 when the profile's distortion or CA isn't applied", () => {
    for (const s of [state({ mode: "off" }), state({ mode: "manual" }), state({ distortionEnabled: false, caEnabled: false })]) {
      const u = computeStageUniforms(s, lensfun(), 4 / 3);
      expect(dist(u, "distRScale")).toBe(1);
      expect(ca(u, "tcaRScale")).toBe(1);
    }
    const none = computeStageUniforms(state(), null, 4 / 3);
    expect(dist(none, "distRScale")).toBe(1);
    expect(ca(none, "tcaRScale")).toBe(1);
  });

  it("binds 1 for an auto CA estimate, which replaces the profile's TCA", () => {
    const u = computeStageUniforms(state({ caAuto: true, autoCaR: 1.001, autoCaB: 0.999 }), lensfun(), 4 / 3);
    expect(ca(u, "tcaModel")).toBe(1);
    expect(ca(u, "tcaRScale")).toBe(1);
  });

  it("leaves the embedded RAF profile in its own half-diagonal units", () => {
    const bytes = Uint8Array.from(atob(GFX100RF_META_RAF_BASE64), (c) => c.charCodeAt(0)).buffer;
    const range = rafMetadataRange(bytes.slice(0, RAF_HEADER_BYTES))!;
    const raf = rafToResolved(parseRafTables(bytes.slice(range.start, range.end))!, { cameraMake: "FUJIFILM", cameraModel: "GFX100RF" })!;
    expect(raf.radiusScale).toBeUndefined();
    const u = computeStageUniforms(state(), raf, 11648 / 8736);
    expect(dist(u, "distModel")).toBe(2);
    expect(dist(u, "distRScale")).toBe(1);
    expect(ca(u, "tcaModel")).toBe(2);
    expect(ca(u, "tcaRScale")).toBe(1);
  });

  it("leaves Adobe-model profiles in their own half-diagonal units", () => {
    const lcp = adobeToResolved(
      {
        make: "Canon",
        model: "EOS",
        lens: "EF 24-70",
        entries: [{ focal: 50, aperture: 4, focalLengthX: 1.4, distortion: { k1: -0.05, k2: 0.01, k3: 0 }, ca: { redK1: 1e-3, redK2: 0, blueK1: -2e-3, blueK2: 0 } }],
      },
      50,
      1.5,
      "lcp",
    )!;
    expect(lcp.radiusScale).toBeUndefined();
    const u = computeStageUniforms(state(), lcp, 1.5);
    expect(dist(u, "distRScale")).toBe(1);
    expect(ca(u, "tcaRScale")).toBe(1);
  });
});

describe("computeStageUniforms — auto-crop", () => {
  const pincushion = lensfun({ distortion: { model: "poly3", k: [0.03] }, radiusScale: Math.hypot(1.5, 1) });
  const cropOf = (s: LensState, p: ResolvedProfile | null) => dist(computeStageUniforms(s, p, 1.5), "cropScale");

  it("crops from the same uniforms the stage is bound with", () => {
    const s = state({ distortion: 20 });
    const expected = computeAutoCropScale(distortionUniforms(pincushion, 20), 1.5);
    expect(expected).toBeGreaterThan(1.05);
    expect(cropOf(s, pincushion)).toBe(expected);
  });

  it("only crops profile distortion that is applied, with auto-crop on", () => {
    expect(cropOf(state({ autoCrop: false }), pincushion)).toBe(1);
    expect(cropOf(state({ distortionEnabled: false }), pincushion)).toBe(1);
    expect(cropOf(state({ mode: "manual" }), pincushion)).toBe(1);
    expect(cropOf(state({ mode: "off" }), pincushion)).toBe(1);
    expect(cropOf(state(), null)).toBe(1);
  });

  it("leaves manual distortion uncropped when the profile applies none", () => {
    const manual = { distortion: 100 };
    expect(cropOf(state({ ...manual, mode: "manual" }), pincushion)).toBe(1);
    expect(cropOf(state({ ...manual, distortionEnabled: false }), pincushion)).toBe(1);
    expect(cropOf(state(manual), lensfun({ distortion: null }))).toBe(1);
  });
});
