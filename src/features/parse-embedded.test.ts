import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CatalogPhoto, SafelightAPI } from "../types/safelight";
import type { ResolvedProfile } from "../db/types";
import { embeddedCatalogHook } from "./parse-embedded";
import { RAF_META_BYTES } from "./parse-raf";
import { GFX100RF_META_RAF_BASE64 } from "./__fixtures__/gfx100rf-meta";

const storage = vi.hoisted(() => ({
  idbHas: vi.fn(async (_store: string, _key: string) => false),
  idbSet: vi.fn(async (_store: string, _key: string, _value: unknown) => {}),
}));

vi.mock("../storage", () => storage);

function fixtureBytes(): ArrayBuffer {
  return Uint8Array.from(atob(GFX100RF_META_RAF_BASE64), (c) => c.charCodeAt(0)).buffer;
}

function apiWith(enabled: boolean): SafelightAPI {
  return { settings: { get: () => enabled } } as unknown as SafelightAPI;
}

function dirWith(file: File) {
  const getFileHandle = vi.fn(async () => ({ getFile: async () => file }));
  return { getFileHandle, dir: { getFileHandle } as unknown as FileSystemDirectoryHandle };
}

const GFX_PHOTO: CatalogPhoto = {
  id: "gfx",
  exif: { cameraMake: "FUJIFILM", cameraModel: "GFX100RF", focalLength: 35 },
  width: 11648,
  height: 8736,
};

/** Minimal big-endian DNG whose OpcodeList3 holds one FixVignetteRadial. */
function dngWithVignette(k: [number, number, number]): ArrayBuffer {
  const opData = 7 * 8;
  const blobLen = 4 + 16 + opData;
  const blobOff = 8 + 2 + 12 + 4;
  const buf = new ArrayBuffer(blobOff + blobLen);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4d4d, false);
  dv.setUint16(2, 42, false);
  dv.setUint32(4, 8, false);
  dv.setUint16(8, 1, false);
  dv.setUint16(10, 0xc74e, false);
  dv.setUint16(12, 7, false);
  dv.setUint32(14, blobLen, false);
  dv.setUint32(18, blobOff, false);
  let p = blobOff;
  for (const v of [1, 3, 1, 0, opData]) {
    dv.setUint32(p, v, false);
    p += 4;
  }
  for (const v of [...k, 0, 0, 0.5, 0.5]) {
    dv.setFloat64(p, v, false);
    p += 8;
  }
  return buf;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.idbHas.mockResolvedValue(false);
});

describe("embeddedCatalogHook — Fujifilm RAF", () => {
  it("caches a profile read from the header and the start of the CFA section only", async () => {
    const file = new File([fixtureBytes()], "DSCF0001.RAF");
    const slice = vi.spyOn(file, "slice");
    const whole = vi.spyOn(file, "arrayBuffer");
    const { dir } = dirWith(file);

    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSCF0001.RAF" });

    expect(whole).not.toHaveBeenCalled();
    expect(slice.mock.calls).toEqual([
      [0, 148],
      [148, 148 + 1024],
    ]);
    expect(storage.idbSet).toHaveBeenCalledTimes(1);
    const [store, key, value] = storage.idbSet.mock.calls[0];
    expect(store).toBe("embedded");
    expect(key).toBe("gfx");
    const profile = value as ResolvedProfile;
    expect(profile.source).toBe("embedded");
    expect(profile.lensId).toBe("embedded:raf:FUJIFILM:GFX100RF");
    expect(profile.distortion?.model).toBe("poly5");
    expect(profile.tca?.model).toBe("poly3");
    expect(profile.vignetting?.k).toHaveLength(3);
  });

  it("bounds the CFA read on a full-size section", async () => {
    const bytes = fixtureBytes();
    new DataView(bytes).setUint32(104, 117035424, false);
    const file = new File([bytes], "DSCF0001.raf");
    const slice = vi.spyOn(file, "slice");
    const { dir } = dirWith(file);

    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSCF0001.raf" });

    expect(slice.mock.calls[1]).toEqual([148, 148 + RAF_META_BYTES]);
    expect(storage.idbSet).toHaveBeenCalledTimes(1);
  });

  it("does nothing when embedded corrections are turned off", async () => {
    const { dir, getFileHandle } = dirWith(new File([fixtureBytes()], "DSCF0001.RAF"));
    await embeddedCatalogHook(apiWith(false)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSCF0001.RAF" });
    expect(getFileHandle).not.toHaveBeenCalled();
    expect(storage.idbSet).not.toHaveBeenCalled();
  });

  it("does not re-read a photo that is already cached", async () => {
    storage.idbHas.mockResolvedValue(true);
    const { dir, getFileHandle } = dirWith(new File([fixtureBytes()], "DSCF0001.RAF"));
    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSCF0001.RAF" });
    expect(getFileHandle).not.toHaveBeenCalled();
  });

  it("caches nothing for a RAF without correction tables", async () => {
    const bytes = fixtureBytes();
    new Uint8Array(bytes).fill(0, 148);
    const { dir } = dirWith(new File([bytes], "DSCF0001.RAF"));
    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSCF0001.RAF" });
    expect(storage.idbSet).not.toHaveBeenCalled();
  });

  it("ignores other proprietary RAWs", async () => {
    const { dir, getFileHandle } = dirWith(new File([fixtureBytes()], "DSC0001.ARW"));
    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo: GFX_PHOTO, dir, fileName: "DSC0001.ARW" });
    expect(getFileHandle).not.toHaveBeenCalled();
  });
});

describe("embeddedCatalogHook — DNG", () => {
  it("still caches the OpcodeList3 vignette through the Adobe model", async () => {
    const photo: CatalogPhoto = {
      id: "dng",
      exif: { cameraMake: "Leica", cameraModel: "Q3", lens: "Summilux 28", focalLength: 28 },
      width: 6000,
      height: 4000,
    };
    const { dir } = dirWith(new File([dngWithVignette([-0.2, 0.05, 0.01])], "L1000001.DNG"));

    await embeddedCatalogHook(apiWith(true)).onPhotoImport!({ photo, dir, fileName: "L1000001.DNG" });

    expect(storage.idbSet).toHaveBeenCalledWith("embedded", "dng", {
      lensId: "embedded:Leica:Summilux 28",
      lensName: "Summilux 28",
      source: "embedded",
      distortion: null,
      tca: null,
      vignetting: { k: [-0.2, 0.05, 0.01] },
    });
  });
});
