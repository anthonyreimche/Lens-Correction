// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The Lensfun lens database is bundled directly into the extension build, so it
// works whichever way the extension is loaded — installed (served from the
// app:// origin) or live from a dev folder (imported from a blob: URL, where a
// sibling fetch via import.meta.url is impossible). The lens data remains
// CC BY-SA 3.0 (see NOTICE); only the surrounding code is MIT.

import type { LensfunLens } from "./types";
import lensDbJson from "../../data/lens-profiles.json";

const db = lensDbJson as LensfunLens[];

/** Async for source compatibility; the database is resident from module load. */
export function loadLensDb(): Promise<LensfunLens[]> {
  return Promise.resolve(db);
}

/** Synchronous access to the database. */
export function getCachedLensDb(): LensfunLens[] | null {
  return db;
}

/** Look up a lens by its Lensfun id (for a remembered or manually-picked choice). */
export function findLensById(id: string): LensfunLens | null {
  return db.find((l) => l.id === id) ?? null;
}
