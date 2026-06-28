// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The four GPU processing-stage contributions that reproduce the core lens
// pipeline. Each stage's inline GLSL is spliced into the develop shader at its
// phase marker and operates on the marker's working variable:
//   geometry      → vec2 srcUv   (mutable source UV, before sampling)
//   decode        → vec3 lin     (scene-linear color; CA replaces it via a prepass)
//   scene-linear  → vec3 lin
//   effects       → vec3 c       (display-encoded color)
// uImageAspect, sensorUv, srcUv, vUv and luma() are provided by the host shader.
//
// IMPORTANT: the host compiler rewrites a stage's uniform `key`s by naive string
// replaceAll over the GLSL, so every uniform key here is distinctive and is
// never a substring of another key in the same stage nor of any local name.

import type { ProcessingStageContribution } from "./types/safelight";
import { STAGE } from "./params";

// ─── Distortion + auto-crop (geometry) ──────────────────────────────────────

export const distortionStage: ProcessingStageContribution = {
  id: STAGE.distortion,
  name: "Lens Distortion",
  phase: "geometry",
  uniforms: [
    { key: "distModel", glslType: "int", default: 0 },
    { key: "distKA", glslType: "float", default: 0 },
    { key: "distKB", glslType: "float", default: 0 },
    { key: "distKC", glslType: "float", default: 0 },
    { key: "distManual", glslType: "float", default: 0 },
    { key: "cropScale", glslType: "float", default: 1 },
  ],
  glsl: `
    vec2 cen = srcUv - 0.5;
    vec2 phys = vec2(cen.x * uImageAspect, cen.y);
    float halfDiag = 0.5 * sqrt(uImageAspect * uImageAspect + 1.0);
    float rr = length(phys) / halfDiag;
    float rr2 = rr * rr;
    float scl = 1.0;
    if (distModel == 1) {
      scl = 1.0 - distKB + distKB * rr2;
    } else if (distModel == 2) {
      scl = 1.0 + distKB * rr2 + distKA * rr2 * rr2;
    } else if (distModel == 3) {
      scl = distKA * rr2 * rr + distKB * rr2 + distKC * rr
          + (1.0 - distKA - distKB - distKC);
    }
    if (abs(distManual) > 0.001) {
      scl += distManual * 0.0003 * rr2;
    }
    vec2 res = 0.5 + cen * scl;
    if (cropScale > 1.001) {
      res = 0.5 + (res - 0.5) / cropScale;
    }
    srcUv = res;
  `,
};

// ─── Lateral chromatic aberration (decode, via channel-split prepass) ────────
// The prepass resamples the source channel-by-channel at radially-scaled UVs and
// writes the corrected RGB; the inline replaces the centre-sampled `lin` with it
// when CA is active. This is the one correction core does by re-sampling the
// source, which a single geometry-UV warp can't express.

export const caStage: ProcessingStageContribution = {
  id: STAGE.ca,
  name: "Lens Chromatic Aberration",
  phase: "decode",
  uniforms: [
    { key: "tcaModel", glslType: "int", default: 0 },
    { key: "caManual", glslType: "float", default: 0 },
  ],
  passes: [
    {
      uniforms: [
        { key: "tcaModel", glslType: "int", default: 0 },
        { key: "tcaKR", glslType: "float", default: 1 },
        { key: "tcaKB", glslType: "float", default: 1 },
        { key: "tcaBR", glslType: "float", default: 0 },
        { key: "tcaCR", glslType: "float", default: 0 },
        { key: "tcaBB", glslType: "float", default: 0 },
        { key: "tcaCB", glslType: "float", default: 0 },
        { key: "caManual", glslType: "float", default: 0 },
        { key: "caAspect", glslType: "float", default: 1.5 },
      ],
      glsl: `
        vec2 cen = vUv - 0.5;
        vec2 phys = vec2(cen.x * caAspect, cen.y);
        float halfDiag = 0.5 * sqrt(caAspect * caAspect + 1.0);
        float rr = length(phys) / halfDiag;
        float rr2 = rr * rr;
        float sclR = 1.0;
        float sclB = 1.0;
        if (tcaModel == 1) {
          sclR = tcaKR;
          sclB = tcaKB;
        } else if (tcaModel == 2) {
          sclR = tcaBR * rr2 + tcaCR * rr + tcaKR;
          sclB = tcaBB * rr2 + tcaCB * rr + tcaKB;
        }
        if (caManual > 0.001) {
          float ofs = caManual / 100.0 * 0.008 * rr2 * 4.0;
          sclR += ofs;
          sclB -= ofs;
        }
        vec2 uvR = 0.5 + cen * sclR;
        vec2 uvB = 0.5 + cen * sclB;
        c = vec3(
          readPrev(clamp(uvR, 0.0, 1.0)).r,
          readPrev(vUv).g,
          readPrev(clamp(uvB, 0.0, 1.0)).b
        );
      `,
    },
  ],
  glsl: `
    if (tcaModel > 0 || caManual > 0.001) {
      lin = stageResult;
    }
  `,
};

// ─── Vignetting (scene-linear) ──────────────────────────────────────────────

export const vignetteStage: ProcessingStageContribution = {
  id: STAGE.vignette,
  name: "Lens Vignetting",
  phase: "scene-linear",
  uniforms: [
    { key: "vigK1", glslType: "float", default: 0 },
    { key: "vigK2", glslType: "float", default: 0 },
    { key: "vigK3", glslType: "float", default: 0 },
    { key: "vigManual", glslType: "float", default: 0 },
  ],
  glsl: `
    vec2 cen = sensorUv - 0.5;
    vec2 phys = vec2(cen.x * uImageAspect, cen.y);
    float halfDiag = 0.5 * sqrt(uImageAspect * uImageAspect + 1.0);
    float rr = length(phys) / halfDiag;
    float rr2 = rr * rr;
    float fac = 1.0;
    if (abs(vigK1) > 0.0001 || abs(vigK2) > 0.0001 || abs(vigK3) > 0.0001) {
      float rr4 = rr2 * rr2;
      float rr6 = rr4 * rr2;
      float vg = 1.0 + vigK1 * rr2 + vigK2 * rr4 + vigK3 * rr6;
      fac = 1.0 / max(vg, 0.01);
    }
    if (abs(vigManual) > 0.001) {
      float fo = pow(clamp(1.0 - rr2 * 0.5, 0.0, 1.0), 2.0);
      float mn = vigManual > 0.0
        ? 1.0 + (1.0 - fo) * (vigManual / 100.0)
        : 1.0 - (1.0 - fo) * (-vigManual / 100.0);
      fac *= mn;
    }
    lin *= clamp(fac, 0.0, 4.0);
  `,
};

// ─── Defringe (effects) ─────────────────────────────────────────────────────
// Phase-2 parity: amount-driven purple/green fringe desaturation, matching core
// applyDefringe(). Phase 3 extends this with the hue-picker uniforms.

export const defringeStage: ProcessingStageContribution = {
  id: STAGE.defringe,
  name: "Lens Defringe",
  phase: "effects",
  uniforms: [
    { key: "dfAmount", glslType: "float", default: 0 },
    { key: "dfPurpleHue", glslType: "float", default: 0 }, // 0 = off (use default purple detection)
    { key: "dfGreenHue", glslType: "float", default: 0 }, // 0 = off (use default green detection)
    { key: "dfRadius", glslType: "float", default: 50 }, // hue tolerance, degrees-ish
  ],
  glsl: `
    if (dfAmount >= 0.001) {
      float lm = luma(c);
      float chroma = length(c - vec3(lm));
      float purpleish = max(0.0, c.b - c.r) + max(0.0, c.b - c.g);
      float greenish = max(0.0, c.g - c.r) + max(0.0, c.g - c.b);
      float fringeMag;
      if (dfPurpleHue > 0.5 || dfGreenHue > 0.5) {
        // Hue-targeted: weight each fringe family by proximity to a picked hue.
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
  `,
};

/** Stages always registered (cheap inline corrections). The CA stage is
 *  registered on demand (its prepass shouldn't run when CA is inactive). */
export const alwaysStages: ProcessingStageContribution[] = [
  distortionStage,
  vignetteStage,
  defringeStage,
];
