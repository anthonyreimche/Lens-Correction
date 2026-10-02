// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Fujifilm RAF embedded lens corrections, decoded from the file's byte layout.
//
// A RAF opens with a 148-byte big-endian header ("FUJIFILMCCD-RAW ") whose
// uint32 pair at 100/104 locates the CFA section. That section starts with its
// own TIFF header (either byte order); IFD0's tag 0xF000 points at a Fujifilm
// sub-IFD, and every offset is relative to the CFA section start. Three
// SRATIONAL tables there describe the lens, each sampled at N radii:
//   0xF00B distortion   [scale][N radii][N displacements, percent]
//   0xF010 vignetting   [scale][N radii][N brightness, percent of centre]
//   0xF00F lateral CA   [scale][N radii][N ch-A][N ch-B][scale]  (fraction vs green)
// Radii are normalised so r = 1 at the visible frame's half-diagonal — exactly
// how the shader stages normalise `rr` — and scale·N is that half-diagonal in
// pixels. The tables are least-squares fitted onto the existing poly5 / radial /
// poly3 stage models rather than routed through the Adobe model, which would
// drop terms.

import type { ExifData } from "../types/safelight";
import type {
  ResolvedDistortion,
  ResolvedProfile,
  ResolvedTca,
  ResolvedVignetting,
} from "../db/types";
import { ifdEntries, readTiffHeader, type IfdEntry } from "./tiff";

export const RAF_HEADER_BYTES = 148;
/** How much of the CFA section to read: the sub-IFD and its tables sit at its
 *  start, ahead of the raw strip. */
export const RAF_META_BYTES = 64 * 1024;

const RAF_MAGIC = "FUJIFILMCCD-RAW ";
const CFA_POINTER_AT = 100;

const TAG_FUJI_IFD = 0xf000;
const TAG_DISTORTION = 0xf00b;
const TAG_CA = 0xf00f;
const TAG_VIGNETTING = 0xf010;
const TYPE_LONG = 4;
const TYPE_SRATIONAL = 10;
const TYPE_IFD = 13;

export interface ByteRange {
  start: number;
  end: number;
}

/** A correction sampled at normalised radii (r = 1 at the half-diagonal). */
export interface RafRadialTable {
  /** The half-diagonal in pixels, i.e. what r = 1 measures. */
  radiusPx: number;
  radii: number[];
  values: number[];
}

/** Lateral CA as two channels' fractional radial scale relative to green. */
export interface RafCaTable {
  radiusPx: number;
  radii: number[];
  channelA: number[];
  channelB: number[];
}

export interface RafTables {
  /** Radial displacement, percent. */
  distortion: RafRadialTable | null;
  /** Brightness, percent of the centre's. */
  vignetting: RafRadialTable | null;
  ca: RafCaTable | null;
}

// ─── Byte layout (pure, unit-tested) ─────────────────────────────────────────

/** File range to read for the corrections: the start of the CFA section,
 *  capped at RAF_META_BYTES. Null if the header isn't a RAF's. */
export function rafMetadataRange(header: ArrayBuffer): ByteRange | null {
  if (header.byteLength < CFA_POINTER_AT + 8) return null;
  const magic = String.fromCharCode(...new Uint8Array(header, 0, RAF_MAGIC.length));
  if (magic !== RAF_MAGIC) return null;
  const dv = new DataView(header);
  const start = dv.getUint32(CFA_POINTER_AT, false);
  const length = dv.getUint32(CFA_POINTER_AT + 4, false);
  if (!start || !length) return null;
  return { start, end: start + Math.min(length, RAF_META_BYTES) };
}

function readSRationals(dv: DataView, e: IfdEntry | undefined, le: boolean): number[] | null {
  if (!e || e.type !== TYPE_SRATIONAL || e.valueOffset + e.count * 8 > dv.byteLength) return null;
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const p = e.valueOffset + i * 8;
    const v = dv.getInt32(p, le) / dv.getInt32(p + 4, le);
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/** [scale][N radii][N values]. */
function radialTable(v: number[] | null): RafRadialTable | null {
  if (!v) return null;
  const n = Math.floor((v.length - 1) / 2);
  if (n < 1) return null;
  return { radiusPx: v[0] * n, radii: v.slice(1, 1 + n), values: v.slice(1 + n, 1 + 2 * n) };
}

/** [scale][N radii][N ch-A][N ch-B], optionally followed by one more scale
 *  (the GFX100RF's count includes it; those 8 bytes are also the start of its
 *  0xF010 table). */
function caTable(v: number[] | null): RafCaTable | null {
  if (!v) return null;
  const n = Math.floor((v.length - 1) / 3);
  if (n < 1) return null;
  return {
    radiusPx: v[0] * n,
    radii: v.slice(1, 1 + n),
    channelA: v.slice(1 + n, 1 + 2 * n),
    channelB: v.slice(1 + 2 * n, 1 + 3 * n),
  };
}

/** Decode the correction tables from the start of a RAF's CFA section. Null if
 *  it has no Fujifilm sub-IFD; a table that is missing or truncated is null. */
export function parseRafTables(cfa: ArrayBuffer): RafTables | null {
  const dv = new DataView(cfa);
  const tiff = readTiffHeader(dv);
  if (!tiff) return null;
  const ptr = ifdEntries(dv, tiff.ifd0, tiff.le).get(TAG_FUJI_IFD);
  if (!ptr || (ptr.type !== TYPE_IFD && ptr.type !== TYPE_LONG) || ptr.count !== 1) return null;
  if (ptr.valueOffset + 4 > cfa.byteLength) return null;
  const sub = ifdEntries(dv, dv.getUint32(ptr.valueOffset, tiff.le), tiff.le);
  const table = (tag: number) => readSRationals(dv, sub.get(tag), tiff.le);
  return {
    distortion: radialTable(table(TAG_DISTORTION)),
    vignetting: radialTable(table(TAG_VIGNETTING)),
    ca: caTable(table(TAG_CA)),
  };
}

// ─── Fitting ─────────────────────────────────────────────────────────────────

/** Least-squares coefficients c minimising Σᵢ (Σⱼ cⱼ·xᵢ^powers[j] − yᵢ)², or
 *  null when the points cannot determine them. */
export function fitPowers(
  x: readonly number[],
  y: readonly number[],
  powers: readonly number[],
): number[] | null {
  const m = powers.length;
  if (x.length < m) return null;
  // Normal equations [AᵀA | Aᵀy], solved by Gauss–Jordan with partial pivoting.
  const a = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  x.forEach((xi, i) => {
    const row = powers.map((p) => xi ** p);
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) a[r][c] += row[r] * row[c];
      a[r][m] += row[r] * y[i];
    }
  });
  const tolerance = 1e-12 * Math.max(...a.map((row, i) => Math.abs(row[i])));
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (!(Math.abs(a[pivot][col]) > tolerance)) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= m; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[m] / row[i]);
}

/** Drop trailing points that only repeat their predecessor's value (the tables
 *  clamp past the frame corner), keeping at least `keep` points. */
function trimClampedTail(radii: number[], values: number[], keep: number) {
  let n = Math.min(radii.length, values.length);
  while (n > keep && values[n - 1] === values[n - 2]) n--;
  return { radii: radii.slice(0, n), values: values.slice(0, n) };
}

// Assumed semantics: an output pixel at radius r samples the source at
// r·(1 + p(r)/100), so negative p is barrel. The poly5 stage samples at
// r·(1 + KB·r² + KA·r⁴), bound as k = [KA, KB].
const DISTORTION_POWERS = [2, 4];

function fitDistortion(t: RafRadialTable): ResolvedDistortion | null {
  const pts = trimClampedTail(t.radii, t.values, DISTORTION_POWERS.length);
  const c = fitPowers(pts.radii, pts.values.map((p) => p / 100), DISTORTION_POWERS);
  return c && { model: "poly5", k: [c[1], c[0]] };
}

// Assumed semantics: v(r) is the brightness in percent of the centre's, i.e.
// the attenuation the vignetting stage divides by, 1 + k1·r² + k2·r⁴ + k3·r⁶.
const VIGNETTING_POWERS = [2, 4, 6];

function fitVignetting(t: RafRadialTable): ResolvedVignetting | null {
  const pts = trimClampedTail(t.radii, t.values, VIGNETTING_POWERS.length);
  const c = fitPowers(pts.radii, pts.values.map((v) => v / 100 - 1), VIGNETTING_POWERS);
  return c && { k: [c[0], c[1], c[2]] };
}

// Assumed semantics: a channel at radius r is sampled at r·(1 + c(r)). The
// poly3 CA prepass samples at r·(b·r² + c·r + v), bound per channel as [b, c, v].
const CA_POWERS = [2, 1, 0];

/** UNVERIFIED: channel A is assumed to be red and channel B blue. If the in-app
 *  check shows the fringes doubling rather than cancelling, swap them here. */
function caRedBlue(t: RafCaTable): { red: number[]; blue: number[] } {
  return { red: t.channelA, blue: t.channelB };
}

function fitCaChannel(radii: number[], values: number[]): number[] | null {
  const pts = trimClampedTail(radii, values, CA_POWERS.length);
  return fitPowers(pts.radii, pts.values.map((c) => 1 + c), CA_POWERS);
}

function fitCa(t: RafCaTable): ResolvedTca | null {
  const { red, blue } = caRedBlue(t);
  const r = fitCaChannel(t.radii, red);
  const b = fitCaChannel(t.radii, blue);
  return r && b && { model: "poly3", k: [...r, ...b] };
}

/** Fit the decoded tables onto the shader models. No radius rescaling: core
 *  decodes RAFs to the visible frame the radii are normalised to. */
export function rafToResolved(tables: RafTables, exif: ExifData): ResolvedProfile | null {
  const distortion = tables.distortion && fitDistortion(tables.distortion);
  const vignetting = tables.vignetting && fitVignetting(tables.vignetting);
  const tca = tables.ca && fitCa(tables.ca);
  if (!distortion && !vignetting && !tca) return null;
  const make = String(exif.cameraMake ?? "");
  const model = String(exif.cameraModel ?? "");
  return {
    lensId: `embedded:raf:${make}:${model}`,
    lensName: String(exif.lens || model || "Embedded correction"),
    source: "embedded",
    distortion,
    tca,
    vignetting,
  };
}
