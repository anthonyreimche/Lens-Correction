import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, CatalogStoreState, DevelopStoreState, SafelightAPI, StoreApi } from "./types/safelight";
import type { LensfunLens } from "./db/types";
import { disposeController, getUIStore, initController, pickLens, recompute, type LensUIState } from "./controller";

const { db } = vi.hoisted(() => {
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
];

describe("remembered lens picks", () => {
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
