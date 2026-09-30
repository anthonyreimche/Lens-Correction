#!/usr/bin/env node
// Convert Lensfun XML database files into a single lens-profiles.json for the
// Lens Correction extension. Run with: node scripts/convert-lensfun-db.mjs
//
// Input:  vendor/lensfun-db/*.xml
// Output: data/lens-profiles.json  (build.mjs copies this into dist/data/)

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildLensDatabase } from "./lensfun-xml.mjs";

const DB_DIR = join(import.meta.dirname, "..", "vendor", "lensfun-db");
const OUT_FILE = join(import.meta.dirname, "..", "data", "lens-profiles.json");

const files = readdirSync(DB_DIR).filter((f) => f.endsWith(".xml")).sort();
const documents = files.map((file) => readFileSync(join(DB_DIR, file), "utf-8"));
const { lenses, droppedDuplicates } = buildLensDatabase(documents);

const json = JSON.stringify(lenses);
writeFileSync(OUT_FILE, json);

console.log(`Converted ${files.length} XML files -> ${lenses.length} lenses`);
console.log(`Dropped ${droppedDuplicates} duplicate lens entries`);
console.log(`Output: ${OUT_FILE} (${(json.length / 1024).toFixed(0)} KB)`);
