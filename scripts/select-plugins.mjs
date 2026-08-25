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
//
// INPUT_PLUGINS works the same way, but selects INPUT_PLUGINS (mutually
// exclusive at runtime — dispatched by pipeline.js on ctx.options.inputMode
// — but every mode selected here still gets bundled together, so the app's
// own UI can switch between them) instead of the additive PLUGINS above.
// Defaults to c2c-plugins' own "generic,docx" when unset, so existing
// builds are unaffected. Each entry is either:
//   mode                    — from c2c-plugins' own INPUT_REGISTRY,
//                              resolved to its own src/<mode>-input/index.js
//                              (c2c-plugins' own input-mode folder naming
//                              convention — see generic-input/docx-input)
//   mode=package            — package's own src/<mode>-input/index.js
//   mode=./relative/path.js — an exact import specifier, same as PLUGINS'
//   mode=/absolute/path.js    third form above
//
// Example, bundling only an external chordpro input mode (no generic/docx
// at all — see c2c-chordpro-plugin's own README):
//   INPUT_PLUGINS=chordpro=c2c-chordpro-plugin PLUGINS=ro-crate-json-output npm run build
//
// Remembers the last explicit selection, in .plugins-selection.json
// (gitignored — a personal working-copy preference, never committed): a run
// with PLUGINS/INPUT_PLUGINS actually set persists them there; a run with
// neither set (a plain `npm run dev`/`build`/`test`, or one of the pre*
// hooks firing on its own) reuses whatever was last remembered instead of
// always resetting to "every c2c-plugins plugin" — which is what silently
// swapped a running `dev:chordpro` server back to the generic bundle the
// moment something as unrelated as `npm test` ran in the same checkout.
// Falls back to the documented "all"/"generic,docx" default only when
// nothing has ever been remembered (a fresh clone).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { REGISTRY, INPUT_REGISTRY } from "c2c-plugins";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const memoryPath = resolvePath(projectRoot, ".plugins-selection.json");

function readMemory() {
  if (!existsSync(memoryPath)) return {};
  try {
    return JSON.parse(readFileSync(memoryPath, "utf8"));
  } catch {
    return {}; // corrupt/hand-edited memory file — treat as absent, don't crash the build over it
  }
}
const memory = readMemory();

// process.env.X is undefined when the var isn't set at all, but "" when set
// to an empty string — only the former should fall through to memory; an
// explicit `PLUGINS= npm run dev` (deliberately "none") must still win and
// get remembered as such, not be treated as "nothing given".
const pluginsGiven = process.env.PLUGINS !== undefined;
const inputPluginsGiven = process.env.INPUT_PLUGINS !== undefined;

const allNames = Object.keys(REGISTRY);
const raw = (pluginsGiven ? process.env.PLUGINS : (memory.plugins ?? "")).trim();
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

// Same bare-name/name=spec parsing as PLUGINS above, but for INPUT_PLUGINS —
// mode is a registry key (INPUT_REGISTRY), not an arbitrary label, since it
// also becomes the property key ctx.options.inputMode is dispatched against
// at runtime (pipeline.js).
const allInputModes = Object.keys(INPUT_REGISTRY);
const inputRaw = (inputPluginsGiven ? process.env.INPUT_PLUGINS : (memory.inputPlugins ?? "")).trim();
const inputEntries = !inputRaw
  ? allInputModes
  : inputRaw.split(",").map((s) => s.trim()).filter(Boolean);

const inputBareModes = [];
const inputCustomEntries = []; // { mode, specifier }
for (const entry of inputEntries) {
  const eq = entry.indexOf("=");
  if (eq === -1) {
    inputBareModes.push(entry);
    continue;
  }
  const mode = entry.slice(0, eq).trim();
  const rhs = entry.slice(eq + 1).trim();
  if (!mode || !rhs) {
    console.error(`select-plugins: malformed INPUT_PLUGINS entry "${entry}" — expected mode or mode=package or mode=./path.js`);
    process.exit(1);
  }
  // c2c-plugins' own input-mode folder naming convention is "<mode>-input"
  // (generic -> generic-input, docx -> docx-input) — applied here too for a
  // bare package name, so an external input-mode package only has to follow
  // that same one convention to work with the short form.
  const specifier = rhs.startsWith(".") || rhs.startsWith("/")
    ? resolvePath(projectRoot, rhs)
    : rhs.includes("/") ? rhs : `${rhs}/src/${mode}-input/index.js`;
  inputCustomEntries.push({ mode, specifier });
}

const unknownInputModes = inputBareModes.filter((mode) => !INPUT_REGISTRY[mode]);
if (unknownInputModes.length) {
  console.error(
    `select-plugins: unknown input mode(s) in INPUT_PLUGINS: ${unknownInputModes.join(", ")}.\n` +
    `Known c2c-plugins input modes: ${allInputModes.join(", ")}\n` +
    `(For an input mode from elsewhere, use mode=package or mode=./path.js — see this script's header comment.)`
  );
  process.exit(1);
}

// Same fail-fast-at-generation-time check customEntries gets above.
for (const { mode, specifier } of inputCustomEntries) {
  let mod;
  try {
    mod = await import(specifier.startsWith("/") ? pathToFileURL(specifier).href : specifier);
  } catch (e) {
    console.error(`select-plugins: could not import "${specifier}" for input mode "${mode}": ${e.message}`);
    process.exit(1);
  }
  if (typeof mod.createPlugin !== "function") {
    console.error(`select-plugins: "${specifier}" (input mode "${mode}") does not export createPlugin(deps) — every plugin must, see c2c-plugins' README for the contract.`);
    process.exit(1);
  }
}

const inputImportLines = [
  ...inputBareModes.map((mode, i) => `import { createPlugin as createInput_${i} } from "c2c-plugins/src/${mode}-input/index.js";`),
  ...inputCustomEntries.map(({ specifier }, i) => `import { createPlugin as createInputCustom_${i} } from "${specifier}";`),
];
const inputPluginLines = [
  ...inputBareModes.map((mode, i) => `  ${mode}: createInput_${i}(deps),`),
  ...inputCustomEntries.map(({ mode }, i) => `  ${mode}: createInputCustom_${i}(deps),`),
];

const selectedNames = [...selectedBareNames, ...customEntries.map((e) => e.name)];
const selectedInputModes = [...inputBareModes, ...inputCustomEntries.map((e) => e.mode)];

const body = `// AUTO-GENERATED by scripts/select-plugins.mjs from the PLUGINS env var —
// do not edit by hand, your changes will be overwritten. Regenerated by the
// pretest/predev/prebuild npm hooks; run \`node scripts/select-plugins.mjs\`
// directly to regenerate without also running dev/build/test.
// Selected plugins (PLUGINS=${raw || "all"}): ${selectedNames.join(", ") || "(none)"}
// Selected input modes (INPUT_PLUGINS=${inputRaw || "generic,docx"}): ${selectedInputModes.join(", ") || "(none)"}
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

// Remember whatever actually got used this run — including a value that
// itself just came from memory, so this is idempotent when nothing changed
// — so the next run with neither env var set reuses it instead of falling
// back to "all"/"generic,docx".
writeFileSync(memoryPath, JSON.stringify({ plugins: raw, inputPlugins: inputRaw }, null, 2) + "\n");

const usedMemoryNote = !pluginsGiven && !inputPluginsGiven && (memory.plugins !== undefined || memory.inputPlugins !== undefined)
  ? " (remembered from last explicit selection — pass PLUGINS/INPUT_PLUGINS to change it)"
  : "";
console.log(`select-plugins: wrote src/plugins/index.js — ${selectedNames.length} plugin(s): ${selectedNames.join(", ") || "(none)"}; ${selectedInputModes.length} input mode(s): ${selectedInputModes.join(", ") || "(none)"}${usedMemoryNote}`);
