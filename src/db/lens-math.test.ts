import { describe, it, expect } from "vitest";
import { matchLens, rememberKey, resolveForPhoto, resolveForLens } from "./matcher";
import { resolveProfile } from "./interpolate";
import type { LensfunCamera, LensfunLens } from "./types";

const lens = (over: Partial<LensfunLens> = {}): LensfunLens => ({
  id: "test",
  maker: "Canon",
  model: "EF 50mm f/1.8 STM",
  mounts: ["Canon EF"],
  cropFactor: 1,
  type: "rectilinear",
  focalMin: 50,
  focalMax: 50,
  apertureMin: 1.8,
  apertureMax: 22,
  distortion: [{ focal: 50, model: "poly3", k: [0.01] }],
  tca: [],
  vignetting: [],
  ...over,
});

describe("matchLens", () => {
  const db = [
    lens(),
    lens({ id: "zoom", model: "EF 24-70mm f/2.8L II USM", maker: "Canon", focalMin: 24, focalMax: 70 }),
    lens({ id: "nikon", model: "NIKKOR Z 50mm f/1.8 S", maker: "Nikon" }),
  ];

  it("matches an exact normalized model string", () => {
    expect(matchLens({ lens: "EF 50mm f/1.8 STM" }, db)?.id).toBe("test");
  });

  it("fuzzy-matches within the right maker and ignores other makers", () => {
    const m = matchLens({ lens: "EF 24-70mm f/2.8L II USM", lensMake: "Canon", focalLength: 35 }, db);
    expect(m?.id).toBe("zoom");
  });

  it("returns null when nothing crosses the score threshold", () => {
    expect(matchLens({ lens: "Totally Unknown Glass 999mm" }, db)).toBeNull();
  });

  it("returns null without a lens string", () => {
    expect(matchLens({}, db)).toBeNull();
  });

  it("treats spellings of one lens maker as the same maker", () => {
    const nokton = lens({ id: "nokton", maker: "Voigtländer", model: "Voigtlander Nokton 58mm F1.4 SLII", focalMin: 58, focalMax: 58 });
    expect(matchLens({ lens: "Nokton 58mm F1.4 SLII", lensMake: "Voigtlander" }, [nokton])?.id).toBe("nokton");
  });
});

const fixedLens = (
  id: string,
  model: string,
  cameras: LensfunCamera[],
  over: Partial<LensfunLens> = {},
): LensfunLens =>
  lens({
    id,
    maker: cameras[0].maker,
    model,
    mounts: [id],
    focalMin: 35,
    focalMax: 35,
    cameras,
    ...over,
  });

describe("matchLens on fixed-lens bodies", () => {
  const gfx = fixedLens("gfx100rf", "GFX100RF & compatibles (Standard)", [{ maker: "Fujifilm", model: "GFX100RF" }], {
    cropFactor: 0.8,
    distortion: [{ focal: 35, model: "ptlens", k: [0.0123, -0.0708, 0.0267] }],
  });
  const q2 = fixedLens("leica-q2", "LEICA Q2 & compatibles", [{ maker: "Leica Camera AG", model: "Leica Q2" }], {
    focalMin: 28,
    focalMax: 28,
  });
  const summilux = lens({
    id: "summilux-m-28",
    maker: "Leica",
    model: "Summilux-M 1:1.4/28 ASPH.",
    mounts: ["Leica M"],
    focalMin: 28,
    focalMax: 28,
  });
  const g7x = fixedLens("g7x", "Canon PowerShot G7 X & compatibles", [{ maker: "Canon", model: "Canon PowerShot G7 X" }]);
  const db = [lens(), summilux, gfx, q2, g7x];

  it("matches the body when the EXIF lens string is empty", () => {
    expect(matchLens({ cameraMake: "FUJIFILM", cameraModel: "GFX100RF" }, db)?.id).toBe("gfx100rf");
  });

  it("prefers the built-in lens over a lens-string match", () => {
    const exif = { cameraMake: "LEICA CAMERA AG", cameraModel: "LEICA Q2", lens: "SUMMILUX 1:1.7/28 ASPH." };
    expect(matchLens(exif, db)?.id).toBe("leica-q2");
  });

  it("leaves interchangeable-lens bodies to lens-string matching", () => {
    const exif = { cameraMake: "Canon", cameraModel: "Canon EOS R5", lens: "EF 50mm f/1.8 STM" };
    expect(matchLens(exif, db)?.id).toBe("test");
  });

  it("matches any of the bodies a lens is built into", () => {
    const shared = fixedLens("x100s", "X100S & compatibles", [
      { maker: "Fujifilm", model: "X100S" },
      { maker: "Fujifilm", model: "X100T" },
    ]);
    expect(matchLens({ cameraMake: "FUJIFILM", cameraModel: "X100T" }, [shared])?.id).toBe("x100s");
  });

  it.each([
    ["FUJIFILM", "GFX 100RF", "Fujifilm", "GFX100RF"],
    ["Canon", "Canon PowerShot G7 X", "Canon", "PowerShot G7 X"],
    ["NIKON CORPORATION", "COOLPIX P7000", "Nikon", "Coolpix P7000"],
    ["NIKON", "E5700", "Nikon", "E5700"],
    ["OLYMPUS IMAGING CORP.", "XZ-1", "Olympus Imaging Corp.", "XZ-1"],
    ["OLYMPUS OPTICAL CO.,LTD", "C4100Z,C4000Z", "Olympus", "C4100Z,C4000Z"],
    ["OM Digital Solutions", "TG-7", "Olympus Corporation", "TG-7"],
    ["SONY", "DSC-RX100M7", "Sony", "DSC-RX100M7"],
    ["RICOH IMAGING COMPANY, LTD.", "RICOH GR III", "Ricoh Imaging Company, Ltd.", "Ricoh GR III"],
    ["RICOH IMAGING COMPANY, LTD.", "RICOH GR III", "Ricoh", "GR III"],
    ["PENTAX Corporation", "PENTAX Optio 430", "Asahi Optical Co.,Ltd", "Pentax Optio 430"],
    ["CASIO COMPUTER CO.,LTD.", "EX-Z750", "Casio Computer Co.,Ltd", "EX-Z750"],
    ["EASTMAN KODAK COMPANY", "KODAK DC120 ZOOM DIGITAL CAMERA", "Kodak", "Kodak DC120 ZOOM Digital Camera"],
    ["Minolta Co., Ltd.", "DiMAGE 7", "Minolta", "DiMAGE 7"],
    ["Konica Minolta Camera, Inc.", "DiMAGE Z2", "Konica Minolta", "DiMAGE Z2"],
    ["LG Electronics", "LG-H815", "LG Mobile", "LG-H815"],
  ])("matches EXIF %s / %s to Lensfun %s / %s", (exifMake, exifModel, maker, model) => {
    const body = fixedLens("body", `${model} & compatibles`, [{ maker, model }]);
    expect(matchLens({ cameraMake: exifMake, cameraModel: exifModel }, [lens(), body])?.id).toBe("body");
  });

  describe("does not confuse neighbouring model names", () => {
    const family = [
      fixedLens("x100", "X100 & compatibles (Standard)", [{ maker: "Fujifilm", model: "FinePix X100" }]),
      fixedLens("x100vi", "X100VI & compatibles", [{ maker: "Fujifilm", model: "X100VI" }]),
      gfx,
    ];

    it.each([["X100V"], ["GFX100"], ["GFX100RF II"]])("%s matches nothing", (model) => {
      expect(matchLens({ cameraMake: "FUJIFILM", cameraModel: model }, family)).toBeNull();
    });

    it("keeps each body to its own lens", () => {
      expect(matchLens({ cameraMake: "FUJIFILM", cameraModel: "X100VI" }, family)?.id).toBe("x100vi");
      expect(matchLens({ cameraMake: "FUJIFILM", cameraModel: "FinePix X100" }, family)?.id).toBe("x100");
    });

    it("requires the maker to agree", () => {
      expect(matchLens({ cameraMake: "Panasonic", cameraModel: "GFX100RF" }, family)).toBeNull();
    });
  });

  describe("with several entries for one body", () => {
    const x100 = [{ maker: "Fujifilm", model: "FinePix X100" }];
    const tcl = fixedLens("x100-tcl", "X100 & compatibles, with TCL-X100", x100, { focalMin: 50, focalMax: 50 });
    const standard = fixedLens("x100-std", "X100 & compatibles (Standard)", x100);
    const exif = { cameraMake: "FUJIFILM", cameraModel: "FinePix X100" };

    it("prefers the standard lens over converter variants", () => {
      expect(matchLens(exif, [tcl, standard])?.id).toBe("x100-std");
      expect(matchLens({ ...exif, lens: "23mm F2" }, [tcl, standard])?.id).toBe("x100-std");
    });

    it("prefers the plain lens over macro and accessory variants", () => {
      const cams = [{ maker: "Sony", model: "Cybershot" }];
      const f707 = [
        fixedLens("f707-macro", "DSC-F707 & compatibles, macro at 2 inches lens-to-subject", cams),
        fixedLens("f707-sakar", "DSC-F707 & compatibles, with Sakar 1858W", cams),
        fixedLens("f707", "DSC-F707 & compatibles", cams),
      ];
      expect(matchLens({ cameraMake: "SONY", cameraModel: "CYBERSHOT" }, f707)?.id).toBe("f707");
    });

    it("picks a converter variant the EXIF lens string names", () => {
      expect(matchLens({ ...exif, lens: "FUJINON 23mm F2 + TCL-X100" }, [standard, tcl])?.id).toBe("x100-tcl");
    });
  });

  describe("when a body's only entry is a converter setup", () => {
    const gr3 = [{ maker: "Ricoh Imaging Company, Ltd.", model: "Ricoh GR III" }];
    const gw4 = fixedLens("gr3-gw4", "Ricoh GR III & compatibles + GW-4", gr3, { focalMin: 13.8, focalMax: 13.8 });
    const exif = { cameraMake: "RICOH IMAGING COMPANY, LTD.", cameraModel: "RICOH GR III", lens: "GR LENS 18.3mm F2.8" };

    it("leaves the body unmatched rather than applying the converter's profile", () => {
      expect(matchLens(exif, [gw4])).toBeNull();
    });

    it("does not fall back to lens-string matching", () => {
      const lookalike = lens({ id: "lookalike", maker: "Ricoh", model: "GR Lens 18.3mm F2.8", mounts: ["Pentax KAF"] });
      expect(matchLens(exif, [gw4, lookalike])).toBeNull();
    });

    it("uses the converter setup when the EXIF lens string names it", () => {
      expect(matchLens({ ...exif, lens: "GR LENS 18.3mm F2.8 + GW-4" }, [gw4])?.id).toBe("gr3-gw4");
    });

    it("still uses a lone CHDK DNG calibration, which profiles the bare optics", () => {
      const a490 = [{ maker: "Canon", model: "Canon PowerShot A490" }];
      const chdk = fixedLens("a495-chdk", "Canon PowerShot A495 & compatibles, with CHDK's DNG", a490);
      expect(matchLens({ cameraMake: "Canon", cameraModel: "Canon PowerShot A490" }, [chdk])?.id).toBe("a495-chdk");
    });

    it("prefers the standard entry over a CHDK DNG calibration", () => {
      const sx220 = [{ maker: "Canon", model: "Canon PowerShot SX220 HS" }];
      const chdk = fixedLens("sx220-chdk", "Canon PowerShot SX220 HS & compatibles, with CHDK's DNG", sx220);
      const standard = fixedLens("sx220", "Canon PowerShot SX220 HS & compatibles (Standard)", sx220);
      expect(matchLens({ cameraMake: "Canon", cameraModel: "Canon PowerShot SX220 HS" }, [chdk, standard])?.id).toBe("sx220");
    });

    it("treats a '+' inside a model name as part of the name", () => {
      const hero = fixedLens("hero3", "GoPro Hero3+ black & compatibles", [{ maker: "GoPro", model: "Hero3+ black" }]);
      expect(matchLens({ cameraMake: "GoPro", cameraModel: "HERO3+ Black" }, [hero])?.id).toBe("hero3");
    });
  });
});

describe("resolveForPhoto on fixed-lens bodies", () => {
  it("resolves the built-in lens at the shot's focal length", () => {
    const gfx = fixedLens("gfx100rf", "GFX100RF & compatibles (Standard)", [{ maker: "Fujifilm", model: "GFX100RF" }], {
      cropFactor: 0.8,
      distortion: [{ focal: 35, model: "ptlens", k: [0.0123, -0.0708, 0.0267] }],
    });
    const exif = { cameraMake: "FUJIFILM", cameraModel: "GFX100RF", focalLength: 35, aperture: 4 };
    const res = resolveForPhoto(exif, [lens(), gfx], 4 / 3);
    expect(res?.lens.id).toBe("gfx100rf");
    expect(res?.profile.cropFactor).toBe(0.8);
    expect(res?.profile.distortion).toEqual({ model: "ptlens", k: [0.0123, -0.0708, 0.0267] });
  });

  it("falls back to the lens's shortest focal length without EXIF focal", () => {
    const zoom = fixedLens("g7x", "Canon PowerShot G7 X & compatibles", [{ maker: "Canon", model: "Canon PowerShot G7 X" }], {
      focalMin: 8.8,
      focalMax: 36.8,
      distortion: [
        { focal: 8.8, model: "poly3", k: [0.05] },
        { focal: 36.8, model: "poly3", k: [-0.01] },
      ],
    });
    const res = resolveForPhoto({ cameraMake: "Canon", cameraModel: "Canon PowerShot G7 X" }, [zoom], 1.5);
    expect(res?.profile.distortion?.k[0]).toBe(0.05);
  });

  it("names the profile after the body's maker", () => {
    const rx1r = fixedLens("rx1r", "DSC-RX1R & compatibles", [{ maker: "Sony", model: "DSC-RX1R" }], { maker: "Carl Zeiss" });
    const res = resolveForPhoto({ cameraMake: "SONY", cameraModel: "DSC-RX1R" }, [rx1r], 1.5);
    expect(res?.profile.lensName).toBe("Sony DSC-RX1R & compatibles");
  });
});

describe("resolveForLens", () => {
  it("names the profile with the canonical lens maker", () => {
    const summicron = lens({ maker: "LEICA CAMERA AG", model: "Summicron-M 1:2/28 Asph.", focalMin: 28, focalMax: 28 });
    expect(resolveForLens(summicron, {}, 1.5).lensName).toBe("Leica Summicron-M 1:2/28 Asph.");
  });
});

describe("rememberKey", () => {
  const g7x = fixedLens("g7x", "Canon PowerShot G7 X & compatibles", [{ maker: "Canon", model: "Canon PowerShot G7 X" }]);
  const g5x = fixedLens("g5x", "Canon PowerShot G5 X & compatibles", [{ maker: "Canon", model: "Canon PowerShot G5 X" }]);
  const gr3 = fixedLens("gr3-gw4", "Ricoh GR III & compatibles + GW-4", [
    { maker: "Ricoh Imaging Company, Ltd.", model: "Ricoh GR III" },
  ]);
  const db = [lens(), g7x, g5x, gr3];

  it("keys a body with a built-in lens by the body", () => {
    const exif = { cameraMake: "RICOH IMAGING COMPANY, LTD.", cameraModel: "RICOH GR III", lens: "GR LENS 18.3mm F2.8" };
    expect(rememberKey(exif, db)).toBe("camera:ricoh|griii");
  });

  it("keys a body with a built-in lens even without a lens string", () => {
    expect(rememberKey({ cameraMake: "Canon", cameraModel: "Canon PowerShot G7 X" }, db)).toBe("camera:canon|powershotg7x");
  });

  it("gives bodies that write the same lens string different keys", () => {
    const g7xKey = rememberKey({ cameraMake: "Canon", cameraModel: "Canon PowerShot G7 X", lens: "8.8-36.8 mm" }, db);
    const g5xKey = rememberKey({ cameraMake: "Canon", cameraModel: "Canon PowerShot G5 X", lens: "8.8-36.8 mm" }, db);
    expect(g7xKey).not.toBe(g5xKey);
  });

  it("keys an interchangeable lens by the EXIF lens string exactly", () => {
    const exif = { cameraMake: "Canon", cameraModel: "Canon EOS R5", lens: "EF 50mm f/1.8 STM" };
    expect(rememberKey(exif, db)).toBe("EF 50mm f/1.8 STM");
  });

  it("has no key without a known body or a lens string", () => {
    expect(rememberKey({ cameraMake: "Canon", cameraModel: "Canon EOS R5" }, db)).toBeNull();
    expect(rememberKey({}, db)).toBeNull();
  });
});

describe("resolveProfile", () => {
  it("interpolates distortion between two focal calibrations", () => {
    const zoom = lens({
      focalMin: 24,
      focalMax: 70,
      distortion: [
        { focal: 24, model: "poly3", k: [0.02] },
        { focal: 70, model: "poly3", k: [-0.01] },
      ],
    });
    const mid = resolveProfile(zoom, 47, 4, 1000); // halfway
    expect(mid.distortion?.k[0]).toBeCloseTo(0.005, 3);
    expect(mid.source).toBe("lensfun");
  });

  it("passes through a single calibration unchanged", () => {
    const p = resolveProfile(lens(), 50, 1.8, 1000);
    expect(p.distortion?.k[0]).toBe(0.01);
  });

  it("resolveForPhoto and resolveForLens agree on the matched lens", () => {
    const db = [lens()];
    const exif = { lens: "EF 50mm f/1.8 STM", focalLength: 50, aperture: 1.8 };
    const viaPhoto = resolveForPhoto(exif, db, 1.5)?.profile.distortion?.k[0];
    const viaLens = resolveForLens(lens(), exif, 1.5).distortion?.k[0];
    expect(viaPhoto).toBe(viaLens);
  });
});
