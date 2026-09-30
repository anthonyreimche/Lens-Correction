// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Manufacturer names, and the lens names shown to the user built from them.

import type { LensfunLens } from "./types";

// Manufacturer names in EXIF (and in Lensfun's camera list) vary wildly. Map
// common variants to Lensfun's canonical names so we can pre-filter by maker
// before fuzzy-matching. Lookup ignores case and punctuation.
const MAKER_ALIASES: Record<string, string> = {
  "nikon corporation": "Nikon",
  "canon inc.": "Canon",
  canon: "Canon",
  "sony corporation": "Sony",
  sony: "Sony",
  fujifilm: "Fujifilm",
  "fujifilm corporation": "Fujifilm",
  "fuji photo film co., ltd.": "Fujifilm",
  "olympus corporation": "Olympus",
  "olympus imaging corp.": "Olympus",
  "olympus optical co.,ltd": "Olympus",
  olympus: "Olympus",
  "om digital solutions": "Olympus",
  panasonic: "Panasonic",
  sigma: "Sigma",
  "sigma corporation": "Sigma",
  tamron: "Tamron",
  "tamron co.,ltd.": "Tamron",
  samyang: "Samyang",
  "samyang optics": "Samyang",
  leica: "Leica",
  "leica camera ag": "Leica",
  "carl zeiss": "Zeiss",
  zeiss: "Zeiss",
  hasselblad: "Hasselblad",
  ricoh: "Ricoh",
  "ricoh imaging company": "Ricoh",
  "ricoh imaging company, ltd.": "Ricoh",
  pentax: "Pentax",
  "pentax corporation": "Pentax",
  "asahi optical co.,ltd": "Pentax",
  "casio computer co.,ltd": "Casio",
  "eastman kodak company": "Kodak",
  "minolta co., ltd.": "Minolta",
  "konica minolta camera, inc.": "Konica Minolta",
  "lg mobile": "LG",
  "lg electronics": "LG",
  apple: "Apple",
  samsung: "Samsung",
  tokina: "Tokina",
  voigtlander: "Voigtländer",
  voigtländer: "Voigtländer",
  cosina: "Voigtländer",
  schneider: "Schneider-Kreuznach",
  "schneider-kreuznach": "Schneider-Kreuznach",
  meike: "Meike",
  meke: "Meike",
};

const MAKER_ALIAS_BY_KEY = new Map(
  Object.entries(MAKER_ALIASES).map(([name, maker]) => [compact(name), maker]),
);

export function canonicalMaker(raw: string): string {
  return MAKER_ALIAS_BY_KEY.get(compact(raw)) ?? raw.trim();
}

/** The maker a lens goes by: its body's for a built-in lens (a Sony RX100 is a
 *  Sony, whatever Lensfun credits for the optics), otherwise its own. */
export function lensMaker(lens: LensfunLens): string {
  return canonicalMaker(lens.cameras?.[0]?.maker ?? lens.maker);
}

export function lensDisplayName(lens: LensfunLens): string {
  return `${lensMaker(lens)} ${lens.model}`;
}

export function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
