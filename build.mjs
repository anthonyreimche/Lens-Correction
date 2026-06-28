// Build the Lens Correction extension: bundle src/index.ts into a single ESM
// file with React left external (Safelight injects its own instance as
// api.react). The Lensfun database (data/lens-profiles.json) is imported by the
// loader and inlined into the bundle, so it works however the extension is
// loaded — installed (app:// origin) or live from a dev folder (blob: URL). The
// store fetches files; it never runs this build — dist/ is committed.

import { rolldown } from "rolldown";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";

const root = dirname(fileURLToPath(import.meta.url));

const build = await rolldown({
  input: join(root, "src/index.ts"),
  external: ["react", "react-dom", "react/jsx-runtime"],
  platform: "browser",
});
await build.write({
  file: join(root, "dist/index.js"),
  format: "esm",
  minify: false,
});
await build.close();

const { size } = await stat(join(root, "dist/index.js"));
console.log(`✓ bundled dist/index.js (${(size / 1024 / 1024).toFixed(1)} MB, lens DB inlined)`);
