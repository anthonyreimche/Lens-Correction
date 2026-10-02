// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Import-time parsing of embedded RAW lens corrections.
//
// DNG files carry the standardized DNG OpcodeList3 (tag 0xC74E):
// WarpRectilinear (radial distortion) and FixVignetteRadial (vignette). The
// opcode blob is always big-endian regardless of the TIFF byte order.
//
// Fujifilm RAF files carry distortion, vignetting and lateral CA tables in a
// Fujifilm sub-IFD at the start of the CFA section (see parse-raf.ts). Only the
// header and that metadata window are read, never the whole file.
//
// Other proprietary RAWs (Sony ARW / Panasonic RW2, …) keep their correction
// data in maker notes instead — a documented next increment.

import type { SafelightAPI, CatalogHooksContribution, CatalogPhoto } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { EXT_ID } from "../params";
import type { AdobeProfile } from "./adobe-model";
import { adobeToResolved } from "./adobe-model";
import { idbSet, idbHas } from "../storage";
import { ifdEntries, nextIfd, readTiffHeader } from "./tiff";
import {
  RAF_HEADER_BYTES,
  parseRafTables,
  rafMetadataRange,
  rafToResolved,
  type RafTables,
} from "./parse-raf";

// ─── DNG opcode parsing (pure, unit-tested) ─────────────────────────────────

export interface EmbeddedCorrections {
  distortion?: { k1: number; k2: number; k3: number };
  vignette?: { a1: number; a2: number; a3: number };
}

/** Locate the OpcodeList3 blob (tag 0xC74E) anywhere in IFD0's chain or SubIFDs. */
export function findOpcodeList3(buf: ArrayBuffer): DataView | null {
  const dv = new DataView(buf);
  const tiff = readTiffHeader(dv);
  if (!tiff) return null;
  const { le } = tiff;

  const visited = new Set<number>();
  const ifds: number[] = [];
  let off = tiff.ifd0;
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

async function readDngProfile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  photo: CatalogPhoto,
): Promise<ResolvedProfile | null> {
  const buf = await readFileBytes(dir, fileName);
  if (!buf) return null;
  const blob = findOpcodeList3(buf);
  if (!blob) return null;
  const corrections = parseOpcodeList(blob);
  if (!corrections.distortion && !corrections.vignette) return null;

  const profile = buildEmbeddedProfile(photo, corrections);
  return adobeToResolved(profile, Number(photo.exif?.focalLength ?? 0), photoAspect(photo), "embedded");
}

/** Read a RAF's correction tables from its header and the start of its CFA
 *  section only — never the whole (often 100 MB+) file. */
export async function readRafTables(file: Blob): Promise<RafTables | null> {
  const range = rafMetadataRange(await file.slice(0, RAF_HEADER_BYTES).arrayBuffer());
  if (!range) return null;
  return parseRafTables(await file.slice(range.start, range.end).arrayBuffer());
}

async function readRafProfile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  photo: CatalogPhoto,
): Promise<ResolvedProfile | null> {
  try {
    const file = await (await dir.getFileHandle(fileName)).getFile();
    const tables = await readRafTables(file);
    return tables && rafToResolved(tables, photo.exif ?? {});
  } catch {
    return null;
  }
}

export function embeddedCatalogHook(api: SafelightAPI): CatalogHooksContribution {
  return {
    id: `${EXT_ID}.embedded`,
    async onPhotoImport(ctx) {
      if (!api.settings.get("embeddedCorrections", true)) return;
      const raf = /\.raf$/i.test(ctx.fileName);
      if (!raf && !/\.dng$/i.test(ctx.fileName)) return;
      if (await idbHas("embedded", ctx.photo.id)) return; // already cached

      const resolved = raf
        ? await readRafProfile(ctx.dir, ctx.fileName, ctx.photo)
        : await readDngProfile(ctx.dir, ctx.fileName, ctx.photo);
      if (resolved) await idbSet("embedded", ctx.photo.id, resolved);
    },
  };
}
