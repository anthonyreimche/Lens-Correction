// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Embedded RAW corrections, read side. The import hook (parse-embedded.ts)
// parses the file's baked-in correction data where the directory handle is
// available and caches a per-photo ResolvedProfile in IndexedDB keyed by photo
// id; this reads it back at develop time.

import type { SafelightAPI } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { idbGet } from "../storage";

export async function resolveEmbedded(
  _api: SafelightAPI,
  photoId: string,
): Promise<ResolvedProfile | null> {
  if (!photoId) return null;
  const obj = await idbGet<ResolvedProfile>("embedded", photoId);
  if (!obj || typeof obj !== "object") return null;
  return { ...obj, source: "embedded" };
}
