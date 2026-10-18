import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // macOS writes AppleDouble "._*" files on non-APFS volumes; never treat them as tests.
    exclude: [...configDefaults.exclude, "**/._*"],
  },
});
