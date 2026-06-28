// Lens Correction for Safelight — MIT licensed (see LICENSE).
// Extension entry point. Registers the develop panel, the GPU stages (via the
// controller), settings, and the import/parse hooks for embedded RAW
// corrections and Adobe LCP profiles.

import type { SafelightAPI } from "./types/safelight";
import { EXT_ID } from "./params";
import { initController, disposeController, recompute } from "./controller";
import { createLensPanel } from "./ui/panel";
import { embeddedCatalogHook } from "./features/parse-embedded";
import { lcpPresetImporter } from "./features/parse-lcp";

let offSettings: (() => void) | null = null;

export function activate(api: SafelightAPI): void {
  api.registerSettings({
    title: "Lens Correction",
    keywords: ["lens", "distortion", "vignette", "chromatic", "lensfun", "lcp"],
    fields: [
      {
        key: "autoApply",
        label: "Apply corrections automatically",
        hint: "New photos start with profile corrections enabled when a lens profile is found.",
        type: "boolean",
        default: true,
      },
      {
        key: "embeddedCorrections",
        label: "Use embedded RAW corrections",
        hint: "Prefer the camera maker's own correction data (DNG opcodes / makernotes) when present.",
        type: "boolean",
        default: true,
      },
    ],
  });

  initController(api);

  api.registerPanel({
    id: `${EXT_ID}.panel`,
    title: "Lens Correction",
    component: createLensPanel(api),
    slot: "develop-right",
    order: 120,
    defaultDock: { module: "develop", direction: "right", order: 9, width: 280 },
  });

  // Embedded RAW corrections: parse on import, cache a per-photo sidecar.
  api.registerCatalogHooks(embeddedCatalogHook(api));

  // Adobe LCP import: teach the Presets panel to accept .lcp files.
  api.registerPresetImporter(lcpPresetImporter(api));

  // Re-resolve when a relevant setting changes (e.g. auto-apply, embedded pref).
  offSettings = api.settings.onChange(() => void recompute());
}

export function deactivate(): void {
  offSettings?.();
  offSettings = null;
  disposeController();
}
