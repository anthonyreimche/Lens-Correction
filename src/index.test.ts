import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogStoreState, DevelopStoreState, PanelContribution, SafelightAPI, StoreApi } from "./types/safelight";
import { activate, deactivate } from "./index";

vi.mock("./db/loader", () => ({
  loadLensDb: () => Promise.resolve([]),
  getCachedLensDb: () => [],
  findLensById: () => null,
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

function fakeApi(panels: PanelContribution[]): SafelightAPI {
  const develop = store<DevelopStoreState>({
    photoId: null,
    params: {},
    paramBag: {},
    setParam: () => {},
    setDynParam: () => {},
    setDynParams: () => {},
    commitEdit: () => {},
  });
  const api = {
    react: { createElement: () => null },
    components: {},
    settings: { get: <T>(_key: string, fallback: T): T => fallback, set: () => {}, onChange: () => () => {} },
    stores: {
      useDevelopStore: develop,
      useCatalogStore: store<CatalogStoreState>({ photos: [] }),
      create: <T>(init: () => T) => store(init()),
    },
    registerSettings: () => {},
    registerPanel: (p: PanelContribution) => void panels.push(p),
    registerCatalogHooks: () => {},
    registerPresetImporter: () => {},
    registerProcessingStage: () => {},
    unregisterProcessingStage: () => {},
  };
  return api as unknown as SafelightAPI;
}

describe("activate", () => {
  afterEach(() => deactivate());

  // Distortion and CA run before mask coverage is known, so a mask's panel
  // writes only the two stages a mask can run again.
  it("offers a mask panel that owns the vignetting and defringe it writes", () => {
    const panels: PanelContribution[] = [];
    activate(fakeApi(panels));
    const mask = panels[0].mask;
    expect(typeof mask?.component).toBe("function");
    expect([...(mask?.owns ?? [])].sort()).toEqual(
      [
        "com.safelight.lens-correction.vignette.vigManual",
        "com.safelight.lens-correction.defringe.dfAmount",
        "com.safelight.lens-correction.defringe.dfPurpleHue",
        "com.safelight.lens-correction.defringe.dfGreenHue",
        "com.safelight.lens-correction.defringe.dfRadius",
      ].sort(),
    );
  });
});
