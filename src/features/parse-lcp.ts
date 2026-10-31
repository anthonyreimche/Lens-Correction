// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Adobe Lens Profile (.lcp) parsing + import. An .lcp is an XMP/RDF document;
// its calibration values appear inconsistently as either attributes or child
// elements, and under varying namespace prefixes, so the reader matches by
// local name and ignores prefixes. Imported profiles are stored in the LCP
// library (IndexedDB) and matched live, like Lensfun.

import type { PresetImporterContribution } from "../types/safelight";
import { EXT_ID } from "../params";
import type { AdobeProfile, AdobeEntry } from "./adobe-model";
import { idbDelete, idbEntries, idbGetAll, idbSet } from "../storage";

function localName(node: { localName?: string | null; nodeName: string }): string {
  return node.localName || node.nodeName.split(":").pop() || node.nodeName;
}

/** Read a numeric param from an element's attributes or direct child elements. */
function readNum(el: Element, name: string): number | undefined {
  for (const a of Array.from(el.attributes)) {
    if (localName(a) === name) {
      const v = parseFloat(a.value);
      return isFinite(v) ? v : undefined;
    }
  }
  for (const c of Array.from(el.children)) {
    if (localName(c) === name) {
      const v = parseFloat(c.textContent || "");
      return isFinite(v) ? v : undefined;
    }
  }
  return undefined;
}

/** The first value of a property in document order, written either as an
 *  element or as an attribute (Adobe's own profiles use attributes). */
function readStr(doc: Document, name: string): string | undefined {
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (localName(a) === name && a.value.trim()) return a.value.trim();
    }
    if (localName(el) === name && el.textContent?.trim()) return el.textContent.trim();
  }
  return undefined;
}

function elementsByLocal(root: Document | Element, name: string): Element[] {
  const all = root.getElementsByTagName("*");
  return Array.from(all).filter((el) => localName(el) === name);
}

/** Read a param from a model element OR its first child Description. */
function readModelNum(modelEl: Element, name: string): number | undefined {
  const v = readNum(modelEl, name);
  if (v !== undefined) return v;
  for (const c of Array.from(modelEl.children)) {
    const cv = readNum(c, name);
    if (cv !== undefined) return cv;
  }
  return undefined;
}

/** Walk ancestors (checking each ancestor's own attrs/children) for a value. */
function ancestorNum(el: Element, name: string): number | undefined {
  let p = el.parentElement;
  while (p) {
    const v = readNum(p, name);
    if (v !== undefined) return v;
    p = p.parentElement;
  }
  return undefined;
}

function ancestorStr(el: Element, name: string): string | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    for (const a of Array.from(p.attributes)) if (localName(a) === name) return a.value.trim();
    for (const c of Array.from(p.children)) if (localName(c) === name) return c.textContent?.trim();
  }
  return undefined;
}

/** The shooting conditions a model element was calibrated at, from the
 *  description it sits in. ApertureValue is APEX: f-number = 2^(Av/2). */
function conditionsOf(m: Element): Pick<AdobeEntry, "focal" | "aperture" | "distance" | "raw"> {
  const apex = ancestorNum(m, "ApertureValue");
  const distance = ancestorNum(m, "FocusDistance") ?? 0;
  const raw = ancestorStr(m, "CameraRawProfile")?.toLowerCase();
  return {
    focal: ancestorNum(m, "FocalLength") ?? 0,
    aperture: apex === undefined ? 0 : Math.pow(2, apex / 2),
    ...(distance > 0 && { distance }),
    ...(raw !== undefined && { raw: raw === "true" }),
  };
}

export function parseLcp(xml: string): AdobeProfile | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
  if (!doc || doc.getElementsByTagName("parsererror").length > 0) return null;

  const make = readStr(doc, "Make") ?? "";
  const model = readStr(doc, "Model") ?? "";
  const lensPrettyName = readStr(doc, "LensPrettyName");
  const lens = readStr(doc, "Lens") ?? lensPrettyName ?? "";
  const sensorFormatFactor = parseFloat(readStr(doc, "SensorFormatFactor") ?? "");
  const width = parseFloat(readStr(doc, "ImageWidth") ?? "");
  const length = parseFloat(readStr(doc, "ImageLength") ?? "");

  const byKey = new Map<string, AdobeEntry>();
  const ensure = (m: Element): AdobeEntry => {
    const at = conditionsOf(m);
    const fx = readModelNum(m, "FocalLengthX") ?? 0;
    const k = [at.focal, at.aperture, at.distance ?? 0, at.raw].join("|");
    let e = byKey.get(k);
    if (!e) {
      e = { ...at, focalLengthX: fx };
      byKey.set(k, e);
    } else if (!e.focalLengthX && fx) {
      e.focalLengthX = fx;
    }
    return e;
  };

  // Distortion — also the carrier of FocalLengthX.
  for (const [name, fisheye] of [["PerspectiveModel", false], ["FisheyeModel", true]] as const) {
    for (const m of elementsByLocal(doc, name)) {
      const k1 = readModelNum(m, "RadialDistortParam1");
      const k2 = readModelNum(m, "RadialDistortParam2");
      const k3 = readModelNum(m, "RadialDistortParam3");
      const e = ensure(m);
      if (fisheye) e.fisheye = true;
      if (k1 !== undefined || k2 !== undefined || k3 !== undefined) {
        e.distortion = { k1: k1 ?? 0, k2: k2 ?? 0, k3: k3 ?? 0 };
      }
    }
  }

  // Vignette.
  for (const m of elementsByLocal(doc, "VignetteModel")) {
    const a1 = readModelNum(m, "VignetteModelParam1");
    const a2 = readModelNum(m, "VignetteModelParam2");
    const a3 = readModelNum(m, "VignetteModelParam3");
    if (a1 !== undefined || a2 !== undefined || a3 !== undefined) {
      ensure(m).vignette = { a1: a1 ?? 0, a2: a2 ?? 0, a3: a3 ?? 0 };
    }
  }

  // Chromatic aberration (red↔green, blue↔green radial scale models).
  for (const m of elementsByLocal(doc, "ChromaticRedGreenModel")) {
    const e = ensure(m);
    const redScale = readModelNum(m, "ScaleFactor");
    e.ca = {
      ...(e.ca ?? { blueK1: 0, blueK2: 0 }),
      redK1: readModelNum(m, "RadialDistortParam1") ?? 0,
      redK2: readModelNum(m, "RadialDistortParam2") ?? 0,
      ...(redScale !== undefined && { redScale }),
    };
  }
  for (const m of elementsByLocal(doc, "ChromaticBlueGreenModel")) {
    const e = ensure(m);
    const blueScale = readModelNum(m, "ScaleFactor");
    e.ca = {
      ...(e.ca ?? { redK1: 0, redK2: 0 }),
      blueK1: readModelNum(m, "RadialDistortParam1") ?? 0,
      blueK2: readModelNum(m, "RadialDistortParam2") ?? 0,
      ...(blueScale !== undefined && { blueScale }),
    };
  }

  const entries = [...byKey.values()].filter(
    (e) => e.distortion || e.vignette || e.ca,
  );
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.focal - b.focal);

  return {
    make,
    model,
    lens: lens || model,
    ...(lensPrettyName && { lensPrettyName }),
    ...(sensorFormatFactor > 0 && { sensorFormatFactor }),
    ...(width > 0 && length > 0 && { imageAspect: Math.max(width, length) / Math.min(width, length) }),
    entries,
  };
}

// ─── Library storage ─────────────────────────────────────────────────────────

// One profile per lens per camera: a profile made on another body is kept beside it.
function profileKey(p: AdobeProfile): string {
  return `${p.make}|${p.model}|${p.lens}`.toLowerCase();
}

/** Parse + store an .lcp into the library. Returns the profile, or null. */
export async function importLcpFile(file: File): Promise<AdobeProfile | null> {
  const text = await file.text();
  const profile = parseLcp(text);
  if (!profile) return null;
  await idbSet("lcp", profileKey(profile), profile);
  return profile;
}

export async function lcpLibrary(): Promise<AdobeProfile[]> {
  return idbGetAll<AdobeProfile>("lcp");
}

export interface ImportedLcpInfo {
  key: string;
  lens: string;
  model: string;
}

export async function importedLcps(): Promise<ImportedLcpInfo[]> {
  const entries = await idbEntries<AdobeProfile>("lcp");
  return entries.map(([key, p]) => ({ key, lens: p.lens || p.model, model: p.model }));
}

export function removeLcp(key: string): Promise<void> {
  return idbDelete("lcp", key);
}

// ─── Preset importer registration (discovery affordance) ─────────────────────

/** `onImported` lets the panel pick the new profile up. */
export function lcpPresetImporter(onImported: () => void): PresetImporterContribution {
  return {
    id: `${EXT_ID}.lcp`,
    label: "Adobe Lens Profile (.lcp)",
    extensions: [".lcp"],
    async parse(file: File) {
      const p = await importLcpFile(file);
      if (!p) return null;
      onImported();
      // The profile now lives in the LCP library and is matched live; the photo
      // is switched to prefer LCP from the panel's Import button. Routing a file
      // through the Presets import just populates the library, so this returns
      // no develop-param changes.
      return { name: `LCP: ${p.lens || p.model}`, params: {} };
    },
  };
}
