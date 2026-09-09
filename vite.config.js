import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Build identity: an incrementing build number (total commit count on the
// current history, so it's identical whether computed locally or in CI —
// unlike GitHub Actions' own run_number, which counts workflow runs, not
// commits, and isn't reproducible outside Actions) plus the short commit SHA
// it was built from. Requires full history (deploy.yml checks out with
// fetch-depth: 0); falls back to "dev" locally if git isn't available.
function getBuildInfo() {
  try {
    const number = execSync("git rev-list --count HEAD").toString().trim();
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    return { number, sha };
  } catch {
    return { number: "dev", sha: "dev" };
  }
}
const BUILD_INFO = getBuildInfo();

// chaos2crate is a browser app that leans on Node-oriented libraries
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

function patchMammothBrowserEventCollision() {
  return {
    name: "patch-mammoth-browser-event-collision",
    enforce: "pre",
    transform(code, id) {
      if (!/mammoth/i.test(id)) return null;
      let out = code;
      const changed =
        out.replace(/var event = new CustomEvent\("CustomEvent"\);/g, 'var customEvent = new CustomEvent("CustomEvent");') !== out ||
        out.replace(/var event = new Event\("CustomEvent"\);/g, 'var customEvent = new Event("CustomEvent");') !== out ||
        out.replace(/dispatchEvent\(event\);/g, "dispatchEvent(customEvent);") !== out ||
        out.replace(/return function\(name, event2\) \{/g, "return function(name, detail) {") !== out ||
        out.replace(/return function\(name, event\) \{/g, "return function(name, detail) {") !== out ||
        out.replace(/detail: event2,/g, "detail: detail,") !== out ||
        out.replace(/detail: event,/g, "detail: detail,") !== out ||
        out.replace(/domEvent\.detail = event2;/g, "domEvent.detail = detail;") !== out ||
        out.replace(/domEvent\.detail = event;/g, "domEvent.detail = detail;") !== out;
      if (!changed) return null;
      out = out.replace(/var event = new CustomEvent\("CustomEvent"\);/g, 'var customEvent = new CustomEvent("CustomEvent");');
      out = out.replace(/var event = new Event\("CustomEvent"\);/g, 'var customEvent = new Event("CustomEvent");');
      out = out.replace(/dispatchEvent\(event\);/g, "dispatchEvent(customEvent);");
      out = out.replace(/return function\(name, event2\) \{/g, "return function(name, detail) {");
      out = out.replace(/return function\(name, event\) \{/g, "return function(name, detail) {");
      out = out.replace(/detail: event2,/g, "detail: detail,");
      out = out.replace(/detail: event,/g, "detail: detail,");
      out = out.replace(/domEvent\.detail = event2;/g, "domEvent.detail = detail;");
      out = out.replace(/domEvent\.detail = event;/g, "domEvent.detail = detail;");
      return out;
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __BUILD_NUMBER__: JSON.stringify(BUILD_INFO.number),
    __BUILD_SHA__: JSON.stringify(BUILD_INFO.sha),
  },
  plugins: [
    patchMaspValidatorCjsArtifacts(),
    patchMammothBrowserEventCollision(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  optimizeDeps: {
    include: [
      "ro-crate",
      "ro-crate-excel/lib/workbook.js",
      "ro-crate-static-site",
      "exceljs",
      "nunjucks",
      // mammoth is a CJS package reached only through c2c-plugins (below),
      // which is excluded from optimization — without this, Vite never
      // runs its CJS->ESM interop on mammoth, so `import mammoth from
      // "mammoth"` fails at runtime with "does not provide an export named
      // 'default'". The "linked-pkg > dep" form re-includes it despite the
      // parent being excluded.
      "c2c-plugins > mammoth",
    ],
    // c2c-plugins' file-format-identify module uses Vite-only `?raw`/`?url`
    // import suffixes (see wasm-loader.js) to load its vendored Go/WASM
    // glue. With preserveSymlinks above making c2c-plugins look like an
    // ordinary node_modules package, Vite's esbuild-based dependency
    // optimizer tries to pre-bundle it and chokes on those suffixes
    // (wasm_exec.js is a plain script with no exports, so esbuild sees
    // `?raw` as a normal JS import and fails with "no matching export").
    // Excluding it keeps its modules on Vite's own transform pipeline,
    // which understands `?raw`/`?url` correctly.
    exclude: ["c2c-plugins"],
  },
  build: {
    target: "es2020",
    commonjsOptions: { transformMixedEsModules: true },
  },
  resolve: {
    // c2c-plugins is a file: dependency (a symlinked sibling checkout, not a
    // real node_modules copy). Without this, bare-specifier resolution for
    // anything it imports — its own deps (mammoth, cheerio, ...) *and*
    // devDependency-injected imports like vite-plugin-node-polyfills' Buffer
    // shim — walks up from c2c-plugins' real on-disk location instead of its
    // apparent node_modules/c2c-plugins location, missing chaos2crate's
    // own node_modules entirely.
    preserveSymlinks: true,
  },
});
