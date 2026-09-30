// Lens Correction for Safelight — MIT licensed (see LICENSE).
// What the manual lens picker lists: search, maker groups and row labels.

import type { LensfunCamera, LensfunLens } from "../db/types";
import { canonicalMaker, lensDisplayName, lensMaker } from "../db/makers";

export interface PickerRow {
  lens: LensfunLens;
  /** Muted text after the name: bodies, focal range, and the crop factor when
   *  another listed row has the same name. Empty when there is nothing to add. */
  detail: string;
}

export interface PickerGroup {
  maker: string;
  rows: PickerRow[];
}

/** Lenses whose makers, model or bodies contain every word of the query. */
export function filterLenses(db: LensfunLens[], query: string, limit = 60): LensfunLens[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return db.slice(0, limit);
  return db
    .filter((lens) => {
      const text = searchText(lens);
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, limit);
}

export function groupLenses(lenses: LensfunLens[]): PickerGroup[] {
  const nameCounts = new Map<string, number>();
  for (const lens of lenses) {
    const name = lensDisplayName(lens);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const groups = new Map<string, PickerRow[]>();
  for (const lens of lenses) {
    const maker = lensMaker(lens);
    const sharesName = (nameCounts.get(lensDisplayName(lens)) ?? 0) > 1;
    const rows = groups.get(maker) ?? [];
    rows.push({ lens, detail: rowDetail(lens, sharesName) });
    groups.set(maker, rows);
  }
  return [...groups].map(([maker, rows]) => ({ maker, rows }));
}

function searchText(lens: LensfunLens): string {
  const names = [lens.maker, canonicalMaker(lens.maker), lens.model];
  for (const cam of lens.cameras ?? []) names.push(cam.maker, canonicalMaker(cam.maker), cam.model);
  return names.join(" ").toLowerCase();
}

function rowDetail(lens: LensfunLens, sharesName: boolean): string {
  const parts: string[] = [];
  if (lens.cameras?.length) parts.push(bodies(lens.cameras));
  if (lens.focalMin > 0) parts.push(focalRange(lens));
  if (sharesName) parts.push(`×${Number(lens.cropFactor.toFixed(2))}`);
  return parts.join(" · ");
}

function bodies(cameras: LensfunCamera[]): string {
  const named = cameras
    .slice(0, 2)
    .map((cam) => cam.model)
    .join(", ");
  return cameras.length > 2 ? `${named} +${cameras.length - 2}` : named;
}

function focalRange(lens: LensfunLens): string {
  return lens.focalMin === lens.focalMax ? `${lens.focalMin}mm` : `${lens.focalMin}-${lens.focalMax}mm`;
}
