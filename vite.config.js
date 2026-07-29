import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// resources2crate is a browser app that leans on Node-oriented libraries
// (ro-crate, ro-crate-excel -> exceljs, ro-crate-static-site -> nunjucks). Vite
// honours each package's `browser` field automatically (exceljs →
// dist/exceljs.min.js, nunjucks → browser/nunjucks.js), and we only import
// ro-crate-excel via its clean lib/workbook.js entry (never the package index,
// which pulls in shelljs/fs-extra). The node polyfills below are a safety net
// for Buffer/process/global that some transitive deps reference.
export default defineConfig({
  base: "./",
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  optimizeDeps: {
    include: ["ro-crate", "ro-crate-excel/lib/workbook.js", "ro-crate-static-site", "exceljs", "nunjucks"],
  },
  build: {
    target: "es2020",
    commonjsOptions: { transformMixedEsModules: true },
  },
});
