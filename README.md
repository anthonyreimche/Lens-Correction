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
  **DNG** files (the standardized DNG OpcodeList3: distortion + vignetting) and **Fujifilm RAF**
  files (distortion, vignetting, and lateral chromatic aberration); maker-note decoding for other
  proprietary RAWs (Sony ARW, Panasonic RW2, Micro-4/3) is in progress.
- **Import your own profiles** — the **Import** button next to the lens name takes an Adobe
  Lens Profile (`.lcp`) from Lightroom / Camera Raw, or a Lensfun `.xml` database file. A
  Lensfun file's lenses join the built-in list; a lens already in it takes your calibration.
  Importing a file with the same name again replaces it, and **Imported profiles** lists
  your imports with a button to remove each. LCP profiles are matched to the exact lens
  name, use the raw or JPEG calibration to suit the photo, and support fisheye lenses.
- **Auto chromatic aberration** — estimates and removes lateral CA directly from the image, no
  profile needed.
- **Advanced defringe** — targeted purple and green fringe removal with eyedropper hue pickers,
  amount, and radius.
- **Full manual control** — distortion, fringing, defringe, and vignetting sliders, with
  auto-crop to hide the corrected borders.
- **In masks:** add Lens Correction to a mask from the Masking panel's Adjust tab for a second
  Vignetting and Defringe (with its Advanced defringe hues) inside that mask only, on top of
  the photo's correction. The lens profile, distortion, chromatic aberration and Auto CA stay
  the photo's: distortion and CA are applied before a mask's area is known, and Auto CA
  measures the whole photo. It needs the current processing: on a photo edited in an earlier
  Safelight, use Update processing first.
- **Smart matching** — auto-detects your lens from EXIF, or your camera for fixed-lens bodies
  (X100, GFX100RF, RX100, …), with a searchable manual picker and a remembered choice per lens
  or body.

All processing runs on the GPU as part of Safelight's develop pipeline, so corrections are
non-destructive and update live.

## Install

In Safelight, open **Extensions**, search for "Lens Correction", and install. Or install by
repo: `anthonyreimche/Lensfun-Lens-Correction`.

## Develop / build

```sh
npm install
npm run build      # bundles src → dist/index.js (the Lensfun DB is inlined)
npm test           # unit tests for the matching, interpolation, parsers, and mask panel
npm run test:gpu   # vignetting and defringe in a mask on a real WebGL2 driver, via a SafeLight checkout's rig
```

`dist/` is committed so installs need no toolchain. The lens database is regenerated from the
Lensfun XML sources with `npm run build:db` (see `scripts/`).

## Licensing

Extension source code: **MIT** (see [LICENSE](LICENSE)).
Bundled lens database: derived from Lensfun, **CC BY-SA 3.0** — see [NOTICE](NOTICE).
