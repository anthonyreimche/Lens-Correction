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
import { CURRENT_PROCESS_VERSION, DEFAULT_GRAIN, DEFAULT_VIGNETTE, defaultMaskAdjustments, type Mask } from "@/catalog/types";
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
import { alwaysStages, defringeStage, defringeV1Stage, distortionStage, vignetteStage } from "@lc/stages";
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

/** The defringe block, hue-targeted when a hue is set: it finds fringes on a
 *  copy clipped to [0, 1] and desaturates the pixel itself. */
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
  const own = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
  return [r0 + (own - r0) * suppress, g0 + (own - g0) * suppress, b0 + (own - b0) * suppress];
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

/** Vignette darkening and coloured grain: in bright areas they leave unequal
 *  channels a defringe after them reads as fringe. */
const EFFECTS_ON = {
  vignette: { ...DEFAULT_VIGNETTE, amount: -30 },
  grain: { ...DEFAULT_GRAIN, amount: 100, color: 100 },
};

// On process version 2 the image stays full range through every stage. A
// downstream stage halves the frame, so a value past white upstream still reads
// back under it. Defringe runs ahead of Vignette (50) and Grain (60), so they
// stay on in the bit-exact test; a defringe at version 1's place, after them,
// must find their false fringes there, or the test proves nothing about order.
// A bare display stage that declares no space is the positive control: the host
// clips ahead of it, so it must change the frame, or the scene doesn't reach the
// effects phase over range and a pass proves nothing.
describe("Lens Correction defringe on version 2", () => {
  const V2 = { processVersion: CURRENT_PROCESS_VERSION };
  const V2_EFFECTS = { ...V2, ...EFFECTS_ON };
  const HALVE: ProcessingStageContribution = {
    id: "test.halve",
    name: "Halve",
    phase: "output-encode",
    priority: 1000,
    space: { encoding: "perceptual" },
    glsl: "c *= 0.5;",
    uniforms: [],
  };
  const CLIPS_AHEAD: ProcessingStageContribution = {
    id: "test.clips-ahead",
    name: "Clips ahead",
    phase: "effects",
    glsl: "c = c;",
    uniforms: [],
  };
  const df = (bag: Record<string, number>) =>
    Object.fromEntries(Object.entries(bag).map(([k, v]) => [`${STAGE.defringe}.${k}`, v]));

  /** Over-range values no fringe test finds once clipped to [0, 1]: every
   *  channel past white, in purple, green and neutral order, and reds whose
   *  green and blue sit below black. */
  const UNFRINGED = floatImage(W, H, (x, y) => {
    const u = x / (W - 1);
    const v = y / (H - 1);
    if (y < H / 4) return [1.3 + 0.4 * u, 1.4 + 0.3 * u, 1.5 + 0.4 * u];
    if (y < H / 2) return [1.3 + 0.2 * u, 1.6 + 0.3 * u, 1.4 + 0.2 * u];
    if (y < (3 * H) / 4) return [1.1 + 0.8 * u, 1.1 + 0.8 * u, 1.1 + 0.8 * u];
    return [0.3 + 0.5 * u, -0.2 - 0.3 * v, -0.25 - 0.3 * v];
  });

  /** Purple fringes past white, and green ones past white and below black,
   *  bright enough that their own luminance is past white too. */
  const WIDE_FRINGES = floatImage(W, H, (x, y) => {
    const u = x / (W - 1);
    if (y < H / 2) return [1.4 + 0.2 * u, 0.8 + 0.1 * u, 1.7 + 0.2 * u];
    return [0.4 + 0.2 * u, 1.5 + 0.3 * u, -0.05 - 0.15 * u];
  });

  function frame(
    scene: ReturnType<typeof floatImage>,
    photo: Record<string, number>,
    over: Record<string, unknown>,
    extra: ProcessingStageContribution[] = [],
    signed = false,
  ): Frame {
    const stages = [...builtinStages(), ...(alwaysStages as ProcessingStageContribution[]), ...extra, ...(signed ? [] : [HALVE])];
    return withRenderer({ stages, pipeline: OPEN_PROBE }, (r) => {
      r.setImage(scene);
      r.setContributedParams(photo);
      r.setParams(identityParams(over));
      const f = signed ? r.readFloatFrame("pre-output", Infinity, { encoding: "perceptual" }) : r.captureFloatFrame();
      if (!f) throw new Error("the frame couldn't be read");
      return f;
    });
  }

  const differing = (a: Frame, b: Frame) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
    return n;
  };

  it("leaves every pixel it doesn't suppress bit-exact, over range, with Vignette and Grain on", () => {
    const idle = df({ dfAmount: 0 });
    const bare = frame(UNFRINGED, idle, V2_EFFECTS);
    const clipped = frame(UNFRINGED, idle, V2_EFFECTS, [CLIPS_AHEAD]);
    expect(differing(bare, clipped)).toBeGreaterThan(W * H * 0.1);
    const settings = [{ dfAmount: 90 }, { dfAmount: 90, dfPurpleHue: 275, dfGreenHue: 120, dfRadius: 60 }];
    for (const s of settings) {
      expect(differing(frame(UNFRINGED, df(s), V2_EFFECTS), bare)).toBe(0);
    }
    const late = {
      ...defringeStage,
      id: "test.defringe-late",
      priority: 100,
      produces: undefined,
      mask: undefined,
    } as ProcessingStageContribution;
    const lateBag = (s: Record<string, number>) =>
      Object.fromEntries(Object.entries(s).map(([k, v]) => [`${late.id}.${k}`, v]));
    const n = differing(frame(UNFRINGED, { ...idle, ...lateBag(settings[0]) }, V2_EFFECTS, [late]), bare);
    console.log(`[lc-gpu] v2 defringe after Vignette and Grain changes ${n} values`);
    expect(n).toBeGreaterThan(W * H * 0.02);
  });

  // Read as the signed `c` the output stage receives: the default capture is
  // half float clipped to [0, 1], which loses the greens below black and adds
  // a half-float step to the model's input.
  it("desaturates over-range fringes toward their own luminance, keeping their range", () => {
    const amount = 90;
    const off = frame(WIDE_FRINGES, df({ dfAmount: 0 }), V2, [], true);
    const on = frame(WIDE_FRINGES, df({ dfAmount: amount }), V2, [], true);
    let belowBlack = 0;
    let max = 0;
    let change = 0;
    let pastWhite = 0;
    for (let p = 0; p < W * H; p++) {
      const o = p * 4;
      const before: Rgb = [off.data[o], off.data[o + 1], off.data[o + 2]];
      const want = defringe(before, amount, 0, 0, 50);
      if (Math.max(...want) > 1) pastWhite++;
      if (Math.min(...before) < 0) belowBlack++;
      for (let ch = 0; ch < 3; ch++) {
        max = Math.max(max, Math.abs(on.data[o + ch] - want[ch]));
        change += (want[ch] - before[ch]) ** 2;
      }
    }
    const changeRms = Math.sqrt(change / (W * H * 3));
    console.log(`[lc-gpu] v2 over-range defringe: change rms ${changeRms.toExponential(2)}; max ${max.toExponential(2)}; ${pastWhite} px past white, ${belowBlack} in below black`);
    expect(changeRms).toBeGreaterThan(1e-2);
    expect(pastWhite).toBeGreaterThan(W * H * 0.5);
    expect(belowBlack).toBeGreaterThan(W * H * 0.25);
    expect(max).toBeLessThan(1e-3);
  });
});

// Process version 1 photos keep the defringe they were edited with, which
// clipped the pixel itself to [0, 1] once its gate opened. A stage ahead of it
// widens the frame past both ends on either version, and the read is the
// signed `c` the output stage receives, Vignette and Grain off: the default
// capture clips to [0, 1] and would hide the clip. The scene holds no fringe,
// so the open gate changes nothing but the clip.
describe("Lens Correction defringe on version 1", () => {
  const WIDEN: ProcessingStageContribution = {
    id: "test.widen",
    name: "Widen",
    phase: "effects",
    priority: 50,
    space: { encoding: "perceptual" },
    glsl: "c = c * 1.6 - 0.3;",
    uniforms: [],
  };
  const NEUTRAL_AND_RED = floatImage(W, H, (x, y) => {
    const u = x / (W - 1);
    if (y < H / 2) return [0.05 + 0.9 * u, 0.05 + 0.9 * u, 0.05 + 0.9 * u];
    return [0.2 + 0.7 * u, 0.02, 0.02];
  });
  const df = (amount: number) => ({ [`${STAGE.defringe}.dfAmount`]: amount });

  function signedFrame(photo: Record<string, number>, processVersion: number): Frame {
    const stages = [...builtinStages(), WIDEN, ...(alwaysStages as ProcessingStageContribution[])];
    return withRenderer({ stages, pipeline: OPEN_PROBE }, (r) => {
      r.setImage(NEUTRAL_AND_RED);
      r.setContributedParams(photo);
      r.setParams(identityParams({ processVersion }));
      const f = r.readFloatFrame("pre-output", Infinity, { encoding: "perceptual" });
      if (!f) throw new Error("readFloatFrame returned null");
      return f;
    });
  }

  it("clips the pixel to [0, 1] once the gate opens on version 1, and not on version 2", () => {
    for (const version of [1, CURRENT_PROCESS_VERSION]) {
      const bare = signedFrame(df(0), version);
      const on = signedFrame(df(90), version);
      let outside = 0;
      let outsideAfter = 0;
      let worst = 0;
      for (let i = 0; i < bare.data.length; i++) {
        if (i % 4 === 3) continue;
        const v = bare.data[i];
        if (v < 0 || v > 1) outside++;
        if (on.data[i] < 0 || on.data[i] > 1) outsideAfter++;
        worst = Math.max(worst, Math.abs(on.data[i] - (version === 1 ? Math.min(Math.max(v, 0), 1) : v)));
      }
      console.log(`[lc-gpu] v${version} defringe gate open: ${outside} values outside [0, 1] going in, ${outsideAfter} after, worst ${worst.toExponential(2)}`);
      expect(outside).toBeGreaterThan(W * H * 0.1);
      expect(worst).toBeLessThan(1e-6);
      if (version === 1) expect(outsideAfter).toBe(0);
      else expect(outsideAfter).toBe(outside);
    }
  });

  // Before the split, one stage at priority 100 read the settings as its own
  // uniforms. Version 1's stage reads them from the stage that owns them now;
  // the frame must not move by a bit, with Vignette and Grain on ahead of it.
  it("renders version 1 as the single defringe stage at priority 100 did, bit for bit", () => {
    const single = {
      ...defringeV1Stage,
      id: STAGE.defringe,
      uniforms: defringeStage.uniforms,
      consumes: undefined,
      glsl: defringeV1Stage.glsl.replace(/^\s*float \w+ = isv_\w+\.[xyzw];\n/gm, ""),
    } as ProcessingStageContribution;
    const render = (lens: ProcessingStageContribution[], photo: Record<string, number>): Frame =>
      withRenderer({ stages: [...builtinStages(), ...lens], pipeline: OPEN_PROBE }, (r) => {
        r.setImage(FRINGES);
        r.setContributedParams(photo);
        r.setParams(identityParams({ processVersion: 1, ...EFFECTS_ON }));
        const f = r.readFloatFrame("pre-output", Infinity, { encoding: "perceptual" });
        if (!f) throw new Error("readFloatFrame returned null");
        return f;
      });
    const split = alwaysStages as ProcessingStageContribution[];
    const before = [distortionStage, vignetteStage, single] as ProcessingStageContribution[];
    const bag = (s: Record<string, number>) =>
      Object.fromEntries(Object.entries(s).map(([k, v]) => [`${STAGE.defringe}.${k}`, v]));
    const idle = render(split, bag({ dfAmount: 0 }));
    for (const s of [{ dfAmount: 90 }, { dfAmount: 90, dfPurpleHue: 275, dfGreenHue: 120, dfRadius: 60 }]) {
      const now = render(split, bag(s));
      const was = render(before, bag(s));
      let changed = 0;
      let differ = 0;
      for (let i = 0; i < now.data.length; i++) {
        if (now.data[i] !== idle.data[i]) changed++;
        if (now.data[i] !== was.data[i]) differ++;
      }
      console.log(`[lc-gpu] v1 defringe ${JSON.stringify(s)}: ${changed} values changed, ${differ} differ from the single stage`);
      expect(changed).toBeGreaterThan(W * H * 0.1);
      expect(differ).toBe(0);
    }
  });
});
