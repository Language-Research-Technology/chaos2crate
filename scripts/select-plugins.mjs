#!/usr/bin/env node
// Regenerates src/plugins/index.js from the PLUGINS env var — a
// comma-separated list of plugins to bundle (default, or the literal "all",
// bundles every c2c-plugins plugin). Runs automatically before
// `npm run dev`/`npm run build`/`npm test` (see package.json's pre* scripts)
// so the checked-in src/plugins/index.js is always regenerated fresh before
// use; it's still committed so the repo isn't left with a missing/stale
// file for anyone who reads it without running a script first.
//
// Only static per-plugin imports achieve real bundle-size exclusion — a
// runtime filter over an eagerly-imported registry would still pull every
// plugin's code into the graph Rollup sees, dynamic-import chunks included.
// So this writes the exact set of import statements a given PLUGINS
// selection needs, rather than filtering an already-fully-imported list.
//
// Each PLUGINS entry is either:
//   name                    — from c2c-plugins' own REGISTRY (the default
//                              source; validated against it, order follows
//                              REGISTRY's own hook-execution order)
//   name=package            — package's own src/<name>/index.js, following
//                              the same layout convention as c2c-plugins —
//                              for another repo (local checkout via a
//                              "file:../other-repo" package.json dependency,
//                              or an online repo pulled in via
//                              "github:org/other-repo") built the same way
//   name=./relative/path.js — an exact import specifier: a subpath into an
//   name=/absolute/path.js    installed package, or a relative/absolute
//                              filesystem path — for a one-off local plugin
//                              you don't want to wire into package.json at
//                              all. Must export createPlugin(deps), same
//                              contract as every other plugin here.
//
// Example mixing all three:
//   PLUGINS=merge,validate-crate,special=other-plugins,scratch=../scratch-plugin/index.js npm run build
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { REGISTRY, INPUT_REGISTRY } from "c2c-plugins";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const allNames = Object.keys(REGISTRY);
const raw = (process.env.PLUGINS || "").trim();
const entries = !raw || raw === "all"
  ? allNames
  : raw.split(",").map((s) => s.trim()).filter(Boolean);

// Split into bare names (resolved against c2c-plugins' REGISTRY) and
// name=spec entries (resolved against whatever spec says).
const bareNames = [];
const customEntries = []; // { name, specifier }
for (const entry of entries) {
  const eq = entry.indexOf("=");
  if (eq === -1) {
    bareNames.push(entry);
    continue;
  }
  const name = entry.slice(0, eq).trim();
  const rhs = entry.slice(eq + 1).trim();
  if (!name || !rhs) {
    console.error(`select-plugins: malformed PLUGINS entry "${entry}" — expected name=package or name=./path.js`);
    process.exit(1);
  }
  // A bare package name (no "/") is expanded to that package's own
  // src/<name>/index.js, mirroring c2c-plugins' own layout convention.
  // A relative/absolute filesystem path is resolved against the project
  // root (this repo's own directory — the same base "../c2c-plugins"
  // already implies) and rewritten as an absolute path: it's about to be
  // embedded in src/plugins/index.js, two directories deeper than the
  // project root, so the path as typed can't be reused verbatim. Anything
  // else containing "/" (no leading "." or "/") is a bare package subpath,
  // used exactly as given.
  const specifier = rhs.startsWith(".") || rhs.startsWith("/")
    ? resolvePath(projectRoot, rhs)
    : rhs.includes("/") ? rhs : `${rhs}/src/${name}/index.js`;
  customEntries.push({ name, specifier });
}

const unknownBareNames = bareNames.filter((name) => !REGISTRY[name]);
if (unknownBareNames.length) {
  console.error(
    `select-plugins: unknown plugin name(s) in PLUGINS: ${unknownBareNames.join(", ")}.\n` +
    `Known c2c-plugins plugins: ${allNames.join(", ")}\n` +
    `(For a plugin from elsewhere, use name=package or name=./path.js — see this script's header comment.)`
  );
  process.exit(1);
}

// Preserve REGISTRY's own order (hook-execution order for plugins sharing a
// stage — see c2c-plugins/index.js) rather than the order PLUGINS listed
// them in. Custom entries have no such ordering information available, so
// they're appended after, in the order they were listed.
const selectedBareNames = allNames.filter((name) => bareNames.includes(name));

// Fail fast, at generation time, if a custom entry doesn't resolve or
// doesn't export createPlugin — a confusing Rollup/Vite error later, deep
// inside someone else's plugin, is a much worse place to discover a typo.
for (const { name, specifier } of customEntries) {
  let mod;
  try {
    // specifier is either a bare package (sub)path, resolved via node_modules,
    // or already an absolute filesystem path (see above) — pathToFileURL
    // only matters for the latter.
    mod = await import(specifier.startsWith("/") ? pathToFileURL(specifier).href : specifier);
  } catch (e) {
    console.error(`select-plugins: could not import "${specifier}" for plugin "${name}": ${e.message}`);
    process.exit(1);
  }
  if (typeof mod.createPlugin !== "function") {
    console.error(`select-plugins: "${specifier}" (plugin "${name}") does not export createPlugin(deps) — every plugin must, see c2c-plugins' README for the contract.`);
    process.exit(1);
  }
}

const importLines = [
  ...selectedBareNames.map((name, i) => `import { createPlugin as create_${i} } from "c2c-plugins/src/${name}/index.js";`),
  ...customEntries.map(({ specifier }, i) => `import { createPlugin as createCustom_${i} } from "${specifier}";`),
];
const pluginLines = [
  ...selectedBareNames.map((name, i) => `  create_${i}(deps), // ${name}`),
  ...customEntries.map(({ name }, i) => `  createCustom_${i}(deps), // ${name} (custom source)`),
];

const inputModes = Object.keys(INPUT_REGISTRY); // always all — mutually exclusive, small, needed for UI mode-switching
const inputImportLines = inputModes.map(
  (mode, i) => `import { createPlugin as createInput_${i} } from "c2c-plugins/src/${mode === "generic" ? "generic-input" : "docx-input"}/index.js";`
);
const inputPluginLines = inputModes.map((mode, i) => `  ${mode}: createInput_${i}(deps),`);

const selectedNames = [...selectedBareNames, ...customEntries.map((e) => e.name)];

const body = `// AUTO-GENERATED by scripts/select-plugins.mjs from the PLUGINS env var —
// do not edit by hand, your changes will be overwritten. Regenerated by the
// pretest/predev/prebuild npm hooks; run \`node scripts/select-plugins.mjs\`
// directly to regenerate without also running dev/build/test.
// Selected plugins (PLUGINS=${raw || "all"}): ${selectedNames.join(", ") || "(none)"}
import { buildDeps } from "./deps.js";
${importLines.join("\n")}
${inputImportLines.join("\n")}

const deps = buildDeps();

// Order here is hook-execution order for plugins sharing a hook stage
// (createHookBus's priority defaults to 10 for every registration, and
// Array#sort is stable, so registration order reproduces the original
// processFolder sequence — see c2c-plugins/index.js's REGISTRY ordering).
// Plugins from a custom source (name=package or name=./path.js in PLUGINS)
// are appended after the c2c-plugins ones, in the order they were listed —
// this script has no way to know where they should sit relative to others
// sharing a hook stage, so place them in PLUGINS accordingly if that matters.
export const PLUGINS = [
${pluginLines.join("\n")}
];

// Input-mode plugins are a separate registry from PLUGINS above: they're
// mutually exclusive (exactly one runs per build, dispatched by
// pipeline.js on ctx.options.inputMode), not additive hook taps that all
// coexist — so they don't go through registerAllPlugins/composeOptionSchema.
export const INPUT_PLUGINS = {
${inputPluginLines.join("\n")}
};

export function registerAllPlugins(hookBus, plugins = PLUGINS) {
  for (const plugin of plugins) {
    for (const [hookName, handler] of Object.entries(plugin.hooks || {})) {
      hookBus.on(hookName, handler, { pluginName: plugin.name });
    }
  }
}

export function composeOptionSchema(plugins = PLUGINS) {
  return plugins.map((p) => p.optionSchema).filter(Boolean);
}

export function composeSettingsSchema(plugins = PLUGINS) {
  return plugins.map((p) => p.settingsSchema).filter(Boolean);
}

// Every file/directory a registered plugin may write directly into the
// picked folder — additive plugins and input-mode plugins alike, since both
// write into the same folder and a build can switch between input modes on
// a folder that still holds a previous run's output. Deduped by path (e.g.
// chat-export and ca-data-prep both declare "c2c-output"), first declared
// kind wins. Consumed by main.js for two things: excluding this from the
// next scan (alongside GENERATED_FILENAMES/CONTROL_FILENAMES) and the
// "delete plugin output before rebuilding" setting.
export function composeOutputPaths(plugins = PLUGINS, inputPlugins = INPUT_PLUGINS) {
  const byPath = new Map();
  for (const plugin of [...plugins, ...Object.values(inputPlugins)]) {
    for (const entry of plugin.outputPaths || []) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}
`;

const outPath = fileURLToPath(new URL("../src/plugins/index.js", import.meta.url));
writeFileSync(outPath, body);
console.log(`select-plugins: wrote src/plugins/index.js — ${selectedNames.length} plugin(s): ${selectedNames.join(", ") || "(none)"}`);
