import type { LensfunLens } from "./types";

export function buildLensDatabase(xmlDocuments: string[]): {
  lenses: LensfunLens[];
  droppedDuplicates: number;
  skipped: number;
};

export function lensKey(lens: LensfunLens): string;

export function mergeLenses(base: LensfunLens[], overrides: LensfunLens[]): LensfunLens[];
