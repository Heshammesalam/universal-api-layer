import { defineConfig } from "tsup";
export default defineConfig({
  entry: [
    "src/core/index.ts",
    "src/react/index.tsx",
    "src/vue/index.ts",
    "src/cli/index.ts",
  ],
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "vue",
    "@tanstack/react-query",
    "@tanstack/vue-query",
  ],
  target: "es2022",
});
