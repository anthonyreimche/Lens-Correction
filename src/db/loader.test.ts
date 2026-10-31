import { describe, it, expect, vi, beforeEach } from "vitest";

const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));

vi.mock("../storage", () => ({
  idbGetAll: () => Promise.resolve([...stored.values()]),
  idbEntries: () => Promise.resolve([...stored.entries()]),
  idbSet: (_store: string, key: string, value: unknown) => {
    stored.set(key, value);
    return Promise.resolve();
  },
  idbDelete: (_store: string, key: string) => {
    stored.delete(key);
    return Promise.resolve();
  },
}));

const lensXml = (model: string, k1: string, quote = '"') => {
  const q = (v: string) => `${quote}${v}${quote}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<lensdatabase version="2">
    <lens>
        <maker>Sony</maker>
        <model>${model}</model>
        <mount>Sony E</mount>
        <cropfactor>1.534</cropfactor>
        <calibration>
            <distortion model=${q("poly3")} focal=${q("16")} k1=${q(k1)}/>
        </calibration>
    </lens>
</lensdatabase>`;
};

// A fresh module per test, as after an app restart; `stored` plays IndexedDB.
async function freshLoader() {
  vi.resetModules();
  return import("./loader");
}

describe("imported Lensfun files", () => {
  beforeEach(() => stored.clear());

  it("adds a new lens to the database", async () => {
    const loader = await freshLoader();
    const [lens] = (await loader.importLensfunXml("mil-sony.xml", lensXml("E 99mm f/1.0 Custom", "0.01"))).lenses;
    expect(loader.findLensById(lens.id)?.model).toBe("E 99mm f/1.0 Custom");
    expect(loader.getCachedLensDb()).toContainEqual(expect.objectContaining({ model: "E 99mm f/1.0 Custom" }));
  });

  it("replaces a built-in lens's calibration under the built-in id", async () => {
    const loader = await freshLoader();
    const builtIn = (await loader.loadLensDb()).find((l) => l.model === "E 16mm f/2.8" && l.cropFactor === 1.534)!;
    const [lens] = (await loader.importLensfunXml("mine.xml", lensXml("E 16mm f/2.8", "0.042"))).lenses;
    expect(lens.id).toBe(builtIn.id);
    expect(loader.findLensById(builtIn.id)?.distortion).toEqual([{ focal: 16, model: "poly3", k: [0.042] }]);
  });

  it("reads single-quoted attributes", async () => {
    const loader = await freshLoader();
    const { lenses } = await loader.importLensfunXml("mine.xml", lensXml("E 99mm f/1.0 Custom", "0.01", "'"));
    expect(lenses).toHaveLength(1);
  });

  it("keeps imported lenses across a restart", async () => {
    await (await freshLoader()).importLensfunXml("mine.xml", lensXml("E 99mm f/1.0 Custom", "0.01"));
    const loader = await freshLoader();
    const db = await loader.loadLensDb();
    expect(db.some((l) => l.model === "E 99mm f/1.0 Custom")).toBe(true);
  });

  it("replaces the lenses of a re-imported file of the same name", async () => {
    const loader = await freshLoader();
    await loader.importLensfunXml("mine.xml", lensXml("E 99mm f/1.0 Custom", "0.01"));
    await loader.importLensfunXml("mine.xml", lensXml("E 98mm f/1.0 Custom", "0.01"));
    const models = (await loader.loadLensDb()).map((l) => l.model);
    expect(models).toContain("E 98mm f/1.0 Custom");
    expect(models).not.toContain("E 99mm f/1.0 Custom");
  });

  it("imports nothing from a file without calibrated lenses", async () => {
    const loader = await freshLoader();
    expect(await loader.importLensfunXml("empty.xml", "<lensdatabase/>")).toEqual({ lenses: [], skipped: 0 });
    expect(stored.size).toBe(0);
  });
});

describe("managing imported Lensfun files", () => {
  beforeEach(() => stored.clear());

  it("lists each imported file with its lens count", async () => {
    const loader = await freshLoader();
    await loader.importLensfunXml("Mine.xml", lensXml("E 99mm f/1.0 Custom", "0.01"));
    expect(await loader.importedLensFiles()).toEqual([{ key: "mine.xml", name: "Mine.xml", count: 1 }]);
  });

  it("removes a file's lenses and restores the built-in calibration it replaced", async () => {
    const loader = await freshLoader();
    const builtIn = (await loader.loadLensDb()).find((l) => l.model === "E 16mm f/2.8" && l.cropFactor === 1.534)!;
    await loader.importLensfunXml("mine.xml", lensXml("E 16mm f/2.8", "0.042"));
    await loader.importLensfunXml("other.xml", lensXml("E 99mm f/1.0 Custom", "0.01"));
    await loader.removeLensfunXml("mine.xml");
    expect(loader.findLensById(builtIn.id)?.distortion).toEqual(builtIn.distortion);
    expect(loader.getCachedLensDb()!.some((l) => l.model === "E 99mm f/1.0 Custom")).toBe(true);
  });
});
