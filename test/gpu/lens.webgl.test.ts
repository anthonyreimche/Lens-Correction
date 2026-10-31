// Vignetting and defringe inside a local-adjustment mask on the real
// renderer. Run via `npm run test:gpu` (test/gpu/run.cjs copies this file into
// a SafeLight checkout and runs it under its headless Chromium + SwiftShader
// rig). What the CPU suite cannot check:
//
//  • a mask's copy of each stage compiles beside the stage, with the host's
//    namespacing, and is bound to the mask's values only: a key the mask
//    doesn't hold runs at its default, not at the photo's value;
//  • inside the mask the copy runs on what the photo's own correction left,
//    matching the CPU model of the stage's GLSL there, and every pixel outside
//    the mask is the photo's own frame, bit for bit.
//
// The probe hands scene-linear light straight to the display without the core
// shoulder, so the frame is the colour the stages work on.

import { describe, expect, it } from "vitest";
import { defaultMaskAdjustments, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  floatImage,
  identityParams,
  withRenderer,
  type Frame,
} from "@/rendering/webgl/webgl.test-support";
import { STAGE } from "@lc/params";
import { alwaysStages } from "@lc/stages";
import { distortionScale, shaderRadius, type DistortionUniforms } from "@lc/distortion";

const W = 256;
const H = 128;
const OPEN_PROBE = { ...LINEAR_PROBE_PIPELINE, id: "test.lc-open-probe", sig: "test.lc-open-probe", skipToneShoulder: true };

type Rgb = [number, number, number];

/** Smooth light under the probe's range even after a strong lift. */
const SOFT = floatImage(W, H, (x, y) => [0.08 + (0.25 * x) / W, 0.18 + (0.12 * y) / H, 0.3 - (0.1 * x) / W]);

/** A hue sweep by column at two strengths by row: purples and greens for the
 *  defringe to find, in display range. */
const FRINGES = floatImage(W, H, (x, y) => {
  const t = (6 * x) / W;
  const f = t - Math.floor(t);
  const hue: Rgb[] = [
    [1, f, 0],
    [1 - f, 1, 0],
    [0, 1, f],
    [0, 1 - f, 1],
    [f, 0, 1],
    [1, 0, 1 - f],
  ];
  const [r, g, b] = hue[Math.floor(t) % 6];
  const [lo, hi] = y < H / 2 ? [0.3, 0.75] : [0.15, 0.5];
  return [lo + (hi - lo) * r, lo + (hi - lo) * g, lo + (hi - lo) * b];
});

// A linear gradient whose step sits at u = 0.5: the right half is covered.
const rightHalf = (bag: Record<string, number>): Mask => ({
  id: "m",
  name: "Mask",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: ["com.safelight.lens-correction.panel"],
  bag,
  components: [{ id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } }],
});

// Columns either side of the step, clear of the three its baked coverage ramps
// over at this width (about 0.2, 0.6 and 0.98 from column 128).
const left = (x: number) => x < W / 2 - 1;
const right = (x: number) => x > W / 2 + 2;

/** The photo's frame without and with the mask, on one renderer: renderers
 *  share one context, and a nested one's dispose() tears down GL state the
 *  outer one relies on. */
function frames(scene: ReturnType<typeof floatImage>, photo: Record<string, number>, mask: Mask): [Frame, Frame] {
  const stages = [...builtinStages(), ...(alwaysStages as ProcessingStageContribution[])];
  return withRenderer({ stages, pipeline: OPEN_PROBE }, (r) => {
    r.setImage(scene);
    r.setContributedParams(photo);
    r.setParams(identityParams({ processVersion: 2 }));
    const off = r.captureFloatFrame();
    r.setParams(identityParams({ processVersion: 2, masks: [mask] }));
    const on = r.captureFloatFrame();
    if (!off || !on) throw new Error("captureFloatFrame returned null");
    return [off, on];
  });
}

function expectOutsideUnchanged(on: Frame, off: Frame): void {
  for (let p = 0; p < W * H; p++) {
    if (!left(p % W)) continue;
    for (let ch = 0; ch < 3; ch++) expect(on.data[p * 4 + ch]).toBe(off.data[p * 4 + ch]);
  }
}

/** The covered columns against `model` applied to the photo's own frame. */
function compareInside(on: Frame, off: Frame, model: (rgb: Rgb, x: number, y: number) => Rgb) {
  let se = 0;
  let change = 0;
  let max = 0;
  let n = 0;
  let worst = "";
  for (let p = 0; p < W * H; p++) {
    const x = p % W;
    if (!right(x)) continue;
    const y = Math.floor(p / W);
    const o = p * 4;
    const before: Rgb = [off.data[o], off.data[o + 1], off.data[o + 2]];
    const want = model(before, x, y);
    for (let ch = 0; ch < 3; ch++) {
      const e = on.data[o + ch] - want[ch];
      const d = want[ch] - before[ch];
      se += e * e;
      change += d * d;
      n++;
      if (Math.abs(e) > max) {
        max = Math.abs(e);
        worst = `x=${x} y=${y} ch=${ch} before=${before[ch].toFixed(4)} want=${want[ch].toFixed(4)} gpu=${on.data[o + ch].toFixed(4)}`;
      }
    }
  }
  return { rms: Math.sqrt(se / n), changeRms: Math.sqrt(change / n), max, worst };
}

// ── CPU models of the stages' GLSL ───────────────────────────────────────────

/** Normalised radius at a pixel's centre: sensorUv over the half diagonal. */
function radius(x: number, y: number): number {
  const aspect = W / H;
  const px = ((x + 0.5) / W - 0.5) * aspect;
  const py = (y + 0.5) / H - 0.5;
  return Math.hypot(px, py) / (0.5 * Math.sqrt(aspect * aspect + 1));
}

/** The manual vignetting term (vigManual), the only one a mask writes. */
function manualVignette(amount: number, x: number, y: number): number {
  const rr2 = radius(x, y) ** 2;
  const fo = Math.min(Math.max(1 - rr2 * 0.5, 0), 1) ** 2;
  const mn = amount > 0 ? 1 + (1 - fo) * (amount / 100) : 1 - (1 - fo) * (-amount / 100);
  return Math.min(Math.max(mn, 0), 4);
}

/** The defringe block, hue-targeted when a hue is set. */
function defringe([r0, g0, b0]: Rgb, amount: number, purpleHue: number, greenHue: number, hueRadius: number): Rgb {
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  const [r, g, b] = [clamp01(r0), clamp01(g0), clamp01(b0)];
  const lm = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = Math.hypot(r - lm, g - lm, b - lm);
  const purpleish = Math.max(0, b - r) + Math.max(0, b - g);
  const greenish = Math.max(0, g - r) + Math.max(0, g - b);
  let fringeMag: number;
  if (purpleHue > 0.5 || greenHue > 0.5) {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const dl = mx - mn;
    let hue = 0;
    if (dl > 1e-5) {
      if (mx === r) hue = (((g - b) / dl) % 6 + 6) % 6;
      else if (mx === g) hue = (b - r) / dl + 2;
      else hue = (r - g) / dl + 4;
      hue *= 60;
    }
    const tol = Math.max(hueRadius, 1);
    let pd = Math.abs(hue - purpleHue);
    pd = Math.min(pd, 360 - pd);
    let gd = Math.abs(hue - greenHue);
    gd = Math.min(gd, 360 - gd);
    const wP = purpleHue > 0.5 ? clamp01(1 - pd / tol) : 0;
    const wG = greenHue > 0.5 ? clamp01(1 - gd / tol) : 0;
    fringeMag = clamp01((purpleish * wP + greenish * wG) * 4);
  } else {
    fringeMag = clamp01((purpleish + greenish) * 4);
  }
  const suppress = clamp01((amount / 100) * fringeMag * (chroma * 8));
  return [r + (lm - r) * suppress, g + (lm - g) * suppress, b + (lm - b) * suppress];
}

// ── Specs ────────────────────────────────────────────────────────────────────

describe("Lens Correction distortion", () => {
  // SOFT is affine in the pixel index, so a bilinear tap anywhere inside the
  // frame reads it exactly: sampling at uv reads f(uv·W − 0.5, uv·H − 0.5).
  const soft = (u: number, v: number): Rgb => {
    const x = u * W - 0.5;
    const y = v * H - 0.5;
    return [0.08 + (0.25 * x) / W, 0.18 + (0.12 * y) / H, 0.3 - (0.1 * x) / W];
  };

  function render(photo: Record<string, number>): Frame {
    const stages = [...builtinStages(), ...(alwaysStages as ProcessingStageContribution[])];
    return withRenderer({ stages, pipeline: OPEN_PROBE }, (r) => {
      r.setImage(SOFT);
      r.setContributedParams(photo);
      r.setParams(identityParams({ processVersion: 2 }));
      const frame = r.captureFloatFrame();
      if (!frame) throw new Error("captureFloatFrame returned null");
      return frame;
    });
  }

  /** The largest gap between the frame and SOFT warped by `u` on the CPU. */
  function maxError(frame: Frame, u: DistortionUniforms): number {
    let max = 0;
    for (let p = 0; p < W * H; p++) {
      const cx = ((p % W) + 0.5) / W - 0.5;
      const cy = (Math.floor(p / W) + 0.5) / H - 0.5;
      const scl = distortionScale(u, shaderRadius(cx, cy, W / H));
      const want = soft(0.5 + cx * scl, 0.5 + cy * scl);
      for (let ch = 0; ch < 3; ch++) max = Math.max(max, Math.abs(frame.data[p * 4 + ch] - want[ch]));
    }
    return max;
  }

  const uniforms = (u: Omit<DistortionUniforms, "distManual">): DistortionUniforms => ({ ...u, distManual: 0 });
  const bag = (u: DistortionUniforms) =>
    Object.fromEntries(Object.entries(u).map(([k, v]) => [`${STAGE.distortion}.${k}`, v]));

  it.each([
    ["poly5 with an r⁶ term", uniforms({ distModel: 2, distKA: -0.12, distKB: 0.03, distKC: -0.06, distRScale: 1 })],
    ["Adobe's fisheye model", uniforms({ distModel: 4, distKA: 0.05, distKB: -0.01, distKC: 0, distRScale: 1.5 })],
  ])("warps the frame as the CPU mirror of %s does", (name, u) => {
    const frame = render(bag(u));
    const err = maxError(frame, u);
    const untouched = maxError(frame, uniforms({ distModel: 0, distKA: 0, distKB: 0, distKC: 0, distRScale: 1 }));
    console.log(`[lc-gpu] ${name}: max error ${err.toExponential(2)}; vs no warp ${untouched.toExponential(2)}`);
    expect(untouched).toBeGreaterThan(1e-2);
    expect(err).toBeLessThan(1e-3);
  });

  it("feels the r⁶ term", () => {
    const u = uniforms({ distModel: 2, distKA: -0.12, distKB: 0.03, distKC: -0.06, distRScale: 1 });
    expect(maxError(render(bag(u)), { ...u, distKC: 0 })).toBeGreaterThan(5e-3);
  });
});

describe("Lens Correction in a mask", () => {
  it("runs the mask's manual vignetting on top of the photo's profile vignetting, inside the mask only", () => {
    const photo = { [`${STAGE.vignette}.vigK1`]: -0.25, [`${STAGE.vignette}.vigManual`]: 0 };
    const amount = 60;
    const [off, on] = frames(SOFT, photo, rightHalf({ [`${STAGE.vignette}.vigManual`]: amount }));
    expectOutsideUnchanged(on, off);
    const s = compareInside(on, off, (rgb, x, y) => rgb.map((v) => v * manualVignette(amount, x, y)) as Rgb);
    console.log(
      `[lc-gpu] masked vignetting: change rms ${s.changeRms.toExponential(2)}; error rms ${s.rms.toExponential(2)}, ` +
        `max ${s.max.toExponential(2)}; worst ${s.worst}`,
    );
    expect(s.changeRms).toBeGreaterThan(1e-2);
    expect(s.max).toBeLessThan(1e-3);
  });

  it("runs the mask's hue-targeted defringe on the photo's colours, inside the mask only", () => {
    const mask = { amount: 90, purple: 275, green: 120, radius: 60 };
    const [off, on] = frames(
      FRINGES,
      { [`${STAGE.defringe}.dfAmount`]: 0 },
      rightHalf({
        [`${STAGE.defringe}.dfAmount`]: mask.amount,
        [`${STAGE.defringe}.dfPurpleHue`]: mask.purple,
        [`${STAGE.defringe}.dfGreenHue`]: mask.green,
        [`${STAGE.defringe}.dfRadius`]: mask.radius,
      }),
    );
    expectOutsideUnchanged(on, off);
    const s = compareInside(on, off, (rgb) => defringe(rgb, mask.amount, mask.purple, mask.green, mask.radius));
    console.log(
      `[lc-gpu] masked defringe: change rms ${s.changeRms.toExponential(2)}; error rms ${s.rms.toExponential(2)}, ` +
        `max ${s.max.toExponential(2)}; worst ${s.worst}`,
    );
    expect(s.changeRms).toBeGreaterThan(1e-2);
    expect(s.max).toBeLessThan(1e-3);
  });
});
