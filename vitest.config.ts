import { configDefaults, defineConfig } from "vitest/config";

// The GPU spec runs inside a SafeLight checkout (npm run test:gpu), not here.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/gpu/**"],
  },
});
