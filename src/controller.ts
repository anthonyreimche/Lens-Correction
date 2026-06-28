// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Runtime orchestration: watch the Develop photo, resolve a lens profile from
// its EXIF (or a manual / embedded / LCP override), push the resulting
// coefficients into the GPU stages via the param bag, and expose a small store
// the panel renders from. Mirrors core's resolveLensForPhoto + renderer binding.

import type { SafelightAPI, ExifData, CatalogPhoto } from "./types/safelight";
import type { ResolvedProfile } from "./db/types";
import { loadLensDb, getCachedLensDb, findLensById } from "./db/loader";
import { resolveForPhoto, resolveForLens, matchLens } from "./db/matcher";
import { resolveEmbedded } from "./features/embedded";
import { resolveLcp } from "./features/lcp";
import { importLcpFile } from "./features/parse-lcp";
import { estimateAutoCa } from "./features/auto-ca";
import {
  type LensState,
  STATE_KEY,
  computeStageUniforms,
  normalizeState,
  defaultState,
  caActive,
} from "./params";
import { caStage, alwaysStages } from "./stages";

export interface LensUIState {
  /** The profile actually applied to the GPU (null in off/manual or no match). */
  profile: ResolvedProfile | null;
  /** Display name of the auto-detected (or chosen) lens, regardless of mode. */
  detectedName: string | null;
  /** Where the applied profile came from. */
  source: ResolvedProfile["source"] | null;
  state: LensState;
  photoId: string | null;
  /** Transient status line (auto-CA progress, LCP import result). */
  status: string | null;
  busy: boolean;
}

let api: SafelightAPI;
// zustand store hook created from api.stores.create — the panel calls it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let uiStore: any = null;
let caRegistered = false;
let unsubDevelop: (() => void) | null = null;
let resolveSeq = 0;

// Cache the resolved profile by the inputs that actually affect resolution, so
// dragging a manual slider re-pushes uniforms without re-matching the database.
let cacheKey = "";
let cacheProfile: ResolvedProfile | null = null;

export function getUIStore() {
  return uiStore;
}

export function initController(a: SafelightAPI): void {
  api = a;
  const autoApply = api.settings.get("autoApply", true);
  uiStore = api.stores.create(
    (): LensUIState => ({
      profile: null,
      detectedName: null,
      source: null,
      state: defaultState(autoApply),
      photoId: null,
      status: null,
      busy: false,
    }),
  );

  for (const s of alwaysStages) api.registerProcessingStage(s);

  unsubDevelop = api.stores.useDevelopStore.subscribe((s, prev) => {
    if (s.photoId !== prev.photoId) void recompute();
  });
  // Warm the DB and resolve the currently-open photo.
  void loadLensDb().then(() => recompute());
  void recompute();
}

export function disposeController(): void {
  unsubDevelop?.();
  unsubDevelop = null;
  for (const s of alwaysStages) api.unregisterProcessingStage(s.id);
  if (caRegistered) {
    api.unregisterProcessingStage(caStage.id);
    caRegistered = false;
  }
  cacheKey = "";
  cacheProfile = null;
}

// ─── State access ────────────────────────────────────────────────────────────

export function readState(): LensState {
  const autoApply = api.settings.get("autoApply", true);
  const bag = api.stores.useDevelopStore.getState().paramBag;
  return normalizeState(bag?.[STATE_KEY], autoApply);
}

function currentPhoto(): CatalogPhoto | null {
  const id = api.stores.useDevelopStore.getState().photoId;
  if (!id) return null;
  return api.stores.useCatalogStore.getState().photos.find((p) => p.id === id) ?? null;
}

/** Displayed image aspect (W/H), accounting for EXIF orientation. */
function photoAspect(photo: CatalogPhoto | null): number {
  const w = typeof photo?.width === "number" ? photo!.width : 0;
  const h = typeof photo?.height === "number" ? photo!.height : 0;
  if (!w || !h) return 1.5;
  const o = (photo?.exif?.orientation as number) ?? 1;
  const swap = o >= 5 && o <= 8;
  const W = swap ? h : w;
  const H = swap ? w : h;
  return H > 0 ? W / H : 1.5;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

async function resolveProfile(
  state: LensState,
  exif: ExifData,
  photoId: string | null,
  aspect: number,
): Promise<ResolvedProfile | null> {
  if (state.mode !== "profile") return null;
  const db = getCachedLensDb() ?? (await loadLensDb());

  // Explicit manual override wins.
  if (state.lensId) {
    const lens = findLensById(state.lensId);
    if (lens) return resolveForLens(lens, exif);
  }

  // A choice remembered for this lens model (from a previous manual pick) is
  // treated like an explicit pick, unless the user pinned a non-Lensfun source.
  if (state.pref === "auto" || state.pref === "lensfun") {
    const remembered = rememberedLensIdFor(exif);
    if (remembered) {
      const lens = findLensById(remembered);
      if (lens) return resolveForLens(lens, exif);
    }
  }

  // Source preference: embedded RAW corrections, then Adobe LCP, then Lensfun.
  const order =
    state.pref === "lensfun"
      ? (["lensfun"] as const)
      : state.pref === "embedded"
        ? (["embedded", "lensfun"] as const)
        : state.pref === "lcp"
          ? (["lcp", "lensfun"] as const)
          : (["embedded", "lcp", "lensfun"] as const); // auto

  for (const src of order) {
    if (src === "embedded" && photoId) {
      const e = await resolveEmbedded(api, photoId);
      if (e) return e;
    } else if (src === "lcp") {
      const l = await resolveLcp(api, exif, aspect);
      if (l) return l;
    } else if (src === "lensfun") {
      const res = resolveForPhoto(exif, db);
      if (res) return res.profile;
    }
  }
  return null;
}

// ─── The core recompute ──────────────────────────────────────────────────────

export async function recompute(): Promise<void> {
  const seq = ++resolveSeq;
  const dev = api.stores.useDevelopStore.getState();
  const photoId = dev.photoId;
  const state = readState();
  const photo = currentPhoto();
  const exif: ExifData = photo?.exif ?? {};
  const aspect = photoAspect(photo);

  // Resolve (cached by the inputs that affect resolution).
  const key = `${photoId}|${state.mode}|${state.pref}|${state.lensId}`;
  let profile: ResolvedProfile | null;
  if (key === cacheKey) {
    profile = cacheProfile;
  } else {
    profile = await resolveProfile(state, exif, photoId, aspect);
    if (seq !== resolveSeq) return; // a newer recompute superseded us
    if (api.stores.useDevelopStore.getState().photoId !== photoId) return;
    cacheKey = key;
    cacheProfile = profile;
  }

  // CA prepass: register only when active (its prepass shouldn't run idle).
  const wantCA = caActive(state, profile);
  if (wantCA && !caRegistered) {
    api.registerProcessingStage(caStage);
    caRegistered = true;
  } else if (!wantCA && caRegistered) {
    api.unregisterProcessingStage(caStage.id);
    caRegistered = false;
  }

  // Push stage uniforms.
  const uniforms = computeStageUniforms(state, profile, aspect);
  api.stores.useDevelopStore.getState().setDynParams(uniforms);

  // Detected-lens name for the panel (independent of mode).
  const db = getCachedLensDb();
  let detectedName = profile?.lensName ?? null;
  if (!detectedName && db) {
    const m = state.lensId ? findLensById(state.lensId) : matchLens(exif, db);
    if (m) detectedName = `${m.maker} ${m.model}`;
  }

  uiStore.setState({
    profile,
    detectedName,
    source: profile?.source ?? null,
    state,
    photoId,
  });
}

// ─── Mutations from the panel ────────────────────────────────────────────────

/** Merge a patch into the persisted LensState, re-render live, and optionally
 *  commit to history (on slider release / discrete actions). */
export function updateState(patch: Partial<LensState>, commitLabel?: string): void {
  const next: LensState = { ...readState(), ...patch };
  api.stores.useDevelopStore.getState().setDynParam(STATE_KEY, next);
  void recompute().then(() => {
    if (commitLabel) void api.stores.useDevelopStore.getState().commitEdit(commitLabel);
  });
}

/** Pick a specific Lensfun lens (manual picker). Switches to profile mode and
 *  remembers the choice for this lens model via settings. */
export function pickLens(lensId: string, lensName: string): void {
  rememberLens(lensName, lensId);
  updateState({ mode: "profile", lensId, pref: "lensfun" }, "Select Lens");
}

// Remember a manual lens choice keyed by the EXIF lens string, so the next photo
// from the same lens auto-selects it.
function rememberLens(_lensName: string, lensId: string): void {
  const photo = currentPhoto();
  const exifLens = photo?.exif?.lens;
  if (!exifLens) return;
  const map = api.settings.get<Record<string, string>>("rememberedLenses", {});
  api.settings.set("rememberedLenses", { ...map, [exifLens]: lensId });
}

/** Apply a remembered manual choice if one exists for this photo's EXIF lens and
 *  the state hasn't already pinned a lens. Called after a photo loads. */
export function rememberedLensIdFor(exif: ExifData): string | null {
  const lens = exif.lens;
  if (!lens) return null;
  const map = api.settings.get<Record<string, string>>("rememberedLenses", {});
  return map[lens] ?? null;
}

/** Estimate lateral CA from the current frame and apply it. */
export async function runAutoCa(): Promise<void> {
  uiStore.setState({ busy: true, status: "Analyzing chromatic aberration…" });
  try {
    const result = await estimateAutoCa(api);
    if (!result) {
      uiStore.setState({ busy: false, status: "Not enough edge detail to estimate CA." });
      return;
    }
    const cur = readState();
    updateState(
      {
        mode: cur.mode === "off" ? "profile" : cur.mode,
        caAuto: true,
        autoCaR: result.r,
        autoCaB: result.b,
      },
      "Auto Chromatic Aberration",
    );
    const pr = ((result.r - 1) * 1000).toFixed(1);
    const pb = ((result.b - 1) * 1000).toFixed(1);
    uiStore.setState({ busy: false, status: `Auto CA applied (R ${pr}‰, B ${pb}‰).` });
  } catch {
    uiStore.setState({ busy: false, status: "Auto CA failed." });
  }
}

/** Clear an auto-CA estimate. */
export function clearAutoCa(): void {
  updateState({ caAuto: false, autoCaR: 1, autoCaB: 1 }, "Clear Auto CA");
  uiStore.setState({ status: null });
}

/** Import an Adobe Lens Profile and prefer LCP corrections for this photo. */
export async function importLcp(file: File): Promise<void> {
  uiStore.setState({ busy: true, status: `Importing ${file.name}…` });
  try {
    const profile = await importLcpFile(file);
    if (!profile) {
      uiStore.setState({ busy: false, status: "Not a readable .lcp profile." });
      return;
    }
    // Invalidate the resolution cache so the new library is consulted.
    cacheKey = "";
    updateState({ mode: "profile", pref: "lcp", lensId: null }, "Import LCP");
    uiStore.setState({ busy: false, status: `Imported: ${profile.lens || profile.model}` });
  } catch {
    uiStore.setState({ busy: false, status: "LCP import failed." });
  }
}
