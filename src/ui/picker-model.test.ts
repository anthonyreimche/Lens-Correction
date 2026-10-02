import { describe, it, expect } from "vitest";
import { filterLenses, groupLenses } from "./picker-model";
import type { LensfunCamera, LensfunLens } from "../db/types";

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
  distortion: [],
  tca: [],
  vignetting: [],
  ...over,
});

const builtIn = (
  id: string,
  maker: string,
  model: string,
  cameras: LensfunCamera[],
  over: Partial<LensfunLens> = {},
): LensfunLens => lens(id, maker, model, { cameras, ...over });

const rx100 = builtIn(
  "rx100",
  "Carl Zeiss",
  "DSC-RX100 & compatibles",
  [
    { maker: "Sony", model: "DSC-RX100" },
    { maker: "Sony", model: "DSC-RX100M2" },
    { maker: "Sony", model: "DSC-RX100M3" },
  ],
  { focalMin: 10.4, focalMax: 37.1 },
);
const lx100 = builtIn("lx100", "Leica", "DMC-LX100 & compatibles", [{ maker: "Panasonic", model: "DMC-LX100" }], {
  focalMin: 10.9,
  focalMax: 34,
});
const lumia = builtIn("lumia", "Zeiss", "Standard", [{ maker: "Nokia", model: "Lumia 1520" }], {
  focalMin: 3.7,
  focalMax: 3.7,
});
const x100 = builtIn(
  "x100",
  "Fujifilm",
  "X100 & compatibles (Standard)",
  [
    { maker: "Fujifilm", model: "FinePix X100" },
    { maker: "Fujifilm", model: "X100F" },
  ],
  { focalMin: 23, focalMax: 23 },
);
const gfx = builtIn("gfx", "Fujifilm", "GFX100RF & compatibles (Standard)", [{ maker: "Fujifilm", model: "GFX100RF" }], {
  focalMin: 35,
  focalMax: 35,
});
const q2 = builtIn("q2", "LEICA CAMERA AG", "LEICA Q2 & compatibles", [{ maker: "Leica Camera AG", model: "Leica Q2" }], {
  focalMin: 28,
  focalMax: 28,
});
const summicron = lens("summicron", "Leica Camera AG", "Summicron-M 1:2/28 Asph.", { focalMin: 28, focalMax: 28 });
const elmar = lens("elmar", "Leica", "Elmar-M 1:3.8/24 Asph.", { focalMin: 24, focalMax: 24 });
const om = lens("om", "OM Digital Solutions", "OM 12-45mm F4.0", { focalMin: 12, focalMax: 45 });
const ef50 = lens("ef50", "Canon", "Canon EF 50mm f/1.8 STM");
const ef50aps = lens("ef50-aps", "Canon", "Canon EF 50mm f/1.8 STM", { cropFactor: 1.611 });
const ef85 = lens("ef85", "Canon", "Canon EF 85mm f/1.8 USM", { focalMin: 85, focalMax: 85 });

const ids = (lenses: LensfunLens[]) => lenses.map((l) => l.id);

describe("filterLenses", () => {
  const db = [rx100, lx100, lumia, x100, gfx, q2, summicron, elmar, om, ef50, ef50aps, ef85];

  it.each([
    ["sony rx100", ["rx100"]],
    ["X100F", ["x100"]],
    ["fujifilm gfx100rf", ["gfx"]],
    ["nokia", ["lumia"]],
  ])("finds a built-in lens by its body: %s", (query, expected) => {
    expect(ids(filterLenses(db, query))).toEqual(expected);
  });

  it("finds a lens by its maker's canonical name", () => {
    expect(ids(filterLenses(db, "olympus 12-45"))).toEqual(["om"]);
  });

  it("still finds a lens by the maker name Lensfun files it under", () => {
    expect(ids(filterLenses(db, "carl zeiss"))).toEqual(["rx100"]);
  });

  it("needs every word, in any order and any case", () => {
    expect(ids(filterLenses(db, "STM canon 50"))).toEqual(["ef50", "ef50-aps"]);
  });

  const many = Array.from({ length: 2000 }, (_, i) => lens(`l${i}`, "Canon", `Lens ${i}`));

  it("lists every lens for an empty query", () => {
    expect(ids(filterLenses(many, "  "))).toEqual(ids(many));
  });

  it("returns every match for a broad query", () => {
    expect(filterLenses(many, "canon")).toHaveLength(2000);
  });
});

describe("groupLenses", () => {
  const makers = (lenses: LensfunLens[]) => groupLenses(lenses).map((g) => g.maker);
  const details = (lenses: LensfunLens[]) => groupLenses(lenses).flatMap((g) => g.rows.map((r) => r.detail));

  it("merges the spellings of one maker into one group", () => {
    const groups = groupLenses([summicron, elmar, q2]);
    expect(groups.map((g) => g.maker)).toEqual(["Leica"]);
    expect(groups[0].rows.map((r) => r.lens.id)).toEqual(["summicron", "elmar", "q2"]);
  });

  it.each([
    ["Schneider", "Schneider-Kreuznach"],
    ["Meke", "Meike"],
    ["Voigtländer", "Voigtlander"],
    ["Ricoh Imaging Company", "Ricoh"],
    ["Nikon Corporation", "NIKON CORPORATION"],
    ["OM Digital Solutions", "Olympus"],
    ["Carl Zeiss", "Zeiss"],
  ])("groups %s with %s", (a, b) => {
    expect(makers([lens("a", a, "A"), lens("b", b, "B")])).toHaveLength(1);
  });

  it("files a built-in lens under its body's maker", () => {
    expect(makers([rx100, lx100, lumia])).toEqual(["Sony", "Panasonic", "Nokia"]);
  });

  it("names the bodies ahead of the focal length", () => {
    expect(details([rx100, lumia, x100])).toEqual([
      "DSC-RX100, DSC-RX100M2 +1 · 10.4-37.1mm",
      "Lumia 1520 · 3.7mm",
      "FinePix X100, X100F · 23mm",
    ]);
  });

  it("adds the crop factor only to rows that share a name", () => {
    expect(details([ef50, ef50aps, ef85])).toEqual(["50mm · ×1", "50mm · ×1.61", "85mm"]);
  });

  it.each([
    [1.6, "×1.6"],
    [1.534, "×1.53"],
    [0.79, "×0.79"],
    [2, "×2"],
  ])("writes crop factor %s as %s", (cropFactor, label) => {
    const [, variant] = details([ef50, lens("variant", "Canon", ef50.model, { cropFactor })]);
    expect(variant).toBe(`50mm · ${label}`);
  });

  it("treats rows as sharing a name across spellings of the maker", () => {
    const full = lens("full", "Leica", summicron.model, { focalMin: 28, focalMax: 28 });
    const aps = { ...summicron, cropFactor: 1.53 };
    expect(details([full, aps])).toEqual(["28mm · ×1", "28mm · ×1.53"]);
  });

  it("has no detail for a lens without a focal length or bodies", () => {
    expect(details([lens("bare", "Canon", "Mystery", { focalMin: 0, focalMax: 0 })])).toEqual([""]);
  });
});
