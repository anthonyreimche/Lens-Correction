import { describe, it, expect, vi } from "vitest";
import type { ResolvedProfile } from "../db/types";
import type { SafelightAPI } from "../types/safelight";
import { fromEmbeddedCache, resolveEmbedded, toEmbeddedCache } from "./embedded";

const storage = vi.hoisted(() => ({ idbGet: vi.fn(async (_store: string, _key: string): Promise<unknown> => null) }));

vi.mock("../storage", () => storage);

const profile: ResolvedProfile = {
  lensId: "embedded:raf:FUJIFILM:GFX100RF",
  lensName: "GFX100RF",
  source: "embedded",
  distortion: { model: "poly5", k: [-0.11, 0.02] },
  tca: null,
  vignetting: { k: [-0.3, 0.05, -0.01] },
};

// Releases before the cache was versioned stored the profile bare, with poly5
// distortion as [r⁴, r²].
const legacy = { ...profile, distortion: { model: "poly5", k: [0.02, -0.11] } };

describe("embedded profile cache", () => {
  it("reads back what it writes", () => {
    expect(fromEmbeddedCache(toEmbeddedCache(profile))).toEqual(profile);
  });

  it("reorders the poly5 distortion of an unversioned entry", () => {
    expect(fromEmbeddedCache(legacy)).toEqual(profile);
  });

  it("keeps an unversioned entry without poly5 distortion as it is", () => {
    const vignetteOnly = { ...profile, distortion: null };
    expect(fromEmbeddedCache(vignetteOnly)).toEqual(vignetteOnly);
  });

  it("ignores entries it can't read", () => {
    expect(fromEmbeddedCache(null)).toBeNull();
    expect(fromEmbeddedCache("profile")).toBeNull();
    expect(fromEmbeddedCache({ version: 99, profile })).toBeNull();
  });

  it("resolves a photo's unversioned entry with the reordered distortion", async () => {
    storage.idbGet.mockResolvedValueOnce(legacy);
    expect(await resolveEmbedded({} as SafelightAPI, "gfx")).toEqual(profile);
    expect(storage.idbGet).toHaveBeenCalledWith("embedded", "gfx");
  });
});
