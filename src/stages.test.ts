import { describe, it, expect } from "vitest";
import type { ProcessingStageContribution, UniformDeclaration } from "./types/safelight";
import { caStage, defringeStage, distortionStage, vignetteStage } from "./stages";
import { distortionUniforms } from "./distortion";
import manifest from "../safelight.json";

const stages = [distortionStage, caStage, vignetteStage, defringeStage];

function sources(stage: ProcessingStageContribution): { glsl: string; uniforms: UniformDeclaration[] }[] {
  return [{ glsl: stage.glsl, uniforms: stage.uniforms }, ...(stage.passes ?? []).map((p) => ({ glsl: p.glsl, uniforms: p.uniforms ?? [] }))];
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/** Occurrences of `key` in `glsl` that sit inside a longer identifier. */
function embeddedOccurrences(glsl: string, key: string): string[] {
  const found: string[] = [];
  for (let at = glsl.indexOf(key); at >= 0; at = glsl.indexOf(key, at + 1)) {
    const before = glsl[at - 1] ?? " ";
    const after = glsl[at + key.length] ?? " ";
    if (IDENTIFIER_CHAR.test(before) || IDENTIFIER_CHAR.test(after)) found.push(glsl.slice(Math.max(0, at - 8), at + key.length + 8));
  }
  return found;
}

describe("stage uniform keys", () => {
  it("the distortion stage declares exactly the keys the binding produces, plus the crop", () => {
    const declared = distortionStage.uniforms.map((u) => u.key).sort();
    expect(declared).toEqual([...Object.keys(distortionUniforms(null, 0)), "cropScale"].sort());
  });

  it("the CA prepass declares a radius scale for its polynomial", () => {
    expect(caStage.passes![0].uniforms!.find((u) => u.key === "tcaRScale")?.default).toBe(1);
  });

  // The host substitutes uniform keys by naive replaceAll over each GLSL source.
  it.each(stages.map((s) => [s.name, s] as const))("%s: every key occurs only as a whole identifier", (_, stage) => {
    for (const { glsl, uniforms } of sources(stage)) {
      for (const { key } of uniforms) expect(embeddedOccurrences(glsl, key), key).toEqual([]);
    }
  });
});

// On process version 2 the host clips a display stage that declares no space to
// [0, 1] ahead of its block, outside its own gate, for as long as it is
// registered, and the image stays full range through every stage. Defringe
// judges fringes on a clipped copy and mixes into the pixel itself, so a pixel
// it doesn't suppress keeps its value, over range or not.
describe("display-phase stages", () => {
  const DISPLAY_PHASES = new Set(["display-adjust", "effects", "output-encode"]);

  it("every display-phase stage declares the display's own space", () => {
    for (const stage of stages.filter((s) => DISPLAY_PHASES.has(s.phase))) {
      expect(stage.space, stage.id).toEqual({ encoding: "perceptual" });
    }
  });

  it("defringe never writes a clipped value back into the image", () => {
    const glsl = forVersion(defringeStage.glsl, 2).replace(/\s+/g, " ").trim();
    expect(glsl).not.toMatch(/\bc = clamp\(c\b/);
    const copy = /^if \(dfAmount >= 0\.001\) \{ vec3 (\w+) = clamp\(c, 0\.0, 1\.0\);/.exec(glsl);
    expect(copy, "the fringe tests read a clipped copy inside the gate").not.toBeNull();
    expect(glsl).toContain(`float lm = luma(${copy![1]});`);
    expect(glsl).toMatch(/c = mix\(c, vec3\(luma\(c\)\), suppress\); \}$/);
  });

  // Process version 1 photos keep the defringe they were edited with, which
  // clipped the pixel itself to [0, 1] inside the gate.
  it("defringe clips the pixel on process version 1, as before the range fix", () => {
    const v1 = forVersion(defringeStage.glsl, 1);
    expect(v1).toMatch(/^\s*c = clamp\(c, 0\.0, 1\.0\);\n\s*vec3 cd = c;$/m);
    // With cd the clipped c itself, luma(c) is lm and the shader is the old one.
    const asBefore = v1
      .replace(/^\s*vec3 cd = c;\n/m, "")
      .replace(/\bcd\b/g, "c")
      .replace("vec3(luma(c))", "vec3(lm)");
    const squash = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
    expect(squash(asBefore)).toBe(squash(DEFRINGE_BEFORE_RANGE_FIX));
  });

  it("defringe gives version 3 the version 2 path, one directive per line", () => {
    const src = defringeStage.glsl;
    expect(src).toContain("#if SL_PROCESS_VERSION >= 2");
    expect(forVersion(src, 3)).toBe(forVersion(src, 2));
    for (const line of src.split("\n").filter((l) => l.trim().startsWith("#"))) {
      expect(line.trim()).toMatch(/^(#if SL_PROCESS_VERSION >= 2|#else|#endif)$/);
    }
  });

  it("needs Safelight 3.2.0, the first to define SL_PROCESS_VERSION", () => {
    expect(manifest.minAppVersion).toBe("3.2.0");
  });
});

/** The source as the host's GLSL preprocessor leaves it for a photo at
 *  `version`: the `#if SL_PROCESS_VERSION >= n` branches resolved and the
 *  directive lines gone. */
function forVersion(src: string, version: number): string {
  const taking: boolean[] = [];
  const out: string[] = [];
  for (const line of src.split("\n")) {
    const open = /^\s*#if SL_PROCESS_VERSION >= (\d+)\s*$/.exec(line);
    if (open) taking.push(version >= Number(open[1]));
    else if (/^\s*#else\s*$/.test(line)) taking.push(!taking.pop());
    else if (/^\s*#endif\s*$/.test(line)) taking.pop();
    else if (taking.every(Boolean)) out.push(line);
  }
  expect(taking).toEqual([]);
  return out.join("\n");
}

const DEFRINGE_BEFORE_RANGE_FIX = `
    if (dfAmount >= 0.001) {
      c = clamp(c, 0.0, 1.0);
      float lm = luma(c);
      float chroma = length(c - vec3(lm));
      float purpleish = max(0.0, c.b - c.r) + max(0.0, c.b - c.g);
      float greenish = max(0.0, c.g - c.r) + max(0.0, c.g - c.b);
      float fringeMag;
      if (dfPurpleHue > 0.5 || dfGreenHue > 0.5) {
        float mx = max(c.r, max(c.g, c.b));
        float mn = min(c.r, min(c.g, c.b));
        float dl = mx - mn;
        float hue = 0.0;
        if (dl > 1e-5) {
          if (mx == c.r) hue = mod((c.g - c.b) / dl, 6.0);
          else if (mx == c.g) hue = (c.b - c.r) / dl + 2.0;
          else hue = (c.r - c.g) / dl + 4.0;
          hue *= 60.0;
        }
        float tol = max(dfRadius, 1.0);
        float pd = abs(hue - dfPurpleHue); pd = min(pd, 360.0 - pd);
        float gd = abs(hue - dfGreenHue); gd = min(gd, 360.0 - gd);
        float wP = dfPurpleHue > 0.5 ? clamp(1.0 - pd / tol, 0.0, 1.0) : 0.0;
        float wG = dfGreenHue > 0.5 ? clamp(1.0 - gd / tol, 0.0, 1.0) : 0.0;
        fringeMag = clamp((purpleish * wP + greenish * wG) * 4.0, 0.0, 1.0);
      } else {
        fringeMag = clamp((purpleish + greenish) * 4.0, 0.0, 1.0);
      }
      float suppress = clamp(dfAmount / 100.0 * fringeMag * (chroma * 8.0), 0.0, 1.0);
      c = mix(c, vec3(lm), suppress);
    }
  `;

// Masks run a copy of a stage only from scene-linear on; distortion (geometry)
// and CA (decode) run before mask coverage is known.
describe("masks", () => {
  it("runs vignetting and defringe again inside masks", () => {
    expect(vignetteStage.mask).toEqual({ maskable: true });
    expect(defringeStage.mask).toEqual({ maskable: true });
  });

  it("leaves distortion and chromatic aberration to the photo", () => {
    expect(distortionStage.mask).toBeUndefined();
    expect(caStage.mask).toBeUndefined();
  });
});

// The CA inline replaces `lin` with a resample of the source, so a decode stage
// ordered ahead of it (capture sharpening, moiré reduction) would be discarded.
describe("decode order", () => {
  it("runs chromatic aberration ahead of every other decode stage", () => {
    expect(caStage.phase).toBe("decode");
    expect(caStage.priority).toBe(0);
  });
});
