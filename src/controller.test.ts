import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, CatalogStoreState, DevelopStoreState, SafelightAPI, StoreApi } from "./types/safelight";
import type { LensfunLens } from "./db/types";
import {
  disposeController,
  getUIStore,
  importLensProfile,
  initController,
  pickLens,
  recompute,
  removeImport,
  type LensUIState,
} from "./controller";

const { db, customLens } = vi.hoisted(() => {
  const lens = (id: string, maker: string, model: string, over: Partial<LensfunLens> = {}): LensfunLens => ({
    id,
    maker,
    model,
    mounts: [],
    cropFactor: 1,
    type: "rectilinear",
    focalMin: 50,
    focalMax: 50,
    apertureMin: 1.8,
    apertureMax: 16,
    distortion: [{ focal: 50, model: "poly3", k: [0.01] }],
    tca: [],
    vignetting: [],
    ...over,
  });
  const compactZoom = { focalMin: 8.8, focalMax: 36.8, cropFactor: 2.7 };
  return {
    customLens: lens("custom99", "Sony", "E 99mm F1.0 Custom", { mounts: ["Sony E"] }),
    db: [
      lens("g7x", "Canon", "Canon PowerShot G7 X & compatibles", {
        ...compactZoom,
        cameras: [{ maker: "Canon", model: "Canon PowerShot G7 X" }],
      }),
      lens("g5x", "Canon", "Canon PowerShot G5 X & compatibles", {
        ...compactZoom,
        cameras: [{ maker: "Canon", model: "Canon PowerShot G5 X" }],
      }),
      lens("ef50", "Canon", "EF 50mm f/1.8 STM"),
      lens("sigma50", "Sigma", "50mm F1.4 DG HSM | A"),
    ],
  };
});

vi.mock("./db/loader", () => ({
  loadLensDb: () => Promise.resolve(db),
  getCachedLensDb: () => db,
  findLensById: (id: string) => db.find((l) => l.id === id) ?? null,
  importLensfunXml: () => {
    db.push(customLens);
    return Promise.resolve({ lenses: [customLens], skipped: 0 });
  },
  importedLensFiles: () => Promise.resolve(db.includes(customLens) ? [{ key: "mine.xml", name: "mine.xml", count: 1 }] : []),
  removeLensfunXml: () => {
    if (db.includes(customLens)) db.splice(db.indexOf(customLens), 1);
    return Promise.resolve();
  },
}));

vi.mock("./features/embedded", () => ({
  resolveEmbedded: (_api: unknown, photoId: string) =>
    Promise.resolve(
      photoId === "dng-1"
        ? { lensId: "embedded", lensName: "Embedded", source: "embedded", distortion: null, tca: null, vignetting: null }
        : null,
    ),
}));

function store<T>(initial: T): StoreApi<T> {
  let state = initial;
  const listeners = new Set<(state: T, prev: T) => void>();
  return Object.assign(() => state, {
    getState: () => state,
    setState(patch: Partial<T>) {
      const prev = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, prev);
    },
    subscribe(listener: (state: T, prev: T) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
}

const photos: CatalogPhoto[] = [
  { id: "g7x-1", exif: { cameraMake: "Canon", cameraModel: "Canon PowerShot G7 X", lens: "8.8-36.8 mm" } },
  { id: "g7x-2", exif: { cameraMake: "Canon", cameraModel: "Canon PowerShot G7 X", lens: "8.8-36.8 mm" } },
  { id: "g5x-1", exif: { cameraMake: "Canon", cameraModel: "Canon PowerShot G5 X", lens: "8.8-36.8 mm" } },
  { id: "r5-1", exif: { cameraMake: "Canon", cameraModel: "Canon EOS R5", lens: "EF 50mm f/1.8 STM" } },
  { id: "dng-1", exif: { cameraMake: "Canon", cameraModel: "Canon EOS R5", lens: "EF 50mm f/1.8 STM" } },
  { id: "a7-1", exif: { cameraMake: "Sony", cameraModel: "ILCE-7M3", lens: "E 99mm F1.0 Custom", focalLength: 50 } },
];

let settings: Map<string, unknown>;
let develop: StoreApi<DevelopStoreState>;

const open = async (photoId: string) => {
  develop.setState({ photoId, paramBag: {} });
  await recompute();
};
const appliedLensId = () => (getUIStore().getState() as LensUIState).profile?.lensId;

beforeEach(() => {
  settings = new Map();
  develop = store<DevelopStoreState>({
    photoId: null,
    params: {},
    paramBag: {},
    setParam: () => {},
    setDynParam: (key, value) => develop.setState({ paramBag: { ...develop.getState().paramBag, [key]: value } }),
    setDynParams: () => {},
    commitEdit: () => {},
  });
  const api = {
    settings: {
      get: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
      set: (key: string, value: unknown) => void settings.set(key, value),
      onChange: () => () => {},
    },
    stores: {
      useDevelopStore: develop,
      useCatalogStore: store<CatalogStoreState>({ photos }),
      create: <T>(init: () => T) => store(init()),
    },
    registerProcessingStage: () => {},
    unregisterProcessingStage: () => {},
  };
  initController(api as unknown as SafelightAPI);
});

afterEach(() => disposeController());

describe("remembered lens picks", () => {
  it("remembers a pick on a fixed-lens body under the body", async () => {
    await open("g7x-1");
    pickLens("sigma50", "Sigma 50mm F1.4 DG HSM | A");
    expect(settings.get("rememberedLenses")).toEqual({ "camera:canon|powershotg7x": "sigma50" });
  });

  it("applies it to later photos from the same body", async () => {
    await open("g7x-1");
    pickLens("sigma50", "Sigma 50mm F1.4 DG HSM | A");
    await open("g7x-2");
    expect(appliedLensId()).toBe("sigma50");
  });

  it("does not carry it to another body that writes the same lens string", async () => {
    await open("g7x-1");
    pickLens("sigma50", "Sigma 50mm F1.4 DG HSM | A");
    await open("g5x-1");
    expect(appliedLensId()).toBe("g5x");
  });

  it("keys a pick on an interchangeable lens by the EXIF lens string", async () => {
    await open("r5-1");
    pickLens("sigma50", "Sigma 50mm F1.4 DG HSM | A");
    expect(settings.get("rememberedLenses")).toEqual({ "EF 50mm f/1.8 STM": "sigma50" });
  });

  it("still applies picks saved under an interchangeable lens string", async () => {
    settings.set("rememberedLenses", { "EF 50mm f/1.8 STM": "sigma50" });
    await open("r5-1");
    expect(appliedLensId()).toBe("sigma50");
  });
});

describe("importing a Lensfun file", () => {
  afterEach(() => void (db.includes(customLens) && db.splice(db.indexOf(customLens), 1)));

  it("applies an imported lens to the open photo", async () => {
    await open("a7-1");
    await importLensProfile(new File(["<lensdatabase/>"], "mine.xml"));
    expect(appliedLensId()).toBe("custom99");
    expect((getUIStore().getState() as LensUIState).status).toBe("Imported 1 lens from mine.xml.");
  });

  it("lists the file among the imports", async () => {
    await open("a7-1");
    await importLensProfile(new File(["<lensdatabase/>"], "mine.xml"));
    expect((getUIStore().getState() as LensUIState).imports).toEqual([{ kind: "xml", key: "mine.xml", label: "mine.xml (1 lens)" }]);
  });

  it("re-resolves the open photo when the file is removed", async () => {
    await open("a7-1");
    await importLensProfile(new File(["<lensdatabase/>"], "mine.xml"));
    await removeImport({ kind: "xml", key: "mine.xml", label: "mine.xml (1 lens)" });
    expect(appliedLensId()).not.toBe("custom99");
    expect((getUIStore().getState() as LensUIState).imports).toEqual([]);
  });
});

describe("embedded corrections setting", () => {
  const source = () => (getUIStore().getState() as LensUIState).source;

  it("applies a photo's embedded correction when on", async () => {
    await open("dng-1");
    expect(source()).toBe("embedded");
  });

  it("falls back to Lensfun when off", async () => {
    settings.set("embeddedCorrections", false);
    await open("dng-1");
    expect(appliedLensId()).toBe("ef50");
  });

  it("re-resolves the open photo when it changes", async () => {
    await open("dng-1");
    settings.set("embeddedCorrections", false);
    await recompute();
    expect(appliedLensId()).toBe("ef50");
  });
});
