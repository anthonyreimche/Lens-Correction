// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Runtime orchestration: watch the Develop photo, resolve a lens profile from
// its EXIF (or a manual / embedded / LCP override), push the resulting
// coefficients into the GPU stages via the param bag, and expose a small store
// the panel renders from. Mirrors core's resolveLensForPhoto + renderer binding.

import type { SafelightAPI, ExifData, CatalogPhoto } from "./types/safelight";
import type { ResolvedProfile } from "./db/types";
import {
  loadLensDb,
  getCachedLensDb,
  findLensById,
  importLensfunXml,
  importedLensFiles,
  removeLensfunXml,
} from "./db/loader";
import { resolveForPhoto, resolveForLens, matchLens, rememberKey } from "./db/matcher";
import { lensDisplayName } from "./db/makers";
import { resolveEmbedded } from "./features/embedded";
import { resolveLcp } from "./features/lcp";
import { importLcpFile, importedLcps, removeLcp } from "./features/parse-lcp";
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
  /** Imported lens profile files, for the panel to list and remove. */
  imports: ImportedItem[];
}

export interface ImportedItem {
  kind: "xml" | "lcp";
  /** Its storage key. */
  key: string;
  label: string;
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
      imports: [],
    }),
  );

  for (const s of alwaysStages) api.registerProcessingStage(s);

  unsubDevelop = api.stores.useDevelopStore.subscribe((s, prev) => {
    if (s.photoId !== prev.photoId) void recompute();
  });
  // Warm the DB and resolve the currently-open photo.
  void loadLensDb().then(() => recompute());
  void recompute();
  void refreshImports();
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

const RENDERED_FORMATS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "avif", "jxl", "gif", "bmp"]);

/** Whether the photo is a raw file; undefined when it has no file name. */
function isRawPhoto(photo: CatalogPhoto | null): boolean | undefined {
  const ext = photo?.filename?.split(".").pop()?.toLowerCase();
  return ext ? !RENDERED_FORMATS.has(ext) : undefined;
}

const embeddedEnabled = () => api.settings.get("embeddedCorrections", true);

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
  photo: CatalogPhoto | null,
  aspect: number,
): Promise<ResolvedProfile | null> {
  const exif: ExifData = photo?.exif ?? {};
  const photoId = photo?.id ?? null;
  if (state.mode !== "profile") return null;
  const db = getCachedLensDb() ?? (await loadLensDb());

  // Explicit manual override wins.
  if (state.lensId) {
    const lens = findLensById(state.lensId);
    if (lens) return resolveForLens(lens, exif, aspect);
  }

  // A choice remembered for this lens or body (from a previous manual pick) is
  // treated like an explicit pick, unless the user pinned a non-Lensfun source.
  if (state.pref === "auto" || state.pref === "lensfun") {
    const remembered = rememberedLensIdFor(exif);
    if (remembered) {
      const lens = findLensById(remembered);
      if (lens) return resolveForLens(lens, exif, aspect);
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
          : embeddedEnabled()
            ? (["embedded", "lcp", "lensfun"] as const) // auto
            : (["lcp", "lensfun"] as const);

  for (const src of order) {
    if (src === "embedded" && photoId) {
      const e = await resolveEmbedded(api, photoId);
      if (e) return e;
    } else if (src === "lcp") {
      const l = await resolveLcp(exif, { aspect, raw: isRawPhoto(photo), fuzzy: state.pref === "lcp" });
      if (l) return l;
    } else if (src === "lensfun") {
      const res = resolveForPhoto(exif, db, aspect);
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
  const key = `${photoId}|${aspect}|${state.mode}|${state.pref}|${state.lensId}|${embeddedEnabled()}`;
  let profile: ResolvedProfile | null;
  if (key === cacheKey) {
    profile = cacheProfile;
  } else {
    profile = await resolveProfile(state, photo, aspect);
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
    if (m) detectedName = lensDisplayName(m);
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
export function updateState(patch: Partial<LensState>, commitLabel?: string): Promise<void> {
  const next: LensState = { ...readState(), ...patch };
  api.stores.useDevelopStore.getState().setDynParam(STATE_KEY, next);
  return recompute().then(() => {
    if (commitLabel) void api.stores.useDevelopStore.getState().commitEdit(commitLabel);
  });
}

/** Pick a specific Lensfun lens (manual picker). Switches to profile mode and
 *  remembers the choice for this lens or body via settings. */
export function pickLens(lensId: string, lensName: string): void {
  rememberLens(lensName, lensId);
  updateState({ mode: "profile", lensId, pref: "lensfun" }, "Select Lens");
}

// Remember a manual lens choice under the photo's rememberKey (its body for a
// built-in lens, else its EXIF lens string), so the next photo auto-selects it.
function rememberLens(_lensName: string, lensId: string): void {
  const key = rememberKey(currentPhoto()?.exif ?? {}, getCachedLensDb() ?? []);
  if (!key) return;
  const map = api.settings.get<Record<string, string>>("rememberedLenses", {});
  api.settings.set("rememberedLenses", { ...map, [key]: lensId });
}

/** Apply a remembered manual choice if one exists for this photo's body or EXIF
 *  lens and the state hasn't already pinned a lens. Called after a photo loads. */
export function rememberedLensIdFor(exif: ExifData): string | null {
  const key = rememberKey(exif, getCachedLensDb() ?? []);
  if (!key) return null;
  const map = api.settings.get<Record<string, string>>("rememberedLenses", {});
  return map[key] ?? null;
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

/** Import a lens profile file: a Lensfun .xml database file or an Adobe .lcp. */
export function importLensProfile(file: File): Promise<void> {
  return file.name.toLowerCase().endsWith(".xml") ? importLensfun(file) : importLcp(file);
}

/** Import an Adobe Lens Profile and prefer LCP corrections for this photo. */
async function importLcp(file: File): Promise<void> {
  uiStore.setState({ busy: true, status: `Importing ${file.name}…` });
  try {
    const profile = await importLcpFile(file);
    if (!profile) {
      uiStore.setState({ busy: false, status: "Not a readable .lcp profile." });
      return;
    }
    // Invalidate the resolution cache so the new library is consulted.
    cacheKey = "";
    await updateState({ mode: "profile", pref: "lcp", lensId: null }, "Import LCP");
    await refreshImports();
    const name = profile.lens || profile.model;
    const applied = uiStore.getState().source === "lcp";
    uiStore.setState({
      busy: false,
      status: applied ? `Imported: ${name}` : `Imported ${name}. It doesn't match this photo's lens.`,
    });
  } catch {
    uiStore.setState({ busy: false, status: "LCP import failed." });
  }
}

const lensCount = (n: number) => (n === 1 ? "1 lens" : `${n} lenses`);

/** Import a Lensfun XML file into the lens database and re-resolve the photo. */
async function importLensfun(file: File): Promise<void> {
  uiStore.setState({ busy: true, status: `Importing ${file.name}…` });
  try {
    const { lenses, skipped } = await importLensfunXml(file.name, await file.text());
    const unread = skipped > 0 ? ` ${lensCount(skipped)} skipped: their calibration format isn't supported.` : "";
    if (lenses.length === 0) {
      uiStore.setState({ busy: false, status: `No usable lenses in this file.${unread}` });
      return;
    }
    cacheKey = "";
    await recompute();
    await refreshImports();
    uiStore.setState({ busy: false, status: `Imported ${lensCount(lenses.length)} from ${file.name}.${unread}` });
  } catch {
    uiStore.setState({ busy: false, status: "Lens file import failed." });
  }
}

async function refreshImports(): Promise<void> {
  const [files, lcps] = await Promise.all([importedLensFiles(), importedLcps()]);
  const imports: ImportedItem[] = [
    ...files.map((f) => ({ kind: "xml" as const, key: f.key, label: `${f.name} (${lensCount(f.count)})` })),
    ...lcps.map((p) => ({ kind: "lcp" as const, key: p.key, label: p.model ? `${p.lens} (${p.model})` : p.lens })),
  ];
  uiStore.setState({ imports });
}

/** Remove an imported profile file and re-resolve the photo without it. */
export async function removeImport(item: ImportedItem): Promise<void> {
  await (item.kind === "xml" ? removeLensfunXml(item.key) : removeLcp(item.key));
  cacheKey = "";
  await recompute();
  await refreshImports();
  uiStore.setState({ status: `Removed ${item.label}.` });
}

/** An .lcp arrived through the Presets panel's import. */
export function lcpImportedElsewhere(): void {
  cacheKey = "";
  void recompute();
  void refreshImports();
}
