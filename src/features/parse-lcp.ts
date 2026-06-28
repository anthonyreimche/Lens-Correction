// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Adobe Lens Profile (.lcp) parsing + import. An .lcp is an XMP/RDF document;
// its calibration values appear inconsistently as either attributes or child
// elements, and under varying namespace prefixes, so the reader matches by
// local name and ignores prefixes. Imported profiles are stored in the LCP
// library (IndexedDB) and matched live, like Lensfun.

import type { SafelightAPI, PresetImporterContribution } from "../types/safelight";
import { EXT_ID } from "../params";
import type { AdobeProfile, AdobeEntry } from "./adobe-model";
import { idbSet, idbGetAll } from "../storage";

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

function readStr(root: ParentNode, name: string): string | undefined {
  const el = findByLocal(root, name);
  if (el?.textContent?.trim()) return el.textContent.trim();
  // also try as an attribute somewhere near the root
  if (root instanceof Element) {
    for (const a of Array.from(root.attributes)) if (localName(a) === name) return a.value;
  }
  return undefined;
}

function findByLocal(root: ParentNode, name: string): Element | null {
  const all = (root as Element).getElementsByTagName?.("*") ?? [];
  for (const el of Array.from(all)) if (localName(el) === name) return el;
  return null;
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

function entryKey(focal: number, aperture: number): string {
  return `${focal.toFixed(2)}|${aperture.toFixed(2)}`;
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
  const lens = readStr(doc, "Lens") ?? readStr(doc, "LensPrettyName") ?? "";

  const byKey = new Map<string, AdobeEntry>();
  const ensure = (focal: number, aperture: number, focalLengthX: number): AdobeEntry => {
    const k = entryKey(focal, aperture);
    let e = byKey.get(k);
    if (!e) {
      e = { focal, aperture, focalLengthX };
      byKey.set(k, e);
    } else if (!e.focalLengthX && focalLengthX) {
      e.focalLengthX = focalLengthX;
    }
    return e;
  };

  // Distortion (rectilinear) — also the carrier of FocalLengthX + focal/aperture.
  for (const m of [
    ...elementsByLocal(doc, "PerspectiveModel"),
    ...elementsByLocal(doc, "FisheyeModel"),
  ]) {
    const focal = ancestorNum(m, "FocalLength") ?? 0;
    const aperture = ancestorNum(m, "ApertureValue") ?? 0;
    const fx = readModelNum(m, "FocalLengthX") ?? 0;
    const k1 = readModelNum(m, "RadialDistortParam1");
    const k2 = readModelNum(m, "RadialDistortParam2");
    const k3 = readModelNum(m, "RadialDistortParam3");
    const e = ensure(focal, aperture, fx);
    if (k1 !== undefined || k2 !== undefined || k3 !== undefined) {
      e.distortion = { k1: k1 ?? 0, k2: k2 ?? 0, k3: k3 ?? 0 };
    }
  }

  // Vignette.
  for (const m of elementsByLocal(doc, "VignetteModel")) {
    const focal = ancestorNum(m, "FocalLength") ?? 0;
    const aperture = ancestorNum(m, "ApertureValue") ?? 0;
    const fx = readModelNum(m, "FocalLengthX") ?? 0;
    const a1 = readModelNum(m, "VignetteModelParam1");
    const a2 = readModelNum(m, "VignetteModelParam2");
    const a3 = readModelNum(m, "VignetteModelParam3");
    if (a1 !== undefined || a2 !== undefined || a3 !== undefined) {
      ensure(focal, aperture, fx).vignette = { a1: a1 ?? 0, a2: a2 ?? 0, a3: a3 ?? 0 };
    }
  }

  // Chromatic aberration (red↔green, blue↔green radial scale models).
  const caRed = elementsByLocal(doc, "ChromaticRedGreenModel");
  const caBlue = elementsByLocal(doc, "ChromaticBlueGreenModel");
  for (const m of caRed) {
    const focal = ancestorNum(m, "FocalLength") ?? 0;
    const aperture = ancestorNum(m, "ApertureValue") ?? 0;
    const e = ensure(focal, aperture, readModelNum(m, "FocalLengthX") ?? 0);
    const k1 = readModelNum(m, "RadialDistortParam1") ?? 0;
    const k2 = readModelNum(m, "RadialDistortParam2") ?? 0;
    e.ca = { redK1: k1, redK2: k2, blueK1: e.ca?.blueK1 ?? 0, blueK2: e.ca?.blueK2 ?? 0 };
  }
  for (const m of caBlue) {
    const focal = ancestorNum(m, "FocalLength") ?? 0;
    const aperture = ancestorNum(m, "ApertureValue") ?? 0;
    const e = ensure(focal, aperture, readModelNum(m, "FocalLengthX") ?? 0);
    const k1 = readModelNum(m, "RadialDistortParam1") ?? 0;
    const k2 = readModelNum(m, "RadialDistortParam2") ?? 0;
    e.ca = { redK1: e.ca?.redK1 ?? 0, redK2: e.ca?.redK2 ?? 0, blueK1: k1, blueK2: k2 };
  }

  const entries = [...byKey.values()].filter(
    (e) => e.distortion || e.vignette || e.ca,
  );
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.focal - b.focal);

  return { make, model, lens: lens || model, entries };
}

// ─── Library storage ─────────────────────────────────────────────────────────

function profileKey(p: AdobeProfile): string {
  return `${p.make}|${p.lens}`.toLowerCase();
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

// ─── Preset importer registration (discovery affordance) ─────────────────────

export function lcpPresetImporter(_api: SafelightAPI): PresetImporterContribution {
  return {
    id: `${EXT_ID}.lcp`,
    label: "Adobe Lens Profile (.lcp)",
    extensions: [".lcp"],
    async parse(file: File) {
      const p = await importLcpFile(file);
      if (!p) return null;
      // The profile now lives in the LCP library and is matched live; the photo
      // is switched to prefer LCP from the panel's "Import .lcp" button. Routing a
      // file through the Presets import just populates the library, so this
      // returns no develop-param changes.
      return { name: `LCP: ${p.lens || p.model}`, params: {} };
    },
  };
}
