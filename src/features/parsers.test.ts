import { describe, it, expect } from "vitest";
import { parseOpcodeList, findOpcodeList3 } from "./parse-embedded";
import { adobeToResolved, type AdobeProfile } from "./adobe-model";

// Build a big-endian OpcodeList3 blob with a WarpRectilinear + FixVignetteRadial.
function buildBlob(): ArrayBuffer {
  const warpData = 4 + 6 * 8 + 2 * 8; // N + 6 doubles + cx,cy = 68
  const vigData = 5 * 8 + 2 * 8; // k0..k4 + cx,cy = 56
  const total = 4 + (16 + warpData) + (16 + vigData);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let p = 0;
  const w32 = (v: number) => {
    dv.setUint32(p, v, false);
    p += 4;
  };
  const w64 = (v: number) => {
    dv.setFloat64(p, v, false);
    p += 8;
  };
  w32(2); // opcode count
  // WarpRectilinear (id 1)
  w32(1); w32(1); w32(0); w32(warpData);
  w32(1); // 1 plane
  w64(1.0); w64(-0.1); w64(0.02); w64(0.0); w64(0.0); w64(0.0); // kr0..3, kt0, kt1
  w64(0.5); w64(0.5); // cx, cy
  // FixVignetteRadial (id 3)
  w32(3); w32(1); w32(0); w32(vigData);
  w64(-0.2); w64(0.05); w64(0.0); w64(0.0); w64(0.0); // k0..k4
  w64(0.5); w64(0.5); // cx, cy
  return buf;
}

describe("parseOpcodeList", () => {
  it("decodes WarpRectilinear radial + FixVignetteRadial", () => {
    const c = parseOpcodeList(new DataView(buildBlob()));
    expect(c.distortion).toEqual({ k1: -0.1, k2: 0.02, k3: 0 });
    expect(c.vignette).toEqual({ a1: -0.2, a2: 0.05, a3: 0 });
  });

  it("normalizes the distortion constant kr0 to 1", () => {
    // kr0 = 2 ⇒ all radial coeffs are halved.
    const buf = buildBlob();
    new DataView(buf).setFloat64(4 + 16 + 4, 2.0, false); // kr0 of the warp
    const c = parseOpcodeList(new DataView(buf));
    expect(c.distortion!.k1).toBeCloseTo(-0.05, 6);
    expect(c.distortion!.k2).toBeCloseTo(0.01, 6);
  });
});

describe("findOpcodeList3", () => {
  it("locates the OpcodeList3 blob in a minimal big-endian TIFF", () => {
    const blob = buildBlob();
    const blobLen = blob.byteLength;
    const blobOff = 8 + (2 + 12 + 4); // header + IFD(count+1 entry+next)
    const buf = new ArrayBuffer(blobOff + blobLen);
    const dv = new DataView(buf);
    dv.setUint16(0, 0x4d4d, false); // 'MM'
    dv.setUint16(2, 42, false);
    dv.setUint32(4, 8, false); // IFD0 at offset 8
    dv.setUint16(8, 1, false); // 1 entry
    dv.setUint16(10, 0xc74e, false); // OpcodeList3 tag
    dv.setUint16(12, 7, false); // UNDEFINED
    dv.setUint32(14, blobLen, false); // count = blob length
    dv.setUint32(18, blobOff, false); // value offset
    dv.setUint32(22, 0, false); // next IFD = 0
    new Uint8Array(buf).set(new Uint8Array(blob), blobOff);

    const found = findOpcodeList3(buf);
    expect(found).not.toBeNull();
    expect(found!.byteLength).toBe(blobLen);
    const c = parseOpcodeList(found!);
    expect(c.distortion!.k1).toBeCloseTo(-0.1, 6);
  });

  it("rejects non-TIFF data", () => {
    expect(findOpcodeList3(new ArrayBuffer(4))).toBeNull();
  });
});

describe("adobeToResolved", () => {
  const profile: AdobeProfile = {
    make: "Canon",
    model: "EOS",
    lens: "EF 24-70",
    entries: [
      {
        focal: 50,
        aperture: 4,
        focalLengthX: 0, // DNG convention ⇒ S = 1
        distortion: { k1: -0.1, k2: 0.02, k3: 0 },
        vignette: { a1: -0.2, a2: 0.05, a3: 0 },
        ca: { redK1: 0.001, redK2: 0, blueK1: -0.002, blueK2: 0 },
      },
    ],
  };

  it("maps a DNG-convention profile straight onto the poly5/tca/vignette models", () => {
    const r = adobeToResolved(profile, 50, 1.5, "embedded");
    expect(r).not.toBeNull();
    expect(r!.source).toBe("embedded");
    // poly5 stored as [r⁴coeff, r²coeff] = [k2, k1] when S = 1.
    expect(r!.distortion).toEqual({ model: "poly5", k: [0.02, -0.1] });
    expect(r!.vignetting!.k).toEqual([-0.2, 0.05, 0]);
    expect(r!.tca!.model).toBe("poly3");
    // [br, cr, vr, bb, cb, vb]
    expect(r!.tca!.k).toEqual([0.001, 0, 1, -0.002, 0, 1]);
  });

  it("scales coefficients by the focal-normalized radius (LCP convention)", () => {
    const lcp: AdobeProfile = {
      ...profile,
      entries: [{ ...profile.entries[0], focalLengthX: 1.4 }],
    };
    const r = adobeToResolved(lcp, 50, 1.5, "lcp");
    // S = 0.5*sqrt(1 + 1/1.5²)/1.4 ≈ 0.4289; r² coeff = k1*S².
    const S = (0.5 * Math.sqrt(1 + 1 / (1.5 * 1.5))) / 1.4;
    expect(r!.distortion!.k[1]).toBeCloseTo(-0.1 * S * S, 6);
    expect(r!.distortion!.k[0]).toBeCloseTo(0.02 * S * S * S * S, 8);
  });
});
