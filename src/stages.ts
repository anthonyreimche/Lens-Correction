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
// Bound by distortionUniforms() and mirrored on the CPU by distortionScale()
// (distortion.ts), which auto-crop evaluates; the two must stay in step.

export const distortionStage: ProcessingStageContribution = {
  id: STAGE.distortion,
  name: "Lens Distortion",
  phase: "geometry",
  uniforms: [
    { key: "distModel", glslType: "int", default: 0 },
    { key: "distKA", glslType: "float", default: 0 },
    { key: "distKB", glslType: "float", default: 0 },
    { key: "distKC", glslType: "float", default: 0 },
    { key: "distRScale", glslType: "float", default: 1 },
    { key: "distManual", glslType: "float", default: 0 },
    { key: "cropScale", glslType: "float", default: 1 },
  ],
  glsl: `
    vec2 cen = srcUv - 0.5;
    vec2 phys = vec2(cen.x * uImageAspect, cen.y);
    float halfDiag = 0.5 * sqrt(uImageAspect * uImageAspect + 1.0);
    float rr = length(phys) / halfDiag;
    float rr2 = rr * rr;
    float rp = rr * distRScale;
    float rp2 = rp * rp;
    float scl = 1.0;
    if (distModel == 1) {
      scl = 1.0 - distKA + distKA * rp2;
    } else if (distModel == 2) {
      scl = 1.0 + distKA * rp2 + distKB * rp2 * rp2 + distKC * rp2 * rp2 * rp2;
    } else if (distModel == 3) {
      scl = distKA * rp2 * rp + distKB * rp2 + distKC * rp
          + (1.0 - distKA - distKB - distKC);
    } else if (distModel == 4 && rp > 0.0) {
      float fishTheta = atan(rp);
      float fishTheta2 = fishTheta * fishTheta;
      scl = fishTheta / rp * (1.0 + distKA * fishTheta2 + distKB * fishTheta2 * fishTheta2);
    }
    if (abs(distManual) > 0.001) {
      scl += distManual * 0.0003 * rr2;
    }
    srcUv = 0.5 + cen * (scl / cropScale);
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
  // It replaces `lin` with a resample of the source, so it runs ahead of every
  // other decode stage, whose work it would otherwise discard.
  priority: 0,
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
        { key: "tcaRScale", glslType: "float", default: 1 },
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
          float rt = rr * tcaRScale;
          sclR = tcaBR * rt * rt + tcaCR * rt + tcaKR;
          sclB = tcaBB * rt * rt + tcaCB * rt + tcaKB;
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
  // A mask's copy multiplies in the mask's own manual vignetting on top of the
  // photo's correction; its profile terms stay 0, so the lens isn't corrected twice.
  mask: { maskable: true },
};

// ─── Defringe (effects) ─────────────────────────────────────────────────────
// Phase-2 parity: amount-driven purple/green fringe desaturation, matching core
// applyDefringe(). Phase 3 extends this with the hue-picker uniforms. The stages
// are always registered, so they declare the display's own space (the host adds
// no clip). Defringe finds fringes on a copy clipped to [0, 1] and desaturates
// the pixel itself, so the image keeps its full range. Photos on process
// version 1 keep the defringe they were edited with, which clipped the pixel
// itself.
//
// Version 2 defringes ahead of the effects' Vignette (50) and Grain (60), whose
// darkening and grain colour in bright areas it would otherwise read as fringe.
// Version 1 keeps its place after them. Priority holds for every photo, so the
// two places are two stages, and on each version one of them compiles to
// nothing. The first keeps the original id and so the settings saved edits,
// presets and masks hold; it hands their values to the second.

const DEFRINGE_SETTINGS = "lensCorrectionDefringe";

const DEFRINGE_BODY = `
      float lm = luma(cd);
      float chroma = length(cd - vec3(lm));
      float purpleish = max(0.0, cd.b - cd.r) + max(0.0, cd.b - cd.g);
      float greenish = max(0.0, cd.g - cd.r) + max(0.0, cd.g - cd.b);
      float fringeMag;
      if (dfPurpleHue > 0.5 || dfGreenHue > 0.5) {
        // Hue-targeted: weight each fringe family by proximity to a picked hue.
        float mx = max(cd.r, max(cd.g, cd.b));
        float mn = min(cd.r, min(cd.g, cd.b));
        float dl = mx - mn;
        float hue = 0.0;
        if (dl > 1e-5) {
          if (mx == cd.r) hue = mod((cd.g - cd.b) / dl, 6.0);
          else if (mx == cd.g) hue = (cd.b - cd.r) / dl + 2.0;
          else hue = (cd.r - cd.g) / dl + 4.0;
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
      c = mix(c, vec3(luma(c)), suppress);`;

export const defringeStage: ProcessingStageContribution = {
  id: STAGE.defringe,
  name: "Lens Defringe",
  phase: "effects",
  priority: 0,
  space: { encoding: "perceptual" },
  uniforms: [
    { key: "dfAmount", glslType: "float", default: 0 },
    { key: "dfPurpleHue", glslType: "float", default: 0 }, // 0 = off (use default purple detection)
    { key: "dfGreenHue", glslType: "float", default: 0 }, // 0 = off (use default green detection)
    { key: "dfRadius", glslType: "float", default: 50 }, // hue tolerance, degrees-ish
  ],
  glsl: `
#if SL_PROCESS_VERSION >= 2
    if (dfAmount >= 0.001) {
      vec3 cd = clamp(c, 0.0, 1.0);${DEFRINGE_BODY}
    }
#endif
  `,
  produces: [
    { name: DEFRINGE_SETTINGS, glslType: "vec4", producer: "vec4(dfAmount, dfPurpleHue, dfGreenHue, dfRadius)" },
  ],
  // A mask's copy defringes again inside the mask with the mask's own amount and hues.
  mask: { maskable: true },
};

export const defringeV1Stage: ProcessingStageContribution = {
  id: STAGE.defringeV1,
  name: "Lens Defringe (version 1)",
  phase: "effects",
  priority: 100,
  space: { encoding: "perceptual" },
  uniforms: [],
  consumes: [DEFRINGE_SETTINGS],
  glsl: `
#if SL_PROCESS_VERSION < 2
    float dfAmount = isv_${DEFRINGE_SETTINGS}.x;
    float dfPurpleHue = isv_${DEFRINGE_SETTINGS}.y;
    float dfGreenHue = isv_${DEFRINGE_SETTINGS}.z;
    float dfRadius = isv_${DEFRINGE_SETTINGS}.w;
    if (dfAmount >= 0.001) {
      c = clamp(c, 0.0, 1.0);
      vec3 cd = c;${DEFRINGE_BODY}
    }
#endif
  `,
};

/** Stages always registered (cheap inline corrections). The CA stage is
 *  registered on demand (its prepass shouldn't run when CA is inactive). */
export const alwaysStages: ProcessingStageContribution[] = [
  distortionStage,
  vignetteStage,
  defringeStage,
  defringeV1Stage,
];
