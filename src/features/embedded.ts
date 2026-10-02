// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Embedded RAW corrections, read side. The import hook (parse-embedded.ts)
// parses the file's baked-in correction data where the directory handle is
// available and caches a per-photo ResolvedProfile in IndexedDB keyed by photo
// id; this reads it back at develop time.

import type { SafelightAPI } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { idbGet } from "../storage";

const CACHE_VERSION = 2;

interface EmbeddedCacheEntry {
  version: typeof CACHE_VERSION;
  profile: ResolvedProfile;
}

export function toEmbeddedCache(profile: ResolvedProfile): EmbeddedCacheEntry {
  return { version: CACHE_VERSION, profile };
}

/** A cached profile, or null if the entry is unreadable. Entries cached before
 *  the version field hold the profile itself, with poly5 distortion stored as
 *  [k2, k1]. The import hook never rewrites a cached photo, so they are
 *  reordered on read. */
export function fromEmbeddedCache(raw: unknown): ResolvedProfile | null {
  if (!raw || typeof raw !== "object") return null;
  if ("version" in raw) return raw.version === CACHE_VERSION ? (raw as EmbeddedCacheEntry).profile : null;
  const legacy = raw as ResolvedProfile;
  const d = legacy.distortion;
  if (d?.model !== "poly5") return legacy;
  return { ...legacy, distortion: { model: "poly5", k: [d.k[1] ?? 0, d.k[0] ?? 0] } };
}

export async function resolveEmbedded(
  _api: SafelightAPI,
  photoId: string,
): Promise<ResolvedProfile | null> {
  if (!photoId) return null;
  const profile = fromEmbeddedCache(await idbGet<unknown>("embedded", photoId));
  return profile && { ...profile, source: "embedded" };
}
