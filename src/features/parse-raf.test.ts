import { describe, it, expect } from "vitest";
import {
  RAF_HEADER_BYTES,
  RAF_META_BYTES,
  fitPowers,
  parseRafTables,
  rafMetadataRange,
  rafToResolved,
  type RafCaTable,
  type RafRadialTable,
  type RafTables,
} from "./parse-raf";
import { GFX100RF_META_RAF_BASE64 } from "./__fixtures__/gfx100rf-meta";
import type { ResolvedProfile } from "../db/types";
import { distortionScale, distortionUniforms } from "../distortion";

function fixtureBytes(): ArrayBuffer {
  return Uint8Array.from(atob(GFX100RF_META_RAF_BASE64), (c) => c.charCodeAt(0)).buffer;
}

const GFX = { cameraMake: "FUJIFILM", cameraModel: "GFX100RF" };

// The GFX100RF's stored tables, as the exact rationals the camera wrote.
const RADII = [967, 1368, 1675, 1934, 2162, 2369, 2558, 2735, 2901].map((n) => n / 2735);
const DISTORTION = [-73052, -153052, -233052, -310421, -386631, -460210, -531894, -601052, -661789].map(
  (n) => n / 65536,
);
const VIGNETTING = [190997, 177049, 164224, 151583, 140183, 130055, 121257, 113237, 113237].map(
  (n) => n / 2048,
);
const CA_A = [7, 5, 5, 6, 6, 4, 0, -3, -3].map((n) => n / 65536);
const CA_B = [5, 6, 6, 6, 8, 10, 13, 19, 19].map((n) => n / 65536);

// Shader mirrors (stages.ts), in half-diagonal-normalised radius r.
const stageScale = (p: ResolvedProfile, r: number) => distortionScale(distortionUniforms(p, 0), r);
const vignetteGain = (k: number[], r: number) => 1 + k[0] * r ** 2 + k[1] * r ** 4 + k[2] * r ** 6;
const poly3Scale = (b: number, c: number, v: number, r: number) => b * r * r + c * r + v;

// ─── Synthetic CFA-section builder ───────────────────────────────────────────

type Rational = readonly [number, number];

interface CfaOptions {
  le?: boolean;
  fujiTag?: number;
  fujiType?: number;
}

/** A CFA section: TIFF header, IFD0 pointing at a Fujifilm sub-IFD whose
 *  entries are SRATIONAL arrays laid out after it. */
function buildCfa(tables: { tag: number; values: Rational[] }[], opts: CfaOptions = {}): ArrayBuffer {
  const le = opts.le ?? true;
  const subOff = 8 + 2 + 12 + 4;
  let dataOff = subOff + 2 + tables.length * 12 + 4;
  const size = tables.reduce((s, t) => s + t.values.length * 8, dataOff);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint16(0, le ? 0x4949 : 0x4d4d, false);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  dv.setUint16(8, 1, le);
  dv.setUint16(10, opts.fujiTag ?? 0xf000, le);
  dv.setUint16(12, opts.fujiType ?? 13, le);
  dv.setUint32(14, 1, le);
  dv.setUint32(18, subOff, le);
  dv.setUint16(subOff, tables.length, le);
  tables.forEach((t, i) => {
    const e = subOff + 2 + i * 12;
    dv.setUint16(e, t.tag, le);
    dv.setUint16(e + 2, 10, le);
    dv.setUint32(e + 4, t.values.length, le);
    dv.setUint32(e + 8, dataOff, le);
    t.values.forEach(([num, den], j) => {
      dv.setInt32(dataOff + j * 8, num, le);
      dv.setInt32(dataOff + j * 8 + 4, den, le);
    });
    dataOff += t.values.length * 8;
  });
  return buf;
}

const ints = (values: number[], den: number): Rational[] => values.map((v) => [v, den] as const);

function syntheticTables(n: number, caTrailingScale = true) {
  const scale: Rational = [7280, n];
  const radii = ints(
    Array.from({ length: n }, (_, i) => Math.round(Math.sqrt((i + 1) / (n - 1)) * 1e6)),
    1e6,
  );
  const series = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  const distortion = { tag: 0xf00b, values: [scale, ...radii, ...ints(series((i) => -1000 * (i + 1)), 65536)] };
  const vignetting = { tag: 0xf010, values: [scale, ...radii, ...ints(series((i) => 200000 - 9000 * i), 2048)] };
  const ca = {
    tag: 0xf00f,
    values: [
      scale,
      ...radii,
      ...ints(series((i) => i), 65536),
      ...ints(series((i) => -(i + 1)), 65536),
      ...(caTrailingScale ? [scale] : []),
    ],
  };
  return { distortion, vignetting, ca };
}

// ─── RAF header ──────────────────────────────────────────────────────────────

describe("rafMetadataRange", () => {
  const header = () => fixtureBytes().slice(0, RAF_HEADER_BYTES);

  it("locates the CFA section from the header's big-endian offset and length", () => {
    expect(rafMetadataRange(header())).toEqual({ start: 148, end: 148 + 1024 });
  });

  it("bounds the read to the metadata window on a full-size CFA section", () => {
    const h = header();
    new DataView(h).setUint32(104, 117035424, false);
    expect(rafMetadataRange(h)).toEqual({ start: 148, end: 148 + RAF_META_BYTES });
  });

  it("rejects files that are not RAFs", () => {
    const h = header();
    new Uint8Array(h)[0] = 0x00;
    expect(rafMetadataRange(h)).toBeNull();
  });

  it("rejects a truncated header", () => {
    expect(rafMetadataRange(header().slice(0, 100))).toBeNull();
  });

  it("rejects an empty CFA section", () => {
    const h = header();
    new DataView(h).setUint32(104, 0, false);
    expect(rafMetadataRange(h)).toBeNull();
  });
});

// ─── Fujifilm sub-IFD tables ─────────────────────────────────────────────────

describe("parseRafTables", () => {
  it("reproduces the GFX100RF's stored rationals exactly", () => {
    const bytes = fixtureBytes();
    const range = rafMetadataRange(bytes.slice(0, RAF_HEADER_BYTES))!;
    const t = parseRafTables(bytes.slice(range.start, range.end))!;

    expect(t.distortion!.radii).toEqual(RADII);
    expect(t.distortion!.values).toEqual(DISTORTION);
    expect(t.vignetting!.radii).toEqual(RADII);
    expect(t.vignetting!.values).toEqual(VIGNETTING);
    expect(t.ca!.radii).toEqual(RADII);
    expect(t.ca!.channelA).toEqual(CA_A);
    expect(t.ca!.channelB).toEqual(CA_B);
    for (const table of [t.distortion!, t.vignetting!, t.ca!]) {
      expect(table.radiusPx).toBeCloseTo(7280, 9);
    }
  });

  it("derives the point count from each tag's count (11-point bodies)", () => {
    const s = syntheticTables(11);
    const t = parseRafTables(buildCfa([s.distortion, s.ca, s.vignetting]))!;
    expect(t.distortion!.radii).toHaveLength(11);
    expect(t.distortion!.values).toHaveLength(11);
    expect(t.vignetting!.values).toHaveLength(11);
    expect(t.ca!.channelA).toEqual(Array.from({ length: 11 }, (_, i) => i / 65536));
    expect(t.ca!.channelB).toEqual(Array.from({ length: 11 }, (_, i) => -(i + 1) / 65536));
    expect(t.distortion!.radiusPx).toBeCloseTo(7280, 9);
  });

  it("accepts a CA table without the trailing scale", () => {
    const s = syntheticTables(9, false);
    const t = parseRafTables(buildCfa([s.ca]))!;
    expect(t.ca!.channelA).toHaveLength(9);
    expect(t.ca!.channelB).toEqual(Array.from({ length: 9 }, (_, i) => -(i + 1) / 65536));
  });

  it("treats absent tables as absent", () => {
    const s = syntheticTables(9);
    const t = parseRafTables(buildCfa([s.vignetting]))!;
    expect(t.distortion).toBeNull();
    expect(t.ca).toBeNull();
    expect(t.vignetting!.values).toHaveLength(9);
  });

  it("treats a table running past the slice as absent", () => {
    const s = syntheticTables(9);
    const full = buildCfa([s.distortion, s.ca, s.vignetting]);
    const t = parseRafTables(full.slice(0, full.byteLength - 8))!;
    expect(t.vignetting).toBeNull();
    expect(t.distortion).not.toBeNull();
    expect(t.ca).not.toBeNull();
  });

  it("reads big-endian sections and a LONG-typed sub-IFD pointer", () => {
    const s = syntheticTables(9);
    const t = parseRafTables(buildCfa([s.distortion], { le: false, fujiType: 4 }))!;
    expect(t.distortion!.values[0]).toBe(-1000 / 65536);
  });

  it("returns null without a Fujifilm sub-IFD", () => {
    const s = syntheticTables(9);
    expect(parseRafTables(buildCfa([s.distortion], { fujiTag: 0x0100 }))).toBeNull();
    expect(parseRafTables(new ArrayBuffer(16))).toBeNull();
  });
});

// ─── Least squares ───────────────────────────────────────────────────────────

describe("fitPowers", () => {
  it("recovers an exact polynomial", () => {
    const x = [0, 1, 2, 3, 4];
    const y = x.map((v) => 2 - 3 * v + 0.5 * v * v);
    const c = fitPowers(x, y, [0, 1, 2])!;
    expect(c[0]).toBeCloseTo(2, 10);
    expect(c[1]).toBeCloseTo(-3, 10);
    expect(c[2]).toBeCloseTo(0.5, 10);
  });

  it("returns null when the system is underdetermined or singular", () => {
    expect(fitPowers([1], [1], [0, 1])).toBeNull();
    expect(fitPowers([1, 1, 1], [1, 2, 3], [0, 1])).toBeNull();
  });
});

// ─── Conversion to the shader models ─────────────────────────────────────────

const R = Array.from({ length: 9 }, (_, i) => Math.sqrt((i + 1) / 8));
const radial = (values: number[]): RafRadialTable => ({ radiusPx: 7280, radii: R, values });
const caTable = (channelA: number[], channelB: number[]): RafCaTable => ({
  radiusPx: 7280,
  radii: R,
  channelA,
  channelB,
});
const NONE: RafTables = { distortion: null, vignetting: null, ca: null };

describe("rafToResolved", () => {
  it("maps distortion percent onto poly5 as [r², r⁴] so the stage samples r·(1 + p/100)", () => {
    const pct = (r: number) => 100 * (-0.05 * r * r + 0.01 * r ** 4);
    const resolved = rafToResolved({ ...NONE, distortion: radial(R.map(pct)) }, GFX)!;
    const d = resolved.distortion!;
    expect(d.model).toBe("poly5");
    expect(d.k[0]).toBeCloseTo(-0.05, 10);
    expect(d.k[1]).toBeCloseTo(0.01, 10);
    for (const r of [0.5, 1, ...R]) expect(stageScale(resolved, r)).toBeCloseTo(1 + pct(r) / 100, 10);
  });

  it("maps vignetting percent-of-centre onto the attenuation the stage divides by", () => {
    const v = R.map((r) => 100 * (1 - 0.3 * r * r + 0.05 * r ** 4 - 0.01 * r ** 6));
    const k = rafToResolved({ ...NONE, vignetting: radial(v) }, GFX)!.vignetting!.k;
    expect(k[0]).toBeCloseTo(-0.3, 10);
    expect(k[1]).toBeCloseTo(0.05, 10);
    expect(k[2]).toBeCloseTo(-0.01, 10);
  });

  it("maps CA channel A to red and channel B to blue as poly3 [br, cr, vr, bb, cb, vb]", () => {
    const a = R.map((r) => 1e-4 * r * r - 2e-4 * r + 3e-5);
    const b = R.map((r) => -5e-5 * r * r + 1e-4 * r);
    const tca = rafToResolved({ ...NONE, ca: caTable(a, b) }, GFX)!.tca!;
    expect(tca.model).toBe("poly3");
    const expected = [1e-4, -2e-4, 1 + 3e-5, -5e-5, 1e-4, 1];
    tca.k.forEach((k, i) => expect(k).toBeCloseTo(expected[i], 10));
  });

  it("excludes clamped tail points that repeat their predecessor", () => {
    const v = R.map((r) => 100 * (1 - 0.3 * r * r + 0.05 * r ** 4 - 0.01 * r ** 6));
    v[8] = v[7];
    const k = rafToResolved({ ...NONE, vignetting: radial(v) }, GFX)!.vignetting!.k;
    expect(k[0]).toBeCloseTo(-0.3, 10);
    expect(k[1]).toBeCloseTo(0.05, 10);
    expect(k[2]).toBeCloseTo(-0.01, 10);
  });

  it("keeps a distinct point beyond the frame corner", () => {
    const p = R.map((r) => 100 * (-0.05 * r * r + 0.01 * r ** 4));
    p[8] += 1;
    const d = rafToResolved({ ...NONE, distortion: radial(p) }, GFX)!.distortion!;
    expect(Math.abs(d.k[0] + 0.05)).toBeGreaterThan(1e-4);
  });

  it("maps a CA-free table to the identity scale", () => {
    const zero = R.map(() => 0);
    const tca = rafToResolved({ ...NONE, ca: caTable(zero, zero) }, GFX)!.tca!;
    const identity = [0, 0, 1, 0, 0, 1];
    tca.k.forEach((k, i) => expect(k).toBeCloseTo(identity[i], 12));
  });

  it("leaves absent tables unset and returns null when nothing is present", () => {
    const v = R.map((r) => 100 - 40 * r * r);
    const p = rafToResolved({ ...NONE, vignetting: radial(v) }, GFX)!;
    expect(p.distortion).toBeNull();
    expect(p.tca).toBeNull();
    expect(p.vignetting).not.toBeNull();
    expect(rafToResolved(NONE, GFX)).toBeNull();
  });

  it("names the profile after the lens, falling back to the body for fixed-lens cameras", () => {
    const tables = { ...NONE, vignetting: radial(R.map((r) => 100 - 40 * r * r)) };
    const fixed = rafToResolved(tables, GFX)!;
    expect(fixed.source).toBe("embedded");
    expect(fixed.lensId).toBe("embedded:raf:FUJIFILM:GFX100RF");
    expect(fixed.lensName).toBe("GFX100RF");
    const lens = rafToResolved(tables, { ...GFX, lens: "GF35mmF4" })!;
    expect(lens.lensName).toBe("GF35mmF4");
  });
});

// ─── Fit quality on the real GFX100RF tables ─────────────────────────────────

describe("GFX100RF fit residuals", () => {
  const radiusPx = 7280;
  const profile = rafToResolved(
    {
      distortion: { radiusPx, radii: RADII, values: DISTORTION },
      vignetting: { radiusPx, radii: RADII, values: VIGNETTING },
      ca: { radiusPx, radii: RADII, channelA: CA_A, channelB: CA_B },
    },
    GFX,
  )!;
  const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));

  it("distortion: barrel, within 6.5 px of every stored point at full resolution", () => {
    expect(stageScale(profile, 1)).toBeLessThan(1);
    const px = RADII.map((r, i) => (stageScale(profile, r) - (1 + DISTORTION[i] / 100)) * r * radiusPx);
    expect(maxAbs(px)).toBeLessThan(6.5);
  });

  it("vignetting: within 0.15 % of centre brightness at every unclamped point", () => {
    const k = profile.vignetting!.k;
    const pct = RADII.slice(0, 8).map((r, i) => vignetteGain(k, r) * 100 - VIGNETTING[i]);
    expect(maxAbs(pct)).toBeLessThan(0.15);
  });

  it("CA: both channels within 0.25 px at every unclamped point", () => {
    const [br, cr, vr, bb, cb, vb] = profile.tca!.k;
    const red = RADII.slice(0, 8).map((r, i) => (poly3Scale(br, cr, vr, r) - (1 + CA_A[i])) * r * radiusPx);
    const blue = RADII.slice(0, 8).map((r, i) => (poly3Scale(bb, cb, vb, r) - (1 + CA_B[i])) * r * radiusPx);
    expect(maxAbs(red)).toBeLessThan(0.25);
    expect(maxAbs(blue)).toBeLessThan(0.25);
  });
});
