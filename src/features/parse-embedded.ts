// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Import-time parsing of embedded RAW lens corrections.
//
// v1 covers DNG files via the standardized DNG OpcodeList3 (tag 0xC74E):
// WarpRectilinear (radial distortion) and FixVignetteRadial (vignette). The
// opcode blob is always big-endian regardless of the TIFF byte order. Coverage
// note: proprietary RAWs (Sony ARW / Fuji RAF / Panasonic RW2, …) carry their
// correction data in maker notes instead — a documented next increment; the
// `buildEmbeddedProfile` seam below is where those decoders plug in.

import type { SafelightAPI, CatalogHooksContribution, CatalogPhoto } from "../types/safelight";
import { EXT_ID } from "../params";
import type { AdobeProfile } from "./adobe-model";
import { adobeToResolved } from "./adobe-model";
import { idbSet, idbHas } from "../storage";

// ─── DNG opcode parsing (pure, unit-tested) ─────────────────────────────────

export interface EmbeddedCorrections {
  distortion?: { k1: number; k2: number; k3: number };
  vignette?: { a1: number; a2: number; a3: number };
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };

interface IfdEntry {
  type: number;
  count: number;
  /** Absolute byte offset of the value (inline values point at the entry). */
  valueOffset: number;
}

function ifdEntries(dv: DataView, ifdOff: number, le: boolean): Map<number, IfdEntry> {
  const map = new Map<number, IfdEntry>();
  if (ifdOff + 2 > dv.byteLength) return map;
  const n = dv.getUint16(ifdOff, le);
  for (let i = 0; i < n; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueOffset = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    map.set(tag, { type, count, valueOffset });
  }
  return map;
}

function nextIfd(dv: DataView, ifdOff: number, le: boolean): number {
  const n = dv.getUint16(ifdOff, le);
  const p = ifdOff + 2 + n * 12;
  return p + 4 <= dv.byteLength ? dv.getUint32(p, le) : 0;
}

/** Locate the OpcodeList3 blob (tag 0xC74E) anywhere in IFD0's chain or SubIFDs. */
export function findOpcodeList3(buf: ArrayBuffer): DataView | null {
  if (buf.byteLength < 8) return null;
  const dv = new DataView(buf);
  const bo = dv.getUint16(0, false);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return null;
  if (dv.getUint16(2, le) !== 42) return null;

  const visited = new Set<number>();
  const ifds: number[] = [];
  let off = dv.getUint32(4, le);
  while (off && !visited.has(off) && off + 2 <= buf.byteLength) {
    visited.add(off);
    ifds.push(off);
    off = nextIfd(dv, off, le);
  }

  // Expand SubIFDs (tag 0x014A) — DNG keeps the raw IFD (and its opcodes) here.
  const scan = [...ifds];
  for (const ifd of ifds) {
    const sub = ifdEntries(dv, ifd, le).get(0x014a);
    if (!sub) continue;
    for (let i = 0; i < sub.count; i++) {
      const o = dv.getUint32(sub.valueOffset + i * 4, le);
      if (!visited.has(o) && o + 2 <= buf.byteLength) {
        visited.add(o);
        scan.push(o);
      }
    }
  }

  for (const ifd of scan) {
    const e = ifdEntries(dv, ifd, le).get(0xc74e);
    if (e && e.valueOffset + e.count <= buf.byteLength && e.count > 8) {
      return new DataView(buf, e.valueOffset, e.count);
    }
  }
  return null;
}

/** Decode WarpRectilinear + FixVignetteRadial from an OpcodeList3 blob. The blob
 *  is big-endian: count, then [opcodeId, version, flags, byteCount, data…] each. */
export function parseOpcodeList(blob: DataView): EmbeddedCorrections {
  const out: EmbeddedCorrections = {};
  let p = 0;
  const u32 = () => {
    const v = blob.getUint32(p, false);
    p += 4;
    return v;
  };
  const f64 = (at: number) => blob.getFloat64(at, false);

  if (blob.byteLength < 4) return out;
  const count = u32();
  for (let i = 0; i < count && p + 16 <= blob.byteLength; i++) {
    const id = u32();
    u32(); // version
    u32(); // flags
    const bytes = u32();
    const dataStart = p;
    if (dataStart + bytes > blob.byteLength) break;

    if (id === 1) {
      // WarpRectilinear: uint32 N planes, then N×6 doubles (kr0..kr3, kt0, kt1),
      // then cx, cy. We take plane 0's radial terms.
      const n = blob.getUint32(dataStart, false);
      if (n >= 1 && dataStart + 4 + 6 * 8 <= blob.byteLength) {
        const base = dataStart + 4;
        const kr0 = f64(base);
        const kr1 = f64(base + 8);
        const kr2 = f64(base + 16);
        const kr3 = f64(base + 24);
        // Normalize out kr0 (≈1) so the model's implicit constant is 1.
        const s = kr0 !== 0 ? 1 / kr0 : 1;
        out.distortion = { k1: kr1 * s, k2: kr2 * s, k3: kr3 * s };
      }
    } else if (id === 3) {
      // FixVignetteRadial: k0..k4 (5 doubles) then cx, cy. gain = 1 + k0 r² + …
      if (dataStart + 5 * 8 <= blob.byteLength) {
        out.vignette = {
          a1: f64(dataStart),
          a2: f64(dataStart + 8),
          a3: f64(dataStart + 16),
        };
      }
    }
    p = dataStart + bytes;
  }
  return out;
}

// ─── Profile assembly ────────────────────────────────────────────────────────

function photoAspect(photo: CatalogPhoto): number {
  const w = typeof photo.width === "number" ? photo.width : 0;
  const h = typeof photo.height === "number" ? photo.height : 0;
  if (!w || !h) return 1.5;
  const o = (photo.exif?.orientation as number) ?? 1;
  const swap = o >= 5 && o <= 8;
  return (swap ? h : w) / (swap ? w : h) || 1.5;
}

/** Build an AdobeProfile from decoded embedded corrections (DNG-opcode radius
 *  convention ⇒ focalLengthX 0 ⇒ half-diagonal normalization). */
function buildEmbeddedProfile(photo: CatalogPhoto, c: EmbeddedCorrections): AdobeProfile {
  return {
    make: String(photo.exif?.cameraMake ?? ""),
    model: String(photo.exif?.cameraModel ?? ""),
    lens: String(photo.exif?.lens ?? "Embedded correction"),
    entries: [
      {
        focal: Number(photo.exif?.focalLength ?? 0),
        aperture: Number(photo.exif?.aperture ?? 0),
        focalLengthX: 0,
        distortion: c.distortion,
        vignette: c.vignette,
      },
    ],
  };
}

async function readFileBytes(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<ArrayBuffer | null> {
  try {
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

export function embeddedCatalogHook(api: SafelightAPI): CatalogHooksContribution {
  return {
    id: `${EXT_ID}.embedded`,
    async onPhotoImport(ctx) {
      if (!api.settings.get("embeddedCorrections", true)) return;
      // v1: DNG opcodes only. Other RAWs use maker notes (future).
      if (!/\.dng$/i.test(ctx.fileName)) return;
      if (await idbHas("embedded", ctx.photo.id)) return; // already cached

      const buf = await readFileBytes(ctx.dir, ctx.fileName);
      if (!buf) return;
      const blob = findOpcodeList3(buf);
      if (!blob) return;
      const corrections = parseOpcodeList(blob);
      if (!corrections.distortion && !corrections.vignette) return;

      const profile = buildEmbeddedProfile(ctx.photo, corrections);
      const resolved = adobeToResolved(
        profile,
        Number(ctx.photo.exif?.focalLength ?? 0),
        photoAspect(ctx.photo),
        "embedded",
      );
      if (resolved) await idbSet("embedded", ctx.photo.id, resolved);
    },
  };
}
