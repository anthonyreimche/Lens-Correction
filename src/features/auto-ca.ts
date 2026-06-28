// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Estimate lateral chromatic aberration directly from the image: capture the
// current frame, find strong green-channel edges, and search for the global
// per-channel radial scale (the linear TCA model) that best aligns the red and
// blue channels to green. No lens profile required.

import type { SafelightAPI } from "../types/safelight";

const MAX_DIM = 1024; // analysis resolution cap
const SCALES = 21; // candidate scales per channel
const RANGE = 0.004; // ±0.4% radial scale search

interface Plane {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  w: number;
  h: number;
}

async function capturePlanes(api: SafelightAPI): Promise<Plane | null> {
  let bmp: ImageBitmap;
  try {
    const params = api.stores.useDevelopStore.getState().params;
    bmp = await api.develop.captureFrame(params);
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(2, Math.round(bmp.width * scale));
  const h = Math.max(2, Math.round(bmp.height * scale));
  let data: Uint8ClampedArray;
  try {
    const cnv = new OffscreenCanvas(w, h);
    const cx = cnv.getContext("2d");
    if (!cx) return null;
    cx.drawImage(bmp, 0, 0, w, h);
    data = cx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  } finally {
    bmp.close?.();
  }
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = data[i * 4] / 255;
    g[i] = data[i * 4 + 1] / 255;
    b[i] = data[i * 4 + 2] / 255;
  }
  return { r, g, b, w, h };
}

function bilinear(ch: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = ch[y0 * w + x0];
  const bb = ch[y0 * w + x1];
  const c = ch[y1 * w + x0];
  const d = ch[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + bb * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Indices of the strongest green edges (a capped sample). */
function edgePixels(p: Plane): number[] {
  const { g, w, h } = p;
  const grad: { i: number; m: number }[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1];
      const gy = g[i + w] - g[i - w];
      const m = gx * gx + gy * gy;
      if (m > 0.01) grad.push({ i, m });
    }
  }
  grad.sort((a, b) => b.m - a.m);
  return grad.slice(0, 20000).map((e) => e.i);
}

/** Cost: mean squared (channel(scaled) − green) over the edge set. */
function costForScale(p: Plane, ch: Float32Array, edges: number[], s: number): number {
  const { g, w, h } = p;
  const cx = w / 2;
  const cy = h / 2;
  let sum = 0;
  for (const i of edges) {
    const x = i % w;
    const y = (i - x) / w;
    const sx = cx + (x - cx) * s;
    const sy = cy + (y - cy) * s;
    const diff = bilinear(ch, w, h, sx, sy) - g[i];
    sum += diff * diff;
  }
  return sum / Math.max(1, edges.length);
}

function bestScale(p: Plane, ch: Float32Array, edges: number[]): number {
  let best = 1;
  let bestCost = Infinity;
  for (let k = 0; k < SCALES; k++) {
    const s = 1 - RANGE + (2 * RANGE * k) / (SCALES - 1);
    const cost = costForScale(p, ch, edges, s);
    if (cost < bestCost) {
      bestCost = cost;
      best = s;
    }
  }
  return best;
}

export interface AutoCaResult {
  r: number;
  b: number;
}

/** Estimate per-channel radial scales, or null if the frame is unusable. */
export async function estimateAutoCa(api: SafelightAPI): Promise<AutoCaResult | null> {
  const p = await capturePlanes(api);
  if (!p) return null;
  const edges = edgePixels(p);
  if (edges.length < 200) return null; // too flat to estimate reliably
  return { r: bestScale(p, p.r, edges), b: bestScale(p, p.b, edges) };
}
