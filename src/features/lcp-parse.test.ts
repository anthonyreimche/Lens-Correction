// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { adobeToResolved, type AdobeProfile } from "./adobe-model";
import { parseLcp } from "./parse-lcp";
import { resolveLcp } from "./lcp";

const { library } = vi.hoisted(() => ({ library: [] as AdobeProfile[] }));

vi.mock("../storage", () => ({
  idbGetAll: () => Promise.resolve(library),
  idbSet: () => Promise.resolve(),
}));

const NS =
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns:stCamera="http://ns.adobe.com/photoshop/1.0/camera-profile/"';

// Attribute-style calibration (the common LCP layout).
const ATTR_LCP = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF ${NS}>
  <rdf:Description>
   <stCamera:Make>Canon</stCamera:Make>
   <stCamera:Model>Canon EOS 5D Mark III</stCamera:Model>
   <stCamera:Lens>EF24-70mm f/2.8L II USM</stCamera:Lens>
   <stCamera:FocalLength>50</stCamera:FocalLength>
   <stCamera:ApertureValue>4</stCamera:ApertureValue>
   <stCamera:PerspectiveModel>
    <rdf:Description stCamera:FocalLengthX="1.4" stCamera:FocalLengthY="1.4"
      stCamera:ImageXCenter="0.5" stCamera:ImageYCenter="0.5"
      stCamera:RadialDistortParam1="-0.05" stCamera:RadialDistortParam2="0.01"
      stCamera:RadialDistortParam3="0.0"/>
   </stCamera:PerspectiveModel>
   <stCamera:VignetteModel>
    <rdf:Description stCamera:VignetteModelParam1="-0.3"
      stCamera:VignetteModelParam2="0.1" stCamera:VignetteModelParam3="0.0"/>
   </stCamera:VignetteModel>
   <stCamera:ChromaticRedGreenModel>
    <rdf:Description stCamera:RadialDistortParam1="0.001" stCamera:RadialDistortParam2="0"/>
   </stCamera:ChromaticRedGreenModel>
   <stCamera:ChromaticBlueGreenModel>
    <rdf:Description stCamera:RadialDistortParam1="-0.002" stCamera:RadialDistortParam2="0"/>
   </stCamera:ChromaticBlueGreenModel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

// Adobe's own layout: each shot's metadata as attributes on an rdf:li's
// Description, with CA and vignette nested inside the PerspectiveModel.
const adobeLcp = (lens: string) => `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
   <photoshop:CameraProfiles>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description xmlns:stCamera="http://ns.adobe.com/photoshop/1.0/camera-profile"
       stCamera:Author="Adobe (www.adobe.com)"
       stCamera:Make="SONY"
       stCamera:Model="ILCE-7RM3"
       stCamera:Lens="${lens}"
       stCamera:LensPrettyName="Sony ${lens}"
       stCamera:FocalLength="24"
       stCamera:FocusDistance="10000"
       stCamera:ApertureValue="4">
       <stCamera:PerspectiveModel>
        <rdf:Description stCamera:Version="2" stCamera:FocalLengthX="0.6"
         stCamera:FocalLengthY="0.6" stCamera:RadialDistortParam1="-0.1"
         stCamera:RadialDistortParam2="0.02">
         <stCamera:ChromaticRedGreenModel>
          <rdf:Description stCamera:FocalLengthX="0.6" stCamera:RadialDistortParam1="0.001"/>
         </stCamera:ChromaticRedGreenModel>
         <stCamera:VignetteModel>
          <rdf:Description stCamera:FocalLengthX="0.6" stCamera:VignetteModelParam1="-0.3"/>
         </stCamera:VignetteModel>
        </rdf:Description>
       </stCamera:PerspectiveModel>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </photoshop:CameraProfiles>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

describe("parseLcp — Adobe's attribute layout", () => {
  it("reads make, model and lens from attributes", () => {
    const p = parseLcp(adobeLcp("FE 24-70mm F2.8 GM"));
    expect(p).toMatchObject({ make: "SONY", model: "ILCE-7RM3", lens: "FE 24-70mm F2.8 GM" });
  });

  it("reads the calibration nested in the perspective model", () => {
    const e = parseLcp(adobeLcp("FE 24-70mm F2.8 GM"))!.entries[0];
    expect(e).toMatchObject({ focal: 24, focalLengthX: 0.6 });
    expect(e.distortion).toEqual({ k1: -0.1, k2: 0.02, k3: 0 });
    expect(e.vignette).toEqual({ a1: -0.3, a2: 0, a3: 0 });
    expect(e.ca).toEqual({ redK1: 0.001, redK2: 0, blueK1: 0, blueK2: 0 });
  });
});

describe("resolveLcp — Adobe's attribute layout", () => {
  beforeEach(() => void library.splice(0));

  it("applies an imported profile to a photo from that lens", async () => {
    library.push(parseLcp(adobeLcp("FE 24-70mm F2.8 GM"))!);
    const r = await resolveLcp({ lens: "FE 24-70mm F2.8 GM", focalLength: 24 }, { aspect: 1.5 });
    expect(r).toMatchObject({ source: "lcp", lensName: "FE 24-70mm F2.8 GM" });
    expect(r!.distortion).not.toBeNull();
  });
});

// An .lcp as Adobe writes it, with one rdf:li per calibrated shot.
const lcpWith = (items: string[], header = 'stCamera:Make="SONY" stCamera:Model="ILCE-7RM3" stCamera:Lens="FE 24-70mm F2.8 GM"') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
   <photoshop:CameraProfiles>
    <rdf:Seq>
${items.map((attrs) => `     <rdf:li>
      <rdf:Description xmlns:stCamera="http://ns.adobe.com/photoshop/1.0/camera-profile"
       ${header} stCamera:SensorFormatFactor="1" stCamera:ImageWidth="7952" stCamera:ImageLength="5304" ${attrs}>
       <stCamera:PerspectiveModel>
        <rdf:Description stCamera:FocalLengthX="0.6" stCamera:RadialDistortParam1="-0.1">
         <stCamera:ChromaticRedGreenModel>
          <rdf:Description stCamera:FocalLengthX="0.6" stCamera:ScaleFactor="1.0004" stCamera:RadialDistortParam1="0.001"/>
         </stCamera:ChromaticRedGreenModel>
        </rdf:Description>
       </stCamera:PerspectiveModel>
      </rdf:Description>
     </rdf:li>`).join("\n")}
    </rdf:Seq>
   </photoshop:CameraProfiles>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

describe("parseLcp — calibration details", () => {
  it("reads ApertureValue as an APEX value", () => {
    const [e] = parseLcp(lcpWith(['stCamera:FocalLength="24" stCamera:ApertureValue="4"']))!.entries;
    expect(e.aperture).toBeCloseTo(4, 10);
    const [wide] = parseLcp(lcpWith(['stCamera:FocalLength="24" stCamera:ApertureValue="2.970854"']))!.entries;
    expect(wide.aperture).toBeCloseTo(2.8, 2);
  });

  it("keeps shots at different focus distances apart", () => {
    const p = parseLcp(
      lcpWith([
        'stCamera:FocalLength="24" stCamera:FocusDistance="0.5" stCamera:ApertureValue="4"',
        'stCamera:FocalLength="24" stCamera:FocusDistance="10000" stCamera:ApertureValue="4"',
      ]),
    )!;
    expect(p.entries.map((e) => e.distance).sort((a, b) => a! - b!)).toEqual([0.5, 10000]);
  });

  it("keeps raw and camera-JPEG calibrations apart", () => {
    const p = parseLcp(
      lcpWith([
        'stCamera:FocalLength="24" stCamera:CameraRawProfile="True"',
        'stCamera:FocalLength="24" stCamera:CameraRawProfile="False"',
      ]),
    )!;
    expect(p.entries.map((e) => e.raw).sort()).toEqual([false, true]);
  });

  it("reads the CA scale factor", () => {
    const [e] = parseLcp(lcpWith(['stCamera:FocalLength="24"']))!.entries;
    expect(e.ca).toMatchObject({ redK1: 0.001, redScale: 1.0004 });
  });

  it("reads the calibration camera's crop factor and frame aspect", () => {
    const p = parseLcp(lcpWith(['stCamera:FocalLength="24"']))!;
    expect(p.sensorFormatFactor).toBe(1);
    expect(p.imageAspect).toBeCloseTo(7952 / 5304, 10);
  });

  it("marks a fisheye calibration", () => {
    const xml = lcpWith(['stCamera:FocalLength="15"']).replace(/PerspectiveModel/g, "FisheyeModel");
    expect(parseLcp(xml)!.entries[0].fisheye).toBe(true);
  });
});

describe("resolveLcp — matching", () => {
  beforeEach(() => void library.splice(0));
  const named = (lens: string, extra = "") =>
    parseLcp(lcpWith(['stCamera:FocalLength="24"'], `stCamera:Make="SONY" stCamera:Model="ILCE-7RM3" stCamera:Lens="${lens}" ${extra}`))!;

  it("matches regardless of case, spacing, punctuation and a leading maker name", async () => {
    library.push(named("FE 24-70mm F2.8 GM"));
    expect(await resolveLcp({ lens: "Sony FE 24-70mm f/2.8 GM", focalLength: 24 }, { aspect: 1.5 })).not.toBeNull();
  });

  it("matches the lens's pretty name too", async () => {
    library.push(named("24-70mm", 'stCamera:LensPrettyName="Sony FE 24-70mm F2.8 GM"'));
    expect(await resolveLcp({ lens: "FE 24-70mm F2.8 GM", focalLength: 24 }, { aspect: 1.5 })).not.toBeNull();
  });

  it("does not apply one lens's profile to a similarly named lens", async () => {
    library.push(named("FE 24-70mm F2.8 GM"));
    expect(await resolveLcp({ lens: "FE 24-70mm F2.8 GM II", focalLength: 24 }, { aspect: 1.5 })).toBeNull();
  });

  it("allows a close name when LCP was chosen for the photo", async () => {
    library.push(named("FE 24-70mm F2.8 GM"));
    expect(await resolveLcp({ lens: "FE 24-70mm F2.8 GM II", focalLength: 24 }, { aspect: 1.5, fuzzy: true })).not.toBeNull();
  });

  it("prefers the profile made on the photo's camera", async () => {
    const a7r3 = named("FE 24-70mm F2.8 GM");
    const a7iv = { ...a7r3, model: "ILCE-7M4", entries: a7r3.entries.map((e) => ({ ...e, focalLengthX: 0.3 })) };
    library.push(a7iv, a7r3);
    const k1 = async (cameraModel: string) =>
      (await resolveLcp({ lens: "FE 24-70mm F2.8 GM", cameraModel, focalLength: 24 }, { aspect: 1.5 }))!.distortion!.k[0];
    expect(await k1("ILCE-7RM3")).toBeCloseTo(adobeToResolved(a7r3, { focal: 24, aspect: 1.5 }, "lcp")!.distortion!.k[0], 12);
    expect(await k1("ILCE-7M4")).toBeCloseTo(adobeToResolved(a7iv, { focal: 24, aspect: 1.5 }, "lcp")!.distortion!.k[0], 12);
  });
});

describe("parseLcp", () => {
  it("reads make/lens and a calibration entry from attribute-style LCP", () => {
    const p = parseLcp(ATTR_LCP);
    expect(p).not.toBeNull();
    expect(p!.make).toBe("Canon");
    expect(p!.lens).toContain("EF24-70");
    expect(p!.entries).toHaveLength(1);
    const e = p!.entries[0];
    expect(e.focal).toBe(50);
    expect(e.focalLengthX).toBeCloseTo(1.4, 3);
    expect(e.distortion).toEqual({ k1: -0.05, k2: 0.01, k3: 0 });
    expect(e.vignette).toEqual({ a1: -0.3, a2: 0.1, a3: 0 });
    expect(e.ca).toEqual({ redK1: 0.001, redK2: 0, blueK1: -0.002, blueK2: 0 });
  });

  it("returns null for non-LCP XML", () => {
    expect(parseLcp("<note><body>hi</body></note>")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseLcp("not xml <<<")).toBeNull();
  });
});
