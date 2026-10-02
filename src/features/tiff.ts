// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Minimal TIFF IFD reading shared by the DNG and Fujifilm RAF parsers. Offsets
// are relative to the start of the buffer holding the TIFF header.

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };

export interface IfdEntry {
  type: number;
  count: number;
  /** Absolute byte offset of the value (inline values point at the entry). */
  valueOffset: number;
}

/** Byte order and IFD0 offset of a TIFF header, or null if it isn't one. */
export function readTiffHeader(dv: DataView): { le: boolean; ifd0: number } | null {
  if (dv.byteLength < 8) return null;
  const bo = dv.getUint16(0, false);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return null;
  if (dv.getUint16(2, le) !== 42) return null;
  return { le, ifd0: dv.getUint32(4, le) };
}

export function ifdEntries(dv: DataView, ifdOff: number, le: boolean): Map<number, IfdEntry> {
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

export function nextIfd(dv: DataView, ifdOff: number, le: boolean): number {
  const n = dv.getUint16(ifdOff, le);
  const p = ifdOff + 2 + n * 12;
  return p + 4 <= dv.byteLength ? dv.getUint32(p, le) : 0;
}
