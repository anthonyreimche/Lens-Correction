// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseLcp } from "./parse-lcp";

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
