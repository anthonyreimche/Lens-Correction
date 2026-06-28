// Lens Correction for Safelight — MIT licensed (see LICENSE).
// The extension's persisted UI intent (LensState) and the pure function that
// turns it + a resolved profile into the flat set of stage-uniform values the
// GPU stages read from the param bag. The gating here mirrors the core
// renderer's lens binding exactly, so the extension reproduces it 1:1.

import type { ResolvedProfile } from "./db/types";
import { computeAutoCropScale } from "./db/auto-crop";

export const EXT_ID = "com.safelight.lens-correction";

// Stage ids (globally unique, namespaced by the extension id).
export const STAGE = {
  distortion: `${EXT_ID}.distortion`,
  ca: `${EXT_ID}.ca`,
  vignette: `${EXT_ID}.vignette`,
  defringe: `${EXT_ID}.defringe`,
} as const;

// The single param-bag key holding the user's lens-correction intent for a
// photo. It has no GLSL descriptor, so the host preserves it verbatim across
// save/load even while the extension is disabled.
export const STATE_KEY = `${EXT_ID}:state`;

export type LensMode = "off" | "profile" | "manual";
export type ProfilePref = "auto" | "lensfun" | "embedded" | "lcp";

/** Persisted per-photo intent. */
export interface LensState {
  mode: LensMode;
  /** Which profile source to prefer when several are available. */
  pref: ProfilePref;
  /** Explicit Lensfun lens id (manual picker / remembered choice), or null. */
  lensId: string | null;
  distortionEnabled: boolean;
  caEnabled: boolean;
  vignetteEnabled: boolean;
  autoCrop: boolean;
  /** Manual sliders. */
  distortion: number; // -100..100
  chromaticAberration: number; // 0..100 (manual fringing)
  defringe: number; // 0..100
  vignetting: number; // -100..100
  /** Auto chromatic aberration estimated from the image. */
  caAuto: boolean;
  /** Estimated per-channel radial scale (relative to green); 1 = none. */
  autoCaR: number;
  autoCaB: number;
  /** Advanced defringe (Phase 3). */
  defringePurpleHue: number; // 0..360 (0 = off)
  defringeGreenHue: number; // 0..360 (0 = off)
  defringeRadius: number; // 0..100
}

export function defaultState(autoApply: boolean): LensState {
  return {
    mode: autoApply ? "profile" : "off",
    pref: "auto",
    lensId: null,
    distortionEnabled: true,
    caEnabled: true,
    vignetteEnabled: true,
    autoCrop: true,
    distortion: 0,
    chromaticAberration: 0,
    defringe: 0,
    vignetting: 0,
    caAuto: false,
    autoCaR: 1,
    autoCaB: 1,
    defringePurpleHue: 0,
    defringeGreenHue: 0,
    defringeRadius: 50,
  };
}

/** Coerce an unknown persisted value into a complete LensState. */
export function normalizeState(raw: unknown, autoApply: boolean): LensState {
  const d = defaultState(autoApply);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fb: number) => (typeof v === "number" && isFinite(v) ? v : fb);
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const mode: LensMode = r.mode === "profile" || r.mode === "manual" || r.mode === "off" ? r.mode : d.mode;
  const pref: ProfilePref =
    r.pref === "lensfun" || r.pref === "embedded" || r.pref === "lcp" || r.pref === "auto" ? r.pref : d.pref;
  return {
    mode,
    pref,
    lensId: typeof r.lensId === "string" ? r.lensId : null,
    distortionEnabled: bool(r.distortionEnabled, d.distortionEnabled),
    caEnabled: bool(r.caEnabled, d.caEnabled),
    vignetteEnabled: bool(r.vignetteEnabled, d.vignetteEnabled),
    autoCrop: bool(r.autoCrop, d.autoCrop),
    distortion: num(r.distortion, 0),
    chromaticAberration: num(r.chromaticAberration, 0),
    defringe: num(r.defringe, 0),
    vignetting: num(r.vignetting, 0),
    caAuto: bool(r.caAuto, false),
    autoCaR: num(r.autoCaR, 1),
    autoCaB: num(r.autoCaB, 1),
    defringePurpleHue: num(r.defringePurpleHue, 0),
    defringeGreenHue: num(r.defringeGreenHue, 0),
    defringeRadius: num(r.defringeRadius, 50),
  };
}

// ─── Stage-uniform values ────────────────────────────────────────────────────

/** Qualify a stage-local uniform key for the param bag, e.g.
 *  "com.safelight.lens-correction.distortion.distModel". */
function qk(stageId: string, key: string): string {
  return `${stageId}.${key}`;
}

/**
 * Turn the user's intent + the resolved profile into the flat param-bag values
 * the four GPU stages read. Mirrors src/rendering/webgl/renderer.ts lens
 * binding (uLens* gating) so the extension reproduces core behaviour exactly.
 *
 * `aspect` is the image's width/height (for CPU auto-crop and the CA prepass's
 * radius normalization; the in-shader stages use the engine's uImageAspect).
 */
export function computeStageUniforms(
  state: LensState,
  profile: ResolvedProfile | null,
  aspect: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const set = (stageId: string, key: string, value: number) => {
    out[qk(stageId, key)] = value;
  };

  const mode = state.mode;
  const useProfile = mode === "profile" && profile !== null;

  // ── Distortion (geometry) ──
  set(STAGE.distortion, "distManual", mode !== "off" ? state.distortion : 0);
  if (useProfile && profile!.distortion && state.distortionEnabled) {
    const d = profile!.distortion;
    set(STAGE.distortion, "distModel", d.model === "poly3" ? 1 : d.model === "poly5" ? 2 : 3);
    set(STAGE.distortion, "distKA", d.k[0] ?? 0);
    set(STAGE.distortion, "distKB", d.k.length > 1 ? d.k[1] : d.k[0] ?? 0);
    set(STAGE.distortion, "distKC", d.k[2] ?? 0);
  } else {
    set(STAGE.distortion, "distModel", 0);
    set(STAGE.distortion, "distKA", 0);
    set(STAGE.distortion, "distKB", 0);
    set(STAGE.distortion, "distKC", 0);
  }
  // Auto-crop: profile mode with profile distortion only (manual mode: user owns it).
  let cropScale = 1;
  if (state.autoCrop && useProfile && profile!.distortion && state.distortionEnabled) {
    cropScale = computeAutoCropScale(
      profile!.distortion.model,
      profile!.distortion.k,
      state.distortion,
      aspect,
    );
  }
  set(STAGE.distortion, "cropScale", cropScale);

  // ── Chromatic aberration (decode prepass) ──
  set(STAGE.ca, "caManual", mode === "manual" ? state.chromaticAberration : 0);
  set(STAGE.ca, "caAspect", aspect);
  if (useProfile && profile!.tca && state.caEnabled) {
    const t = profile!.tca;
    if (t.model === "linear") {
      set(STAGE.ca, "tcaModel", 1);
      set(STAGE.ca, "tcaKR", t.k[0] ?? 1);
      set(STAGE.ca, "tcaKB", t.k[1] ?? 1);
      set(STAGE.ca, "tcaBR", 0);
      set(STAGE.ca, "tcaCR", 0);
      set(STAGE.ca, "tcaBB", 0);
      set(STAGE.ca, "tcaCB", 0);
    } else {
      // poly3: [br, cr, vr, bb, cb, vb]
      set(STAGE.ca, "tcaModel", 2);
      set(STAGE.ca, "tcaBR", t.k[0] ?? 0);
      set(STAGE.ca, "tcaCR", t.k[1] ?? 0);
      set(STAGE.ca, "tcaKR", t.k[2] ?? 1);
      set(STAGE.ca, "tcaBB", t.k[3] ?? 0);
      set(STAGE.ca, "tcaCB", t.k[4] ?? 0);
      set(STAGE.ca, "tcaKB", t.k[5] ?? 1);
    }
  } else {
    set(STAGE.ca, "tcaModel", 0);
    set(STAGE.ca, "tcaKR", 1);
    set(STAGE.ca, "tcaKB", 1);
    set(STAGE.ca, "tcaBR", 0);
    set(STAGE.ca, "tcaCR", 0);
    set(STAGE.ca, "tcaBB", 0);
    set(STAGE.ca, "tcaCB", 0);
  }
  // Auto CA (estimated from the image) overrides the profile CA when enabled:
  // a global per-channel radial scale (the linear TCA model).
  if (mode !== "off" && state.caAuto && (state.autoCaR !== 1 || state.autoCaB !== 1)) {
    set(STAGE.ca, "tcaModel", 1);
    set(STAGE.ca, "tcaKR", state.autoCaR);
    set(STAGE.ca, "tcaKB", state.autoCaB);
    set(STAGE.ca, "tcaBR", 0);
    set(STAGE.ca, "tcaCR", 0);
    set(STAGE.ca, "tcaBB", 0);
    set(STAGE.ca, "tcaCB", 0);
  }

  // ── Vignetting (scene-linear) ──
  set(STAGE.vignette, "vigManual", mode === "manual" ? state.vignetting : 0);
  if (useProfile && profile!.vignetting && state.vignetteEnabled) {
    set(STAGE.vignette, "vigK1", profile!.vignetting.k[0]);
    set(STAGE.vignette, "vigK2", profile!.vignetting.k[1]);
    set(STAGE.vignette, "vigK3", profile!.vignetting.k[2]);
  } else {
    set(STAGE.vignette, "vigK1", 0);
    set(STAGE.vignette, "vigK2", 0);
    set(STAGE.vignette, "vigK3", 0);
  }

  // ── Defringe (effects) ──
  set(STAGE.defringe, "dfAmount", mode !== "off" ? state.defringe : 0);
  set(STAGE.defringe, "dfPurpleHue", mode !== "off" ? state.defringePurpleHue : 0);
  set(STAGE.defringe, "dfGreenHue", mode !== "off" ? state.defringeGreenHue : 0);
  set(STAGE.defringe, "dfRadius", state.defringeRadius);

  return out;
}

/** True when the CA decode prepass needs to run for this state+profile (used to
 *  register/unregister the expensive prepass stage rather than run it idle). */
export function caActive(state: LensState, profile: ResolvedProfile | null): boolean {
  if (state.mode === "off") return false;
  if (state.caAuto && (state.autoCaR !== 1 || state.autoCaB !== 1)) return true;
  if (state.mode === "manual") return state.chromaticAberration > 0.001;
  return state.caEnabled && !!profile?.tca;
}
