# Lens Correction for Safelight

Professional lens correction for [Safelight](https://github.com/anthonyreimche/Safelight) —
distortion, chromatic aberration, vignetting, and defringe — as an installable extension.

It corrects optical flaws automatically from your lens, and gives you precise manual control
when you want it.

## Features

- **Automatic profile correction** from the [Lensfun](https://lensfun.github.io/) database
  (thousands of camera + lens calibrations): geometric distortion, transverse chromatic
  aberration, and vignetting, interpolated to the exact focal length, aperture, and focus
  distance of each shot.
- **Embedded RAW corrections** — reads the camera maker's own correction data baked into the
  file, so many lenses correct perfectly even when no Lensfun profile exists. Today this covers
  **DNG** files (the standardized DNG OpcodeList3: distortion + vignetting); maker-note decoding
  for proprietary RAWs (Sony ARW, Fujifilm RAF, Panasonic RW2, Micro-4/3) is in progress.
- **Adobe Lens Profile (`.lcp`) import** — bring your existing Lightroom / Camera Raw lens
  profiles.
- **Auto chromatic aberration** — estimates and removes lateral CA directly from the image, no
  profile needed.
- **Advanced defringe** — targeted purple and green fringe removal with eyedropper hue pickers,
  amount, and radius.
- **Full manual control** — distortion, fringing, defringe, and vignetting sliders, with
  auto-crop to hide the corrected borders.
- **Smart matching** — auto-detects your lens from EXIF, with a searchable manual picker and a
  remembered choice per lens.

All processing runs on the GPU as part of Safelight's develop pipeline, so corrections are
non-destructive and update live.

## Install

In Safelight, open **Extensions**, search for "Lens Correction", and install. Or install by
repo: `anthonyreimche/Lensfun-Lens-Correction`.

## Develop / build

```sh
npm install
npm run build      # bundles src → dist/index.js (the Lensfun DB is inlined)
npm test           # unit tests for the matching, interpolation, and parsers
```

`dist/` is committed so installs need no toolchain. The lens database is regenerated from the
Lensfun XML sources with `npm run build:db` (see `scripts/`).

## Licensing

Extension source code: **MIT** (see [LICENSE](LICENSE)).
Bundled lens database: derived from Lensfun, **CC BY-SA 3.0** — see [NOTICE](NOTICE).
