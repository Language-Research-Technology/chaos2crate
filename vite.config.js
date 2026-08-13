import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// resources2crate is a browser app that leans on Node-oriented libraries
// (ro-crate, ro-crate-excel -> exceljs, ro-crate-static-site -> nunjucks). Vite
// honours each package's `browser` field automatically (exceljs →
// dist/exceljs.min.js, nunjucks → browser/nunjucks.js), and we only import
// ro-crate-excel via its clean lib/workbook.js entry (never the package index,
// which pulls in shelljs/fs-extra). The node polyfills below are a safety net
// for Buffer/process/global that some transitive deps reference.
// ro-crate-masp's lib/masp-validator.js (a library file, not a CLI entry
// point) carries a leftover `#!/usr/bin/env node` shebang. Rollup normally
// strips a shebang when it's the very first thing in a module, but
// vite-plugin-node-polyfills injects an import above it first, pushing the
// shebang to a later line where it's just an invalid `#` token. Strip it
// ourselves, before that plugin runs (enforce: "pre").
//
// The same file also ends with a `if (require.main === module) { ... }`
// CLI-entry-point block. `@rollup/plugin-commonjs` rewrites `require(...)`
// calls but leaves the bare `require.main` property access alone, so the
// bundled module references a `require` global that doesn't exist in the
// browser — throwing "require is not defined" the moment the module (which
// every profile load pulls in) is evaluated, CLI usage or not. Neutralize
// the guard so that block is dead code.
function patchMaspValidatorCjsArtifacts() {
  return {
    name: "patch-masp-validator-cjs-artifacts",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/node_modules/ro-crate-masp/")) return null;
      let out = code;
      if (out.startsWith("#!")) out = out.replace(/^#!.*\n/, "");
      out = out.replace("if (require.main === module) {", "if (false) {");
      return out === code ? null : out;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    patchMaspValidatorCjsArtifacts(),
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
