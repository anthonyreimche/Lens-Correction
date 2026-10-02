import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { LensfunLens } from "../src/db/types";
import { resolveForLens } from "../src/db/matcher";
import { distortionScale, distortionUniforms } from "../src/distortion";
import { buildLensDatabase } from "./lensfun-xml.mjs";

const doc = (...blocks: string[]): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<lensdatabase version="2">\n${blocks.join("\n")}\n</lensdatabase>`;

const camera = (maker: string, model: string, mount: string): string => `
    <camera>
        <maker>${maker}</maker>
        <model>${model}</model>
        <mount>${mount}</mount>
        <cropfactor>1.53</cropfactor>
    </camera>`;

const lens = (names: string, mounts: string[], cropFactor = "1.53"): string => `
    <lens>
        ${names}
        ${mounts.map((m) => `<mount>${m}</mount>`).join("\n        ")}
        <cropfactor>${cropFactor}</cropfactor>
        <calibration>
            <distortion model="ptlens" focal="23" a="0.012" b="-0.035" c="0.028"/>
        </calibration>
    </lens>`;

const GFX100RF_CAMERA = `
    <camera>
        <maker>Fujifilm</maker>
        <model>GFX100RF</model>
        <mount>fujiGFX100RF</mount>
        <cropfactor>0.8</cropfactor>
    </camera>`;

const GFX100RF_LENS = `
    <lens>
        <maker>Fujifilm</maker>
        <model>GFX100RF &amp; compatibles (Standard)</model>
        <model lang="en">fixed lens</model>
        <model lang="de">festes Objektiv</model>
        <mount>fujiGFX100RF</mount>
        <cropfactor>0.8</cropfactor>
        <calibration>
            <distortion model="ptlens" focal="35" a="0.0122972" b="-0.0707816" c="0.026727"/>
        </calibration>
    </lens>`;

const F11_LENS = lens(
  `<maker>Fujifilm</maker>
        <model>FinePix F11 &amp; compatibles (Standard)</model>
        <model lang="en">fixed lens</model>
        <model lang="de">festes Objektiv</model>`,
  ["fujiF11"],
);

const XF_LENS = lens(
  `<maker>Fujifilm</maker>
        <model>XF18-55mmF2.8-4 R LM OIS</model>
        <model lang="en">XF 18-55mm f/2.8-4 R LM OIS</model>`,
  ["Fujifilm X"],
);

const build = (...documents: string[]) => buildLensDatabase(documents);

const byModel = (lenses: LensfunLens[], model: string): LensfunLens => {
  const found = lenses.find((l) => l.model === model);
  if (!found) throw new Error(`no lens "${model}" in [${lenses.map((l) => l.model).join(", ")}]`);
  return found;
};

describe("buildLensDatabase — fixed-lens cameras", () => {
  it("names a fixed lens by its untagged model, not the translated 'fixed lens' label", () => {
    const { lenses } = build(doc(GFX100RF_CAMERA, GFX100RF_LENS));
    expect(lenses).toHaveLength(1);
    expect(lenses[0].maker).toBe("Fujifilm");
    expect(lenses[0].model).toBe("GFX100RF & compatibles (Standard)");
    expect(lenses[0].mounts).toEqual(["fujiGFX100RF"]);
    expect(lenses[0].id).toBe("fujifilm-gfx100rf-compatibles-standard");
  });

  it("attaches the bodies that share the fixed lens's mount", () => {
    const { lenses } = build(doc(GFX100RF_CAMERA, camera("Fujifilm", "X100V", "fujix100v2"), GFX100RF_LENS));
    expect(lenses[0].cameras).toEqual([{ maker: "Fujifilm", model: "GFX100RF" }]);
  });

  it("attaches bodies declared in a different file", () => {
    const { lenses } = build(doc(GFX100RF_CAMERA), doc(GFX100RF_LENS));
    expect(lenses[0].cameras).toEqual([{ maker: "Fujifilm", model: "GFX100RF" }]);
  });

  it("lists every body sharing the mount, each once", () => {
    const x100v = lens(
      `<maker>Fujifilm</maker>
        <model>X100V &amp; compatibles</model>
        <model lang="en">fixed lens, or with WCL/TCL</model>`,
      ["fujix100v2"],
    );
    const { lenses } = build(
      doc(camera("Fujifilm", "X100V", "fujix100v2"), camera("Fujifilm", "X100VI", "fujix100v2"), x100v),
      doc(camera("Fujifilm", "X100V", "fujix100v2")),
    );
    expect(lenses[0].cameras).toEqual([
      { maker: "Fujifilm", model: "X100V" },
      { maker: "Fujifilm", model: "X100VI" },
    ]);
  });

  it("keeps two fixed lenses of the same maker under distinct ids", () => {
    const { lenses, droppedDuplicates } = build(doc(GFX100RF_CAMERA, camera("Fujifilm", "FinePix F11", "fujiF11"), F11_LENS, GFX100RF_LENS));
    expect(lenses).toHaveLength(2);
    expect(droppedDuplicates).toBe(0);
    expect(new Set(lenses.map((l) => l.id)).size).toBe(2);
    expect(byModel(lenses, "FinePix F11 & compatibles (Standard)").cameras).toEqual([{ maker: "Fujifilm", model: "FinePix F11" }]);
    expect(byModel(lenses, "GFX100RF & compatibles (Standard)").cameras).toEqual([{ maker: "Fujifilm", model: "GFX100RF" }]);
  });

  it("treats a lowercase pseudo-mount as fixed even without a 'fixed lens' label", () => {
    const x70 = lens(`<maker>Fujifilm</maker>\n        <model>X70 &amp; compatibles (Standard)</model>`, ["fujix70"]);
    const { lenses } = build(doc(camera("Fujifilm", "X70", "fujix70"), x70));
    expect(lenses[0].cameras).toEqual([{ maker: "Fujifilm", model: "X70" }]);
  });

  it("gives a fixed lens with no known body an empty cameras list", () => {
    const { lenses } = build(doc(GFX100RF_LENS));
    expect(lenses[0].cameras).toEqual([]);
  });

  it("leaves interchangeable lenses without a cameras field, even when bodies share the mount", () => {
    const { lenses } = build(doc(camera("Fujifilm", "X-T5", "Fujifilm X"), XF_LENS));
    expect(lenses[0]).not.toHaveProperty("cameras");
  });

  it("names attached bodies by their untagged maker and model", () => {
    const dji = `
    <camera>
        <maker>DJI</maker>
        <maker lang="en">Dà-Jiāng Innovations</maker>
        <model>FC3411</model>
        <model lang="en">Air 2S</model>
        <mount>djiFC3411</mount>
        <cropfactor>2.7</cropfactor>
    </camera>`;
    const fixed = lens(`<maker>DJI</maker>\n        <model>FC3411 &amp; compatibles</model>\n        <model lang="en">FC3411 fixed lens</model>`, ["djiFC3411"]);
    const { lenses } = build(doc(dji, fixed));
    expect(lenses[0].cameras).toEqual([{ maker: "DJI", model: "FC3411" }]);
  });
});

describe("buildLensDatabase — names", () => {
  it("uses the untagged model of an interchangeable lens", () => {
    const { lenses } = build(doc(XF_LENS));
    expect(lenses[0].model).toBe("XF18-55mmF2.8-4 R LM OIS");
  });

  it("prefers the untagged maker over the English one", () => {
    const leica = lens(`<maker>Leica Camera AG</maker>\n        <maker lang="en">Leica</maker>\n        <model>SUMMILUX-M 1:1.4/35 ASPH.</model>`, ["Leica M"]);
    const { lenses } = build(doc(leica));
    expect(lenses[0].maker).toBe("Leica Camera AG");
  });

  it("falls back to the English maker and model when there is no untagged one", () => {
    const englishOnly = lens(`<maker lang="en">Meike</maker>\n        <model lang="en">Meike 12mm f/2.8</model>`, ["Fujifilm X"]);
    const { lenses } = build(doc(englishOnly));
    expect(lenses[0].maker).toBe("Meike");
    expect(lenses[0].model).toBe("Meike 12mm f/2.8");
  });

  it("decodes XML entities without double-decoding", () => {
    const odd = lens(
      `<maker>A &amp; B</maker>\n        <model>&lt;C&gt; &quot;D&quot; &apos;E&apos; &amp;lt;</model>`,
      ["Fujifilm X"],
    );
    const { lenses } = build(doc(odd));
    expect(lenses[0].maker).toBe("A & B");
    expect(lenses[0].model).toBe(`<C> "D" 'E' &lt;`);
  });

  it("records every mount of a multi-mount lens", () => {
    const sigma = lens(`<maker>Sigma</maker>\n        <model>Sigma 50mm f/1.4 EX DG HSM</model>`, ["Sigma SA", "Canon EF", "Nikon F AF"]);
    const { lenses } = build(doc(sigma));
    expect(lenses[0].mounts).toEqual(["Sigma SA", "Canon EF", "Nikon F AF"]);
  });
});

describe("buildLensDatabase — ids and duplicates", () => {
  it("keeps slugging interchangeable lens ids from the English name, so persisted ids still resolve", () => {
    const { lenses } = build(doc(XF_LENS));
    expect(lenses[0].id).toBe("fujifilm-xf-18-55mm-f-2-8-4-r-lm-ois");
  });

  it("drops a lens repeated with the same maker, model, mounts and crop factor, and counts it", () => {
    const { lenses, droppedDuplicates } = build(doc(XF_LENS), doc(XF_LENS));
    expect(lenses).toHaveLength(1);
    expect(droppedDuplicates).toBe(1);
  });

  it("keeps a lens's calibrations for different crop factors under distinct ids", () => {
    const names = `<maker>Nikon</maker>
        <model>Nikon AF-S Micro Nikkor 60mm f/2.8G ED</model>
        <model lang="en">Nikkor AF-S 60mm f/2.8G ED Micro</model>`;
    const { lenses, droppedDuplicates } = build(doc(lens(names, ["Nikon F AF"], "1.523"), lens(names, ["Nikon F AF"], "1")));
    expect(droppedDuplicates).toBe(0);
    expect(lenses.map((l) => [l.id, l.cropFactor])).toEqual([
      ["nikon-nikkor-af-s-60mm-f-2-8g-ed-micro", 1.523],
      ["nikon-nikkor-af-s-60mm-f-2-8g-ed-micro-nikon-f-af", 1],
    ]);
  });

  it("treats the same mounts in a different order as the same lens", () => {
    const a = lens(`<maker>Sigma</maker>\n        <model>Sigma 19mm f/2.8 DN</model>`, ["Sony E", "Micro 4/3 System"]);
    const b = lens(`<maker>Sigma</maker>\n        <model>Sigma 19mm f/2.8 DN</model>`, ["Micro 4/3 System", "Sony E"]);
    const { lenses, droppedDuplicates } = build(doc(a, b));
    expect(lenses).toHaveLength(1);
    expect(droppedDuplicates).toBe(1);
  });

  it("keeps distinct lenses whose names slugify alike, appending the mount to the later id", () => {
    const lower = lens(`<maker>Tamron</maker>\n        <model>Tamron SP 90mm f/2.8 Di Macro</model>`, ["Canon EF"]);
    const upper = lens(`<maker>Tamron</maker>\n        <model>Tamron SP 90mm F/2.8 Di Macro</model>`, ["Nikon F AF"]);
    const { lenses, droppedDuplicates } = build(doc(lower, upper));
    expect(droppedDuplicates).toBe(0);
    expect(byModel(lenses, "Tamron SP 90mm f/2.8 Di Macro").id).toBe("tamron-tamron-sp-90mm-f-2-8-di-macro");
    expect(byModel(lenses, "Tamron SP 90mm F/2.8 Di Macro").id).toBe("tamron-tamron-sp-90mm-f-2-8-di-macro-nikon-f-af");
  });

  it("keeps the same lens listed for different mounts under distinct ids", () => {
    const full = lens(`<maker>Zeiss</maker>\n        <model>Carl Zeiss Planar T* 1.4/50 ZF.2</model>`, ["Nikon F AF", "Canon EF"]);
    const nikon = lens(`<maker>Zeiss</maker>\n        <model>Carl Zeiss Planar T* 1.4/50 ZF.2</model>`, ["Nikon F AF"]);
    const { lenses, droppedDuplicates } = build(doc(full, nikon));
    expect(droppedDuplicates).toBe(0);
    expect(lenses.map((l) => l.id).sort()).toEqual([
      "zeiss-carl-zeiss-planar-t-1-4-50-zf-2",
      "zeiss-carl-zeiss-planar-t-1-4-50-zf-2-nikon-f-af",
    ]);
  });

  it("falls back to a counter when the mount suffix is taken too", () => {
    const a = lens(`<maker>Tamron</maker>\n        <model>Tamron 90mm f/2.8</model>`, ["Canon EF"]);
    const b = lens(`<maker>Tamron</maker>\n        <model>Tamron 90mm F/2.8</model>`, ["Canon EF"]);
    const c = lens(`<maker>Tamron</maker>\n        <model>TAMRON 90mm f/2.8</model>`, ["Canon EF"]);
    const { lenses } = build(doc(a, b, c));
    expect(lenses.map((l) => l.id).sort()).toEqual([
      "tamron-tamron-90mm-f-2-8",
      "tamron-tamron-90mm-f-2-8-canon-ef",
      "tamron-tamron-90mm-f-2-8-canon-ef-2",
    ]);
  });

  it("sorts by maker, then model", () => {
    const { lenses } = build(doc(XF_LENS, GFX100RF_LENS, lens(`<maker>Canon</maker>\n        <model>EF 50mm f/1.8 STM</model>`, ["Canon EF"])));
    expect(lenses.map((l) => l.model)).toEqual([
      "EF 50mm f/1.8 STM",
      "GFX100RF & compatibles (Standard)",
      "XF18-55mmF2.8-4 R LM OIS",
    ]);
  });
});

describe("buildLensDatabase — calibration aspect ratio", () => {
  const withAspect = (aspect: string): string => `
    <lens>
        <maker>Olympus</maker>
        <model>Zuiko Digital 14-42mm f/3.5-5.6</model>
        <mount>4/3 System</mount>
        <cropfactor>2</cropfactor>
        <aspect-ratio>${aspect}</aspect-ratio>
        <calibration>
            <distortion model="poly3" focal="14" k1="-0.0123"/>
        </calibration>
    </lens>`;

  it.each([
    ["4:3", 4 / 3],
    ["3:2", 1.5],
    ["16:9", 16 / 9],
    ["8:7", 8 / 7],
    ["1:1", 1],
    ["1.5", 1.5],
    [" 4:3 ", 4 / 3],
  ])("reads %s as long/short %f", (aspect, expected) => {
    const { lenses } = build(doc(withAspect(aspect)));
    expect(lenses[0].aspectRatio).toBeCloseTo(expected, 12);
  });

  it.each([
    ["2:3", 1.5],
    ["0.75", 4 / 3],
  ])("normalises the portrait form %s to long/short", (aspect, expected) => {
    const { lenses } = build(doc(withAspect(aspect)));
    expect(lenses[0].aspectRatio).toBeCloseTo(expected, 12);
  });

  it.each([["abc"], ["4:0"], ["0"], ["-1.5"], ["4:3:2"]])("leaves an unreadable %s undeclared", (aspect) => {
    const { lenses } = build(doc(withAspect(aspect)));
    expect(lenses[0]).not.toHaveProperty("aspectRatio");
  });

  it("leaves a lens without the element undeclared, keeping the record small", () => {
    const { lenses } = build(doc(GFX100RF_LENS));
    expect(lenses[0]).not.toHaveProperty("aspectRatio");
  });
});

describe("buildLensDatabase — poly5 distortion", () => {
  const poly5 = `
    <lens>
        <maker>Canon</maker>
        <model>Canon EF 35mm f/2</model>
        <mount>Canon EF</mount>
        <cropfactor>1</cropfactor>
        <aspect-ratio>3:2</aspect-ratio>
        <calibration>
            <distortion model="poly5" focal="35" k1="-0.08" k2="0.02"/>
        </calibration>
    </lens>`;

  it.each([0.5, 1])("reaches the stage as 1 + k1·r² + k2·r⁴ in Lensfun's radius (shader r = %f)", (r) => {
    const { lenses } = build(doc(poly5));
    expect(lenses[0].distortion[0].k).toEqual([-0.08, 0.02]);
    const profile = resolveForLens(lenses[0], { focalLength: 35, focalLength35mm: 35 }, 1.5);
    const rl = r * Math.hypot(1.5, 1);
    expect(distortionScale(distortionUniforms(profile, 0), r)).toBeCloseTo(1 - 0.08 * rl ** 2 + 0.02 * rl ** 4, 12);
  });
});

describe("vendored Lensfun database", () => {
  const dir = fileURLToPath(new URL("../vendor/lensfun-db/", import.meta.url));
  const documents = readdirSync(dir)
    .filter((f) => f.endsWith(".xml"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8"));
  const { lenses } = buildLensDatabase(documents);

  it("gives every lens a unique id", () => {
    expect(new Set(lenses.map((l) => l.id)).size).toBe(lenses.length);
  });

  it("keeps the Fujifilm fixed-lens bodies reachable", () => {
    expect(byModel(lenses, "GFX100RF & compatibles (Standard)").cameras).toContainEqual({ maker: "Fujifilm", model: "GFX100RF" });
    const x100v = byModel(lenses, "X100V & compatibles").cameras;
    expect(x100v).toContainEqual({ maker: "Fujifilm", model: "X100V" });
    expect(x100v).toContainEqual({ maker: "Fujifilm", model: "X100VI" });
    expect(byModel(lenses, "FinePix F11 & compatibles (Standard)").cameras).toContainEqual({ maker: "Fujifilm", model: "FinePix F11" });
  });

  it("keeps the id an interchangeable lens had in earlier releases", () => {
    expect(lenses.find((l) => l.id === "fujifilm-xf-18-55mm-f-2-8-4-r-lm-ois")?.model).toBe("XF18-55mmF2.8-4 R LM OIS");
  });

  it("keeps no 'fixed lens' placeholder names", () => {
    expect(lenses.filter((l) => /fixed lens/i.test(l.model)).map((l) => l.id)).toEqual([]);
  });

  it("carries the declared calibration aspect ratio, and only where declared", () => {
    expect(byModel(lenses, "FinePix F11 & compatibles (Standard)").aspectRatio).toBeCloseTo(4 / 3, 12);
    expect(byModel(lenses, "GFX100RF & compatibles (Standard)")).not.toHaveProperty("aspectRatio");
    const declared = lenses.filter((l) => l.aspectRatio !== undefined);
    expect(declared.length).toBeGreaterThan(300);
    expect(declared.every((l) => l.aspectRatio! >= 1)).toBe(true);
  });
});
