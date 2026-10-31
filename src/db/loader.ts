// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The Lensfun lens database is bundled directly into the extension build, so it
// works whichever way the extension is loaded — installed (served from the
// app:// origin) or live from a dev folder (imported from a blob: URL, where a
// sibling fetch via import.meta.url is impossible). The lens data remains
// CC BY-SA 3.0 (see NOTICE); only the surrounding code is MIT.
//
// Lensfun XML files the user imports are kept in IndexedDB and laid over the
// bundled database: their lenses are added, or recalibrate a bundled lens.

import type { LensfunLens } from "./types";
import lensDbJson from "../../data/lens-profiles.json";
import { buildLensDatabase, lensKey, mergeLenses } from "./lensfun-xml.mjs";
import { idbDelete, idbEntries, idbGetAll, idbSet } from "../storage";

interface ImportedLensFile {
  name: string;
  lenses: LensfunLens[];
}

const bundled = lensDbJson as LensfunLens[];
let db = bundled;
let loading: Promise<LensfunLens[]> | null = null;

/** The database with imported lenses laid over the bundled ones. */
export function loadLensDb(): Promise<LensfunLens[]> {
  loading ??= idbGetAll<ImportedLensFile>("lensfun").then((files) => {
    db = mergeLenses(bundled, files.flatMap((f) => f.lenses));
    return db;
  });
  return loading;
}

/** Synchronous access to the database; the bundled lenses until imports load. */
export function getCachedLensDb(): LensfunLens[] | null {
  return db;
}

/** Look up a lens by its Lensfun id (for a remembered or manually-picked choice). */
export function findLensById(id: string): LensfunLens | null {
  return db.find((l) => l.id === id) ?? null;
}

/** Import a Lensfun XML file, replacing an earlier import of the same name.
 *  Returns its lenses as they now sit in the database (none when the file holds
 *  no calibrated lens) and how many it skipped for want of a calibration this
 *  reads. */
export async function importLensfunXml(
  fileName: string,
  xml: string,
): Promise<{ lenses: LensfunLens[]; skipped: number }> {
  const { lenses, skipped } = buildLensDatabase([xml]);
  if (lenses.length === 0) return { lenses: [], skipped };
  await idbSet("lensfun", fileName.toLowerCase(), { name: fileName, lenses } satisfies ImportedLensFile);
  const imported = new Set(lenses.map(lensKey));
  return { lenses: (await reload()).filter((l) => imported.has(lensKey(l))), skipped };
}

export interface ImportedLensFileInfo {
  key: string;
  name: string;
  count: number;
}

export async function importedLensFiles(): Promise<ImportedLensFileInfo[]> {
  const files = await idbEntries<ImportedLensFile>("lensfun");
  return files.map(([key, f]) => ({ key, name: f.name, count: f.lenses.length }));
}

/** Remove an imported file; a built-in lens it recalibrated gets its own back. */
export async function removeLensfunXml(key: string): Promise<void> {
  await idbDelete("lensfun", key);
  await reload();
}

function reload(): Promise<LensfunLens[]> {
  loading = null;
  return loadLensDb();
}
