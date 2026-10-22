import { describe, it, expect } from "vitest";
import type { ProcessingStageContribution, UniformDeclaration } from "./types/safelight";
import { caStage, defringeStage, distortionStage, vignetteStage } from "./stages";
import { distortionUniforms } from "./distortion";

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
// registered. Defringe is always registered, so it clips only inside its gate.
describe("display-phase stages", () => {
  const DISPLAY_PHASES = new Set(["display-adjust", "effects", "output-encode"]);

  it("every display-phase stage declares the display's own space", () => {
    for (const stage of stages.filter((s) => DISPLAY_PHASES.has(s.phase))) {
      expect(stage.space, stage.id).toEqual({ encoding: "perceptual" });
    }
  });

  it("defringe clips its input only inside its amount gate", () => {
    const glsl = defringeStage.glsl.replace(/\s+/g, " ").trim();
    expect(glsl.startsWith("if (dfAmount >= 0.001) { c = clamp(c, 0.0, 1.0);")).toBe(true);
  });
});
