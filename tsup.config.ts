import { defineConfig } from "tsup";
export default defineConfig({
  entry: [
    "src/core/index.ts",
    "src/react/index.tsx",
    "src/vue/index.ts",
    "src/cli/index.ts",
    "src/websocket/index.ts",
    "src/websocket/react.ts",
    "src/websocket/vue.ts",
    "src/angular/index.ts",
    "src/websocket/angular.ts",
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
    "@angular/core",
    "rxjs",
  ],
  target: "es2022",
});
